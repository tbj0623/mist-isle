import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('client/main.js', root))],
  outfile: fileURLToPath(new URL('app.js', dist)),
  bundle: true, minify: true, sourcemap: false, target: ['chrome100'], format: 'iife', legalComments: 'eof',
});
for (const file of ['index.html', 'style.css', 'icon.svg']) {
  await copyFile(new URL(`client/${file}`, root), new URL(file, dist));
}
await mkdir(new URL('licenses/', dist), { recursive: true });
for (const name of ['three', 'ws', 'lucide']) {
  await copyFile(new URL(`node_modules/${name}/LICENSE`, root), new URL(`licenses/${name}.txt`, dist));
}
await mkdir(new URL('android/app/src/main/assets/', root), { recursive: true });
await cp(dist, new URL('android/app/src/main/assets/', root), { recursive: true });
console.log('Web bundle and offline Android assets built.');
