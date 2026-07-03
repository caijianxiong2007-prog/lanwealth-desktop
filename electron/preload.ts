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
  // 知识库原件本地留底(「仅本地」档):原件存本机 userData,索引在云端
  knowledge: {
    saveSource:   (docId: string, name: string, data: ArrayBuffer) => ipcRenderer.invoke('know:save', docId, name, new Uint8Array(data)),
    listSources:  ()               => ipcRenderer.invoke('know:list'),
    readSource:   (docId: string)  => ipcRenderer.invoke('know:read', docId),
    deleteSource: (docId: string)  => ipcRenderer.invoke('know:delete', docId),
  },
  platform: process.platform,
})
