import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 局域网可访问（手机连同一网络直达；内网穿透也监听此端口）
    port: 5173,
    strictPort: true, // 端口被占时直接报错而不是悄悄换端口（启动脚本按 5173 打开浏览器）
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
})
