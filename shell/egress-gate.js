// egress-gate.js — 壳级出域闸的扫描核心(纯函数,不依赖 Electron,可单测)
//
// 2026-09-23 起因:「签名包 = 承诺锚」被审计打穿 —— 签名壳只有 16KB,脱敏引擎是网页运行时
// 下发的 JS,签名根本没锚住引擎。老板拍板走 A 路线:壳自己做出域闸,网页 JS 被改坏也绕不过
// **这里列出的形态**。同日经 3 视角攻击 + 3 验证者实跑,33 类绕过全部吸收进本文件(见各段注释)。
//
// 边界(写清楚,别让下一个人误以为它做得更多):
//  · 它**不识别**什么是敏感的 —— 那是网页端引擎(redact.ts detectSensitive)的事。
//    它只认「渲染进程通过 IPC 登记过的真值」,做精确串匹配。登记什么、它就守什么。
//  · 它守的是「已登记的真值不得离开本机」,不区分会话:A 会话登记的报价,
//    B 会话(哪怕非保密)的请求里出现同样的串,一样拦。这是有意的 ——
//    按会话放行意味着相信渲染进程报的"当前是哪个会话",而不信任渲染进程正是它存在的理由。
//  · 真值只在主进程内存里,不落盘。App 重启后由渲染进程在装入密表时重新登记。
//  · 它守不住三类形态,这是精确串匹配的本质,不是待修 bug,别往这里堆启发式:
//      ① 分片 —— 真值拆到两个字段/两个请求,任何一层都不存在完整串;
//      ② 语义改写 —— 128.5万 写成 1285000 / 12.85亿 / 一百二十八点五万;
//      ③ 任意自定义编码 —— XOR、自定义字母表、charCode 数组、倒序……解不出即当二进制。
//    这三类要靠别的层(引擎侧不让完整真值进渲染进程内存、上游合同)。
//
// 匹配纪律(与引擎同口径,见 redact.ts〔擎8〕〔擎14〕):
//  · foldWidth:表折叠(全角/阿拉伯-印度/波斯/上下标数字、全角货币符)→ NFKC(带圈数字/数学字母
//    数字等兼容等价)→ 剥离 Cf 格式字符(零宽空格/软连字符/BOM/双向控制)→ 再表折叠。
//    register 与 scan 同一函数,两侧一致。
//  · 数字边界:真值以数字开头/结尾时,命中位置前/后不得紧邻数字 ——
//    '38.5' 不得在 '138.5' 里命中(否则「型号 MG-138.5」这种无辜串会误拦)。
//  · 解码层(每层都扫,最多 5 轮到不动点):JSON/JS 转义(\uXXXX \u{…} \xNN 八进制 \n)、百分号(到不动点)、
//    表单 + 号、HTML 数字/命名实体、Quoted-Printable、base64 串(含被空白切行的)、hex 串(两种对齐)、
//    去空白视图。另加「相位针」:登记时预算真值的 base64/hex 编码串,原文里直接 includes ——
//    短真值的 base64 不足 run 阈值也逃不掉。
//  · 二进制体:gzip / zlib / raw deflate / brotli / zip 容器(以中央目录为准,本地头兜底,
//    未被任何条目覆盖的尾巴字节单独处置)/ multipart 逐 part。定宽编码(UTF-16/32 两种字节序)各解一遍。
//  · fail-closed:加密 zip、zip64、解不开的压缩流、超出展开预算、递归到顶仍非文本 → 当作命中(拦)。

'use strict'

const zlib = require('zlib')

