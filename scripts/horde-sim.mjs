#!/usr/bin/env node
// 雾岛突围 / MIST ISLE — 生存波次无渲染验收（node scripts/horde-sim.mjs）
// 用真实 Match + bot 队友跑完 20 波，断言：
//   1) 每波都能清（敌人会死，波次会推进）
//   2) 基地血量会掉，但不一定归零
//   3) 10 种升级都能买成功
//   4) 波次修正会正确应用（hordeRun.modifiers 与 HORDE.modifierEvery 对齐）
// 输出每波：敌人数量 / 类型 / 耗时 / 结算时基地血量。
import { performance } from 'node:perf_hooks';
import { Match } from '../shared/simulation.mjs';
import { HORDE } from '../shared/rules.mjs';
import { ENEMIES } from '../shared/data/enemies.mjs';

const TICK = 1 / 30;
const MAX_SECONDS = 60 * 60; // 1 小时模拟上限，防死循环
const args = process.argv.slice(2);
const SEED = Number(args.find((a) => a.startsWith('--seed='))?.split('=')[1] || 20261018);
const HUMAN_TEAM = 0;

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); return ok; };

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function pad(text, n) { return String(text).padEnd(n, ' '); }

/** 建一局：1 名「人类」（其实是脚本控制）+ 3 名 bot 队友，和线上 horde 一致。 */
function buildMatch(seed) {
  const m = new Match({ seed, mode: 'horde', maxPlayers: 8 });
  m.addPlayer('human', '指挥官', { team: HUMAN_TEAM });
  for (let i = 0; i < 3; i++) m.addPlayer(`bot${i + 1}`, `队友${i + 1}`, { bot: true, team: HUMAN_TEAM });
  m.start();
  return m;
}

