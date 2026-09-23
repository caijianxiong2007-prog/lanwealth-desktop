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

test('IPC 三通道齐全:secret:register → gate.register;secret:status → gate.status;secret:active → secretActive', () => {
  assert.match(mainCode, /ipcMain\.handle\('secret:register'[^\n]*gate\.register\(/)
  assert.match(mainCode, /ipcMain\.handle\('secret:status'[^\n]*gate\.status\(\)/)
  assert.match(mainCode, /ipcMain\.handle\('secret:active'[^\n]*secretActive\s*=\s*!!/)
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
  for (const ev of ['will-navigate', 'will-redirect']) {
    const h = between(mainCode, `on('${ev}'`, '\n  })')
    assert.ok(h.includes('isAllowedOrigin(url)'), `${ev} 没做 origin 判定`)
    assert.ok(h.includes('event.preventDefault()'), `${ev} 没 preventDefault`)
    assert.ok(h.includes('safeOpenExternal(url)'), `${ev} 没走 safeOpenExternal`)
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
