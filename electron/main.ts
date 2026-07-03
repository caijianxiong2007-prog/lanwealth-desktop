import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join, dirname }                                    from 'path'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'fs'

// ── Persistent JSON store (no extra deps) ────────────────────────────────────
const STORE_FILE = join(app.getPath('userData'), 'store.json')
let store: Record<string, unknown> = {}
try { store = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) } catch {}
function saveStore() {
  mkdirSync(dirname(STORE_FILE), { recursive: true })
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width:             1200,
    height:            800,
    minWidth:          800,
    minHeight:         560,
    backgroundColor:   '#0A0A0B',
    show:              false,
    // Mac: native traffic lights inside the window
    titleBarStyle:     process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload:          join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  })

  mainWindow.on('ready-to-show', () => { mainWindow?.show() })

  // Open external links in default browser, not Electron.
  // 只放行安全协议(https/http/mailto),拦截 file:/javascript: 等,避免恶意链接打开本地资源或执行脚本。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const proto = new URL(url).protocol
      if (proto === 'https:' || proto === 'http:' || proto === 'mailto:') shell.openExternal(url)
    } catch { /* 非法 URL,忽略 */ }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── IPC: store ───────────────────────────────────────────────────────────────
ipcMain.handle('store:get',    (_, key: string)               => store[key])
ipcMain.handle('store:set',    (_, key: string, val: unknown) => { store[key] = val; saveStore() })
ipcMain.handle('store:delete', (_, key: string)               => { delete store[key]; saveStore() })

// ── IPC: window controls (custom title bar) ──────────────────────────────────
ipcMain.on('win:minimize',  () => mainWindow?.minimize())
ipcMain.on('win:maximize',  () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
ipcMain.on('win:close',     () => mainWindow?.close())

// ── IPC: 知识库原件本地留底(「仅本地」档)────────────────────────────────────
// 原件存 userData/knowledge-sources/{docId}/{文件名};检索索引在云端,原件只留本机。
// docId 由服务端生成(uuid),仍严格消毒防路径穿越;文件名去除路径分隔符。
const KNOW_DIR = join(app.getPath('userData'), 'knowledge-sources')
const safeDocId = (id: unknown): string | null => {
  const s = String(id ?? '')
  return /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : null
}
const safeFileName = (name: unknown): string =>
  String(name ?? 'source.bin').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 160) || 'source.bin'

ipcMain.handle('know:save', (_e, docId: unknown, name: unknown, data: unknown) => {
  const id = safeDocId(docId)
  if (!id || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return { ok: false }
  const dir = join(KNOW_DIR, id)
  mkdirSync(dir, { recursive: true })
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Uint8Array)
  writeFileSync(join(dir, safeFileName(name)), buf)
  return { ok: true }
})

ipcMain.handle('know:list', () => {
  try {
    if (!existsSync(KNOW_DIR)) return []
    return readdirSync(KNOW_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && safeDocId(d.name))
      .map(d => {
        const files = readdirSync(join(KNOW_DIR, d.name))
        return files.length ? { docId: d.name, name: files[0] } : null
      })
      .filter(Boolean)
  } catch { return [] }
})

ipcMain.handle('know:read', (_e, docId: unknown) => {
  const id = safeDocId(docId)
  if (!id) return null
  try {
    const dir = join(KNOW_DIR, id)
    const files = readdirSync(dir)
    if (!files.length) return null
    const name = safeFileName(files[0])
    const buf = readFileSync(join(dir, name))
    // Buffer 走 IPC 结构化克隆到渲染进程即 Uint8Array
    return { name, data: buf }
  } catch { return null }
})

ipcMain.handle('know:delete', (_e, docId: unknown) => {
  const id = safeDocId(docId)
  if (!id) return { ok: false }
  try { rmSync(join(KNOW_DIR, id), { recursive: true, force: true }); return { ok: true } } catch { return { ok: false } }
})
