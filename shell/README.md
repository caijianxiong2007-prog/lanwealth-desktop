# Bayze 桌面版(网页套壳)— 线上发行版源码

**这是实际发版的桌面版**(v1.1.0 起,现 v1.3.0):Electron 套壳加载 app.lanwealth.com
完整工作台,注入原生化 CSS;v1.2.0 起带知识库「仅本地」原件留底 IPC 桥
(`window.electronApp.knowledge`,main.js 消毒处理器 + preload contextBridge)。

- 打包:复制本目录到云盘外(如 ~/bayze-desktop-build),npm install 后按
  desktop-release-pipeline 流程签名/公证(CSC_NAME 去前缀,bayze-notary profile)。
- 仓库根目录的 electron-vite 原生重写(纯聊天+知识库页)**从未发版**,保留作参考。
- 2026-07-04 前本源码只存在于 OneDrive(6月底迁移遗漏),现迁入 git,OneDrive 副本已退役。

## 壳级出域闸(v1.3.0)

主进程拦截 defaultSession 的每个出站请求(`webRequest.onBeforeRequest`,含发往自家源的),
用渲染进程经 `window.electronApp.secretEgress.register()` 登记的密表真值做精确串匹配(`egress-gate.js`,
折宽 / JSON转义 / 百分号 / base64 / gzip / zip 多层解码),命中即取消并向页面发 `secret:blocked`
(只带 label/kind/method/path)。密表非空时 ws/wss 与渲染进程自设 content-encoding 的请求一律取消。
配套加固:IPC 发送帧 origin 校验、will-redirect 锁源、外链 scheme 白名单、正式包关 DevTools、
权限只放剪贴板、fuses(`build/fuses.js`,afterPack)、entitlements 收紧。

- `npm test`:扫描核心 + 静态接线看守(node --test,零依赖)
- `npm run probe:egress`:起真实壳经 CDP 发各形态请求核对拦/放(需外网)
