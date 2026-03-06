import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0', // 監聽所有 IP 位址 (IPv4 和 IPv6)
    port: 5173,
  },
  build: {
    // Strip console.log and debugger statements in production builds
    esbuild: { drop: ['console', 'debugger'] },
  },
})