/** 脚本操控「人类」：站在基地旁，朝最近敌人开火；顺便买升级。 */
function driveHuman(m, human) {
  const run = m.hordeRun;
  if (!run || !human || !human.alive) return;
  const base = run.base;
  let best = null;
  let bestD = 40;
  for (const e of run.enemies) {
    if (e.hp <= 0) continue;
    const d = Math.hypot(e.x - human.x, e.z - human.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  const input = m.emptyInput ? m.emptyInput() : {
    mx: 0, mz: 0, aim: 0, fire: false, reload: false, heal: false, interact: false, swap: false,
    ping: false, sprint: false, crouch: false, dodge: false, throwable: null, useItem: null,
    pingKind: 'move', slot: -1, revive: false, buy: null, upgrade: null, ready: false, seq: 0,
  };
  input.seq = (human.lastSeq || 0) + 1;
  if (best) {
    human.angle = Math.atan2(best.x - human.x, best.z - human.z);
    input.aim = human.angle;
    input.fire = bestD < 34;
    if (bestD > 14) { input.mx = Math.sin(human.angle) * 0.6; input.mz = Math.cos(human.angle) * 0.6; }
    input.reload = human.loadout?.[human.slot]?.ammo === 0;
  } else {
    const toBase = Math.hypot(human.x - base.x, human.z - base.z);
    if (toBase > 6) {
      const a = Math.atan2(base.x - human.x, base.z - human.z);
      input.mx = Math.sin(a); input.mz = Math.cos(a); input.aim = a;
    }
  }
  m.input('human', input);
}

/** 有闲钱就升级：按优先级买，买不起就跳过。 */
const BUY_ORDER = [
  'repair', 'turret', 'ammo', 'armor', 'medstation', 'slowfield',
  'barricade', 'weaponcache', 'overcharge', 'airstrike',
];
function autoBuy(m, bought) {
  const run = m.hordeRun;
  if (!run) return;
  for (const kind of BUY_ORDER) {
    const cost = m.upgradeCost(kind);
    if (!Number.isFinite(cost) || run.credits < cost) continue;
    if (m._buy(m.players[0], kind)) bought[kind] = (bought[kind] || 0) + 1;
  }
}

function main() {
  const m = buildMatch(SEED);
  const run = m.hordeRun;
  const human = m.players.find((p) => p.id === 'human');
  const bought = {};
  const waveRows = [];
  let lastWave = 0;
  let peakActive = 0;
  let tickTime = 0;
  let ticks = 0;
  const t0 = performance.now();

  let waveStart = 0;
  let buyTimer = 0;
  const origEmit = m._emit.bind(m);
  m._emit = (type, data) => {
    const ev = origEmit(type, data);
    if (type === 'waveClear') {
      waveRows.push({
        wave: data.wave,
        time: data.time ?? (m.time - waveStart),
        baseHp: data.baseHp ?? Math.round(run.base.hp),
        killed: data.killed ?? 0,
        modifier: data.modifier || '-',
        credits: data.credits,
      });
      waveStart = m.time;
    }
    return ev;
  };

  while (m.phase !== 'ended' && m.time < MAX_SECONDS) {
    driveHuman(m, human);
    const tickStart = performance.now();
    m.update(TICK);
    tickTime += performance.now() - tickStart;
    ticks++;
    peakActive = Math.max(peakActive, run.enemies.length);
    buyTimer += TICK;
    if (buyTimer >= 3) { buyTimer = 0; autoBuy(m, bought); }
    if (run.wave !== lastWave) { lastWave = run.wave; if (!waveStart) waveStart = m.time; }
  }
  const wall = performance.now() - t0;

  // ── 报表 ────────────────────────────────────────────────────────────────
  const line = (n) => console.log('-'.repeat(n));
  line(78);
  console.log(`雾岛突围 · 生存波次 20 波验收（seed=${SEED}）`);
  line(78);
  console.log(pad('波', 4) + pad('组成', 34) + pad('修正', 8) + pad('耗时', 9) + pad('基地', 8) + '击杀');
  line(78);
  for (const row of waveRows) {
    const entry = HORDE.waveTable[row.wave - 1];
    const comp = entry
      ? entry.composition.map((c) => `${ENEMIES[c.type].name}×${c.count}`).join(' ')
      : '无尽';
    console.log(
      pad(`#${row.wave}`, 4) + pad(comp.slice(0, 32), 34) + pad(row.modifier, 8)
      + pad(fmtTime(row.time), 9) + pad(`${row.baseHp}`, 8) + row.killed,
    );
  }
  line(78);

  // ── 断言 ────────────────────────────────────────────────────────────────
  const cleared = run.wave >= run.totalWaves || run.endless;
  check(cleared, `未能跑到第 20 波（停在 ${run.wave} 波）`);
  check(waveRows.length >= run.totalWaves, `清波记录只有 ${waveRows.length} 条，应 ≥ ${run.totalWaves}`);
  check(waveRows.every((r) => r.killed > 0), '存在没有任何击杀的波次（敌人没死）');
  check(run.base.hp < run.base.maxHp, '基地血量始终满值，敌人没造成压力');
  check(run.base.hp > 0 || m.resultReason === 'baseDestroyed', '基地血量数据异常');

  // 修正：每 3 波一个，且只能来自池子
  const expectMods = HORDE.waveTable.filter((w) => w.modifier || w.wave % HORDE.modifierEvery === 0).length;
  check(run.modifiers.length === expectMods,
    `修正数量 ${run.modifiers.length} ≠ 预期 ${expectMods}`);
  check(run.modifiers.every((id) => HORDE.modifierPool.includes(id)),
    `出现池外修正：${run.modifiers.join(',')}`);

  // 10 种升级
  const allUpgrades = Object.keys(HORDE.upgrades);
  const missing = allUpgrades.filter((k) => !bought[k]);
  check(missing.length === 0, `没能买到的升级：${missing.join(', ')}`);

  // 结算
  const summary = m.result?.horde || null;
  check(!!summary, 'result.horde 缺失');
  if (summary) {
    check(summary.totalWaves === 20, `战绩 totalWaves=${summary.totalWaves}`);
    check(summary.modifiers.length === run.modifiers.length, '战绩 modifiers 与运行时不一致');
    check(summary.kills > 0 && summary.bossKills >= 4, '战绩击杀/首领击杀异常');
    check(summary.cleared === (m.resultReason === 'cleared'), '清关标记与结束原因不一致');
  }

  // 性能
  const avgTick = tickTime / Math.max(1, ticks);
  const peakHp = run.base.maxHp;

  console.log(`结束原因     : ${m.resultReason || '—'}`);
  console.log(`最终波次     : ${run.wave} / ${run.totalWaves}${run.endless ? '（无尽）' : ''}`);
  console.log(`模拟时长     : ${fmtTime(m.time)}（${ticks} tick，墙钟 ${(wall / 1000).toFixed(2)}s）`);
  console.log(`基地血量     : ${Math.round(run.base.hp)} / ${peakHp}`);
  console.log(`击杀 / 首领  : ${run.kills} / ${run.bossKills}`);
  console.log(`得分 / 信用点: ${Math.round(run.score)} / ${Math.round(run.credits)}`);
  console.log(`波次修正     : ${run.modifiers.join(' → ') || '无'}`);
  console.log(`升级购买     : ${allUpgrades.map((k) => `${HORDE.upgrades[k].name}×${bought[k] || 0}`).join('  ')}`);
  console.log(`峰值同屏敌人 : ${peakActive}（上限 ${HORDE.maxActive}）`);
  console.log(`平均 tick    : ${avgTick.toFixed(3)} ms（30Hz 预算 33.3ms）`);
  line(78);
  if (fail.length) {
    console.log(`✖ 失败 ${fail.length} 项：`);
    for (const f of fail) console.log(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('✔ 全部断言通过（每波可清 / 基地承压 / 10 种升级可买 / 修正正确 / 战绩完整）');
}

main();
