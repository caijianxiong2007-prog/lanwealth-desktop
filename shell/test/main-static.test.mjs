// 壳侧静态看守:读 main.js / preload.js / package.json / build/* 的源文本,守住出域闸的接线与加固项。
// 跑法:npm test。纪律:每条守卫都要"能红" —— 写完一条就故意破坏对应源码看它红不红(探针结果记在 commit message)。
// 注释先剥掉再看(codeOf):注释里写着 "will-redirect" 不算接了线。末尾有 codeOf 自身的阳性对照。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read  = f => fs.readFileSync(path.join(SHELL, f), 'utf8')

// ── 剥注释(保留字符串/模板/正则字面量原样)───────────────────────────────
export function codeOf(src) {
  const n = src.length
  let i = 0
  let out = ''
  const lastSig = () => { for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k]; return '' }
  const regexAllowed = p => p === '' || '(,=:[!&|?{};+-*%<>~^'.includes(p)

  function readString(q) {
    out += q; i++
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2 } else { out += src[i++] }
    }
    if (i < n) out += src[i++]
  }
  function readTemplate() {
    out += '`'; i++
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (src[i] === '$' && src[i + 1] === '{') { out += '${'; i += 2; readCode(true); continue }
      out += src[i++]
    }
    if (i < n) out += src[i++]
  }
  function readRegex() {
    let j = i + 1, inClass = false
    while (j < n) {
      const ch = src[j]
      if (ch === '\\') { j += 2; continue }
      if (ch === '\n') break
      if (inClass) { if (ch === ']') inClass = false }
      else if (ch === '[') inClass = true
      else if (ch === '/') break
      j++
    }
    out += src.slice(i, j + 1); i = j + 1
  }
  function readCode(untilBrace) {
    let depth = 0
    while (i < n) {
      const c = src[i], d = src[i + 1]
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
      if (c === "'" || c === '"') { readString(c); continue }
      if (c === '`') { readTemplate(); continue }
      if (c === '/' && regexAllowed(lastSig())) { readRegex(); continue }
      if (untilBrace) {
        if (c === '{') depth++
        else if (c === '}') { if (depth === 0) { out += c; i++; return } depth-- }
      }
      out += c; i++
    }
  }
  readCode(false)
  return out
}

const between = (code, from, to) => {
  const a = code.indexOf(from)
  assert.ok(a >= 0, `源码里找不到 ${from}`)
  const b = to ? code.indexOf(to, a + from.length) : -1
  return code.slice(a, b < 0 ? undefined : b)
}

const mainCode  = codeOf(read('main.js'))
const preCode   = codeOf(read('preload.js'))
const fusesCode = codeOf(read('build/fuses.js'))
const pkg       = JSON.parse(read('package.json'))
const ents      = read('build/entitlements.mac.plist')

// ── A. 出域闸接线 ──────────────────────────────────────────────────────────
test('onBeforeRequest 挂在 <all_urls> 上,且在处理器里调用 gate.scanText 与 gate.scanBuffer', () => {
  const h = between(mainCode, 'onBeforeRequest(', 'onBeforeSendHeaders(')
  assert.match(h, /urls:\s*\[\s*'<all_urls>'\s*\]/)
  assert.ok(h.includes('gate.scanText('),   'URL 没扫')
  assert.ok(h.includes('gate.scanBuffer('), '请求体没扫')
  assert.ok(h.includes('uploadData'),       '没遍历 uploadData')
  assert.ok(h.includes('getBlobData('),     'blob 体没取出来扫')
  assert.ok(h.includes('readFile('),        'file 体没读出来扫')
})

test('onBeforeRequest:快路径(未登记真值时直接放行)在任何扫描之前', () => {
  const h = between(mainCode, 'onBeforeRequest(', 'onBeforeSendHeaders(')
  const fast = h.indexOf('gate.status().count === 0')
  assert.ok(fast >= 0, '没有快路径')
  assert.ok(fast < h.indexOf('gate.scanText('), '快路径必须先于扫描')
})

test('onBeforeRequest:ws:/wss: 一律取消(webRequest 看不见帧,fail-closed)', () => {
  const h = between(mainCode, 'onBeforeRequest(', 'onBeforeSendHeaders(')
  assert.ok(h.includes('/^wss?:/i'), '没有 ws/wss 判定')
  assert.match(h, /wss\?:[\s\S]{0,120}block\(/, 'ws 命中后没有走 block')
})

test('onBeforeRequest:处理器异常时 catch 分支取消请求(fail-closed)', () => {
  const h = between(mainCode, 'onBeforeRequest(', 'onBeforeSendHeaders(')
  assert.match(h, /catch\s*\([^)]*\)\s*\{[^}]*cancel:\s*true/, 'catch 里没有 cancel: true')
})

