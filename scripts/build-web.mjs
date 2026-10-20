/**
 * Web UI build: bundle web/app.ts (hls.js + qrcode-generator inlined) into
 * dist/web/app.js and copy static assets. No CDN dependencies at runtime.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.join(root, '..', 'web');
const webOut = path.join(root, '..', 'dist', 'web');

fs.mkdirSync(webOut, { recursive: true });

await build({
  entryPoints: [path.join(webSrc, 'app.ts')],
  bundle: true,
  outfile: path.join(webOut, 'app.js'),
  format: 'iife',
  target: ['es2020'],
  minify: process.env.NODE_ENV === 'production',
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development') },
});

for (const file of ['index.html', 'style.css', 'favicon.svg']) {
  const src = path.join(webSrc, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(webOut, file));
}
console.log('web UI built → dist/web');
