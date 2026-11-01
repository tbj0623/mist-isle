// 雾岛突围 / MIST ISLE 1.1 — 分析系统验证用假数据生成器（seed）
// ─────────────────────────────────────────────────────────────────────────────
// 生成 200 个会话 / 800 场对局的合成遥测，追加到 data/telemetry/YYYY-MM-DD.jsonl。
// 每行都带 "seed":true，并写一份 data/telemetry/_seed.json 清单；
// --clean 逐行剔除 seed:true 的行（文件里若混有真实遥测会被保留），
// 因此可以随时清干净，不会误删真实数据。
// 用法：
//   node scripts/analytics-seed.mjs               # 生成（默认 200 会话 / 800 场）
//   node scripts/analytics-seed.mjs --sessions 50 --matches 200
//   node scripts/analytics-seed.mjs --days 7      # 摊到最近 7 天
//   node scripts/analytics-seed.mjs --clean       # 删除所有 seed 数据
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { EVENTS, newSessionId } from '../shared/telemetry.mjs';
import { WEAPONS } from '../shared/data/weapons.mjs';

const ROOT = new URL('../data/telemetry/', import.meta.url);
const MANIFEST = '_seed.json';
const DAY = 86400000;
const WEAPON_IDS = ['ar7', 'ak12', 'v9', 'mp5k', 's12', 'm14', 'svd', 'awm', 'p90', 'p9', 'm60', 'crossbow']
  .filter((id) => WEAPONS[id]);
const SCREENS = ['home', 'play', 'loadout', 'store', 'career', 'missions', 'codex', 'settings', 'online'];
const MAPS = ['qinglan', 'chisha', 'baiye'];
const MODES = ['solo', 'squad', 'horde', 'training'];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const val = Number(args[i + 1]);
  return Number.isFinite(val) ? val : true;
};
const SESSIONS = Math.max(1, Number(flag('sessions', 200)) || 200);
const MATCHES = Math.max(1, Number(flag('matches', 800)) || 800);
const MATCH_BUDGET = Math.max(1, MATCHES / SESSIONS);
const DAYS = Math.max(1, Math.min(30, Number(flag('days', 3)) || 3));

