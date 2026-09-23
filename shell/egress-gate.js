// egress-gate.js — 壳级出域闸的扫描核心(纯函数,不依赖 Electron,可单测)
//
// 2026-09-23 起因:「签名包 = 承诺锚」被审计打穿 —— 签名壳只有 16KB,脱敏引擎是网页运行时
// 下发的 JS,签名根本没锚住引擎。老板拍板走 A 路线:壳自己做出域闸,网页 JS 怎么改都绕不过。
//
// 边界(写清楚,别让下一个人误以为它做得更多):
//  · 它**不识别**什么是敏感的 —— 那是网页端引擎(redact.ts detectSensitive)的事。
//    它只认「渲染进程通过 IPC 登记过的真值」,做精确串匹配。登记什么、它就守什么。
//  · 它守的是「已登记的真值不得离开本机」,不区分会话:A 会话登记的报价,
//    B 会话(哪怕非保密)的请求里出现同样的串,一样拦。这是有意的 ——
//    按会话放行意味着相信渲染进程报的"当前是哪个会话",而不信任渲染进程正是它存在的理由。
//  · 真值只在主进程内存里,不落盘。App 重启后由渲染进程在装入密表时重新登记
//    (secret-store 装入 → IPC register)。理论上存在"装入前的窗口",但要在那个窗口
//    发出真值,发送方得先拿到真值,而真值只在密表里 —— 装入密表正是触发登记的那一步。
//
// 匹配纪律(与引擎同口径,见 redact.ts〔擎8〕〔擎14〕):
//  · 先 foldWidth:全角/阿拉伯-印度/波斯/上下标数字折成 ASCII,全角货币符同理。
//    引擎登记时折过,这里对请求体也折,两边才对得上。
//  · 数字边界:真值以数字开头/结尾时,命中位置前/后不得紧邻数字 ——
//    '38.5' 不得在 '138.5' 里命中(否则「型号 MG-138.5」这种无辜串会误拦)。
//  · 多层解码后每一层都扫:JSON \uXXXX 转义、百分号编码、base64 串、gzip 体、zip 容器。
//    网页 JS 一旦被改坏,最省事的绕法就是换个编码 —— 这些是它一定会先试的几手。
//  · 拆不开的形态一律 fail-closed:加密 zip、zip64、解不开的 deflate → 当作命中处理(拦)。

'use strict'

const zlib = require('zlib')

// ── 字符折叠(移植自 tokenbridge/src/lib/redact.ts,必须与引擎逐字一致)────────────
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const SUBSCRIPTS   = '₀₁₂₃₄₅₆₇₈₉'
const PUNCT_MAP    = { '．': '.', '，': ',', '％': '%', '＄': '$', '￡': '£', '￠': '¢', '·': '.', '・': '.', '‧': '.', '˙': '.' }

function foldWidth(text) {
  return String(text).replace(/[０-９Ａ-Ｚａ-ｚ．，％＄￡￠·・‧˙٠-٩۰-۹⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/g, (ch) => {
    const c = ch.charCodeAt(0)
    if (c >= 0xff10 && c <= 0xff19) return String.fromCharCode(c - 0xff10 + 48)
    if (c >= 0xff21 && c <= 0xff3a) return String.fromCharCode(c - 0xff21 + 65)
    if (c >= 0xff41 && c <= 0xff5a) return String.fromCharCode(c - 0xff41 + 97)
    if (c >= 0x0660 && c <= 0x0669) return String.fromCharCode(c - 0x0660 + 48)
    if (c >= 0x06f0 && c <= 0x06f9) return String.fromCharCode(c - 0x06f0 + 48)
    const sup = SUPERSCRIPTS.indexOf(ch); if (sup >= 0) return String(sup)
    const sub = SUBSCRIPTS.indexOf(ch);   if (sub >= 0) return String(sub)
    return PUNCT_MAP[ch] ?? ch
  })
}

// ── 解码层 ──────────────────────────────────────────────────────────────────
const isDigit = ch => ch >= '0' && ch <= '9'

/** JSON 字符串转义还原:\uXXXX(含代理对)、\n \t \" \\ \/ 。对整段文本宽松应用,
 *  不要求它是合法 JSON —— 我们只关心"这些字节解码后会不会变成真值"。 */
function unescapeJson(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([\\/"'])/g, '$1')
}

/** 百分号解码(容错:坏序列原样保留而不是抛异常) */
function unescapePercent(text) {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => {
    try { return decodeURIComponent(m) } catch { return m }
  })
}

/** 文本里的 base64 片段(标准/URL-safe,≥16 字符)解码出的可打印内容 */
function decodeBase64Runs(text) {
  const out = []
  const re = /[A-Za-z0-9+/_-]{16,}={0,2}/g
  let m
  while ((m = re.exec(text)) !== null) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/')
    try {
      const buf = Buffer.from(run, 'base64')
      if (!buf.length) continue
      const s = buf.toString('utf8')
      // 解出来的东西要"像文本"才值得扫,否则随机二进制只会拖慢
      const printable = (s.match(/[\x20-\x7e -￿]/g) || []).length
      if (printable / s.length >= 0.7) out.push(s)
    } catch { /* 不是 base64,跳过 */ }
  }
  return out
}

/** 二进制体:gzip / zip 容器展开为可扫文本。展不开 → 返回 { opaque: true } 让上层 fail-closed。 */
function expandBinary(buf, depth = 0) {
  const texts = []
  if (!Buffer.isBuffer(buf) || !buf.length || depth > 2) return { texts, opaque: false }

  // gzip
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      const inner = zlib.gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 })
      const sub = expandBinary(inner, depth + 1)
      return { texts: [inner.toString('utf8'), ...sub.texts], opaque: sub.opaque }
    } catch { return { texts, opaque: true } }
  }

  // zip 容器(docx/xlsx/pptx 都是):走本地文件头逐个展开,不依赖中央目录
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    let off = 0, opaque = false
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
      const flags   = buf.readUInt16LE(off + 6)
      const method  = buf.readUInt16LE(off + 8)
      const csize   = buf.readUInt32LE(off + 18)
      const usize   = buf.readUInt32LE(off + 22)
      const nlen    = buf.readUInt16LE(off + 26)
      const xlen    = buf.readUInt16LE(off + 28)
      const dataOff = off + 30 + nlen + xlen
      const encrypted   = (flags & 0x1) !== 0
      const dataDescr   = (flags & 0x8) !== 0          // 长度在数据后:不知道压缩长度,拆不开
      const zip64       = csize === 0xffffffff || usize === 0xffffffff
      if (encrypted || dataDescr || zip64 || dataOff + csize > buf.length) { opaque = true; break }
      const chunk = buf.subarray(dataOff, dataOff + csize)
      try {
        const raw = method === 0 ? chunk
                  : method === 8 ? zlib.inflateRawSync(chunk, { maxOutputLength: 64 * 1024 * 1024 })
                  : null
        if (raw === null) { opaque = true; break }
        const sub = expandBinary(raw, depth + 1)
        texts.push(raw.toString('utf8'), ...sub.texts)
        if (sub.opaque) { opaque = true; break }
      } catch { opaque = true; break }
      off = dataOff + csize
    }
    return { texts, opaque }
  }

  return { texts: [buf.toString('utf8')], opaque: false }
}

