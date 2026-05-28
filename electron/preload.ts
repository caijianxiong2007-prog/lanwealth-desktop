import { contextBridge, ipcRenderer } from 'electron'

// Expose safe IPC methods to renderer (no direct Node.js access)
contextBridge.exposeInMainWorld('electronAPI', {
  store: {
    get:    (key: string)                => ipcRenderer.invoke('store:get',    key),
    set:    (key: string, val: unknown)  => ipcRenderer.invoke('store:set',    key, val),
    delete: (key: string)                => ipcRenderer.invoke('store:delete', key),
  },
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close:    () => ipcRenderer.send('win:close'),
  },
  platform: process.platform,
})
