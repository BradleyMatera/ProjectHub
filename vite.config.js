import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'analytics/dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'analytics/main.js'),
      name: 'ProjectHubAnalytics',
      fileName: 'analytics',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        assetFileNames: 'analytics.[ext]',
      },
    },
  },
});