/** 一段文本的全部可扫层:原文 + JSON 还原 + 百分号还原 + base64 片段(各自再折宽)。
 *  两轮:base64 里可能又是 JSON 转义的字符串。 */
function layersOf(text) {
  const seen = new Set()
  const out = []
  const push = (s) => { if (typeof s === 'string' && s && !seen.has(s)) { seen.add(s); out.push(s) } }
  let frontier = [String(text)]
  for (let round = 0; round < 2 && frontier.length; round++) {
    const next = []
    for (const t of frontier) {
      push(t)
      const j = unescapeJson(t);    if (j !== t) { push(j); next.push(j) }
      const p = unescapePercent(t); if (p !== t) { push(p); next.push(p) }
      for (const b of decodeBase64Runs(t)) { push(b); next.push(b) }
    }
    frontier = next
  }
  return out
}

// ── 匹配 ────────────────────────────────────────────────────────────────────
function boundaryOk(hay, idx, needle) {
  if (isDigit(needle[0]) && idx > 0 && isDigit(hay[idx - 1])) return false
  const end = idx + needle.length
  if (isDigit(needle[needle.length - 1]) && end < hay.length && isDigit(hay[end])) return false
  return true
}

function findIn(hay, needle) {
  let from = 0
  for (;;) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) return -1
    if (boundaryOk(hay, idx, needle)) return idx
    from = idx + 1
  }
}

// ── 闸门本体 ────────────────────────────────────────────────────────────────
const MIN_LEN = 2   // 折宽后短于此的真值不登记(引擎本就不会产出,这里是防御)

class EgressGate {
  constructor() {
    /** folded original → { label, kind } */
    this.entries = new Map()
  }

  /** 登记真值。幂等;返回本次新增条数。传什么守什么 —— 不做任何"敏感与否"的判断。 */
  register(items) {
    let added = 0
    for (const it of Array.isArray(items) ? items : []) {
      const original = typeof it?.original === 'string' ? it.original : ''
      const key = foldWidth(original.trim())
      if (key.length < MIN_LEN) continue
      if (!this.entries.has(key)) added++
      this.entries.set(key, { label: String(it.label ?? ''), kind: String(it.kind ?? '') })
    }
    return added
  }

  status() { return { active: true, count: this.entries.size } }

  /** 扫一段文本(已是字符串)。命中返回 { label, kind, layer },否则 null。 */
  scanText(text) {
    if (!this.entries.size || !text) return null
    const layers = layersOf(text)
    for (let li = 0; li < layers.length; li++) {
      const hay = foldWidth(layers[li])
      for (const [needle, meta] of this.entries) {
        if (findIn(hay, needle) >= 0) return { ...meta, layer: li }
      }
    }
    return null
  }

  /** 扫一个请求体(Buffer)。二进制先展开;展不开 → 视为命中(fail-closed)。 */
  scanBuffer(buf) {
    if (!this.entries.size || !buf || !buf.length) return null
    const { texts, opaque } = expandBinary(buf)
    for (const t of texts) {
      const hit = this.scanText(t)
      if (hit) return hit
    }
    if (opaque) return { label: '(无法检查的压缩/加密容器)', kind: 'opaque', layer: -1 }
    return null
  }
}

module.exports = { EgressGate, foldWidth, layersOf, expandBinary, unescapeJson, unescapePercent, decodeBase64Runs, boundaryOk }
