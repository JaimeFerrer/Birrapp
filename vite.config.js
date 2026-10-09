import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 700, // el SDK de Firebase ocupa ~550 kB (~165 kB comprimido)
  },
});
