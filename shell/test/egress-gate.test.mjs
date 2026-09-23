// 壳级出域闸 · 扫描核心自检。跑法:npm test(node --test,零依赖)
// 纪律:每组守卫都有一条"能让它红"的对照 —— 拆掉不会红的守卫等于装饰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { EgressGate, foldWidth, boundaryOk, expandBinary, layersOf } = require('../egress-gate.js')

const gate = (...originals) => {
  const g = new EgressGate()
  g.register(originals.map(o => ({ original: o, label: '金额', kind: 'money' })))
  return g
}
const hit = (g, text) => g.scanText(text) !== null

// ── 最小 zip 构造(本地文件头 + 可选 deflate),供容器测试 ──────────────────────
function makeZip(entries, { encrypted = false, method = 8 } = {}) {
  const parts = []
  for (const [name, content] of entries) {
    const raw  = Buffer.from(content, 'utf8')
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw
    const nameB = Buffer.from(name, 'utf8')
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(encrypted ? 0x1 : 0, 6)
    h.writeUInt16LE(method, 8)
    h.writeUInt32LE(0, 10); h.writeUInt32LE(0, 14)
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22)
    h.writeUInt16LE(nameB.length, 26); h.writeUInt16LE(0, 28)
    parts.push(h, nameB, data)
  }
  return Buffer.concat(parts)
}

// ── ① 字符折叠与引擎同口径 ──────────────────────────────────────────────────
test('foldWidth:全角/阿拉伯-印度/波斯/上下标数字与全角标点全部折成 ASCII', () => {
  assert.equal(foldWidth('１２８．５万'), '128.5万')
  assert.equal(foldWidth('٣٨٫٥'), '38٫5')          // 阿拉伯小数分隔符不在引擎折叠表里,保持一致
  assert.equal(foldWidth('۴۵۰'), '450')
  assert.equal(foldWidth('３８·５'), '38.5')
  assert.equal(foldWidth('¹⁸％'), '18%')
  assert.equal(foldWidth('₁₂₈'), '128')
  assert.equal(foldWidth('ＭＧ-１００'), 'MG-100')
})

// ── ② 登记 ────────────────────────────────────────────────────────────────
test('register:幂等、按折宽后去重、返回新增数、过短不登记', () => {
  const g = new EgressGate()
  assert.equal(g.register([{ original: '128.5万' }, { original: '１２８．５万' }]), 1)  // 全角与半角同一条
  assert.equal(g.register([{ original: '128.5万' }]), 0)
  assert.equal(g.register([{ original: '7' }, { original: ' ' }, { original: '' }]), 0)  // 短于 MIN_LEN
  assert.equal(g.status().count, 1)
  assert.equal(g.register([{ original: '恒康集团', label: '客户', kind: 'entity' }]), 1)
  assert.equal(g.status().count, 2)
})

// ── ③ 明文命中与不命中 ────────────────────────────────────────────────────
test('scanText:真值原样出现即命中;不在则放行;空登记表放行一切', () => {
  const g = gate('128.5万', '恒康集团')
  assert.ok(hit(g, '{"messages":[{"content":"这批货报价 128.5万"}]}'))
  assert.ok(hit(g, '给恒康集团的报价单'))
  assert.ok(!hit(g, '{"messages":[{"content":"这批货报价 ⟦金额-KX⟧"}]}'))
  assert.ok(!hit(g, ''))
  assert.ok(!hit(new EgressGate(), '128.5万 恒康集团'))
})

test('scanText:请求体是全角/波斯数字也命中(折宽后比)', () => {
  const g = gate('38.5')
  assert.ok(hit(g, '单价 ３８．５ 元'))
  assert.ok(hit(g, '单价 ۳۸.۵ 元'))
  assert.ok(hit(g, '单价 38·5 元'))
})

// ── ④ 数字边界(〔擎8〕) ───────────────────────────────────────────────────
test('数字边界:38.5 不得在 138.5 / 38.51 里命中,但 38.5元 与 "38.5" 要命中', () => {
  const g = gate('38.5')
  assert.ok(!hit(g, '型号 MG-138.5'))
  assert.ok(!hit(g, '数值 38.51'))
  assert.ok(hit(g, '单价 38.5元/台'))
  assert.ok(hit(g, '{"v":"38.5"}'))
  assert.ok(hit(g, '38.5'))
})
test('阳性对照:boundaryOk 本身必须有能力判否 —— 否则上面那条恒真', () => {
  assert.equal(boundaryOk('138.5', 1, '38.5'), false)
  assert.equal(boundaryOk('x38.5y', 1, '38.5'), true)
  assert.equal(boundaryOk('38.5', 0, '38.5'), true)
  // 以字母收尾的真值不受数字边界约束(实体名):恒康集团 后面紧跟数字也要命中
  assert.equal(boundaryOk('恒康集团2024', 0, '恒康集团'), true)
})

