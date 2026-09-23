// 壳级出域闸 · 扫描核心自检。跑法:npm test(node --test,零依赖)
// 纪律:每组守卫都有一条"能让它红"的对照 —— 拆掉不会红的守卫等于装饰。
// 2026-09-23 攻击线(3 视角 × 实跑验证)确认的每一类绕过,这里都有对应用例;用例名里标了来源。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  EgressGate, foldWidth, boundaryOk, collectTexts, layersOf, splitMultipart, b64Phases, hexPhases,
} = require('../egress-gate.js')

const gate = (...originals) => {
  const g = new EgressGate()
  g.register(originals.map(o => ({ original: o, label: '金额', kind: 'money' })))
  return g
}
const hit  = (g, text) => g.scanText(text) !== null
const bhit = (g, buf)  => g.scanBuffer(buf) !== null
const esc  = s => s.replace(/[一-鿿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))

// ── zip 构造:完整(本地头 + 中央目录 + EOCD)与仅本地头两种 ────────────────────
function zipParts(entries, { encrypted = false, method = 8, lieCsize = null } = {}) {
  const locals = [], cds = []
  let off = 0
  for (const [name, content] of entries) {
    const raw  = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw
    const nameB = Buffer.from(name, 'utf8')
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(encrypted ? 1 : 0, 6)
    h.writeUInt16LE(method, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22)
    h.writeUInt16LE(nameB.length, 26); h.writeUInt16LE(0, 28)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(encrypted ? 1 : 0, 8); c.writeUInt16LE(method, 10)
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameB.length, 28)
    c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt32LE(off, 42)
    locals.push(h, nameB, data); cds.push(c, nameB)
    off += 30 + nameB.length + data.length
    if (lieCsize !== null) h.writeUInt32LE(lieCsize, 18)   // 本地头撒谎(中央目录仍是真的)
  }
  const cd = Buffer.concat(cds)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10)
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16)
  return { locals: Buffer.concat(locals), cd, eocd: e }
}
const makeZip      = (entries, opts) => { const p = zipParts(entries, opts); return Buffer.concat([p.locals, p.cd, p.eocd]) }
const makeZipLocal = (entries, opts) => zipParts(entries, opts).locals

// ═══ ① 字符折叠(与引擎同口径 + 攻击线加的 NFKC / Cf)═════════════════════════
test('foldWidth:全角/阿拉伯-印度/波斯/上下标数字与全角标点全部折成 ASCII', () => {
  assert.equal(foldWidth('１２８．５万'), '128.5万')
  assert.equal(foldWidth('۴۵۰'), '450')
  assert.equal(foldWidth('３８·５'), '38.5')
  assert.equal(foldWidth('¹⁸％'), '18%')
  assert.equal(foldWidth('ＭＧ-１００'), 'MG-100')
  assert.equal(foldWidth('38˙5'), '38.5')                    // '˙' 必须在 NFKC 之前进表(攻击线〔编码-12〕)
})
test('foldWidth:NFKC 兼容等价(带圈/数学粗体数字)与 Cf 格式字符(零宽/软连字符/BOM)—— 攻击线〔编码-1/2/12/13〕', () => {
  assert.equal(foldWidth('③⑧.⑤'), '38.5')
  assert.equal(foldWidth('𝟑𝟖.𝟓'), '38.5')
  assert.equal(foldWidth('恒​康‍集­团﻿'), '恒康集团')
  assert.equal(foldWidth('1​2​8.5万'), '128.5万')
})

