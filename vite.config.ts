import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    // The same framing refusal the daemon sends on every response (server/index.ts). The
    // dev server is the other way the dashboard is reached, and a page framed off port 5179
    // proxies straight through to the real API, so the boundary has to hold on both.
    headers: {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    },
    proxy: {
      '/api': 'http://127.0.0.1:4319',
      '/ws': { target: 'ws://127.0.0.1:4319', ws: true },
    },
  },
  build: { outDir: 'dist' },
})
