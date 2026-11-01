// 雾岛突围 / MIST ISLE — Web 产物构建（owner: Lead · scripts/build.mjs）
//
// 职责：用 esbuild 把 client/main.js 打成 dist/app.js，复制 index.html / style.css /
// icon.svg / 三方许可证，再整目录同步到 android/app/src/main/assets/。
//
// 注意：每一步都先清空目标目录。历史实现只 mkdir + 覆盖写，导致 dist/app.dev.js
// （2.2MB 的旧调试产物，全仓库已无生产者）长期残留并被复制进 APK —— 产物目录
// 「只增不减」，任何一次改名/删文件都会让旧文件永久随包发布。
import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const assets = new URL('android/app/src/main/assets/', root);

// 1) 清空旧产物（两个目录都重建，避免陈旧文件被复制进 APK）
await rm(dist, { recursive: true, force: true });
await rm(assets, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('client/main.js', root))],
  outfile: fileURLToPath(new URL('app.js', dist)),
  bundle: true, minify: true, sourcemap: false, target: ['chrome100'], format: 'iife', legalComments: 'eof',
});

for (const file of ['index.html', 'style.css', 'icon.svg']) {
  await copyFile(new URL(`client/${file}`, root), new URL(file, dist));
}
// 浏览器试玩与 APK 分发时一并保留原创代码和第三方依赖的许可说明。
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(new URL(file, root), new URL(file, dist));
}

// 2) 三方许可证。缺包时跳过而不是让整个构建失败：
//    three/lucide 已从运行时依赖里移除（只有 client bundle 用，产物里不残留），
//    干净的生产环境 `npm ci --omit=dev` 之后不存在这两个目录。
await mkdir(new URL('licenses/', dist), { recursive: true });
for (const name of ['three', 'ws', 'lucide']) {
  const src = new URL(`node_modules/${name}/LICENSE`, root);
  try {
    await access(src);
    await copyFile(src, new URL(`licenses/${name}.txt`, dist));
  } catch {
    // 缺失就跳过：许可证只影响「随产物分发」的合规信息，不应阻塞构建
  }
}

// 3) 同步到 Android assets
await mkdir(assets, { recursive: true });
await cp(dist, assets, { recursive: true });
console.log('Web bundle and offline Android assets built.');
