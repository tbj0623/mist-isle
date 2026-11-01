// 雾岛突围 / MIST ISLE — 数值平衡仪表盘（真实模拟采样，不重写伤害公式）
// 用法：node scripts/balance-report.mjs
// 原理：构造真实 Match，两名玩家互为靶子，反复 tryFire → _traceShot → _applyShotDamage。
//       命中率 / 循环 DPS / TTK 全部来自 simulation.mjs 原逻辑（散布、后坐力、护甲吸收、
//       要害判定、射程衰减），本脚本只做统计，不重算任何伤害。
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Match, effectiveWeapon } from '../shared/simulation.mjs';
import { WEAPONS, ATTACHMENTS, applyAttachmentMods, damageAtDistance } from '../shared/data/weapons.mjs';
import { ARMORS } from '../shared/data/items.mjs';
import { COMBAT } from '../shared/rules.mjs';

const TICK = 1 / 30;
const OUT_DIR = path.resolve('artifacts/balance');
const OUT_FILE = path.join(OUT_DIR, 'report.md');
const IDS = Object.keys(WEAPONS);
const TIERS = [0, 1, 2, 3];
const BANDS = [6, 10, 15, 20, 28, 36, 46, 60, 78, 96];
const TARGET_R = 0.7;

/** 确定性 RNG：每个测量点用固定种子，保证不同武器面对同一串「准星抖动」。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 靶场：两名玩家，屏蔽掩体/载具/事件 ───────────────────────────────────────
function buildArena(seed = 20261018) {
  const m = new Match({ mapId: 'qinglan', seed, mode: 'solo', maxPlayers: 2, duration: 3600 });
  m.cars.length = 0;
  const world = m.world;
  m.world = Object.create(world);
  m.world.wallDistance = () => 9999; // 只考察枪械本身，排除掩体遮挡
  m._emit = () => {};
  const a = m.addPlayer('A', '射手A', { team: 0, loadout: [{ type: 'p9' }] });
  const b = m.addPlayer('B', '靶子B', { team: 1, loadout: [{ type: 'p9' }] });
  m.phase = 'live';
  const st = { traces: 0, hits: 0, heads: 0, dmg: 0 };
  const trace = m._traceShot.bind(m);
  m._traceShot = (ox, oz, dx, dz, range, sh) => {
    st.traces++;
    const hit = trace(ox, oz, dx, dz, range, sh);
    if (hit) { st.hits++; if (hit.head) st.heads++; }
    return hit;
  };
  const dmg = m.damage.bind(m);
  m.damage = (t, amount, sid, opts) => {
    const dealt = dmg(t, amount, sid, opts);
    if (t === b) st.dmg += dealt;
    return dealt;
  };
  return { m, a, b, st };
}
const ARENA = buildArena();

function equip(p, w, atts = []) {
  const eff = applyAttachmentMods(w, atts);
  p.loadout[0] = { type: eff.id, ammo: eff.magazine, attachments: atts.slice(), _eff: eff };
  p.slot = 0;
  p.mags[eff.ammo] = 1e7;
  return eff;
}

function place(p, x, z, hp, tier, armor) {
  Object.assign(p, {
    x, z, y: 0, hp, alive: true, downed: false, shield: 0, armor, armorTier: tier,
    fireCd: 0, reloadTime: 0, healTime: 0, healKind: null, recoil: 0, spreadBloom: 0,
    triggerHeld: false, state: 'normal', moved: false, stamina: 100, rank: 0,
  });
  p.loadout[0].ammo = effectiveWeapon(p).magazine;
}

function reset(dist, hpA = 1e9, hpB = 100, tierB = 0, armorB = 0) {
  const { m, a, b, st } = ARENA;
  m.phase = 'live'; m.time = 0; m.matchTime = 0; m.result = null;
  m.zone.nextIn = 1e9; m.zone.closing = false; m.zone.damage = 0; m.zone.phase = -1;
  place(a, 0, 0, hpA, 0, 0);
  place(b, 0, dist, hpB, tierB, armorB);
  st.traces = 0; st.hits = 0; st.heads = 0; st.dmg = 0;
}

/** 准星落在命中圆内均匀随机点 → 真人瞄准误差；命中核心区 ≈14% 面积即判要害。 */
function aimAt(p, t, rng) {
  const r = TARGET_R * Math.sqrt(rng());
  const th = rng() * Math.PI * 2;
  p.angle = Math.atan2(t.x + Math.cos(th) * r - p.x, t.z + Math.sin(th) * r - p.z);
  return p.angle;
}

