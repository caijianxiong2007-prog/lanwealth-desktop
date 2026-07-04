/// <reference types="vite/client" />

// electron-vite 通过 define 注入的编译期常量(见 electron.vite.config.ts)。
interface ImportMetaEnv {
  readonly APP_URL: string
  readonly SUPABASE_URL: string
  readonly SUPABASE_ANON_KEY: string
  readonly ELECTRON_RENDERER_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Electron 自定义标题栏用 -webkit-app-region 控制拖拽;React 的 CSSProperties 默认无此键,
// 全局扩一次,避免每处 `as any`(ChatPage/LoginPage/KnowledgePage 均用到)。
import 'react'
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}