// ── 上限(防 OOM:一个 1MB 的 zip 可以声明 100 个各膨到 64MB 的条目)─────────────
const MAX_INFLATE   = 64 * 1024 * 1024        // 单次解压输出上限
const MAX_BUDGET    = 256 * 1024 * 1024       // 一次 scanBuffer 的展开总预算
const MAX_DEPTH     = 3                        // 容器嵌套深度
const MAX_LAYER_LEN = 48 * 1024 * 1024         // 单层文本超过此长度不再派生解码层
const MAX_ROUNDS    = 5                        // 解码轮数(每轮只把新增层放进下一轮)
const MAX_ENTRIES   = 5000                     // 登记条数上限(超出不静默,status 带 truncated)
const MAX_LABEL     = 64
const MIN_LEN       = 2                        // 折宽后短于此的真值不登记(引擎本就不会产出,这里是防御)
const MIN_PHASE     = 10                       // 相位针最短长度:太短的编码串会撞上无辜的哈希/随机串

// ── 字符折叠(移植自 tokenbridge/src/lib/redact.ts,表折叠部分必须与引擎逐字一致)────
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const SUBSCRIPTS   = '₀₁₂₃₄₅₆₇₈₉'
const PUNCT_MAP    = { '．': '.', '，': ',', '％': '%', '＄': '$', '￡': '£', '￠': '¢', '·': '.', '・': '.', '‧': '.', '˙': '.' }

function foldTable(text) {
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

/** 表折叠 → NFKC → 剥 Cf → 再表折叠。先过一遍表是因为 '˙'(U+02D9)的 NFKC 是「空格+组合点」,
 *  直接先 NFKC 会把它从 PUNCT_MAP 漏掉(攻击线〔编码-12〕)。 */
function foldWidth(text) {
  return foldTable(foldTable(text).normalize('NFKC').replace(/\p{Cf}/gu, ''))
}

// ── 解码层 ──────────────────────────────────────────────────────────────────
const isDigit = ch => ch >= '0' && ch <= '9'
const cp = n => { try { return String.fromCodePoint(n) } catch { return '' } }

/** JS/JSON 字符串转义还原:\u{…}、\uXXXX、\xNN、\NNN 八进制、\n\r\t、\\ \/ \" \' 。
 *  对整段文本宽松应用,不要求它是合法 JSON —— 我们只关心"这些字节解码后会不会变成真值"。 */
function unescapeJson(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-3][0-7]{2}|[0-7]{1,2})(?![0-7])/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c])
    .replace(/\\([\\/"'])/g, '$1')
}

/** 百分号解码到不动点(坏序列原样保留;最多 5 轮防病态输入) */
function unescapePercent(text) {
  let cur = text
  for (let i = 0; i < 5; i++) {
    const next = cur.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => { try { return decodeURIComponent(m) } catch { return m } })
    if (next === cur) break
    cur = next
  }
  return cur
}

/** HTML 数字实体(&#x6052; / &#24658;)与最常见的几个命名实体 */
const NAMED_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function unescapeHtml(text) {
  return text
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => NAMED_ENTITY[n])
}

/** Quoted-Printable:软换行先去,=XX 字节序列 → UTF-8 */
function unescapeQp(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/(?:=[0-9A-Fa-f]{2})+/g, (m) => Buffer.from(m.replace(/=/g, ''), 'hex').toString('utf8'))
}

/** 文本里的 base64 片段(标准/URL-safe,≥16 字符)。不做"像不像文本"过滤 —— 攻击者会掺控制字节压低可打印率
 *  (攻击线〔结构-4〕)。短真值的 base64 不靠这里(靠相位针);被空白切碎的靠去空白视图后再跑这里。
 *  阈值不再往下降:每个 ≥8 位的普通英文单词都会被当 base64 解一遍,只添垃圾层。 */
function decodeBase64Runs(text) {
  const out = []
  const re = /[A-Za-z0-9+/_-]{16,}={0,2}/g
  let m
  while ((m = re.exec(text)) !== null) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/')
    try { const buf = Buffer.from(run, 'base64'); if (buf.length) out.push(buf.toString('utf8')) } catch { /* 不是 base64 */ }
  }
  return out
}