// 确定性伪随机（种子固定）：同一命令每次生成同样的报告，便于比对回归。
let seedState = 0x2f6e2b1;
const rand = () => {
  seedState ^= seedState << 13; seedState >>>= 0;
  seedState ^= seedState >> 17;
  seedState ^= seedState << 5; seedState >>>= 0;
  return seedState / 0xffffffff;
};
const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
const int = (min, max) => Math.floor(min + rand() * (max - min + 1));
const gauss = (mean, sd) => {
  const u = Math.max(1e-6, rand()), v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// 武器平衡画像：使用率与击杀效率按「设计意图」设定，让报表能看出强弱差异。
const WEAPON_PROFILE = {
  ar7: { use: 0.26, kpm: 0.085, dist: 24 }, ak12: { use: 0.16, kpm: 0.080, dist: 21 },
  v9: { use: 0.14, kpm: 0.070, dist: 9 }, mp5k: { use: 0.08, kpm: 0.066, dist: 8 },
  s12: { use: 0.07, kpm: 0.110, dist: 6 }, m14: { use: 0.06, kpm: 0.075, dist: 33 },
  svd: { use: 0.05, kpm: 0.090, dist: 46 }, awm: { use: 0.03, kpm: 0.130, dist: 62 },
  p90: { use: 0.05, kpm: 0.062, dist: 10 }, p9: { use: 0.04, kpm: 0.045, dist: 7 },
  m60: { use: 0.04, kpm: 0.070, dist: 18 }, crossbow: { use: 0.02, kpm: 0.055, dist: 15 },
};
const profileOf = (id) => WEAPON_PROFILE[id] || { use: 0.01, kpm: 0.05, dist: 15 };
const WEAPON_POOL = WEAPON_IDS.flatMap((id) => Array.from({ length: Math.max(1, Math.round(profileOf(id).use * 100)) }, () => id));
const pickWeapon = () => (rand() < 0.82 ? pick(WEAPON_POOL) : pick(WEAPON_IDS));

const dayKey = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
const isoAt = (offset) => new Date(Date.now() - offset * DAY - Math.floor(rand() * DAY)).toISOString();

/** 单会话：生命周期 + 界面停留 + 漏斗 + 若干对局 + 经济。 */
function makeSession() {
  const sid = newSessionId();
  const dayOffset = Math.floor(rand() * DAYS);
  const base = Date.now() - dayOffset * DAY;
  const events = [];
  const push = (name, props, at) => {
    if (!EVENTS[name]) return;
    events.push({ name, sid, ts: base + at, v: 1, props, seed: true });
  };

  const quality = pick(['low', 'balanced', 'high']);
  const platform = pick(['web', 'mobile-web', 'android', 'android']);
  const firstClock = int(0, 3600) * 1000;
  let clock = firstClock;
  push('session_start', { platform, version: '1.1.0', quality }, clock);

  // 漏斗：每个会话必然经过 boot/home，其余步骤按留存曲线衰减。
  const reachPlay = rand() < 0.86;
  const reachDeploy = reachPlay && rand() < 0.80;
  const reachLive = reachDeploy && rand() < 0.90;
  const reachResult = reachLive && rand() < 0.86;
  push('funnel', { step: 'boot', ok: true }, clock);
  push('funnel', { step: 'home', ok: true }, clock + 1200);
  if (!reachPlay) {
    push('funnel', { step: 'play', ok: false }, clock + 2000);
    push('session_end', { durationMs: int(20, 90) * 1000, matchesPlayed: 0 }, clock + 9000);
    return { sid, dayOffset, events, matches: 0, clock };
  }
  push('funnel', { step: 'play', ok: true }, clock + 1800);

  // 界面停留：home 最长，商店/生涯次之，设置最短 —— 这些就是报表里「谁最耗时」。
  const screens = ['home', ...Array.from({ length: int(2, 6) }, () => pick(SCREENS))];
  for (const screen of screens) {
    const open = clock + int(1, 6) * 1000;
    push('screen_open', { screen, from: screen === 'home' ? 'boot' : 'home' }, open);
    const dwell = screen === 'home' ? int(4000, 26000)
      : screen === 'store' ? int(2500, 14000)
        : screen === 'career' || screen === 'missions' ? int(2000, 9000)
          : int(600, 4200);
    push('screen_leave', { screen, durationMs: dwell }, open + dwell);
    if (screen === 'store' && rand() < 0.45) {
      push('purchase', { itemId: pick(['skin_arctic', 'skin_dune', 'weapon_m14', 'battle_pass', 'emote_wave']), price: int(200, 1200), currency: 'credits' }, open + 900);
    }
    if (screen === 'missions' && rand() < 0.5) {
      push('mission_claim', { missionId: pick(['d_kills5', 'd_win1', 'w_damage3000', 'd_pickup10']), xp: int(80, 400) }, open + 700);
    }
    if (rand() < 0.18) push('dialog_open', { dialog: pick(['help-dialog', 'map-dialog', 'codex-dialog', 'settings']) }, open + 400);
    clock = open + dwell + int(200, 1500);
  }

  if (!reachDeploy) {
    push('funnel', { step: 'deploy', ok: false }, clock);
    push('session_end', { durationMs: int(60, 240) * 1000, matchesPlayed: 0 }, clock + 6000);
    return { sid, dayOffset, events, matches: 0, clock };
  }
  push('funnel', { step: 'deploy', ok: true }, clock + 800);
  if (!reachLive) {
    push('funnel', { step: 'live', ok: false }, clock + 2000);
    push('session_end', { durationMs: int(90, 300) * 1000, matchesPlayed: 0 }, clock + 9000);
    return { sid, dayOffset, events, matches: 0, clock };
  }
  push('funnel', { step: 'live', ok: true }, clock + 2600);

  // 对局：每会话 1–8 场，15% 的玩家打完一局就走 —— 这是真实流失点。
  const wanted = clamp(Math.round(gauss(MATCHES / SESSIONS, (MATCHES / SESSIONS) * 0.6)), 1, 8);
  let played = 0;
  for (let i = 0; i < wanted; i++) {
    const block = makeMatch(clock, reachLive);
    for (const ev of block.events) events.push({ ...ev, sid, ts: base + ev.ts });
    clock = block.endAt;
    played++;
    if (rand() < 0.15) break;
  }
  if (reachResult) push('funnel', { step: 'result', ok: true }, clock + 4000);
  push('session_end', { durationMs: Math.max(30000, clock - firstClock), matchesPlayed: played }, clock + int(3, 30) * 1000);
  return { sid, dayOffset, events, matches: played, clock };
}

/** 生成一局：match_start + 采样开火 + 击杀 + 死亡 + match_end（ts 为会话内相对毫秒）。 */
function makeMatch(startClock, live = true) {
  const events = [];
  const mode = rand() < 0.45 ? 'squad' : rand() < 0.7 ? 'solo' : pick(MODES);
  const mapId = pick(MAPS);
  const duration = int(180, 620);
  const push = (name, props, ts) => events.push({ name, ts, v: 1, props, seed: true });
  push('match_start', { mode, mapId, difficulty: pick(['rookie', 'veteran', 'elite']), offline: rand() < 0.35 }, startClock);
  if (!live) return { events, endAt: startClock + duration * 1000 };
  const fires = int(6, 32); // 已按 1/20 采样后的条数
  const weapon = pickWeapon();
  const prof = profileOf(weapon);
  for (let f = 0; f < fires; f++) {
    push('weapon_fire', {
      weaponId: rand() < 0.75 ? weapon : pickWeapon(),
      distance: Math.round(clamp(gauss(prof.dist, prof.dist * 0.45), 1, 120)),
    }, startClock + Math.floor((f / fires) * duration) * 1000);
  }
  const killCount = Math.max(0, Math.round(gauss(prof.kpm * fires, 1.2)));
  for (let k = 0; k < killCount; k++) {
    const kw = pickWeapon();
    push('weapon_kill', {
      weaponId: kw,
      distance: Math.round(clamp(gauss(profileOf(kw).dist, 12), 1, 140)),
      headshot: rand() < 0.28,
    }, startClock + int(10, duration) * 1000);
  }
  if (rand() < 0.7) {
    push('death', { killerWeapon: pickWeapon(), distance: Math.round(clamp(gauss(22, 16), 1, 130)), byHeadshot: rand() < 0.22 }, startClock + duration * 1000);
  }
  const placement = clamp(Math.round(gauss(6, 6)), 1, 20);
  push('match_end', {
    mode, mapId, placement, kills: killCount,
    damage: Math.round(killCount * clamp(gauss(170, 40), 90, 320)),
    survived: Math.min(duration, placement <= 3 ? duration : int(60, duration)),
    won: placement === 1 && rand() < 0.75,
  }, startClock + duration * 1000);
  return { events, endAt: startClock + duration * 1000 + int(2, 20) * 1000 };
}

async function clean() {
  let files = [], kept = 0, dropped = 0;
  try {
    const manifest = JSON.parse(await readFile(new URL(MANIFEST, ROOT), 'utf8'));
    files = (manifest.files || []).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch { files = []; }
  for (const file of files) {
    let text;
    try { text = await readFile(new URL(file, ROOT), 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter(Boolean);
    const isSeed = (line) => /"seed":\s*true/.test(line);
    const real = lines.filter((line) => !isSeed(line));
    dropped += lines.length - real.length;
    kept += real.length;
    if (real.length) await writeFile(new URL(file, ROOT), `${real.join('\n')}\n`, 'utf8');
    else { try { await unlink(new URL(file, ROOT)); } catch { /* 已删除 */ } }
  }
  try { await unlink(new URL(MANIFEST, ROOT)); } catch { /* 没生成过 */ }
  console.log(`已删除 ${dropped} 条 seed 事件，保留 ${kept} 条真实事件（清单 ${MANIFEST} 已移除）`);
}

async function main() {
  if (args.includes('--clean')) { await clean(); return; }
  await mkdir(ROOT, { recursive: true });
  const buckets = new Map();
  let totalMatches = 0, totalEvents = 0;
  const sessions = [];
  for (let i = 0; i < SESSIONS; i++) sessions.push(makeSession(i));
  for (const s of sessions) {
    totalMatches += s.matches;
    for (const ev of s.events) {
      const day = new Date(ev.ts).toISOString().slice(0, 10);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(`${JSON.stringify(ev)}\n`);
      totalEvents++;
    }
  }
  const written = [];
  for (const [day, lines] of [...buckets.entries()].sort()) {
    const name = `${day}.jsonl`;
    try { await appendFile(new URL(name, ROOT), lines.join(''), 'utf8'); } catch {
      await writeFile(new URL(name, ROOT), lines.join(''), 'utf8');
    }
    written.push({ name, events: lines.length });
  }
  await writeFile(new URL(MANIFEST, ROOT), JSON.stringify({
    seed: true, generatedAt: new Date().toISOString(), sessions: SESSIONS,
    matches: totalMatches, events: totalEvents, files: written.map((w) => w.name),
  }, null, 2), 'utf8');
  console.log(`seed 完成：${SESSIONS} 会话 / ${totalMatches} 场对局 / ${totalEvents} 条事件`);
  console.log(`追加到 ${written.length} 个文件（每行带 seed:true，清单 data/telemetry/${MANIFEST}）：`);
  for (const w of written) console.log(`  ${w.name}  ${w.events} 条`);
  console.log('清理：node scripts/analytics-seed.mjs --clean');
}

main().catch((err) => { console.error('seed 失败：', err); process.exit(1); });