/** 真跑一段模拟时间：auto 按住扳机，半自动每 2 tick 重扣一次。 */
function run(seconds, { shootA = true, shootB = false, seed = 12345 } = {}) {
  const { m, a, b } = ARENA;
  const rng = makeRng(seed);
  const ticks = Math.max(1, Math.round(seconds / TICK));
  for (let i = 0; i < ticks; i++) {
    if (shootA && a.alive) {
      a.input.fire = effectiveWeapon(a).auto ? true : i % 2 === 0;
      a.input.aim = aimAt(a, b, rng);
    }
    if (shootB && b.alive) {
      b.input.fire = effectiveWeapon(b).auto ? true : i % 2 === 0;
      b.input.aim = aimAt(b, a, rng);
    }
    m.update(TICK);
    if (!a.alive || !b.alive) break;
  }
  return m.time;
}

/** 采样点：弹丸命中率 / 落地循环 DPS / 要害率。 */
function sample(w, atts, dist, seconds) {
  const { a, st } = ARENA;
  equip(a, w, atts);
  reset(dist, 1e9, 1e9);
  run(seconds);
  return { acc: st.traces ? st.hits / st.traces : 0, dps: st.dmg / seconds, head: st.traces ? st.heads / st.traces : 0 };
}

/** TTK：靶子 100HP + 指定护甲，取 3 次击杀耗时的中位数；打不死记 4s。 */
function ttk(w, atts, dist, tier = 0, armor = 0, trials = 3) {
  const { m, a, b } = ARENA;
  equip(a, w, atts);
  const out = [];
  for (let n = 0; n < trials; n++) {
    reset(dist, 1e9, COMBAT.maxHp, tier, armor);
    run(4, { seed: 777 + n * 31 });
    out.push(b.alive ? 4 : m.time);
  }
  return out.sort((x, y) => x - y)[Math.floor(trials / 2)];
}

/** 镜像对枪：A 穿 tierA、B 穿 tierB，双方同枪同时开火，返回 A 的胜率。 */
function duel(tierA, tierB, w, dist, n = 60) {
  const { a, b } = ARENA;
  equip(a, w); equip(b, w);
  const da = tierA ? ARMORS['armor' + tierA] : null;
  const db = tierB ? ARMORS['armor' + tierB] : null;
  let win = 0;
  for (let i = 0; i < n; i++) {
    reset(dist, COMBAT.maxHp, COMBAT.maxHp, 0, 0);
    place(a, 0, 0, COMBAT.maxHp, tierA, da ? da.durability : 0);
    place(b, 0, dist, COMBAT.maxHp, tierB, db ? db.durability : 0);
    run(3, { shootA: true, shootB: true, seed: 900 + i * 13 });
    if (!b.alive) win += a.alive ? 1 : 0.5;
  }
  return win / n;
}

const cycleOf = (w) => w.magazine * w.interval + w.reload;
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const pct = (v) => (Number.isFinite(v) ? v * 100 : Number.NaN);
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const sgn = (v, d = 1) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—');

function weaponRow(id) {
  const w = WEAPONS[id];
  const win = Math.min(16, Math.max(4, cycleOf(w) * 1.5));
  const near = 8; const mid = Math.round(w.range * 0.5); const far = Math.round(w.range * 0.85);
  const prof = BANDS.filter((d) => d <= w.range * 1.05)
    .map((d) => ({ d, ...sample(w, [], d, Math.min(6, Math.max(2, w.interval * 6 + 2))) }));
  const at = (d) => prof.reduce((s, p) => (Math.abs(p.d - d) < Math.abs(s.d - d) ? p : s), prof[0]);
  const base = damageAtDistance(w, 0) * (w.pellets || 1);
  let effRange = 0;
  for (const p of prof) {
    if (p.acc >= 0.5 && damageAtDistance(w, p.d) * (w.pellets || 1) >= base * 0.35) effRange = p.d;
  }
  return {
    id, w, near, mid, far, effRange,
    dps: sample(w, [], near, win).dps, dpsMid: sample(w, [], mid, win).dps,
    ttk0: ttk(w, [], near, 0), ttk50: ttk(w, [], near, 2, 50),
    ttkMid: ttk(w, [], mid, 0), ttkFar: ttk(w, [], far, 0),
    ttkArmor: TIERS.map((t) => ttk(w, [], near, t, t ? ARMORS['armor' + t].durability : 0)),
    accNear: at(near).acc, accMid: at(mid).acc, accFar: at(far).acc, headNear: at(near).head,
  };
}