/** 文本里的 hex 片段(≥8 位),两种对齐各解一次(攻击线〔结构-2〕:前置一个 hex 字符即错位) */
function decodeHexRuns(text) {
  const out = []
  const re = /[0-9a-fA-F]{8,}/g
  let m
  while ((m = re.exec(text)) !== null) {
    for (const off of [0, 1]) {
      const h = m[0].slice(off)
      const even = h.length % 2 ? h.slice(0, -1) : h
      if (even.length >= 8) { try { out.push(Buffer.from(even, 'hex').toString('utf8')) } catch { /* skip */ } }
    }
  }
  return out
}

/** 一段文本的全部可扫层。每轮只把**新增**层放进下一轮,seen 集合保证收敛。 */
function layersOf(text) {
  const seen = new Set()
  const out = []
  const push = (s) => {
    if (typeof s !== 'string' || !s || s.length > MAX_LAYER_LEN || seen.has(s)) return false
    seen.add(s); out.push(s); return true
  }
  let frontier = [String(text)]
  push(frontier[0])
  for (let round = 0; round < MAX_ROUNDS && frontier.length; round++) {
    const next = []
    const add = (s) => { if (push(s)) next.push(s) }
    for (const t of frontier) {
      const j = unescapeJson(t);    if (j !== t) add(j)
      const p = unescapePercent(t); if (p !== t) add(p)
      if (t.includes('+')) { const f = unescapePercent(t.replace(/\+/g, ' ')); if (f !== t) add(f) }   // form-urlencoded
      const h = unescapeHtml(t);    if (h !== t) add(h)
      const q = unescapeQp(t);      if (q !== t) add(q)
      for (const b of decodeBase64Runs(t)) add(b)
      if (/\s/.test(t)) {
        const ns = t.replace(/\s+/g, '')
        add(ns)                                                   // 去空白视图:「128.5 万」「恒 康 集 团」
        for (const b of decodeBase64Runs(ns)) add(b)              // MIME 76 列换行切开的 base64
      }
      for (const x of decodeHexRuns(t)) add(x)
    }
    frontier = next
  }
  return out
}

