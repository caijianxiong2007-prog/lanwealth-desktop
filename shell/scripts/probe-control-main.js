// 探针的**阳性对照**壳:没有出域闸、没有 PAC 黑洞、没有 WebRTC 策略的最小 Electron 主进程。
// 只给 scripts/egress-probe.mjs 用 —— 先用它证明"观察者端口 + 页面脚本"真的看得见 STUN/TURN/WebTransport 的流量,
// 再用真正的 main.js 跑同一段脚本看它们归零。没有这一步,"归零"和"根本没测到"分不开(自我印证=没验证)。
// ⚠️ 不打进正式包(package.json build.files 只带 main/preload/egress-gate/assets)。
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  w.loadURL('https://fast.lanwealth.com/api/app-config')
})
