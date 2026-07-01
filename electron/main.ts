import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join, dirname }                                    from 'path'
import { readFileSync, writeFileSync, mkdirSync }           from 'fs'

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
