// preload.js — runs in the renderer process with limited Node access
// contextIsolation: true means this is sandboxed from the page JS
const { contextBridge, ipcRenderer } = require('electron')

// Expose minimal info + 知识库本地留底桥 + 出域闸登记桥 to the web app.
// 安全边界:窗口导航已锁定 fast.lanwealth.com / app.lanwealth.com 两个源
// (main.js will-navigate / will-redirect / windowOpenHandler),桥只会暴露给自家页面;
// 每个 IPC 通道在 main 进程再按发送帧的 origin 验一次(assertTrustedSender);
// 文件写入被 main 进程按 docId 白名单消毒并限制在 userData 子目录。
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
  // 壳级出域闸:网页端装入密表时把真值登记到主进程,主进程拦每个出站请求做精确串匹配。
  // 真值只进主进程内存;被拦通知只带 { label, kind, method, path },不含真值。
  secretEgress: {
    // items: [{ original, label, kind }] → 返回本次新增条数
    register:  (items) => ipcRenderer.invoke('secret:register', Array.isArray(items) ? items : []),
    // → { active, count }
    status:    ()      => ipcRenderer.invoke('secret:status'),
    // 有保密会话打开时置 true:线路故障时壳不自动换线(换源会让密表暂时不可见),改为询问
    setActive: (b)     => ipcRenderer.invoke('secret:active', !!b),
    // 登出 / 换账号时调用:清空主进程里的登记(密表按用户隔离,登记也不能跨用户存活)
    clear:     ()      => ipcRenderer.invoke('secret:clear'),
    // 被拦通知;返回取消订阅函数
    onBlocked: (cb) => {
      const handler = (_e, info) => { try { cb(info) } catch { /* 页面回调出错不影响桥 */ } }
      ipcRenderer.on('secret:blocked', handler)
      return () => ipcRenderer.removeListener('secret:blocked', handler)
    },
  },
})