// ── ⑤ 编码层:网页 JS 被改坏后最先会试的几手 ────────────────────────────────
test('JSON \\uXXXX 转义的真值命中', () => {
  const g = gate('恒康集团', '128.5万')
  const esc = JSON.stringify({ c: '恒康集团' }).replace(/[一-鿿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  assert.ok(!esc.includes('恒康集团'), '前提:原文里确实看不到明文')
  assert.ok(hit(g, esc))
  assert.ok(hit(g, '{"c":"128.5\\u4e07"}'))   // 万 = 万
})

test('百分号编码的真值命中(URL 查询串出域)', () => {
  const g = gate('恒康集团', '128.5万')
  const q = '/api/search?q=' + encodeURIComponent('恒康集团 报价')
  assert.ok(!q.includes('恒康集团'))
  assert.ok(hit(g, q))
  assert.ok(hit(g, '?v=' + encodeURIComponent('128.5万')))
})

test('base64 包裹的真值命中;base64 里再套 JSON 转义也命中(两轮)', () => {
  const g = gate('恒康集团')
  const b64 = Buffer.from('客户是恒康集团,报价见附件').toString('base64')
  assert.ok(!b64.includes('恒康集团'))
  assert.ok(hit(g, `{"payload":"${b64}"}`))
  const url64 = Buffer.from('客户是恒康集团').toString('base64url')
  assert.ok(hit(g, `data=${url64}`))
  const nested = Buffer.from(JSON.stringify({ c: '恒康集团' }).replace(/[一-鿿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16))).toString('base64')
  assert.ok(hit(g, nested))
})

test('阳性对照:layersOf 对无编码文本只给一层 —— 挂了说明解码层在凭空造字', () => {
  assert.deepEqual(layersOf('plain text 42'), ['plain text 42'])
})

// ── ⑥ 二进制体:gzip / zip 容器 / 不可拆 fail-closed ───────────────────────
test('gzip 请求体展开后命中', () => {
  const g = gate('128.5万')
  const gz = zlib.gzipSync(Buffer.from('{"content":"报价 128.5万"}'))
  assert.ok(g.scanBuffer(gz) !== null)
  assert.ok(g.scanBuffer(zlib.gzipSync(Buffer.from('{"content":"报价 ⟦金额-KX⟧"}'))) === null)
})

test('zip 容器(docx 形态):deflate 与 stored 两种条目内的真值都命中', () => {
  const g = gate('128.5万')
  const docx = makeZip([['word/document.xml', '<w:t>报价 128.5万</w:t>'], ['[Content_Types].xml', '<Types/>']])
  assert.ok(g.scanBuffer(docx) !== null)
  const stored = makeZip([['a.txt', '报价 128.5万']], { method: 0 })
  assert.ok(g.scanBuffer(stored) !== null)
  const clean = makeZip([['word/document.xml', '<w:t>报价 ⟦金额-KX⟧</w:t>']])
  assert.equal(g.scanBuffer(clean), null)
})

test('fail-closed:加密 zip、未知压缩法、坏 deflate 一律判命中(opaque)', () => {
  const g = gate('任意真值')
  const enc = makeZip([['a.txt', '无关内容']], { encrypted: true })
  assert.equal(g.scanBuffer(enc)?.kind, 'opaque')
  const weird = makeZip([['a.txt', '无关内容']], { method: 99 })
  assert.equal(g.scanBuffer(weird)?.kind, 'opaque')
  const badGz = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage')])
  assert.equal(g.scanBuffer(badGz)?.kind, 'opaque')
})
test('阳性对照:登记表为空时 opaque 也放行(闸门没有可守的东西时不得误伤上传)', () => {
  const g = new EgressGate()
  assert.equal(g.scanBuffer(makeZip([['a.txt', 'x']], { encrypted: true })), null)
})

test('gzip 套 zip、zip 套 gzip 都展得开', () => {
  const g = gate('128.5万')
  const inner = makeZip([['d.xml', '报价 128.5万']])
  assert.ok(g.scanBuffer(zlib.gzipSync(inner)) !== null)
  const zipOfGz = makeZip([['blob.gz', zlib.gzipSync(Buffer.from('报价 128.5万')).toString('latin1')]], { method: 0 })
  // stored 条目里放 gzip 字节:makeZip 走 utf8 会破坏字节,这里直接手拼
  const gzB = zlib.gzipSync(Buffer.from('报价 128.5万'))
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(0, 8)
  h.writeUInt32LE(gzB.length, 18); h.writeUInt32LE(gzB.length, 22); h.writeUInt16LE(1, 26)
  assert.ok(g.scanBuffer(Buffer.concat([h, Buffer.from('g'), gzB])) !== null)
  void zipOfGz
})

test('expandBinary:普通 UTF-8 文本原样返回、不 opaque', () => {
  const r = expandBinary(Buffer.from('hello 世界'))
  assert.deepEqual(r, { texts: ['hello 世界'], opaque: false })
})

// ── ⑦ 不误伤:常见 JSON 结构值不该撞上登记的报价 ────────────────────────────
test('不误伤:时间戳/模型名/token 数不会撞上 "18%" 或 "128.5万"', () => {
  const g = gate('18%', '128.5万', '38.5')
  const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1800, ts: 1789527812846, temp: 0.185, id: 'c-18a' })
  assert.equal(g.scanText(body), null)
})
