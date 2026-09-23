const { app, BrowserWindow, Menu, shell, nativeTheme, session, ipcMain, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')
const { EgressGate } = require('./egress-gate')

nativeTheme.themeSource = 'dark'

// ── 线路候选:快车道优先,主域兜底 ─────────────────────────────────────────
//
// 2026-09-21 大陆裸线实测(同样 18 个静态资源 ≈1MB,两条路**交替**采样):
//   fast(Cloudflare 橙云)   8.9 / 9.0 / 10.5 / 15.1 秒
//   app (灰云直连 Vercel)   35.9 / 63.3 / 63.3 / 97.9 秒
// 快 4~7 倍,而且抖动小得多。橙云还绕到了阿姆斯特丹(cf-ray …-AMS)——
// 绕半个地球还快 4 倍,说明 Vercel 那条 sin1 路在大陆是真的差。
//
// ⚠️ **但不能只留橙云。** 09-10 在福建电信实测,同一个橙云开关是 **0/5 全死**,
//    而灰云 6/6。这个开关**按 ISP 变**,失败模式是「完全打不开」而不是「变慢」。
//    所以两条都留着、启动时探测谁通用谁 —— 让「该选哪条」这个问题不必回答。
//
// ⚠️ 换线 = 换 origin = **换 cookie 作用域**。Supabase 会话是 cookie 且没设 domain,
//    所以换线之后用户要**重新登录一次**。因此探到的线路会记在 userData 优先复用,
//    不要每次启动都重新挑。
const BASES = [
  'https://fast.lanwealth.com',   // Cloudflare 橙云:多数线路快 4~7 倍,个别 ISP 会整段阻断
  'https://app.lanwealth.com',    // 灰云直连 Vercel 新段:慢,但实测过的线路上没断过
]
const ALLOWED_ORIGINS = new Set(BASES.map(b => new URL(b).origin))
const FALLBACK_BASE   = BASES[BASES.length - 1]   // 全探不通时回落到它,让错误正常暴露

// 企业版用户主用桌面端 → 加载完整工作台(对话/知识库/企业管理/图片/视频全功能),
// 不再用阉割版独立聊天页;网页感元素(Home/Download/角标)由下方注入 CSS 隐藏。
const chatUrl   = base => `${base}/dashboard/chat`
const isMac     = process.platform === 'darwin'
const isWin     = process.platform === 'win32'

let mainWindow
let currentBase = FALLBACK_BASE

// ── 信任边界:同源判定 / 外链 scheme / IPC 发送方 ───────────────────────────
function isAllowedOrigin(url) {
  try { return ALLOWED_ORIGINS.has(new URL(url).origin) } catch { return false }
}

// 只把 http/https/mailto 交给系统浏览器;其余 scheme(file:/javascript:/自定义协议…)一律丢弃,
// 不给网页一条"借壳唤起本机程序"的路。
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
function safeOpenExternal(url) {
  let proto = ''
  try { proto = new URL(url).protocol } catch { return }
  if (!EXTERNAL_SCHEMES.has(proto)) return
  shell.openExternal(url)
}

// 每个 ipcMain.handle 第一行都要过这一关:发送帧不在自家两个源上就直接抛。
// 窗口导航虽已锁同源,但 IPC 是壳暴露给页面的最高权限面,这里再验一次不多余。
function assertTrustedSender(event) {
  const frameUrl = event && event.senderFrame ? event.senderFrame.url : ''
  if (!frameUrl || !ALLOWED_ORIGINS.has(new URL(frameUrl).origin)) {
    throw new Error('ipc: sender frame is not a trusted origin')
  }
}

// ── 壳级出域闸 ──────────────────────────────────────────────────────────────
//
// 主进程拦截 defaultSession 上的**每一个**出站请求(含发往自家 fast/app 源的),
// 用渲染进程经 IPC 登记的密表真值做精确串匹配,命中即取消。扫描核心在 egress-gate.js。
// 网页 JS 改成什么样都绕不过这一层 —— 它跑在签名壳里,不是从网上拉下来的。
//
// 边界(别让下一个人误以为它做得更多):
//  · 它不判断什么是敏感的,只守"已登记的真值"。登记什么、守什么。
//  · webRequest 看不见 WebSocket 帧 → 只要密表非空,ws:/wss: 一律取消(App 本就不用 WS)。
//  · 渲染进程自己设 content-encoding 压缩请求体 → 取消(壳解不开的体不能放行)。
//  · 真值只在主进程内存,不落盘、不写日志、不发回渲染进程;被拦通知只带 label/kind/method/path。
//  · 检查过程出任何异常 → 取消(fail-closed)。
const gate = new EgressGate()
let secretActive = false                       // 渲染进程告知:当前是否有保密会话打开(用于换线冻结)
const MAX_SCAN_FILE = 32 * 1024 * 1024         // 上传文件超过此大小不读进内存,直接视为 opaque 命中

function notifyBlocked(hit, details) {
  let pathname = '?'
  try { pathname = new URL(details.url).pathname } catch { /* 留 '?' */ }
  console.warn(`[egress] 已拦截 ${details.method} ${pathname} —— ${hit.kind}/${hit.label}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('secret:blocked', { label: hit.label, kind: hit.kind, method: details.method, path: pathname })
  }
}

const asBuffer = b => (Buffer.isBuffer(b) ? b : Buffer.from(b))

function installEgressGate() {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, async (details, cb) => {
    // cb 必须且只能调用一次;answer 做幂等保护,catch 分支再调也不会二次触发。
    let answered = false
    const answer = (r) => { if (!answered) { answered = true; cb(r) } }
    const block  = (hit) => { notifyBlocked(hit, details); answer({ cancel: true }) }
    try {
      if (gate.status().count === 0) return answer({})          // 快路径:未登记任何真值时零开销
      if (/^wss?:/i.test(details.url)) return block({ label: '(WebSocket 通道)', kind: 'websocket' })
      const urlHit = gate.scanText(details.url)
      if (urlHit) return block(urlHit)
      for (const part of details.uploadData || []) {
        let buf
        if (part.blobUUID) {
          buf = await session.defaultSession.getBlobData(part.blobUUID)
        } else if (part.file) {
          const st = await fs.promises.stat(part.file)
          if (st.size > MAX_SCAN_FILE) return block({ label: '(超过 32MB 的上传文件)', kind: 'opaque' })
          buf = await fs.promises.readFile(part.file)
        } else if (part.bytes) {
          buf = part.bytes
        } else {
          // 既无 bytes 也无 file/blobUUID:Electron 44 实测 ReadableStream 体就长这样,壳读不到内容 → 拦
          return block({ label: '(无法读取的上传体)', kind: 'opaque' })
        }
        const hit = gate.scanBuffer(asBuffer(buf))
        if (hit) return block(hit)
      }
      answer({})
    } catch (e) {
      console.warn('[egress] 检查异常,按拦截处理:', e && e.message)
      answer({ cancel: true })
    }
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    if (gate.status().count === 0) return cb({})
    const selfEncoded = Object.keys(details.requestHeaders || {}).some(h => h.toLowerCase() === 'content-encoding')
    if (!selfEncoded) return cb({})
    notifyBlocked({ label: '(渲染进程自设 Content-Encoding)', kind: 'content-encoding' }, details)
    cb({ cancel: true })
  })
}

// 权限:只给自家源放行剪贴板两项,其余(摄像头/麦克风/通知/定位/全屏…)一律拒。
const CLIPBOARD_PERMS = new Set(['clipboard-read', 'clipboard-sanitized-write'])
function installPermissionPolicy() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = (details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : '')
    cb(CLIPBOARD_PERMS.has(permission) && isAllowedOrigin(origin))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return CLIPBOARD_PERMS.has(permission) && isAllowedOrigin(requestingOrigin)
  })
}

// ── 线路探测与记忆 ──────────────────────────────────────────────────────────
const BASE_STAMP = () => path.join(app.getPath('userData'), '.last-good-base')

function rememberBase(b) {
  try { fs.writeFileSync(BASE_STAMP(), b) } catch { /* 写不了下次重探,无害 */ }
}

// 探一条线:用 /api/app-config —— 轻量、免登录、可缓存。
// ⚠️ **别用 /api/health**:服务端会外呼 Atlas/LiteLLM,又重又会把上游的毛病算到线路头上。
// 被墙的表现是 RST/超时;**收到任何 HTTP 响应(哪怕 4xx/5xx)都算这条线通** ——
// 我们判的是「网络到不到得了」,不是「服务健不健康」。
async function probeBase(base, ms = 3500) {
  try {
    await fetch(`${base}/api/app-config`, { cache: 'no-store', signal: AbortSignal.timeout(ms) })
    return true
  } catch { return false }
}

async function pickBase() {
  let last = null
  try { last = fs.readFileSync(BASE_STAMP(), 'utf8').trim() } catch { /* 首次运行 */ }
  const order = BASES.includes(last) ? [last, ...BASES.filter(b => b !== last)] : [...BASES]
  for (const b of order) {
    if (await probeBase(b)) { rememberBase(b); return b }
  }
  return FALLBACK_BASE
}

function createWindow(base = currentBase) {
  currentBase = base
  mainWindow = new BrowserWindow({
    width:          960,
    height:         680,
    minWidth:       720,
    minHeight:      520,
    // macOS: inset traffic lights into our custom header
    // Windows: hidden title bar + native overlay controls (top-right)
    titleBarStyle:  isMac ? 'hiddenInset' : 'hidden',
    ...(isMac  ? { trafficLightPosition: { x: 16, y: 14 } } : {}),
    ...(isWin  ? { titleBarOverlay: { color: '#13152A', symbolColor: '#888', height: 44 } } : {}),
    backgroundColor: '#0C0D16',
    title:           'Bayze',
    icon:            path.join(__dirname, 'assets', isWin ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      devTools:         !app.isPackaged,   // 正式包不开 DevTools:别给"从控制台把密表读出来"留门
    },
  })

  const defaultUserAgent = mainWindow.webContents.getUserAgent()
  const desktopUserAgent = `${defaultUserAgent} BayzeDesktop/${app.getVersion()}`
  mainWindow.loadURL(chatUrl(currentBase), { userAgent: desktopUserAgent })

  // 线路在运行中挂了(网络层失败,不是 4xx/5xx)→ 换另一条重来一次。
  // 只换一次:两条都不通时来回切只会让人看不懂,不如让错误页正常显示出来。
  //
  // 换线冻结:换线 = 换 origin,保密会话与密表存在渲染进程的按源隔离存储里,
  // 换过去会"看不见"(不丢,切回即恢复)。所以有保密会话打开时不自动换,先问。
  let switched = false
  mainWindow.webContents.on('did-fail-load', async (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    if (code === -3) return                  // ERR_ABORTED = 正常导航打断,不是故障
    if (switched) return
    const other = BASES.find(b => b !== currentBase)
    if (!other) return
    if (secretActive) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type:      'warning',
        title:     '线路加载失败',
        message:   '当前有保密会话打开',
        detail:    '当前线路加载失败。换线会切换到另一个源,保密会话与密表在新源上暂时不可见(不丢,切回即恢复)。',
        buttons:   ['重试当前线路', '仍然换线'],
        defaultId: 0,
        cancelId:  0,
      })
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (response !== 1) {
        mainWindow.loadURL(chatUrl(currentBase), { userAgent: desktopUserAgent })
        return
      }
    }
    switched = true
    console.warn(`[route] ${currentBase} 加载失败(${code} ${desc}),换到 ${other}`)
    currentBase = other
    rememberBase(other)
    mainWindow.loadURL(chatUrl(other), { userAgent: desktopUserAgent })
  })

  // Inject native-feel CSS: minimal scrollbars, smooth fonts, no web-browser artifacts
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      /* Thin scrollbars — only visible on hover */
      ::-webkit-scrollbar             { width: 4px; height: 4px; }
      ::-webkit-scrollbar-track       { background: transparent; }
      ::-webkit-scrollbar-thumb       { background: rgba(255,255,255,0.08); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
      /* Native font rendering */
      * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
      /* No focus ring on buttons/selects (native apps don't show it) */
      button:focus, select:focus, a:focus { outline: none; }
      /* Smooth scrolling everywhere */
      * { scroll-behavior: smooth; }
      /* Hide default cursor on drag region */
      [style*="WebkitAppRegion"] { cursor: default !important; }

      /* ── 去网页感(App 内隐藏浏览器/官网导流元素,显专业) ── */
      /* 顶栏 Home 链接、侧栏 Download App、lanwealth.com 角标:App 内均无意义 */
      a[href="https://www.lanwealth.com"],
      a[href="https://lanwealth.com"],
      a[href="/download"] { display: none !important; }
      /* 工作台顶栏兼作原生标题栏:整条可拖拽移动窗口,交互元素除外 */
      header[class*="topbar"] { -webkit-app-region: drag; }
      header[class*="topbar"] a,
      header[class*="topbar"] button,
      header[class*="topbar"] select,
      header[class*="topbar"] input,
      header[class*="topbar"] [class*="avatar"],
      header[class*="topbar"] [class*="balance"] { -webkit-app-region: no-drag; }
      ${isMac ? `/* macOS 红绿灯位于左上,给 logo 让位 */
      header[class*="topbar"] { padding-left: 76px !important; }` : ''}
    `)
  })

  // Open external links in system browser, keep internal navigation inside the window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedOrigin(url)) { safeOpenExternal(url); return { action: 'deny' } }
    mainWindow.loadURL(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedOrigin(url)) { event.preventDefault(); safeOpenExternal(url) }
  })

  // 服务端 302 到外域也走同一套判定:窗口只能停在自家两个源上。
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedOrigin(url)) { event.preventDefault(); safeOpenExternal(url) }
  })

  buildMenu()
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{
      label: 'Bayze',
      submenu: [
        { label: 'About Bayze', role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        {
          // 启动时不再无条件清缓存(见 clearCacheIfUpgraded 的说明),
          // 这里留一个手动出口:怀疑是缓存问题时点一下。
          label: '清空缓存并重载',
          click: async () => {
            try { await session.defaultSession.clearCache() } catch { /* 清不掉也照样重载 */ }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache()
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── 磁盘缓存:只在 App 版本变了才清,不再每次启动都清 ──────────────────────
//
// 原来这里是无条件 `await session.defaultSession.clearCache()`,注释说是"让生产更新
// 立刻生效"。2026-09-21 实测,这个理由不成立、代价却很大:
//
//  · 理由不成立:`app.lanwealth.com` 的静态资源 URL 自带内容哈希
//    (`/_next/static/chunks/<hash>.js`),`cache-control: public,max-age=31536000,immutable` ——
//    发了新版就是新文件名,旧缓存根本不会被命中;而 HTML 本身是
//    `cache-control: public, max-age=0, must-revalidate`,每次都回源校验。
//    换句话说:不清缓存,更新一样立刻生效。
//  · 代价很大:首页一轮就是 18 个静态文件、约 1.0 MB。大陆裸线实测(en0、不走代理、
//    5 次取样)这 1 MB 要 **18~74 秒**,而且抖得厉害 —— 顺序拉 17.7/49.9/73.9 秒,
//    并行 6 路 40.3/22.8 秒,快慢跟并发方式无关,就是链路本身不稳。
//    同样的请求数打境内 CDN 是 0.4 秒,走隧道是 2.9 秒。
//    Vercel 给大陆的边缘节点是 **sin1(新加坡)**,不是香港;HTML 本身是
//    `x-vercel-cache: HIT`,所以这些时间全是网络往返,不是服务端算得慢。
//    ——于是"每次启动清缓存"= 每次开 App 都在大陆的网络上重下 1 MB,老板收到的反馈
//    「桌面版的操作页面下载非常缓慢」就是这个。
//
// 现在改为:只有当打包版本号和上次运行时不同,才清一次。
// 另外 View 菜单里加了「清空缓存并重载」,需要手动兜底时用。
const CACHE_STAMP = () => path.join(app.getPath('userData'), '.cache-version')

async function clearCacheIfUpgraded() {
  const cur = app.getVersion()
  let prev = null
  try { prev = fs.readFileSync(CACHE_STAMP(), 'utf8').trim() } catch { /* 首次运行,没有戳 */ }
  if (prev === cur) return false
  try {
    await session.defaultSession.clearCache()
  } catch (e) {
    // 清缓存失败不该拦住启动 —— 最坏情况只是沿用旧缓存
    console.warn('[cache] clearCache 失败,继续启动:', e && e.message)
  }
  try { fs.writeFileSync(CACHE_STAMP(), cur) } catch { /* 写不了戳就下次再清一遍,无害 */ }
  return true
}

app.whenReady().then(async () => {
  installEgressGate()          // 先装闸再开窗:窗口的第一个请求就已经在闸后面
  installPermissionPolicy()
  await clearCacheIfUpgraded()

  createWindow(await pickBase())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC: 出域闸登记 ────────────────────────────────────────────────────────
// 渲染进程装入密表时把真值登记进来;真值只进 gate 内存,不回传、不落盘。
ipcMain.handle('secret:register', (e, items) => { assertTrustedSender(e); return gate.register(items) })
ipcMain.handle('secret:status',   (e) => { assertTrustedSender(e); return gate.status() })
ipcMain.handle('secret:active',   (e, b) => { assertTrustedSender(e); secretActive = !!b; return secretActive })

// ── IPC: 知识库原件本地留底(「仅本地」档,v1.2.0)────────────────────────────
// 原件存 userData/knowledge-sources/{docId}/{文件名};检索索引在云端,原件只留本机。
// docId 由服务端生成(uuid),仍严格消毒防路径穿越;文件名去除路径分隔符。
const KNOW_DIR = () => path.join(app.getPath('userData'), 'knowledge-sources')
const safeDocId = id => (/^[A-Za-z0-9-]{8,64}$/.test(String(id ?? '')) ? String(id) : null)
const safeFileName = name =>
  (String(name ?? 'source.bin').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 160)) || 'source.bin'

function knowSave(docId, name, data, text) {
  const id = safeDocId(docId)
  if (!id || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return { ok: false }
  const dir = path.join(KNOW_DIR(), id)
  fs.mkdirSync(dir, { recursive: true })
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data)
  fs.writeFileSync(path.join(dir, safeFileName(name)), buf)
  // 提取的全文也存本机(sidecar):查询时直接读文本、免二次解析发给云端模型(Part A)。
  if (typeof text === 'string' && text.trim()) {
    try { fs.writeFileSync(path.join(dir, '_text.txt'), text.slice(0, 400000), 'utf8') } catch { /* 文本留底失败不影响原件 */ }
  }
  return { ok: true }
}

// 按关键词在本机资料里检索,返回匹配文件的全文(供桌面版聊天时作附件发给云端模型)。
// 打分:文件名命中权重高 + 全文命中次数;取前 maxDocs、合计不超 charBudget。纯本地,不出网。
function knowQuery(keywords, opts) {
  try {
    const dir = KNOW_DIR()
    if (!fs.existsSync(dir)) return { docs: [], candidateCount: 0 }
    const kws = (Array.isArray(keywords) ? keywords : [])
      .map(k => String(k ?? '').trim().toLowerCase()).filter(k => k.length >= 2).slice(0, 6)
    if (!kws.length) return { docs: [], candidateCount: 0 }
    const maxDocs = Math.min(Math.max(Number(opts?.maxDocs) || 6, 1), 12)
    const charBudget = Math.min(Math.max(Number(opts?.charBudget) || 100000, 2000), 400000)

    const scored = []
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !safeDocId(d.name)) continue
      const sub = path.join(dir, d.name)
      const files = fs.readdirSync(sub)
      const origName = files.find(f => f !== '_text.txt') || ''
      const textPath = path.join(sub, '_text.txt')
      if (!fs.existsSync(textPath)) continue                     // 无文本 sidecar(旧版留底)→ 跳过,提示用户重传
      let text = ''
      try { text = fs.readFileSync(textPath, 'utf8') } catch { continue }
      if (!text.trim()) continue
      const nameL = origName.toLowerCase(), textL = text.toLowerCase()
      const nameHits = kws.filter(k => nameL.includes(k)).length
      const textHits = kws.filter(k => textL.includes(k)).length
      if (nameHits + textHits === 0) continue
      scored.push({ name: origName || d.name, text, score: nameHits * 1000 + textHits })
    }
    scored.sort((a, b) => b.score - a.score)
    const out = []
    let used = 0
    for (const s of scored) {
      if (out.length >= maxDocs) break
      const room = charBudget - used
      if (room <= 400) break
      const slice = s.text.length > room ? s.text.slice(0, room) : s.text
      out.push({ name: s.name, text: slice })
      used += slice.length
    }
    return { docs: out, candidateCount: scored.length }
  } catch { return { docs: [], candidateCount: 0 } }
}

function knowList() {
  try {
    if (!fs.existsSync(KNOW_DIR())) return []
    return fs.readdirSync(KNOW_DIR(), { withFileTypes: true })
      .filter(d => d.isDirectory() && safeDocId(d.name))
      .map(d => {
        const files = fs.readdirSync(path.join(KNOW_DIR(), d.name))
        return files.length ? { docId: d.name, name: files[0] } : null
      })
      .filter(Boolean)
  } catch { return [] }
}

function knowRead(docId) {
  const id = safeDocId(docId)
  if (!id) return null
  try {
    const dir = path.join(KNOW_DIR(), id)
    const files = fs.readdirSync(dir)
    if (!files.length) return null
    const name = safeFileName(files[0])
    return { name, data: fs.readFileSync(path.join(dir, name)) }
  } catch { return null }
}

function knowDelete(docId) {
  const id = safeDocId(docId)
  if (!id) return { ok: false }
  try { fs.rmSync(path.join(KNOW_DIR(), id), { recursive: true, force: true }); return { ok: true } } catch { return { ok: false } }
}

ipcMain.handle('know:save',   (e, ...a) => { assertTrustedSender(e); return knowSave(...a) })
ipcMain.handle('know:query',  (e, ...a) => { assertTrustedSender(e); return knowQuery(...a) })
ipcMain.handle('know:list',   (e) => { assertTrustedSender(e); return knowList() })
ipcMain.handle('know:read',   (e, ...a) => { assertTrustedSender(e); return knowRead(...a) })
ipcMain.handle('know:delete', (e, ...a) => { assertTrustedSender(e); return knowDelete(...a) })
