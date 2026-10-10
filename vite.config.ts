import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** The built version (package.json), shown on the title screen and compared by the update check. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, open: false, fs: { allow: ['.'] } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
