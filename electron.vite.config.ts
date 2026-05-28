import { resolve }               from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react                     from '@vitejs/plugin-react'

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
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    define: {
      'import.meta.env.SUPABASE_URL':      JSON.stringify('https://umpwmtciqxthmyzpymhu.supabase.co'),
      'import.meta.env.SUPABASE_ANON_KEY': JSON.stringify('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtcHdtdGNpcXh0aG15enB5bWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMTQ1NDgsImV4cCI6MjA5Mjg5MDU0OH0.3CuAaxPOdfmt-NarK5v8wc5L6f57NY1jO9_CnrU5d_Q'),
      'import.meta.env.APP_URL':           JSON.stringify('https://app.lanwealth.com'),
    },
  },
})