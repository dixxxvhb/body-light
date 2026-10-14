import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { port: 5190, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
