// 三图并排对比图生成器（worldgen/renderfx 交付物）
// 用法：node scripts/map-compare-sheet.mjs [--tag=after]
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=?(.*)$/.exec(a);
  return m ? [m[1], m[2] || '1'] : [a, '1'];
}));
const TAG = args.tag || 'after';
const DIR = path.join('artifacts', 'maps', TAG);
const MAPS = ['qinglan', 'chisha', 'baiye'];
const LABEL = {
  qinglan: '青岚岛 QINGLAN — 湿润青绿 / 灰蓝雾 / 雨丝 / 信号塔',
  chisha: '赤砂矿区 RED SAND — 橙红沙尘 / 暖黄光 / 飘沙 / 露天矿坑',
  baiye: '白夜港 WHITE NIGHT — 冷蓝夜色 / 月光 / 落雪 / 窗光 / 灯塔',
};

async function dataUrl(file) {
  const buf = await readFile(file);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const battle = [];
const overview = [];
for (const m of MAPS) {
  battle.push(await dataUrl(path.join(DIR, `${m}-battle.png`)));
  overview.push(await dataUrl(path.join(DIR, `${m}-overview.png`)));
}

const html = `<html><body style="margin:0;background:#0d151c;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#e8eef2">
  <div style="padding:16px 20px 10px;font-size:21px;font-weight:700;letter-spacing:.5px">
    MIST ISLE 1.0 · 三张地图并排对比 <span style="color:#7f97a6;font-weight:400;font-size:15px">（上：对局视角　下：全景）</span>
  </div>
  <div style="display:flex;gap:10px;padding:0 12px 16px">
    ${MAPS.map((m, i) => `<div style="flex:1;min-width:0">
      <div style="font-size:14px;padding:7px 5px;color:#8fd6e8;font-weight:600">${LABEL[m]}</div>
      <img src="${battle[i]}" style="width:100%;display:block;border-radius:7px;border:1px solid #24323c">
      <img src="${overview[i]}" style="width:100%;display:block;border-radius:7px;border:1px solid #24323c;margin-top:7px">
    </div>`).join('')}
  </div></body></html>`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 820 }, deviceScaleFactor: 1 })).newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(600);
await mkdir(DIR, { recursive: true });
const out = path.join(DIR, 'compare-three-maps.png');
await page.screenshot({ path: out, fullPage: true });
await page.close();

// 地标特写拼接图
const heroFiles = [];
for (const m of MAPS) {
  const report = JSON.parse(await readFile(path.join(DIR, 'report.json'), 'utf8'));
  for (const shot of report.maps[m].landmarkShots || []) {
    if (shot.hero) heroFiles.push({ map: m, ...shot });
  }
}
if (heroFiles.length) {
  const tiles = [];
  for (const h of heroFiles) tiles.push(await dataUrl(path.join(DIR, path.basename(h.file))));
  const html2 = `<html><body style="margin:0;background:#0d151c;font-family:system-ui,sans-serif;color:#e8eef2">
    <div style="padding:16px 20px 10px;font-size:21px;font-weight:700">MIST ISLE 1.0 · 12 个地标特写</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:0 12px 16px">
      ${heroFiles.map((h, i) => `<div>
        <img src="${tiles[i]}" style="width:100%;display:block;border-radius:6px;border:1px solid #24323c">
        <div style="font-size:13px;padding:5px 3px;color:#c8d6de">${h.name} <span style="color:#6f8794">${h.kind}</span></div>
      </div>`).join('')}
    </div></body></html>`;
  const page2 = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })).newPage();
  await page2.setContent(html2, { waitUntil: 'load' });
  await page2.waitForTimeout(600);
  await page2.screenshot({ path: path.join(DIR, 'compare-landmarks.png'), fullPage: true });
  await browser.close();
  console.log(`wrote ${path.join(DIR, 'compare-landmarks.png')} (${heroFiles.length} landmarks)`);
}
console.log(`wrote ${out}`);
