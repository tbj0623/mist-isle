// AI 战术基准：三档难度（新兵/老兵/精锐）各 5 队 × 4 人同场互打 N 局，
// 输出各档胜率 / 前 25% 率 / KD / 圈死比例 / 平均存活时间，以及每 tick 的
// AI 决策耗时（隔离测量 thinkBot，不污染战绩局）。
// 用法：node scripts/ai-bench.mjs [局数=12]
import { Match } from '../shared/simulation.mjs';
import { thinkBot } from '../shared/ai.mjs';

const GAMES = Math.max(1, Number(process.argv[2] || 12));
const TICK = 1 / 30;
const MAX_TICKS = 30 * 430; // 单局硬上限：毒圈全程 264s + 决赛余量
const TIERS = ['recruit', 'veteran', 'elite'];
const TIER_NAMES = { recruit: '新兵', veteran: '老兵', elite: '精锐' };
const TEAMS_PER_TIER = 5;
const SQUAD = 4;
const TOTAL_TEAMS = TEAMS_PER_TIER * TIERS.length;
const tierOfTeam = (t) => TIERS[t % TIERS.length]; // 15 队轮转 → 每档恰好 5 队

function buildMatch(seed) {
  const m = new Match({
    mapId: 'qinglan', seed, mode: 'squad', maxPlayers: TOTAL_TEAMS * SQUAD,
    duration: 420, difficulty: 'veteran',
  });
  for (let t = 0; t < TOTAL_TEAMS; t++) {
    for (let k = 0; k < SQUAD; k++) {
      m.addPlayer(`b${t}_${k}`, `Bot${t}_${k}`, { bot: true, team: t, difficulty: tierOfTeam(t) });
    }
  }
  m.start();
  return m;
}

function blankPer() {
  const per = {};
  for (const t of TIERS) {
    per[t] = { wins: 0, teamsTop: 0, kills: 0, deaths: 0, zone: 0, revived: 0, surv: 0, n: 0 };
  }
  return per;
}