// ── 相位针:真值的 base64 / hex 编码串,原文直接 includes ────────────────────────
// base64 每 3 字节 4 字符:真值前面的字节数不同,编码串不同。三种相位各取"只由真值字节决定"的稳定子串。
function b64Phases(key) {
  const out = new Set()
  const kb = Buffer.from(key, 'utf8')
  for (let pad = 0; pad < 3; pad++) {
    const enc = Buffer.concat([Buffer.alloc(pad, 0x41), kb]).toString('base64').replace(/=+$/, '')
    const a = Math.ceil((8 * pad) / 6)
    const b = Math.floor((8 * (pad + kb.length) - 6) / 6)
    const stable = enc.slice(a, b + 1)
    if (stable.length >= MIN_PHASE) { out.add(stable); out.add(stable.replace(/\+/g, '-').replace(/\//g, '_')) }
  }
  return [...out]
}
function hexPhases(key) {
  const h = Buffer.from(key, 'utf8').toString('hex')
  return h.length >= MIN_PHASE ? [h, h.toUpperCase()] : []
}

// ── 二进制展开(visitor 形式:逐段扫、扫完即丢,不累积;visit 返回 true 即停)─────────
function looksLikeText(buf) {
  const s = buf.toString('utf8')
  if (s.includes('�')) return false
  let ctrl = 0
  for (let i = 0; i < s.length && i < 65536; i++) {
    const c = s.charCodeAt(i)
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++
  }
  return ctrl / Math.min(s.length || 1, 65536) < 0.05
}

/** 定宽非 UTF-8 视图:UTF-16LE/BE、UTF-32LE/BE。解不成合法码点的视图直接跳过。 */
function wideViews(buf) {
  const out = []
  if (buf.length >= 4 && buf.length % 2 === 0) {
    out.push(buf.toString('utf16le'))
    out.push(Buffer.from(buf).swap16().toString('utf16le'))
  }
  if (buf.length >= 8 && buf.length % 4 === 0) {
    for (const le of [true, false]) {
      let s = '', ok = true
      for (let i = 0; i < buf.length; i += 4) {
        const n = le ? buf.readUInt32LE(i) : buf.readUInt32BE(i)
        if (n > 0x10ffff) { ok = false; break }
        s += String.fromCodePoint(n)
      }
      if (ok) out.push(s)
    }
  }
  return out
}

/** multipart/form-data 自描述:体以 --boundary 开头。拆成 [{headers, body}];不像 multipart 返回 null。 */
function splitMultipart(buf) {
  if (buf.length < 4 || buf[0] !== 0x2d || buf[1] !== 0x2d) return null
  const eol = buf.indexOf('\r\n')
  if (eol < 3 || eol > 200) return null
  const boundary = buf.subarray(0, eol).toString('latin1')
  if (!/^--[A-Za-z0-9'()+_,\-./:=? ]+$/.test(boundary)) return null
  const parts = []
  let pos = eol + 2
  const sep = Buffer.from('\r\n' + boundary, 'latin1')
  for (;;) {
    const hdrEnd = buf.indexOf('\r\n\r\n', pos)
    if (hdrEnd < 0) break
    const headers = buf.subarray(pos, hdrEnd).toString('utf8')
    const bodyStart = hdrEnd + 4
    const next = buf.indexOf(sep, bodyStart)
    const body = buf.subarray(bodyStart, next < 0 ? buf.length : next)
    parts.push({ headers, body })
    if (next < 0) break
    pos = next + sep.length
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break     // 结束标记 --
    pos += 2                                                   // 跳过 \r\n
  }
  return parts.length ? parts : null
}

function tryInflate(fn, buf, budget) {
  try {
    const out = fn(buf, { maxOutputLength: Math.max(1, Math.min(MAX_INFLATE, budget.left)) })
    budget.left -= out.length
    return out
  } catch { return null }
}

/**
 * 展开一个二进制体,对每段可扫文本调 visit(text)。visit 返回 true 表示"命中,别扫了"。
 * 返回 { opaque, stopped }。opaque = 存在解不开/不该放行的部分(fail-closed 由上层决定)。
 */
function expandBinary(buf, visit, depth = 0, budget = { left: MAX_BUDGET }) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { opaque: false, stopped: false }
  if (budget.left <= 0) return { opaque: true, stopped: false }
  if (depth > MAX_DEPTH) return { opaque: !looksLikeText(buf), stopped: false }   // 到顶还是压缩体 → 拦;是文本 → 放
  const V = (s) => visit(s) === true
  const recurse = (inner) => expandBinary(inner, visit, depth + 1, budget)
  const emitText = () => { if (V(buf.toString('utf8'))) return true; for (const w of wideViews(buf)) if (V(w)) return true; return false }

  // multipart:逐 part —— part 头(filename= 可带真值)当文本扫,part 体递归
  const parts = splitMultipart(buf)
  if (parts) {
    let opaque = false
    for (const p of parts) {
      if (V(p.headers)) return { opaque, stopped: true }
      const r = recurse(p.body)
      if (r.stopped) return { opaque: opaque || r.opaque, stopped: true }
      opaque = opaque || r.opaque
    }
    return { opaque, stopped: false }
  }

  // gzip
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const inner = tryInflate(zlib.gunzipSync, buf, budget)
    return inner ? recurse(inner) : { opaque: true, stopped: false }
  }
  // zlib 流(RFC 1950,Content-Encoding: deflate 的规范形态)
  if (buf.length >= 2 && buf[0] === 0x78 && ((buf[0] << 8) | buf[1]) % 31 === 0) {
    const inner = tryInflate(zlib.inflateSync, buf, budget)
    return inner ? recurse(inner) : { opaque: true, stopped: false }
  }
  // zip 容器(docx/xlsx/pptx)
  if (buf.length >= 30 && buf.readUInt32LE(0) === 0x04034b50) return expandZip(buf, visit, depth, budget)

  // 无魔数:先当文本扫(UTF-8 + 定宽视图)
  if (emitText()) return { opaque: false, stopped: true }
  if (looksLikeText(buf)) return { opaque: false, stopped: false }
  // 不像文本:机会式解 raw deflate / brotli(攻击线〔容器-1/3〕)。解开 → 递归;都解不开 → 当二进制放行
  for (const fn of [zlib.inflateRawSync, zlib.brotliDecompressSync]) {
    const inner = tryInflate(fn, buf, budget)
    if (inner && inner.length) return recurse(inner)
  }
  return { opaque: false, stopped: false }
}

/** zip:以中央目录为准(本地头会撒谎,攻击线〔容器-6〕),没有中央目录再走本地头;
 *  不被任何条目/结构覆盖的尾巴字节单独处置:是文本就扫,不是文本就 opaque。 */
function expandZip(buf, visit, depth, budget) {
  const V = (s) => visit(s) === true
  const recurse = (inner) => expandBinary(inner, visit, depth + 1, budget)
  const covered = []
  let opaque = false

  const handleEntry = (localOff, method, flags, csize, usize) => {
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) { opaque = true; return false }
    const nlen = buf.readUInt16LE(localOff + 26), xlen = buf.readUInt16LE(localOff + 28)
    const dataOff = localOff + 30 + nlen + xlen
    if ((flags & 0x1) || csize === 0xffffffff || usize === 0xffffffff || dataOff + csize > buf.length) { opaque = true; return false }
    covered.push([localOff, dataOff + csize])
    const chunk = buf.subarray(dataOff, dataOff + csize)
    let raw = null
    if (method === 0) raw = chunk
    else if (method === 8) raw = tryInflate(zlib.inflateRawSync, chunk, budget)
    if (!raw) { opaque = true; return false }
    const r = recurse(raw)
    opaque = opaque || r.opaque
    return !r.stopped
  }

  // 找 EOCD(从尾部往前,最多 64KB+22 的注释区)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd >= 0) {
    const total = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16)
    if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff || cdOff + cdSize > eocd) return { opaque: true, stopped: false }
    // EOCD 只覆盖它自己(22 字节 + 注释);EOCD 之后再有字节就是"追加物",归尾巴处置,不能一笔画进 covered
    const commentLen = buf.readUInt16LE(eocd + 20)
    covered.push([cdOff, cdOff + cdSize], [eocd, Math.min(buf.length, eocd + 22 + commentLen)])
    let p = cdOff
    for (let i = 0; i < total; i++) {
      if (p + 46 > cdOff + cdSize || buf.readUInt32LE(p) !== 0x02014b50) return { opaque: true, stopped: false }
      const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10)
      const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24)
      const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32)
      const localOff = buf.readUInt32LE(p + 42)
      if (!handleEntry(localOff, method, flags, csize, usize)) return { opaque, stopped: !opaque }
      p += 46 + nlen + xlen + clen
    }
  } else {
    // 没有中央目录:本地头顺序走
    let off = 0
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
      const flags = buf.readUInt16LE(off + 6), method = buf.readUInt16LE(off + 8)
      const csize = buf.readUInt32LE(off + 18), usize = buf.readUInt32LE(off + 22)
      if (flags & 0x8) return { opaque: true, stopped: false }          // 长度在数据后:拆不开
      if (!handleEntry(off, method, flags, csize, usize)) return { opaque, stopped: !opaque }
      off = covered[covered.length - 1][1]
    }
  }

  // 尾巴/缝隙:任何未被覆盖的字节区间 —— 文本就扫,非文本就 opaque(攻击线〔容器-6〕真值追加在后)
  covered.sort((a, b) => a[0] - b[0])
  let cursor = 0
  for (const [s, e] of covered) {
    if (s > cursor + 4) { const r = recurse(buf.subarray(cursor, s)); if (r.stopped) return { opaque, stopped: true }; opaque = opaque || r.opaque || !looksLikeText(buf.subarray(cursor, s)) }
    cursor = Math.max(cursor, e)
  }
  if (buf.length > cursor + 4) { const t = buf.subarray(cursor); const r = recurse(t); if (r.stopped) return { opaque, stopped: true }; opaque = opaque || r.opaque || !looksLikeText(t) }
  return { opaque, stopped: false }
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
class EgressGate {
  constructor() {
    this.entries = new Map()   // folded original → { label, kind }
    this.phases  = new Map()   // 相位针(base64/hex 编码串)→ { label, kind }
    this.truncated = false
  }

