// 渲染层静态自检（owner: renderfx）
// 仅验证 client/scene.js + models.js + fx.js + theme.js 可被 esbuild 打包（无语法/导入错误），
// 并做轻量结构断言；不启动浏览器、不写 dist。
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'client/scene.js');

test('render entry bundles without syntax or import errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mist-render-'));
  const outfile = join(dir, 'render.bundle.mjs');
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      minify: false,
      sourcemap: false,
      format: 'esm',
      target: ['chrome100'],
      // 真实浏览器里由 index.html 的 importmap/打包器解析 three；这里只打 we 自己的模块
      external: ['three', 'three/*'],
      logLevel: 'silent',
    });
    const code = await readFile(outfile, 'utf8');
    assert.ok(code.length > 30_000, `bundle too small: ${code.length}`);
    // 契约 §10.1 / §10.3 / §10.2 关键导出必须在 bundle 中
    for (const name of ['GameScene', 'setMap', 'showHome', 'beginMatch', 'setState', 'aimAt', 'groundAt', 'predictInput', 'hitmarker']) {
      assert.ok(code.includes(name), `missing scene member: ${name}`);
    }
    for (const name of ['createCharacter', 'createVehicle', 'createLootModel', 'createTree', 'createProp', 'createAirdrop', 'createPingMarker', 'createTextSprite', 'disposeModel']) {
      assert.ok(code.includes(name), `missing model factory: ${name}`);
    }
    assert.ok(code.includes('Fx'), 'missing Fx class');
    // 共享导出：makeWorld / QUALITY 至少被引用（不校验具体实现）
    assert.ok(code.includes('makeWorld'), 'scene must consume shared/map.mjs makeWorld');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fx and theme bundle standalone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mist-fx-'));
  try {
    for (const [name, file] of [['fx', 'client/fx.js'], ['theme', 'client/theme.js'], ['models', 'client/models.js']]) {
      const outfile = join(dir, `${name}.mjs`);
      await build({
        entryPoints: [join(root, file)], outfile, bundle: true, format: 'esm', target: ['chrome100'],
        external: ['three', 'three/*'], logLevel: 'silent',
      });
      const code = await readFile(outfile, 'utf8');
      assert.ok(code.length > 2000, `${file} bundle too small`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