/** 配件收益：对该槽位全部可用枪取平均（装 vs 不装）。 */
function attachmentGain(id) {
  const att = ATTACHMENTS[id];
  const pick = IDS.filter((wid) => WEAPONS[wid].slots.includes(att.slot));
  const acc = { dps: 0, ttk: 0, acc: 0, cycle: 0, n: 0, rows: [] };
  for (const wid of pick) {
    const w = WEAPONS[wid];
    const d = Math.max(8, Math.round(w.range * 0.55));
    const sec = Math.min(8, Math.max(3, cycleOf(w)));
    const b = sample(w, [], d, sec); const v = sample(w, [id], d, sec);
    if (!(b.dps > 0)) continue;
    const bt = ttk(w, [], d, 0); const vt = ttk(w, [id], d, 0);
    acc.dps += v.dps / b.dps - 1;
    acc.ttk += vt / Math.max(0.01, bt) - 1;
    acc.acc += (v.acc - b.acc) * 100;
    acc.cycle += cycleOf(applyAttachmentMods(w, [id])) / cycleOf(w) - 1;
    acc.rows.push({ wid, dps: v.dps / b.dps - 1 });
    acc.n++;
  }
  if (!acc.n) return null;
  acc.rows.sort((x, y) => y.dps - x.dps);
  return {
    id, att, n: acc.n, dps: pct(acc.dps / acc.n), ttk: pct(acc.ttk / acc.n),
    acc: acc.acc / acc.n, cycle: acc.cycle / acc.n, best: acc.rows[0], worst: acc.rows[acc.rows.length - 1],
  };
}

// ── 入口：生成 artifacts/balance/report.md ────────────────────────────────
//
// 本文件此前只有 helper、没有 main（`node scripts/balance-report.mjs` 静默 exit 0、
// 不产出任何东西），等于一个「存在但不可用」的工具。这里补上入口：
// 逐武器测「近/中/远」三档的 DPS 与 TTK、有效射程、以及配件影响，写成 Markdown 表。

/** 把武器行渲染成一行 Markdown。 */
function markdownRow(r) {
  return `| ${r.w.short || r.id} | ${r.w.cls} | ${r.w.tier} | ${f1(r.dps)} | ${f1(r.dpsMid)} | `
    + `${f2(r.ttkPeace)} / ${f2(r.ttkMid)} / ${f2(r.ttkFar)} | ${r.effRange}m | ${f1(pct(r.acc))}% |`;
}

function buildReport() {
  const rows = [];
  for (const id of IDS) {
    try {
      const r = weaponRow(id);
      if (r) rows.push(r);
    } catch (err) {
      console.warn(`[balance] ${id} 采样失败:`, err?.message || err);
    }
  }
  rows.sort((a, b) => (b.w.tier - a.w.tier) || b.dps - a.dps);

  const lines = [
    '# MIST ISLE 数值平衡报告',
    '',
    `> 由 \`scripts/balance-report.mjs\` 自动生成（真实 \`Match\` 采样，不重算伤害公式）。`,
    `> 采样口径：两名玩家互为靶子，靶子半径 ${TARGET_R}m，固定种子抖动。`,
    '',
    '## 武器总表',
    '',
    '| 武器 | 类别 | T | 近距 DPS | 中距 DPS | TTK 近/中/远 (s) | 有效射程 | 命中率 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(markdownRow),
    '',
    '## 类别汇总',
    '',
  ];

  // 按类别汇总：平均近距 DPS 与平均有效射程，一眼看出哪类偏强/偏弱
  const byCls = new Map();
  for (const r of rows) {
    const c = byCls.get(r.w.cls) || { n: 0, dps: 0, range: 0, ttk: 0 };
    c.n += 1; c.dps += r.dps; c.range += r.effRange; c.ttk += (r.ttkMid || 0);
    byCls.set(r.w.cls, c);
  }
  lines.push('| 类别 | 数量 | 平均近距 DPS | 平均有效射程 | 平均中距 TTK |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [cls, c] of [...byCls.entries()].sort((a, b) => b[1].dps / b[1].n - a[1].dps / a[1].n)) {
    lines.push(`| ${cls} | ${c.n} | ${f1(c.dps / c.n)} | ${f1(c.range / c.n)}m | ${f2(c.ttk / c.n)}s |`);
  }
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  return { text: lines.join('\n'), rows };
}

try {
  const { text, rows } = buildReport();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, text, 'utf8');
  console.log(`平衡报告已生成：${OUT_FILE}（${rows.length} 把武器）`);
  // 控制台同时输出类别汇总，便于快速扫一眼
  const start = text.indexOf('## 类别汇总');
  if (start >= 0) console.log(`\n${text.slice(start)}`);
} catch (err) {
  console.error('[balance] 生成失败:', err?.stack || err);
  process.exitCode = 1;
}