test('onBeforeRequest:超过 32MB 的上传文件视为 opaque 命中', () => {
  const h = between(mainCode, 'onBeforeRequest(', 'onBeforeSendHeaders(')
  assert.match(mainCode, /MAX_SCAN_FILE\s*=\s*32\s*\*\s*1024\s*\*\s*1024/)
  assert.match(h, /size\s*>\s*MAX_SCAN_FILE[\s\S]{0,80}kind:\s*'opaque'/)
})

test('onBeforeSendHeaders:登记非空时请求头含 content-encoding → 取消', () => {
  const h = between(mainCode, 'onBeforeSendHeaders(', 'function installPermissionPolicy')
  assert.match(h, /urls:\s*\[\s*'<all_urls>'\s*\]/)
  assert.match(h, /toLowerCase\(\)\s*===\s*'content-encoding'/, '没有对请求头名做 content-encoding 比对(kind 标签里出现同名字符串不算)')
  assert.ok(h.includes('cancel: true'), '命中后没取消')
})

test('闸门在开窗之前装好(窗口的第一个请求就在闸后)', () => {
  const ready = between(mainCode, 'app.whenReady()', "app.on('window-all-closed'")
  const gateAt = ready.indexOf('installEgressGate()')
  const winAt  = ready.indexOf('createWindow(')
  assert.ok(gateAt >= 0 && winAt >= 0)
  assert.ok(gateAt < winAt, 'installEgressGate 必须在 createWindow 之前')
  assert.ok(ready.includes('installPermissionPolicy()'), '权限策略没装')
})

