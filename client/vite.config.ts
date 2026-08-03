import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 4200,
    open: true,
    allowedHosts: ['chainbomb.shadrakbessanh.me', '.shadrakbessanh.me'],
    proxy: {
      // Browser -> vite -> on-chain host service (funded wallet, tick crank)
      '/host': {
        target: 'http://127.0.0.1:7070',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/host/, ''),
      },
    },
  },
});
