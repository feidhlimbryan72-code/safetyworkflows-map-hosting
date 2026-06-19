import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: false // Keep it false for non-interactive runner to prevent starting browser externally
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