test('IPC 四通道齐全:secret:register → gate.register;secret:status → gate.status;secret:active → secretActive;secret:clear → gate.clear', () => {
  assert.match(mainCode, /ipcMain\.handle\('secret:register'[\s\S]{0,120}gate\.register\(/)
  assert.match(mainCode, /ipcMain\.handle\('secret:status'[\s\S]{0,120}gate\.status\(/)
  assert.match(mainCode, /ipcMain\.handle\('secret:active'[\s\S]{0,120}secretActive\s*=/)
  assert.match(mainCode, /ipcMain\.handle\('secret:clear'[\s\S]{0,160}gate\.clear\(\)[\s\S]{0,80}secretActive\s*=\s*false/)
})

test('换线冻结:did-fail-load 里先看 secretActive,为 true 时弹框给「重试当前线路」「仍然换线」', () => {
  const h = between(mainCode, "'did-fail-load'", "'did-finish-load'")
  assert.ok(h.includes('if (secretActive)'), '没看 secretActive')
  assert.ok(h.includes('dialog.showMessageBox('), '没弹框')
  assert.ok(h.includes("'重试当前线路'") && h.includes("'仍然换线'"), '按钮文案不对')
  // 判定在自动换线动作之前
  assert.ok(h.indexOf('if (secretActive)') < h.indexOf('switched = true'), '冻结判定必须先于换线')
})

test('真值不外泄:secret:blocked 通知对象只含 label/kind/method/path,不含 original/value', () => {
  const sends = [...mainCode.matchAll(/send\(\s*'secret:blocked'\s*,\s*\{([^}]*)\}/g)]
  assert.equal(sends.length, 1, 'secret:blocked 的 send 应恰好一处(找不到说明通知没接、或形状变了看守失效)')
  const body = sends[0][1]
  assert.doesNotMatch(body, /\b(original|value|needle|entries)\b/, '通知对象里出现了真值字段')
  for (const k of ['label', 'kind', 'method', 'path']) assert.match(body, new RegExp(`\\b${k}\\b`))
  // console.warn 那行同样不能带真值
  const warn = between(mainCode, 'function notifyBlocked', 'const asBuffer')
  assert.doesNotMatch(warn, /hit\.(original|value)/)
})

// ── B. 加固 ────────────────────────────────────────────────────────────────
test('每个 ipcMain.handle 后 40 字符内出现 assertTrustedSender(含既有 know:*)', () => {
  const calls = [...mainCode.matchAll(/ipcMain\.handle\(/g)]
  assert.ok(calls.length >= 8, `handler 数量异常:${calls.length}(know×5 + secret×3)`)
  for (const m of calls) {
    const head = mainCode.slice(m.index + m[0].length, m.index + m[0].length + 40 + 'assertTrustedSender'.length)
    const at = head.indexOf('assertTrustedSender')
    assert.ok(at >= 0 && at <= 40, `handler 未先验发送方:${mainCode.slice(m.index, m.index + 60)}`)
  }
})

test('assertTrustedSender:按 senderFrame.url 的 origin 对 ALLOWED_ORIGINS 判定,不在则 throw', () => {
  const f = between(mainCode, 'function assertTrustedSender', '\n}\n')
  assert.ok(f.includes('senderFrame'))
  assert.ok(f.includes('ALLOWED_ORIGINS.has('))
  assert.ok(f.includes('throw '))
})

test('will-redirect 与 will-navigate 同一套 origin 判定:外域 preventDefault + 外开', () => {
  const nav = between(mainCode, "'will-navigate'", "'will-redirect'")
  const red = between(mainCode, "'will-redirect'", 'buildMenu()')
  assert.ok(nav.includes('isAllowedOrigin(url)'), 'will-navigate 没做 origin 判定')
  // will-redirect 用 details 形式(Electron 44:位置参数已 deprecated),判定函数必须是同一个 isAllowedOrigin
  assert.ok(red.includes('isAllowedOrigin(details.url)'), 'will-redirect 没做 origin 判定')
  for (const [name, h] of [['will-navigate', nav], ['will-redirect', red]]) {
    assert.ok(h.includes('preventDefault()'), `${name} 外域没 preventDefault`)
    assert.ok(h.includes('safeOpenExternal('), `${name} 外域没交给 safeOpenExternal`)
  }
})

test('openExternal 只经 safeOpenExternal 一处,且 scheme 白名单 = http/https/mailto', () => {
  const uses = [...mainCode.matchAll(/shell\.openExternal\(/g)]
  assert.equal(uses.length, 1, 'shell.openExternal 应只在 safeOpenExternal 内出现一次')
  const f = between(mainCode, 'function safeOpenExternal', '\n}\n')
  assert.ok(f.includes('shell.openExternal('))
  assert.ok(f.includes('EXTERNAL_SCHEMES.has('))
  assert.match(mainCode, /EXTERNAL_SCHEMES\s*=\s*new Set\(\[\s*'http:',\s*'https:',\s*'mailto:'\s*\]\)/)
})

test('webPreferences: devTools: !app.isPackaged,且 sandbox/contextIsolation 仍开、nodeIntegration 仍关', () => {
  const wp = between(mainCode, 'webPreferences: {', '\n    }')
  assert.match(wp, /devTools:\s*!app\.isPackaged/)
  assert.match(wp, /sandbox:\s*true/)
  assert.match(wp, /contextIsolation:\s*true/)
  assert.match(wp, /nodeIntegration:\s*false/)
})

test('权限:setPermissionRequestHandler 与 setPermissionCheckHandler 都装,只放行两项剪贴板且限自家源', () => {
  assert.ok(mainCode.includes('setPermissionRequestHandler('))
  assert.ok(mainCode.includes('setPermissionCheckHandler('))
  assert.match(mainCode, /CLIPBOARD_PERMS\s*=\s*new Set\(\[\s*'clipboard-read',\s*'clipboard-sanitized-write'\s*\]\)/)
  const f = between(mainCode, 'function installPermissionPolicy', '\n}\n')
  const decisions = [...f.matchAll(/CLIPBOARD_PERMS\.has\(permission\)\s*&&\s*isAllowedOrigin\(/g)]
  assert.equal(decisions.length, 2, '两个处理器都必须是 "剪贴板项 && 自家源" 的与判定')
})

test('entitlements:已删 disable-library-validation 与 allow-dyld-environment-variables,保留 allow-jit 与 unsigned-executable-memory', () => {
  assert.ok(!ents.includes('disable-library-validation'))
  assert.ok(!ents.includes('allow-dyld-environment-variables'))
  assert.ok(ents.includes('com.apple.security.cs.allow-jit'))
  assert.ok(ents.includes('com.apple.security.cs.allow-unsigned-executable-memory'))
})

test('package.json:electron ≥ 44、electron-builder ≥ 26、@electron/fuses 在列;afterPack 指向 fuses;files 含 egress-gate.js', () => {
  const major = s => Number(String(s).replace(/^[\^~]/, '').split('.')[0])
  assert.ok(major(pkg.devDependencies.electron) >= 44, `electron=${pkg.devDependencies.electron}`)
  assert.ok(major(pkg.devDependencies['electron-builder']) >= 26)
  assert.ok(pkg.devDependencies['@electron/fuses'])
  assert.equal(pkg.build.afterPack, 'build/fuses.js')
  for (const f of ['main.js', 'preload.js', 'egress-gate.js']) assert.ok(pkg.build.files.includes(f), `files 缺 ${f}`)
  assert.ok(pkg.scripts.test.startsWith('node --test'))
})

test('build/fuses.js:六个 fuse 值正确', () => {
  const want = {
    RunAsNode: 'false',
    EnableCookieEncryption: 'true',
    EnableNodeOptionsEnvironmentVariable: 'false',
    EnableNodeCliInspectArguments: 'false',
    EnableEmbeddedAsarIntegrityValidation: 'true',
    OnlyLoadAppFromAsar: 'true',
  }
  for (const [k, v] of Object.entries(want)) {
    assert.match(fusesCode, new RegExp(`\\[FuseV1Options\\.${k}\\]:\\s*${v}\\b`), `${k} 应为 ${v}`)
  }
  assert.ok(fusesCode.includes('flipFuses('))
  assert.ok(fusesCode.includes('FuseVersion.V1'))
})

test('preload:secretEgress 暴露 register/status/setActive/onBlocked,onBlocked 订阅 secret:blocked', () => {
  const s = between(preCode, 'secretEgress: {', '\n  },')
  assert.match(s, /register:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\('secret:register'/)
  assert.match(s, /status:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('secret:status'\)/)
  assert.match(s, /setActive:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\('secret:active'/)
  assert.match(s, /onBlocked:[\s\S]*ipcRenderer\.on\('secret:blocked'/)
  assert.ok(s.includes('removeListener'), 'onBlocked 要能退订')
})

test('preload 调用的每个 invoke 通道在 main 都有 handle,反之亦然', () => {
  const invoked = new Set([...preCode.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]))
  const handled = new Set([...mainCode.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]))
  assert.deepEqual([...invoked].sort(), [...handled].sort())
  for (const ch of ['secret:register', 'secret:status', 'secret:active']) assert.ok(handled.has(ch), ch)
})

test('preload 文件头注释写明锁的是 fast + app 两个源', () => {
  const head = read('preload.js').split('\n').slice(0, 12).join('\n')
  assert.ok(head.includes('fast.lanwealth.com') && head.includes('app.lanwealth.com'))
})

// ── 阳性对照:codeOf 真的在剥注释,且没把字符串/正则/模板里的东西当注释剥掉 ─────────
test('阳性对照:codeOf 剥掉行注释与块注释', () => {
  assert.equal(codeOf('a // will-redirect\nb'), 'a \nb')
  assert.equal(codeOf('a /* will-redirect */ b'), 'a  b')
  assert.ok(!codeOf(read('main.js')).includes('大陆裸线实测'), 'main.js 顶部那段注释应被剥掉')
  assert.ok(read('main.js').includes('大陆裸线实测'), '前提:原文里确实有这段注释')
})

test('阳性对照:codeOf 保留字符串里的 // 与正则字符类里的 / 和 "', () => {
  assert.equal(codeOf("const u = 'https://x' // c"), "const u = 'https://x' ")
  assert.equal(codeOf(`s.replace(/[/\\\\:*?"<>|]+/g, '_') // z`), `s.replace(/[/\\\\:*?"<>|]+/g, '_') `)
  assert.equal(codeOf('a = b / c // d\ne = f / g'), 'a = b / c \ne = f / g')
})

test('阳性对照:codeOf 保留模板字面量内容(含嵌套 ${} 与像注释的文本)', () => {
  const src = 'x(`/* css */ a ${m ? `/* inner */ b` : \'\'} c`) // tail'
  assert.equal(codeOf(src), 'x(`/* css */ a ${m ? `/* inner */ b` : \'\'} c`) ')
  assert.ok(codeOf(read('main.js')).includes('/* Thin scrollbars'), 'insertCSS 模板里的 CSS 注释是内容,不能剥')
})

test('阳性对照:between 找不到起点会抛(否则上面的切片守卫会在切不到时静默通过)', () => {
  assert.throws(() => between('abc', 'zzz', 'c'))
})

// ── F. 2026-09-23 对抗评审(壳侧 11 条)后补的守卫 ───────────────────────────────
test('请求头也过闸:onBeforeSendHeaders 里调用 gate.scanHeaders,且整段在 try/catch 内 fail-closed(评审 high-1)', () => {
  const h = between(mainCode, 'onBeforeSendHeaders(', 'onHeadersReceived(')
  assert.ok(h.includes('gate.scanHeaders('), '请求头没扫:自定义头 / Cookie 带真值会直接出域')
  assert.match(h, /try\s*\{[\s\S]*gate\.scanHeaders\([\s\S]*catch\s*\([^)]*\)\s*\{[^}]*cancel:\s*true/, '扫头不在 try/catch 内或 catch 没取消')
})

test('外开 URL 先过闸:safeOpenExternal 函数体内 shell.openExternal 之前调用 gate.scanText(评审 high-2)', () => {
  const f = between(mainCode, 'function safeOpenExternal(', 'function assertTrustedSender(')
  const scan = f.indexOf('gate.scanText('), open = f.indexOf('shell.openExternal(')
  assert.ok(scan >= 0, 'window.open 外域带真值这条路没过闸')
  assert.ok(open >= 0 && scan < open, '扫描必须在 openExternal 之前')
  assert.ok(f.includes("method: 'EXTERNAL'"), '外开被拦也要通知')
})

test('WebTransport / WebRTC:不靠任何命令行开关(2026-09-23 实测全部无效),靠 PAC 黑洞;无效开关不得再出现', () => {
  assert.ok(!/appendSwitch\('disable-quic'\)/.test(mainCode), '--disable-quic 实测关不掉 WebTransport,只会把自家源降到 h2')
  assert.ok(!/disable-blink-features[^\n]*WebTransport/.test(mainCode), 'disable-blink-features=WebTransport 实测不删 API')
  assert.ok(!/disable-features[^\n]*(WebTransport|WebRTC)/.test(mainCode), 'disable-features=WebTransport/WebRTC 实测无效')
  assert.ok(mainCode.includes('async function installNetworkAllowlist('), '封这两条通道的是 PAC 黑洞')
})

test('网络白名单:EXTRA_ALLOWED_HOSTS 含 Supabase 主机(登录 / 存储直传 / 媒体签名 URL 都从浏览器直连它)', () => {
  const list = between(mainCode, 'const EXTRA_ALLOWED_HOSTS = [', ']')
  assert.ok(list.includes("'umpwmtciqxthmyzpymhu.supabase.co'"), '缺 Supabase 主机 = 桌面版登录都登不上')
  assert.ok(!/lanwealth\.com/.test(list), '自家源来自 BASES,别在这里重复')
})

test('WebRTC:不再注入 CSP webrtc 指令(Chromium 152 报 Unrecognized directive,实测装饰性)', () => {
  assert.ok(!mainCode.includes("webrtc 'block'"), 'CSP webrtc 指令无效,留着就是假承诺')
  assert.ok(!mainCode.includes('onHeadersReceived('), '删掉指令后 onHeadersReceived 也不该留空壳')
})

test('WebRTC:窗口在第一次 loadURL 之前设 disable_non_proxied_udp(砍 UDP 路;TCP/TLS 中继由 PAC 管)', () => {
  const w = between(mainCode, 'function createWindow(', 'function buildMenu(')
  const pol = w.indexOf("setWebRTCIPHandlingPolicy('disable_non_proxied_udp')"), load = w.indexOf('loadURL(')
  assert.ok(pol >= 0, '没设 WebRTC 策略')
  assert.ok(load >= 0 && pol < load, '策略必须在第一次 loadURL 之前')
})

test('网络白名单 PAC 黑洞:默认返回 PROXY 127.0.0.1:1,白名单主机按系统代理决议走', () => {
  const f = between(mainCode, 'async function installNetworkAllowlist(', 'function installPermissionPolicy(')
  assert.ok(mainCode.includes("const BLACKHOLE = 'PROXY 127.0.0.1:1'"), '黑洞代理常量不对')
  assert.match(f, /return \$\{JSON\.stringify\(BLACKHOLE\)\}; \}/, 'PAC 的兜底 return 必须是黑洞')
  assert.match(f, /for \(const host of ALLOWED_HOSTS\)/, '白名单没进 PAC')
  assert.match(f, /resolver\.resolveProxy\(`https:\/\/\$\{host\}\/`\)/, '白名单主机要按系统代理决议(公司代理环境不能断)')
  assert.match(f, /session\.fromPartition\('bayze-proxy-resolver'\)/, '决议必须在独立 session 做:defaultSession 装了 PAC 之后 resolveProxy 只会回 PAC 的结果')
  assert.ok(!/session\.defaultSession\.resolveProxy/.test(f), '不能用 defaultSession 决议')
  assert.match(f, /session\.defaultSession\.setProxy\(\{ mode: 'pac_script'/, 'PAC 要装到 defaultSession')
  assert.ok(f.includes("if (!/^[A-Za-z0-9 .:;\\[\\]_-]+$/.test(decision)) decision = 'DIRECT'"), '决议串要过字符白名单再拼进脚本')
})

test('网络白名单:主机集 = BASES 的主机 + EXTRA_ALLOWED_HOSTS,且启动时 PAC 先于开窗、换线前重写', () => {
  assert.match(mainCode, /const ALLOWED_HOSTS = new Set\(\[\s*\.\.\.BASES\.map\(b => new URL\(b\)\.hostname\),[\s\S]{0,300}?\.\.\.EXTRA_ALLOWED_HOSTS,\s*\]\)/)
  assert.match(mainCode, /const EXTRA_ALLOWED_HOSTS = \[/)
  const ready = between(mainCode, 'app.whenReady().then(', "app.on('window-all-closed'")
  const pac = ready.indexOf('await installNetworkAllowlist()'), win = ready.indexOf('createWindow(')
  assert.ok(pac >= 0 && win >= 0 && pac < win, 'PAC 黑洞必须先于第一个请求(createWindow 之前 await)')
  const fail = between(mainCode, "'did-fail-load'", "'did-finish-load'")
  const re = fail.indexOf('await installNetworkAllowlist()'), sw = fail.indexOf('loadURL(chatUrl(other)')
  assert.ok(re >= 0 && sw >= 0 && re < sw, '换线前要按当前系统代理重写 PAC')
})

test('正式包拒绝远程调试开关:isPackaged 且 hasSwitch(remote-debugging-port/pipe) → app.exit(评审 medium-6)', () => {
  assert.match(mainCode, /app\.isPackaged[\s\S]{0,200}remote-debugging-port[\s\S]{0,120}remote-debugging-pipe[\s\S]{0,120}hasSwitch\([\s\S]{0,60}app\.exit\(1\)/)
})

test('上传体三条路都套 32MB 上限:blob / file / bytes(评审 medium-5)', () => {
  const h = between(mainCode, 'onBeforeRequest(', 'onBeforeSendHeaders(')
  assert.match(h, /getBlobData\([^)]*\)[\s\S]{0,80}buf\.length > MAX_SCAN_FILE/, 'blob 没限大小:页面构造 1GB Blob 直接读进主进程')
  assert.match(h, /st\.size > MAX_SCAN_FILE/, 'file 没限大小')
  assert.match(h, /buf = part\.bytes[\s\S]{0,60}buf\.length > MAX_SCAN_FILE/, 'bytes 没限大小')
})

test('secretActive 有复位路径:主帧换页(did-start-navigation isMainFrame && !isSameDocument)归零(评审 medium-7)', () => {
  assert.match(mainCode, /'did-start-navigation'[\s\S]{0,160}isMainFrame && !d\.isSameDocument[\s\S]{0,40}secretActive = false/)
})

test('will-redirect 只管主帧(评审 low-9):用 details.isMainFrame 提前返回,判定仍走 isAllowedOrigin', () => {
  const h = between(mainCode, "'will-redirect'", 'buildMenu()')
  assert.match(h, /if \(!details\.isMainFrame\) return/)
  assert.ok(h.includes('isAllowedOrigin(details.url)'))
})

test('preload 暴露 clear 且 main 有对应 handle(secret:clear)', () => {
  assert.match(preCode, /clear:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('secret:clear'\)/)
  assert.ok(mainCode.includes("ipcMain.handle('secret:clear'"))
})

test('承诺措辞收口:main.js 不再写「怎么改都绕不过」这种全称句(评审 medium-4)', () => {
  const src = read('main.js')
  assert.ok(!src.includes('怎么改都绕不过'), '全称承诺要改成"列出的形态"')
  assert.ok(src.includes('守不住分片、语义改写和任意自定义编码'), '要把守不住的三类写在承诺旁边')
})
