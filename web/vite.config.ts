import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is same-origin in production; in dev we proxy /api and /ws to :4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
