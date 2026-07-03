const { app, BrowserWindow, Menu, shell, nativeTheme, session, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')

nativeTheme.themeSource = 'dark'

const BASE_URL  = 'https://app.lanwealth.com'
// 企业版用户主用桌面端 → 加载完整工作台(对话/知识库/企业管理/图片/视频全功能),
// 不再用阉割版独立聊天页;网页感元素(Home/Download/角标)由下方注入 CSS 隐藏。
const CHAT_URL  = `${BASE_URL}/dashboard/chat`
const isMac     = process.platform === 'darwin'
const isWin     = process.platform === 'win32'
const APP_ORIGIN = new URL(BASE_URL).origin

let mainWindow

function createWindow() {
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
    },
  })

  const defaultUserAgent = mainWindow.webContents.getUserAgent()
  const desktopUserAgent = `${defaultUserAgent} BayzeDesktop/${app.getVersion()}`
  mainWindow.loadURL(CHAT_URL, { userAgent: desktopUserAgent })

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
    let internal = false
    try { internal = new URL(url).origin === APP_ORIGIN } catch { /* invalid URL */ }
    if (!internal) { shell.openExternal(url); return { action: 'deny' } }
    mainWindow.loadURL(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    let internal = false
    try { internal = new URL(url).origin === APP_ORIGIN } catch { /* invalid URL */ }
    if (!internal) { event.preventDefault(); shell.openExternal(url) }
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

app.whenReady().then(async () => {
  // Clear HTTP disk cache on every launch so production updates are always picked up immediately
  await session.defaultSession.clearCache()

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC: 知识库原件本地留底(「仅本地」档,v1.2.0)────────────────────────────
// 原件存 userData/knowledge-sources/{docId}/{文件名};检索索引在云端,原件只留本机。
// docId 由服务端生成(uuid),仍严格消毒防路径穿越;文件名去除路径分隔符。
const KNOW_DIR = () => path.join(app.getPath('userData'), 'knowledge-sources')
const safeDocId = id => (/^[A-Za-z0-9-]{8,64}$/.test(String(id ?? '')) ? String(id) : null)
const safeFileName = name =>
  (String(name ?? 'source.bin').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 160)) || 'source.bin'

ipcMain.handle('know:save', (_e, docId, name, data) => {
  const id = safeDocId(docId)
  if (!id || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return { ok: false }
  const dir = path.join(KNOW_DIR(), id)
  fs.mkdirSync(dir, { recursive: true })
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data)
  fs.writeFileSync(path.join(dir, safeFileName(name)), buf)
  return { ok: true }
})

ipcMain.handle('know:list', () => {
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
})

ipcMain.handle('know:read', (_e, docId) => {
  const id = safeDocId(docId)
  if (!id) return null
  try {
    const dir = path.join(KNOW_DIR(), id)
    const files = fs.readdirSync(dir)
    if (!files.length) return null
    const name = safeFileName(files[0])
    return { name, data: fs.readFileSync(path.join(dir, name)) }
  } catch { return null }
})

ipcMain.handle('know:delete', (_e, docId) => {
  const id = safeDocId(docId)
  if (!id) return { ok: false }
  try { fs.rmSync(path.join(KNOW_DIR(), id), { recursive: true, force: true }); return { ok: true } } catch { return { ok: false } }
})
