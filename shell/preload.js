// preload.js — runs in the renderer process with limited Node access
// contextIsolation: true means this is sandboxed from the page JS
const { contextBridge, ipcRenderer } = require('electron')

// Expose minimal info + 知识库本地留底桥 to the web app.
// 安全边界:窗口导航已锁定 app.lanwealth.com 同源(main.js will-navigate/windowOpenHandler),
// 桥只会暴露给自家页面;文件写入被 main 进程按 docId 白名单消毒并限制在 userData 子目录。
contextBridge.exposeInMainWorld('electronApp', {
  platform: process.platform,
  version:  process.versions.electron,
  // 知识库「仅本地」原件留底:原件只存这台电脑,云端只有检索索引
  knowledge: {
    // 存原件(+可选提取全文 sidecar,供查询时读取);text 传入则本机也留全文
    saveSource:   (docId, name, data, text) => ipcRenderer.invoke('know:save', docId, name, new Uint8Array(data), typeof text === 'string' ? text : undefined),
    listSources:  ()      => ipcRenderer.invoke('know:list'),
    readSource:   (docId) => ipcRenderer.invoke('know:read', docId),
    deleteSource: (docId) => ipcRenderer.invoke('know:delete', docId),
    // 按关键词检索本机资料,返回匹配文件全文(桌面版聊天时作附件发云端模型)
    query:        (keywords, opts) => ipcRenderer.invoke('know:query', keywords, opts),
  },
})
