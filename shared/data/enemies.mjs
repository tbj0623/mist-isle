// 雾岛突围 / MIST ISLE 1.0 — 生存波次敌人图鉴（共享数据，无 DOM）
// 数值唯一真源是 rules.HORDE.enemies；本文件只做「派生视图 + 查询函数」，
// 这样调优时只改 rules.mjs 一处，图鉴/客户端/模拟层自动同步。
import { HORDE } from '../rules.mjs';

/** 敌人种类顺序（图鉴、波次编排队列、测试都按这个顺序）。 */
export const ENEMY_ORDER = ['crawler', 'runner', 'brute', 'spitter', 'bomber', 'boss'];

/** 行为标签（策划案口径，客户端/HUD 可读）。 */
export const ENEMY_BEHAVIORS = {
  advance: '直线推进',
  flank: '绕后突袭',
  ranged: '远程吐酸',
  kamikaze: '近身自爆',
  boss: '首领技能',
};

/** 图鉴文案：与数值分离，避免调数值时反复改文案。 */
const LORE = {
  crawler: '被雾侵蚀的岛民，成群结队、动作迟钝，靠数量淹没防线。',
  runner: '四肢修长的猎犬，会绕开正面火力，优先扑向后排的活人。',
  brute: '披着废钢甲壳的重装个体，慢，但一锤就能把人掀飞。',
  spitter: '背囊里装满酸液，能在 15 米外把腐蚀性黏液抛进据点。',
  bomber: '体内长着不稳定核心的自爆个体，靠近就炸，被打爆也会炸。',
  boss: '雾岛之主。冲锋、召唤、震地三招循环，双首领出现在第 20 波。',
};

/** 体型标签（客户端低模据此决定比例）。 */
const SIZE = { crawler: 'small', runner: 'slim', brute: 'wide', spitter: 'bulky', bomber: 'round', boss: 'huge' };

/** 威胁度 1–5（图鉴排序/波次提示用）。 */
const THREAT = { crawler: 1, runner: 2, brute: 3, spitter: 3, bomber: 4, boss: 5 };

/** 扁平化后的敌人定义（保留 rules 里的全部字段，另加 derived 字段）。 */
export const ENEMIES = Object.freeze(Object.fromEntries(ENEMY_ORDER.map((id) => {
  const base = HORDE.enemies[id];
  if (!base) throw new Error(`HORDE.enemies 缺少 ${id}`);
  return [id, Object.freeze({
    ...base,
    behaviorName: ENEMY_BEHAVIORS[base.behavior] || base.behavior,
    desc: LORE[id] || '',
    size: SIZE[id] || 'small',
    threat: THREAT[id] || 1,
  })];
})));

/** 方便 `import { HORDE_ENEMY_LIST }` 直接遍历。 */
export const HORDE_ENEMY_LIST = ENEMY_ORDER.map((id) => ENEMIES[id]);

export const ENEMY_IDS = ENEMY_ORDER.slice();

export function getEnemy(id) { return ENEMIES[id] || null; }

/** 图鉴视图（ui-screens 的 enemyCatalog() 可直接吃 world.data.enemies）。 */
export function enemyCatalog() {
  return HORDE_ENEMY_LIST.map((e) => ({
    id: e.id, name: e.name, desc: e.desc, hp: e.hp, damage: e.damage,
    threat: e.threat, color: e.color, behavior: e.behavior, behaviorName: e.behaviorName,
    size: e.size, xp: e.xp, credits: e.credits, boss: e.kind === 'boss',
  }));
}

/**
 * 单波敌人总数（已含蜂群修正的取整规则）。
 * @param {{composition: Array<{type: string, count: number}>}} entry
 * @param {{countMul?: number}} [mod]
 */
export function waveEnemyCount(entry, mod = null) {
  if (!entry || !Array.isArray(entry.composition)) return 0;
  const mul = mod && Number.isFinite(mod.countMul) ? mod.countMul : 1;
  let total = 0;
  for (const part of entry.composition) total += Math.max(0, Math.round(part.count * mul));
  return total;
}

/**
 * 展开成刷怪队列（按 kind 分组、首领最后出场，避免一开场就被 boss 贴脸）。
 * @returns {Array<{type: string, count: number}>}
 */
export function waveSpawnQueue(entry, mod = null) {
  if (!entry || !Array.isArray(entry.composition)) return [];
  const mul = mod && Number.isFinite(mod.countMul) ? mod.countMul : 1;
  const normal = [];
  const bosses = [];
  for (const part of entry.composition) {
    const def = ENEMIES[part.type];
    if (!def) continue;
    const count = Math.max(0, Math.round(part.count * mul));
    if (!count) continue;
    (def.kind === 'boss' ? bosses : normal).push({ type: part.type, count });
  }
  return normal.concat(bosses);
}

/** 第 wave 波的编排（1-based）；超过 20 波返回无尽模板。 */
export function waveEntry(wave) {
  const table = HORDE.waveTable;
  if (wave >= 1 && wave <= table.length) return table[wave - 1];
  return null;
}

/** 无尽模式（21 波起）的组成：20 波的骨架上按波数加量，去掉固定首领数量。 */
export function endlessEntry(wave) {
  const over = Math.max(1, wave - HORDE.endlessAfter);
  const grow = Math.floor(over * HORDE.endlessCountStep);
  const comp = [
    { type: 'crawler', count: 26 + grow },
    { type: 'runner', count: 20 + Math.floor(grow * 0.8) },
    { type: 'brute', count: 8 + Math.floor(over * 0.6) },
    { type: 'spitter', count: 8 + Math.floor(over * 0.5) },
    { type: 'bomber', count: 6 + Math.floor(over * 0.5) },
  ];
  if (wave % HORDE.bossEvery === 0) comp.push({ type: 'boss', count: 1 + Math.floor(over / 6) });
  return { wave, composition: comp, modifier: null };
}

/** 某波应出场的首领数量（16 波起双首领）。 */
export function bossCountFor(entry) {
  if (!entry || !Array.isArray(entry.composition)) return 0;
  let n = 0;
  for (const part of entry.composition) if (part.type === 'boss') n += part.count;
  return n;
}

/** 复活时间分段：1–5 波 6s / 6–12 波 10s / 13+ 波 14s。 */
export function reviveTimeFor(wave) {
  const w = Math.max(1, Math.floor(Number(wave) || 1));
  const tiers = HORDE.reviveTiers;
  for (let i = 0; i < tiers.length; i++) if (w <= tiers[i].maxWave) return tiers[i].time;
  return tiers[tiers.length - 1].time;
}

/** 波次修正：本次是否该抽（每 3 波一个）。 */
export function shouldRollModifier(wave) {
  return wave > 0 && wave % HORDE.modifierEvery === 0;
}

/**
 * 按规则抽修正：编排里写了 modifier 就用编排的，否则用 rng 从池里抽。
 * rng 必须是 match.rng（确定性），禁止 Math.random。
 */
export function rollModifier(rng, wave, entry = null) {
  if (entry && entry.modifier) return HORDE.modifiers[entry.modifier] || null;
  if (!shouldRollModifier(wave)) return null;
  const pool = HORDE.modifierPool;
  const roll = typeof rng === 'function' ? rng() : 0;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return HORDE.modifiers[pool[idx]] || null;
}

/** 图鉴导出别名（shared/data/index.mjs 会转出）。 */
export const ENEMY_CATALOG = enemyCatalog();

export default ENEMIES;
