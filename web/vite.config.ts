import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', timeout: 600_000, proxyTimeout: 600_000 } },
  },
});