  /** 登记真值。幂等;返回本次新增条数。传什么守什么 —— 不做任何"敏感与否"的判断。 */
  register(items) {
    let added = 0
    for (const it of Array.isArray(items) ? items : []) {
      const original = typeof it?.original === 'string' ? it.original : ''
      const key = foldWidth(original.trim())
      if (key.length < MIN_LEN) continue
      if (!this.entries.has(key)) {
        if (this.entries.size >= MAX_ENTRIES) { this.truncated = true; console.warn('[egress] 登记条数超上限,后续忽略'); break }
        added++
      }
      const kind = String(it.kind ?? '').slice(0, 32)
      let label = String(it.label ?? '').slice(0, MAX_LABEL)
      // label 由渲染进程任意提供:若与真值互含,label 本身就会泄真值到日志/通知 → 换成 kind
      const fl = foldWidth(label)
      if (fl && (fl.includes(key) || key.includes(fl))) label = kind || '(已登记)'
      const meta = { label, kind }
      this.entries.set(key, meta)
      for (const ph of [...b64Phases(key), ...hexPhases(key)]) this.phases.set(ph, meta)
    }
    return added
  }

  clear() { this.entries.clear(); this.phases.clear(); this.truncated = false }

  status() { return { active: true, count: this.entries.size, truncated: this.truncated } }