// ═══ ② 登记 ═══════════════════════════════════════════════════════════════
test('register:幂等、按折宽后去重、返回新增数、过短不登记', () => {
  const g = new EgressGate()
  assert.equal(g.register([{ original: '128.5万' }, { original: '１２８．５万' }]), 1)
  assert.equal(g.register([{ original: '128.5万' }]), 0)
  assert.equal(g.register([{ original: '7' }, { original: ' ' }, { original: '' }]), 0)
  assert.equal(g.status().count, 1)
  assert.equal(g.register([{ original: '恒康集团', label: '客户', kind: 'entity' }]), 1)
  assert.equal(g.status().count, 2)
  g.clear(); assert.equal(g.status().count, 0)
})
test('register:label 与真值互含时换成 kind —— 否则 label 本身把真值带进日志/通知(评审 low-8)', () => {
  const g = new EgressGate()
  g.register([{ original: '恒康集团', label: '恒康集团', kind: 'entity' }, { original: '128.5万', label: '报价128.5万元', kind: 'money' }])
  assert.equal(g.scanText('x 恒康集团 y').label, 'entity')
  assert.equal(g.scanText('x 128.5万 y').label, 'money')
})
test('register:条数上限 5000,超出不静默(status.truncated)', () => {
  const g = new EgressGate()
  const many = Array.from({ length: 5200 }, (_, i) => ({ original: `真值编号${i}`, label: 'x', kind: 'x' }))
  g.register(many)
  assert.equal(g.status().count, 5000)
  assert.equal(g.status().truncated, true)
})

// ═══ ③ 明文 ═══════════════════════════════════════════════════════════════
test('scanText:真值原样出现即命中;不在则放行;空登记表放行一切', () => {
  const g = gate('128.5万', '恒康集团')
  assert.ok(hit(g, '{"messages":[{"content":"这批货报价 128.5万"}]}'))
  assert.ok(hit(g, '给恒康集团的报价单'))
  assert.ok(!hit(g, '{"messages":[{"content":"这批货报价 ⟦金额-KX⟧"}]}'))
  assert.ok(!hit(g, ''))
  assert.ok(!hit(new EgressGate(), '128.5万 恒康集团'))
})
test('scanText:请求体是全角/波斯/中点写法也命中', () => {
  const g = gate('38.5')
  assert.ok(hit(g, '单价 ３８．５ 元')); assert.ok(hit(g, '单价 ۳۸.۵ 元')); assert.ok(hit(g, '单价 38·5 元'))
})
test('scanHeaders:头名+头值一起扫(评审 high-1:自定义头 / Cookie 带真值)', () => {
  const g = gate('恒康集团')
  assert.ok(g.scanHeaders({ 'x-note': encodeURIComponent('恒康集团') }) !== null)
  assert.ok(g.scanHeaders({ cookie: 'probe=' + encodeURIComponent('恒康集团') + '; a=b' }) !== null)
  assert.equal(g.scanHeaders({ accept: 'application/json', cookie: 'sb=abc' }), null)
})

// ═══ ④ 数字边界 ═══════════════════════════════════════════════════════════
test('数字边界:38.5 不得在 138.5 / 38.51 里命中,但 38.5元 与 "38.5" 要命中', () => {
  const g = gate('38.5')
  assert.ok(!hit(g, '型号 MG-138.5')); assert.ok(!hit(g, '数值 38.51'))
  assert.ok(hit(g, '单价 38.5元/台')); assert.ok(hit(g, '{"v":"38.5"}')); assert.ok(hit(g, '38.5'))
})
test('阳性对照:boundaryOk 本身必须有能力判否 —— 否则上面那条恒真', () => {
  assert.equal(boundaryOk('138.5', 1, '38.5'), false)
  assert.equal(boundaryOk('x38.5y', 1, '38.5'), true)
  assert.equal(boundaryOk('恒康集团2024', 0, '恒康集团'), true)
})

