// 一次性工具（不入库）：对比 style.css 已定义的 class 与两个 UI 模块实际使用的 class。
import { readFileSync } from 'node:fs';

const css = readFileSync('client/style.css', 'utf8');
const cssClasses = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) cssClasses.add(m[1]);

const SKIP = new Set(['true', 'false', 'null', 'flex', 'grid', 'none', 'block', 'auto', 'left', 'right', 'center', 'top', 'bottom',
  'switch', 'dialog', 'table', 'button', 'span', 'button', 'hidden', 'div', 'img', 'svg', 'path', 'role']);

for (const file of ['client/ui-screens.js', 'client/ui-hud.js']) {
  const src = readFileSync(file, 'utf8');
  const used = new Set();
  // h('div', 'a b c', ...) 以及 h('div', templateLiteral)
  for (const m of src.matchAll(/h\('([a-z0-9]+)',\s*(['"`])([^'"`]*)\2/g)) {
    for (const tok of m[3].split(/\s+/)) if (tok && !tok.includes('$')) used.add(tok);
  }
  // classList.add / toggle / replace 以及 className 赋值
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)) used.add(q[1]);
  }
  for (const m of src.matchAll(/className\s*=\s*`?([^`;]*)/g)) {
    for (const q of m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)) used.add(q[1]);
  }
  const missing = [...used].filter(c => !cssClasses.has(c) && !SKIP.has(c)).sort();
  console.log(`\n== ${file} · 未在 style.css 中定义的 class（${missing.length}）==`);
  console.log(missing.join(' '));
}
