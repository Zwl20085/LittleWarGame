import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false, fs: { allow: ['.'] } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
