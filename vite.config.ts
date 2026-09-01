import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 使用相对路径，保证打包后在 file:// 与 Capacitor WebView 下都能加载
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared-music/src', import.meta.url)),
    },
  },
})
