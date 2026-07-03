# Bayze 桌面版(网页套壳)— 线上发行版源码

**这是实际发版的桌面版**(v1.1.0 起,现 v1.2.0):Electron 套壳加载 app.lanwealth.com
完整工作台,注入原生化 CSS;v1.2.0 起带知识库「仅本地」原件留底 IPC 桥
(`window.electronApp.knowledge`,main.js 消毒处理器 + preload contextBridge)。

- 打包:复制本目录到云盘外(如 ~/bayze-desktop-build),npm install 后按
  desktop-release-pipeline 流程签名/公证(CSC_NAME 去前缀,bayze-notary profile)。
- 仓库根目录的 electron-vite 原生重写(纯聊天+知识库页)**从未发版**,保留作参考。
- 2026-07-04 前本源码只存在于 OneDrive(6月底迁移遗漏),现迁入 git,OneDrive 副本已退役。
