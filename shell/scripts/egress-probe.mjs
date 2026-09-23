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
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'bayze-egress-probe-'))
const PORT = 9333 + Math.floor(Math.random() * 500)
const electronBin = path.join(SHELL, 'node_modules/.bin/electron')
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: SHELL, stdio: ['ignore', 'pipe', 'pipe'] })
let mainLog = ''
child.stdout.on('data', d => { mainLog += d })
child.stderr.on('data', d => { mainLog += d })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function getPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const pg = list.find(t => t.type === 'page' && /lanwealth\.com/.test(t.url))
      if (pg) return pg
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error('page target not found; log:\n' + mainLog)
}

let failures = 0
const expect = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : String(got).includes(want)
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✖'} ${name.padEnd(34)} ${got}`)
}

try {
  const pg = await getPage()
  console.log('page:', pg.url)
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const pending = new Map()
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const cdp = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
  async function evalIn(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return 'THREW ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }

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
  expect('干净 POST → 放行', await evalIn(post(`JSON.stringify({ q: '⟦客户-KX⟧ 138.5万' })`)), 'ALLOWED')
  expect('干净 GET → 放行', await evalIn(`window.__try(() => fetch(location.origin + '/api/app-config'))`), 'ALLOWED status=200')
  const beaconBefore = await evalIn(`window.__blocked.length`)
  await evalIn(`navigator.sendBeacon(location.origin + '/api/app-config', '${SECRET}')`)
  await sleep(1500)
  expect('sendBeacon 含真值(看通知数+1)', await evalIn(`window.__blocked.length`) - beaconBefore, v => v === 1)
  const blocked = await evalIn(`JSON.stringify(window.__blocked)`)
  expect('被拦通知条数', JSON.parse(blocked).length, v => v === 13)   // 12 条 fetch/XHR/ws 型 + 1 条 beacon
  expect('通知只带 label/kind/method/path', JSON.parse(blocked).every(i => Object.keys(i).sort().join() === 'kind,label,method,path'), v => v === true)
  expect('通知里无真值', blocked.includes(SECRET) ? 'LEAK' : 'clean', 'clean')
  expect('主进程日志无真值', mainLog.includes(SECRET) ? 'LEAK' : 'clean', 'clean')
  expect('主进程日志有拦截记录', (mainLog.match(/\[egress\] 已拦截/g) || []).length, v => v >= 13)
  ws.close()
} finally {
  child.kill('SIGTERM')
  await sleep(800)
  fs.rmSync(UD, { recursive: true, force: true })
}
console.log(failures ? `\n✖ ${failures} 项不符` : '\n✔ 全部符合预期')
process.exit(failures ? 1 : 0)
