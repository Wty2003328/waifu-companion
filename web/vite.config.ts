import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev`, the companion-server is the source of truth for
// /api/*, /ws/avatar, /health, and the avatar/* asset directory. Vite
// proxies through to it so a single browser session can talk to both.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api':    { target: 'http://127.0.0.1:9181', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:9181', changeOrigin: true },
      '/avatar/models': { target: 'http://127.0.0.1:9181', changeOrigin: true },
      '/ws':     { target: 'ws://127.0.0.1:9181', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
