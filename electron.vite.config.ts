import { resolve }               from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react                     from '@vitejs/plugin-react'

// 构建期常量:优先读环境变量,缺省回落到生产默认值(保证现有 npm run build / package:* 无需
// 额外配置即可打包)。anon key 本就是设计给客户端公开嵌入的(RLS 保护数据),非服务端密钥;
// 走 env 只是方便环境切换 / 密钥轮换 / 测试与生产隔离。切环境:导出 SUPABASE_URL /
// SUPABASE_ANON_KEY / APP_URL 后再 build 即可。
const SUPABASE_URL      = process.env.SUPABASE_URL      ?? 'https://umpwmtciqxthmyzpymhu.supabase.co'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtcHdtdGNpcXh0aG15enB5bWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMTQ1NDgsImV4cCI6MjA5Mjg5MDU0OH0.3CuAaxPOdfmt-NarK5v8wc5L6f57NY1jO9_CnrU5d_Q'
const APP_URL           = process.env.APP_URL           ?? 'https://app.lanwealth.com'
// 备用域(域名容灾):逗号分隔,如 'https://app.bayzeai.com'。注册好备用域后打包时导出
// BACKUP_APP_URLS 即可点亮;缺省为空 = 行为与单域完全一致。见 src/lib/baseUrl.ts。
const BACKUP_APP_URLS   = process.env.BACKUP_APP_URLS   ?? ''
// CSP connect-src 白名单 = 主域 + 备用域 + Supabase(index.html 的 %API_CONNECT_SRC% 占位符)
const CONNECT_SRC = [APP_URL, ...BACKUP_APP_URLS.split(',')]
  .map(s => s.trim()).filter(Boolean).concat(SUPABASE_URL).join(' ')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/main.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload.ts') } } },
  },
  renderer: {
    root: resolve(__dirname),
    plugins: [react(), {
      // 把 CSP 占位符替换为实际域名白名单(dev 与 build 均生效)
      name: 'csp-connect-src',
      transformIndexHtml: (html: string) => html.replaceAll('%API_CONNECT_SRC%', CONNECT_SRC),
    }],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/index.html') } } },
    define: {
      'import.meta.env.SUPABASE_URL':      JSON.stringify(SUPABASE_URL),
      'import.meta.env.SUPABASE_ANON_KEY': JSON.stringify(SUPABASE_ANON_KEY),
      'import.meta.env.APP_URL':           JSON.stringify(APP_URL),
      'import.meta.env.BACKUP_APP_URLS':   JSON.stringify(BACKUP_APP_URLS),
    },
  },
})