  /** 扫一段文本。命中返回 { label, kind, layer },否则 null。 */
  scanText(text) {
    if (!this.entries.size || !text) return null
    const layers = layersOf(text)
    for (let li = 0; li < layers.length; li++) {
      const raw = layers[li]
      for (const [needle, meta] of this.phases) if (raw.includes(needle)) return { ...meta, layer: li }
      const hay = foldWidth(raw)
      for (const [needle, meta] of this.entries) if (findIn(hay, needle) >= 0) return { ...meta, layer: li }
    }
    return null
  }

  /** 扫请求头(名+值)。 */
  scanHeaders(headers) {
    if (!this.entries.size || !headers) return null
    const lines = Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    return this.scanText(lines.join('\n'))
  }

  /** 扫一个请求体(Buffer)。二进制先展开;展不开 → 视为命中(fail-closed)。 */
  scanBuffer(buf) {
    if (!this.entries.size || !buf || !buf.length) return null
    let hit = null
    const r = expandBinary(buf, (t) => { hit = this.scanText(t); return hit !== null })
    if (hit) return hit
    if (r.opaque) return { label: '(无法检查的压缩/加密容器)', kind: 'opaque', layer: -1 }
    return null
  }
}

/** 测试用:把一个体展开成文本数组(有上限),不用于生产路径。 */
function collectTexts(buf, cap = 200) {
  const texts = []
  const r = expandBinary(buf, (t) => { texts.push(t); return texts.length >= cap })
  return { texts, opaque: r.opaque }
}

module.exports = {
  EgressGate, foldWidth, layersOf, expandBinary, collectTexts, splitMultipart, looksLikeText,
  unescapeJson, unescapePercent, unescapeHtml, unescapeQp, decodeBase64Runs, decodeHexRuns, wideViews,
  b64Phases, hexPhases, boundaryOk,
}