/** 跑一局完整对局并收集三档战绩。 */
function runGame(seed) {
  const m = buildMatch(seed);
  const idTeam = new Map();
  for (const p of m.players) idTeam.set(p.id, p.team);
  const cur = blankPer();
  const stats = { throws: 0, heals: 0, pickups: 0, vehicles: 0, downs: 0, nades: {} };
  for (const t of TIERS) stats.nades[t] = { frag: 0, smoke: 0, flash: 0, molotov: 0 };
  const origEmit = m._emit.bind(m);
  m._emit = (kind, data) => {
    if (kind === 'kill' && data && data.by == null) {
      // 圈死/环境死（毒圈与车载爆炸都不带击杀者）
      const per = cur[tierOfTeam(idTeam.get(data.player))];
      if (per) per.zone++;
    } else if (kind === 'revived' && data) {
      const per = cur[tierOfTeam(idTeam.get(data.by))];
      if (per) per.revived++;
    } else if (kind === 'down') stats.downs++;
    else if (kind === 'throw' && data) {
      stats.throws++;
      const tier = tierOfTeam(idTeam.get(data.player));
      if (stats.nades[tier][data.kind] !== undefined) stats.nades[tier][data.kind]++;
    } else if (kind === 'healStart') stats.heals++;
    else if (kind === 'pickup') stats.pickups++;
    else if (kind === 'vehicle') stats.vehicles++;
    return origEmit(kind, data);
  };
  const t0 = process.hrtime.bigint();
  let ticks = 0;
  for (let i = 0; i < MAX_TICKS && m.phase !== 'ended'; i++) { m.update(TICK); ticks++; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const ranks = (m.result && m.result.ranks && m.result.ranks.length)
    ? m.result.ranks : m._teamRanks();
  if (ranks.length) cur[tierOfTeam(ranks[0].team)].wins++;
  for (const r of ranks) {
    if (r.rank <= 4) cur[tierOfTeam(r.team)].teamsTop++; // 16 队的前 25% = 前 4
  }
  for (const p of m.players) {
    const s = cur[tierOfTeam(p.team)];
    s.kills += p.kills;
    if (!p.alive) s.deaths++;
    s.surv += (p.deadAt > 0 ? p.deadAt : m.time);
    s.n++;
  }
  return { per: cur, stats, ticks, ms, reason: m.result ? m.result.reason : 'capped' };
}

/** 性能局：每 tick 先隔离跑一遍 thinkBot（结束后还原 think 状态），
 *  得到纯决策耗时不影响对局本身；simMs 是完整 update 的每 tick 耗时。 */
function perfRun() {
  const m = buildMatch(998244353);
  let aiNs = 0n;
  let simNs = 0n;
  let n = 0;
  for (let i = 0; i < 1800 && m.phase !== 'ended'; i++) {
    const t0 = process.hrtime.bigint();
    const ps = m.players;
    for (let j = 0; j < ps.length; j++) {
      const p = ps[j];
      if (!p.bot || !p.alive) continue;
      const saved = p.think;
      try { thinkBot(m, p, TICK); } catch (err) { /* 性能采样局，吞掉即可 */ }
      p.think = saved;
      p.botInput = null;
    }
    const t1 = process.hrtime.bigint();
    m.update(TICK);
    const t2 = process.hrtime.bigint();
    aiNs += t1 - t0;
    simNs += t2 - t1;
    n++;
  }
  return { aiMs: Number(aiNs) / 1e6 / Math.max(1, n), simMs: Number(simNs) / 1e6 / Math.max(1, n), n };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const agg = blankPer();
let totTicks = 0;
let totMs = 0;
let totThrow = 0;
let totHeal = 0;
let totPickup = 0;
let totVehicle = 0;
let totDowns = 0;
let endedCount = 0;
const nadeAgg = {};
for (const t of TIERS) nadeAgg[t] = { frag: 0, smoke: 0, flash: 0, molotov: 0 };

for (let g = 0; g < GAMES; g++) {
  const r = runGame(1100 + g * 17);
  totTicks += r.ticks;
  totMs += r.ms;
  totThrow += r.stats.throws;
  totHeal += r.stats.heals;
  totPickup += r.stats.pickups;
  totVehicle += r.stats.vehicles;
  totDowns += r.stats.downs;
  if (r.reason !== 'capped') endedCount++;
  for (const t of TIERS) {
    const a = agg[t];
    const s = r.per[t];
    a.wins += s.wins;
    a.teamsTop += s.teamsTop;
    a.kills += s.kills;
    a.deaths += s.deaths;
    a.zone += s.zone;
    a.revived += s.revived;
    a.surv += s.surv;
    a.n += s.n;
    for (const k of Object.keys(nadeAgg[t])) nadeAgg[t][k] += r.stats.nades[t][k];
  }
}

const perf = perfRun();

const pct = (v, d) => `${(v * 100).toFixed(d ?? 1)}%`;
console.log(`\n=== 雾岛突围 AI 基准：三档同场互打 ${GAMES} 局（每档 ${TEAMS_PER_TIER} 队 × ${SQUAD} 人，青岚岛） ===`);
console.log('难度    胜率    前25%队率   KD      圈死占比   平均存活   救人/局   手雷/烟/闪/燃（全档累计）');
for (const t of TIERS) {
  const a = agg[t];
  const winRate = a.wins / GAMES;
  const topRate = a.teamsTop / (TEAMS_PER_TIER * GAMES);
  const kd = a.kills / Math.max(1, a.deaths);
  const zoneRatio = a.zone / Math.max(1, a.deaths);
  const avgSurv = a.surv / Math.max(1, a.n);
  const revPerGame = a.revived / GAMES;
  const n = nadeAgg[t];
  console.log(
    `${TIER_NAMES[t].padEnd(4)}  ${pct(winRate).padEnd(7)} ${pct(topRate).padEnd(11)}`
    + ` ${kd.toFixed(2).padEnd(7)} ${pct(zoneRatio).padEnd(10)}`
    + ` ${avgSurv.toFixed(0).padStart(3)}s      ${revPerGame.toFixed(1)}       `
    + `${n.frag}/${n.smoke}/${n.flash}/${n.molotov}`,
  );
}
console.log(`\n行为计数/局：投掷 ${ (totThrow / GAMES).toFixed(1) }，治疗 ${ (totHeal / GAMES).toFixed(1) }，`
  + `拾取 ${ (totPickup / GAMES).toFixed(0) }，载具事件 ${ (totVehicle / GAMES).toFixed(0) }，`
  + `倒地 ${ (totDowns / GAMES).toFixed(1) }；完整结束 ${endedCount}/${GAMES} 局`);
console.log(`对局耗时：${ (totMs / GAMES / 1000).toFixed(1) }s/局（${ (totTicks / GAMES).toFixed(0) } ticks/局）`);
console.log(`性能（60 bot）：AI 决策 ${perf.aiMs.toFixed(3)} ms/tick，整帧 update ${perf.simMs.toFixed(3)} ms/tick（采样 ${perf.n} ticks）`);