// ═══ ⑤ 文本编码层(攻击线确认的每一类)════════════════════════════════════════
test('JSON \\uXXXX / \\u{…} / \\xNN / 八进制 / \\n 转义 —— 攻击线〔编码-9/10/11〕', () => {
  const g = gate('恒康集团', '38.5', '128.5万')
  assert.ok(hit(g, esc(JSON.stringify({ c: '恒康集团' }))))
  assert.ok(hit(g, '{"c":"\\u{6052}\\u{5eb7}\\u{96c6}\\u{56e2}"}'))
  assert.ok(hit(g, '{"v":"\\x33\\x38\\x2e\\x35"}'))
  assert.ok(hit(g, '{"v":"\\063\\070\\056\\065"}'))
  assert.ok(hit(g, '{"c":"128.5\\u4e07"}'))
})
test('百分号编码:单层 / 三层嵌套 / 表单 + 号 —— 攻击线〔编码-14〕〔结构-5〕', () => {
  const g = gate('恒康集团', '128.5 万')
  assert.ok(hit(g, '/api/search?q=' + encodeURIComponent('恒康集团 报价')))
  let triple = '恒康集团'; for (let i = 0; i < 3; i++) triple = encodeURIComponent(triple)
  assert.ok(!triple.includes('恒康')); assert.ok(hit(g, 'q=' + triple))
  assert.ok(hit(g, 'v=128.5+%E4%B8%87'))                                  // + 当空格 → "128.5 万"
})
test('HTML 数字实体(十六进制/十进制)—— 攻击线〔编码-5/6〕', () => {
  const g = gate('恒康集团')
  assert.ok(hit(g, '<p>&#x6052;&#x5eb7;&#x96c6;&#x56e2;</p>'))
  assert.ok(hit(g, '&#24658;&#24247;&#38598;&#22242;'))
})
test('Quoted-Printable(含软换行)—— 攻击线〔编码-7〕', () => {
  const g = gate('恒康集团')
  const qp = [...Buffer.from('恒康集团')].map(b => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join('')
  assert.ok(hit(g, 'body: ' + qp))
  assert.ok(hit(g, 'body: ' + qp.slice(0, 12) + '=\r\n' + qp.slice(12)))
})
test('base64:整段 / URL-safe / 掺控制字节 / 每 8 字符换行切块 / base64 套 JSON 转义 —— 攻击线〔编码-8〕〔结构-4〕', () => {
  const g = gate('恒康集团')
  const b64 = Buffer.from('客户是恒康集团,报价见附件').toString('base64')
  assert.ok(hit(g, `{"payload":"${b64}"}`))
  assert.ok(hit(g, 'data=' + Buffer.from('客户是恒康集团').toString('base64url')))
  const noisy = Buffer.from('\x01\x02\x03\x04\x05\x06\x07\x08恒康集团\x01\x02\x03\x04\x05\x06\x07\x08').toString('base64')
  assert.ok(hit(g, noisy))
  const chunked = b64.match(/.{1,8}/g).join('\n')
  assert.ok(hit(g, chunked))
  const nested = Buffer.from(esc(JSON.stringify({ c: '恒康集团' }))).toString('base64')
  assert.ok(hit(g, nested))
})
test('短真值的 base64(编码后不足 run 阈值 16)靠相位针命中 —— 攻击线〔结构-3〕', () => {
  const g = gate('恒康厂')                                                  // 9 字节 → base64 12 字符,run 解码层够不着
  for (const pad of ['', 'a', 'ab']) {
    const b64 = Buffer.from(pad + '恒康厂').toString('base64')
    assert.ok(b64.replace(/=+$/, '').length < 16, `前提:${b64} 的字母串短于 run 阈值(正则不数 = 填充),只有相位针能抓`)
    assert.ok(hit(g, 'k=' + b64), `pad=${pad}`)
  }
  assert.ok(b64Phases('恒康厂').length >= 3)
  assert.equal(b64Phases('38').length, 0)                                  // 太短不下针(会撞无辜哈希)
})
test('hex 编码(两种对齐)—— 攻击线〔结构-2〕', () => {
  const g = gate('恒康集团')
  const h = Buffer.from('恒康集团').toString('hex')
  assert.ok(hit(g, `{"h":"${h}"}`)); assert.ok(hit(g, `{"h":"${h.toUpperCase()}"}`))
  assert.ok(hit(g, `{"h":"0${h}"}`))                                       // 前置一个 hex 字符错位(相位针是子串,照样命中)
  assert.ok(hexPhases('恒康集团').length === 2 && hexPhases('38').length === 0)
  // 相位针只认真值本身的 hex;hex 里再套一层 JSON 转义,只有 run 解码层能抓 —— 这条让 decodeHexRuns 承重
  const nested = Buffer.from(esc(JSON.stringify({ c: '恒康集团' }))).toString('hex')
  assert.ok(!nested.includes(h), '前提:嵌套后不再含真值的直接 hex')
  assert.ok(hit(g, `{"h":"${nested}"}`)); assert.ok(hit(g, `{"h":"f${nested}"}`))
})
test('真值中间插空白 / 零宽 / 软连字符 —— 评审 medium-4 与攻击线〔编码-1/2〕', () => {
  const g = gate('128.5万', '恒康集团')
  assert.ok(hit(g, '报价 128.5 万')); assert.ok(hit(g, '恒 康 集 团'))
  assert.ok(hit(g, '恒​康​集​团')); assert.ok(hit(g, '恒­康集团'))
})
test('阳性对照:layersOf 对无编码文本只给一层;去空白视图不会凭空造字', () => {
  assert.deepEqual(layersOf('plaintext42'), ['plaintext42'])
})

// ═══ ⑥ 二进制体 ═══════════════════════════════════════════════════════════
test('gzip / zlib / raw deflate / brotli 请求体展开后命中 —— 攻击线〔容器-1/2/3〕〔编码-15〕', () => {
  const g = gate('128.5万')
  // 体要真的被压缩:短文本压缩器常直接存字面量,utf8 视图就能看到真值,那样这条测的就不是解压。
  const filler = 'lorem ipsum dolor sit amet, '.repeat(200)
  const body = Buffer.from(`{"filler":"${filler}","content":"报价 128.5万","tail":"${filler}"}`)
  for (const [name, fn] of [['gzip', zlib.gzipSync], ['zlib', zlib.deflateSync], ['raw', zlib.deflateRawSync], ['brotli', zlib.brotliCompressSync]]) {
    const z = fn(body)
    assert.ok(!z.toString('utf8').includes('128.5万') && !z.toString('latin1').includes('128.5'), `前提:${name} 压缩后字面不可见`)
    assert.ok(bhit(g, z), name)
  }
  assert.ok(!bhit(g, zlib.gzipSync(Buffer.from(`{"filler":"${filler}","content":"报价 ⟦金额-KX⟧"}`))))
})
test('UTF-16LE/BE 与 UTF-32LE/BE 请求体 —— 攻击线〔编码-3/4〕〔容器-9〕', () => {
  const g = gate('恒康集团')
  assert.ok(bhit(g, Buffer.from('{"c":"恒康集团"}', 'utf16le')))
  assert.ok(bhit(g, Buffer.from('{"c":"恒康集团"}', 'utf16le').swap16()))
  const u32 = Buffer.alloc(4 * 4); [...'恒康集团'].forEach((ch, i) => u32.writeUInt32LE(ch.codePointAt(0), i * 4))
  assert.ok(bhit(g, u32))
})
test('zip 容器:deflate 与 stored 条目、条目内 UTF-16 XML 都命中;干净 docx 放行', () => {
  const g = gate('128.5万')
  assert.ok(bhit(g, makeZip([['word/document.xml', '<w:t>报价 128.5万</w:t>'], ['[Content_Types].xml', '<Types/>']])))
  assert.ok(bhit(g, makeZip([['a.txt', '报价 128.5万']], { method: 0 })))
  assert.ok(bhit(g, makeZip([['d.xml', Buffer.from('<t>报价 128.5万</t>', 'utf16le')]])))
  assert.equal(g.scanBuffer(makeZip([['word/document.xml', '<w:t>报价 ⟦金额-KX⟧</w:t>']])), null)
})
test('zip:本地头 csize 撒谎、真值在中央目录指向的位置 → 以中央目录为准仍命中 —— 攻击线〔容器-6〕', () => {
  const g = gate('128.5万')
  const z = makeZip([['a.txt', '报价 128.5万']], { lieCsize: 2 })
  assert.ok(bhit(g, z))
})
test('zip:真值以明文追加在合法 zip 之后 → 尾巴当文本扫到;追加不可解二进制 → opaque', () => {
  const g = gate('128.5万')
  const clean = makeZip([['a.txt', '无关']])
  assert.ok(bhit(g, Buffer.concat([clean, Buffer.from('\n报价 128.5万')])))
  const r = g.scanBuffer(Buffer.concat([clean, Buffer.from([0x00, 0xff, 0x13, 0x37, 0x80, 0x81, 0x82, 0x83])]))
  assert.equal(r?.kind, 'opaque')
})
test('zip 无中央目录(仅本地头)仍逐条展开', () => {
  const g = gate('128.5万')
  assert.ok(bhit(g, makeZipLocal([['a.txt', '报价 128.5万']])))
})
test('fail-closed:加密 zip、未知压缩法、坏 gzip 一律判 opaque', () => {
  const g = gate('任意真值')
  assert.equal(g.scanBuffer(makeZip([['a.txt', '无关']], { encrypted: true }))?.kind, 'opaque')
  assert.equal(g.scanBuffer(makeZip([['a.txt', '无关']], { method: 99 }))?.kind, 'opaque')
  assert.equal(g.scanBuffer(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage')]))?.kind, 'opaque')
})
test('fail-closed:嵌套超过深度上限仍是压缩体 → opaque;到顶是干净文本 → 放行 —— 攻击线〔容器-4〕', () => {
  const g = gate('128.5万')
  let deep = Buffer.from('报价 128.5万'); for (let i = 0; i < 6; i++) deep = zlib.gzipSync(deep)
  assert.equal(g.scanBuffer(deep)?.kind, 'opaque')
  let clean = Buffer.from('报价 ⟦金额-KX⟧'); for (let i = 0; i < 3; i++) clean = zlib.gzipSync(clean)
  assert.equal(g.scanBuffer(clean), null)
})
test('fail-closed:展开总预算(256MB)—— 20 个各膨 20MB 的条目 → opaque,而非 OOM(评审 medium-5)', () => {
  const g = gate('任意真值')
  const big = Buffer.alloc(20 * 1024 * 1024, 0x20)
  const bomb = makeZip(Array.from({ length: 20 }, (_, i) => [`e${i}.txt`, big]))
  assert.ok(bomb.length < 1024 * 1024, '前提:炸弹本身很小')
  assert.equal(g.scanBuffer(bomb)?.kind, 'opaque')
})
test('阳性对照:登记表为空时 opaque 也放行(闸门没有可守的东西时不得误伤上传)', () => {
  assert.equal(new EgressGate().scanBuffer(makeZip([['a.txt', 'x']], { encrypted: true })), null)
})
test('multipart:文件 part 里的 docx、part 头里的 filename= 都命中;干净 multipart 放行 —— 攻击线〔容器-5〕', () => {
  const g = gate('128.5万', '恒康集团')
  const B = '----WebKitFormBoundaryXYZ'
  const mp = (name, fname, body) => Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    body, Buffer.from(`\r\n--${B}--\r\n`)])
  assert.ok(bhit(g, mp('f', 'a.docx', makeZip([['word/document.xml', '<w:t>报价 128.5万</w:t>']]))))
  assert.ok(bhit(g, mp('f', '恒康集团报价.txt', Buffer.from('无关'))))
  assert.equal(g.scanBuffer(mp('f', 'a.txt', Buffer.from('干净 ⟦金额-KX⟧'))), null)
  assert.ok(splitMultipart(mp('f', 'a.txt', Buffer.from('x'))).length === 1)
  assert.equal(splitMultipart(Buffer.from('not multipart')), null)
})
test('collectTexts:普通 UTF-8 文本原样可见、不 opaque', () => {
  const r = collectTexts(Buffer.from('hello 世界'))
  assert.equal(r.texts[0], 'hello 世界'); assert.equal(r.opaque, false)
})

// ═══ ⑦ 不误伤 ═════════════════════════════════════════════════════════════
test('不误伤:时间戳/模型名/token 数/hex 哈希/随机 base64 不会撞上 "18%" "128.5万" "38.5"', () => {
  const g = gate('18%', '128.5万', '38.5')
  const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1800, ts: 1789527812846, temp: 0.185, id: 'c-18a',
    sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', blob: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC7' })
  assert.equal(g.scanText(body), null)
  assert.equal(g.scanBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])), null)   // PNG 头
})
