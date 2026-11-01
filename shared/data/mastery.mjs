// 雾岛突围 / MIST ISLE — 武器精通与配件解锁曲线（共享纯数据，无 DOM / 无 Node API）
// ─────────────────────────────────────────────────────────────────────────────
// 设计口径：
//   · 每把枪独立成长，Lv1→Lv10 累计 6900 XP（xpTable 为累计门槛，不是每级差值）。
//   · 一局「主用一把枪 3 杀 + 15 命中」= 45×3 + 3×15 + 25 = 205 XP → 满级约 34 局。
//   · 每级都有奖励：Lv2 本系配件提前解锁 / Lv4 战地涂装 / Lv6 击杀播报语音 /
//     Lv8 枪械挂件 / Lv10 专属称号 + 金色涂装；Lv3/5/7/9 补信用点，避免「空级」。
//   · 配件不再「掉落即满配」：ATTACHMENT_UNLOCKS 把 14 个配件按武器系分配，
//     本系在 Lv1–6 逐步解锁；跨系要再晚 2 级（设计强绑定，不是数值惩罚）。
//   · 所有 id 均来自 shared/data/weapons.mjs（18 把枪 / 14 个配件），本文件不复制武器表。
// ─────────────────────────────────────────────────────────────────────────────
import { WEAPONS, WEAPON_ORDER, ATTACHMENTS, ATTACHMENT_ORDER } from './weapons.mjs';

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 十级称号（下标 0 = Lv1）
export const MASTERY_TITLES = ['初识', '熟练', '老练', '精锐', '猎手', '老手', '专家', '大师', '宗师', '本命'];
export const MASTERY_MAX_XP = 6900;
export const CROSS_CLASS_PENALTY = 2; // 非本系武器解锁同一配件要晚 2 级

// 奖励模板里的 {weapon} 由 rewardsAtLevel(level, weaponId) 替换为真实武器 id。
export const MASTERY = {
  maxLevel: 10,
  title: '武器精通',
  xpTable: [0, 120, 320, 640, 1100, 1750, 2600, 3700, 5100, 6900],
  xpPerKill: 45,
  xpPerHit: 3,
  xpPerMatch: 25,
  xpPerWin: 120,
  levels: [
    {
      level: 1, title: '初识', tag: '入门',
      desc: '第一次把这把枪的保险拨到连发。',
      rewards: [{ kind: 'emblem', id: 'emblem_{weapon}', name: '精通徽记 · 初识' }],
    },
    {
      level: 2, title: '熟练', tag: '配件',
      desc: '知道它什么时候会跳，也知道该怎么压。',
      rewards: [{ kind: 'attachment', id: 'auto:2', name: '本系 Lv2 配件提前解锁' }],
    },
    {
      level: 3, title: '老练', tag: '信用点',
      desc: '换弹的节奏开始变成肌肉记忆。',
      rewards: [{ kind: 'credits', amount: 250, name: '信用点 ×250' }],
    },
    {
      level: 4, title: '精锐', tag: '涂装',
      desc: '枪身上该有自己的记号了。',
      rewards: [{ kind: 'skin', id: '{weapon}_field', name: '战地涂装' }],
    },
    {
      level: 5, title: '猎手', tag: '信用点',
      desc: '听见枪声就能判断距离和口径。',
      rewards: [{ kind: 'credits', amount: 450, name: '信用点 ×450' }],
    },
    {
      level: 6, title: '老手', tag: '播报',
      desc: '你的击杀开始有专属的播报声。',
      rewards: [{ kind: 'voice', id: 'voice_kill_{weapon}', name: '击杀播报语音' }],
    },
    {
      level: 7, title: '专家', tag: '信用点',
      desc: '同一把枪在你手里像换过零件。',
      rewards: [{ kind: 'credits', amount: 700, name: '信用点 ×700' }],
    },
    {
      level: 8, title: '大师', tag: '挂件',
      desc: '枪背带上多了一个只有你懂的挂件。',
      rewards: [{ kind: 'charm', id: 'charm_{weapon}', name: '枪械挂件' }],
    },
    {
      level: 9, title: '宗师', tag: '信用点',
      desc: '岛上开始有人照着你的配装抄。',
      rewards: [{ kind: 'credits', amount: 1000, name: '信用点 ×1000' }],
    },
    {
      level: 10, title: '本命', tag: '本命',
      desc: '这把枪不再是你捡到的，而是你认领的。',
      rewards: [
        { kind: 'title', id: 'master_{weapon}', name: '专属称号 · 本命' },
        { kind: 'skin', id: '{weapon}_gold', name: '金色涂装' },
      ],
    },
  ],
};

// 配件解锁矩阵：reqMasteryLevel 是本系（或本枪）的解锁等级，14 件全部落在 Lv2–6；
// 其他武器系要 +CROSS_CLASS_PENALTY 级（上限 10）。
// 覆盖约束（tests/mastery.test.mjs 会校验）：
//   1) 8 个武器系各自都有至少 1 件「本系 Lv2 且该系武器真有这个槽位」的配件，升到 Lv2 必兑现；
//   2) 每件的槽位在该系至少一把枪上存在（例：机枪只有 optic/muzzle/grip，弹匣类不派给 lmg）。
// 注意：红点镜 = 步枪 Lv2，而 DEFAULT_LOADOUT 默认带 red_dot，
// 接线必须先用 sanitizeAttachments 过滤默认配装（补丁见交付简报第 5 节）。
export const ATTACHMENT_UNLOCKS = {
  // optic —— 本系主力瞄具
  red_dot: { weaponClass: 'rifle', reqMasteryLevel: 2, note: '步枪基础瞄具，先有准星再谈枪法' },
  holo: { weaponClass: 'smg', reqMasteryLevel: 2, note: '冲锋枪近战视野环' },
  scope_4x: { weaponClass: 'marksman', reqMasteryLevel: 2, note: '精准步枪中距点名' },
  scope_8x: { weaponClass: 'sniper', reqMasteryLevel: 6, note: '狙击远程镜，本系最后一件' },
  // muzzle
  muzzle_brake: { weaponClass: 'pistol', reqMasteryLevel: 2, note: '手枪起手的制退' },
  choke: { weaponClass: 'shotgun', reqMasteryLevel: 2, note: '霰弹收束，贴脸更硬' },
  compensator: { weaponClass: 'lmg', reqMasteryLevel: 2, note: '机枪连发压枪，架点前先稳住' },
  suppressor: { weaponClass: 'sniper', reqMasteryLevel: 2, note: '狙击消音，藏枪线' },
  // mag
  ext_mag: { weaponClass: 'rifle', reqMasteryLevel: 3, note: '步枪扩容，压制不断火' },
  quick_mag: { weaponClass: 'smg', reqMasteryLevel: 4, note: '冲锋枪快拔，贴脸换弹快半拍' },
  drum_mag: { weaponClass: 'shotgun', reqMasteryLevel: 6, note: '霰弹弹鼓，本系满配的最后一块' },
  // grip
  angled_grip: { weaponClass: 'special', reqMasteryLevel: 2, note: '特种武器快速举枪' },
  vertical_grip: { weaponClass: 'special', reqMasteryLevel: 4, note: '特种武器垂直握把，连点不飘' },
  bipod: { weaponClass: 'lmg', reqMasteryLevel: 5, note: '机枪两脚架，架住就是一条封锁线' },
  // 1.3.0 高阶件：只给满级（reqMasteryLevel = MASTERY.maxLevel）——
  // 「练到本命才拿得到」是精通系统存在的意义，不能让它们在中段就能解锁。
  scope_12x: { weaponClass: 'sniper', reqMasteryLevel: 10, note: '十二倍镜，狙击专精的终点' },
  heavy_brake: { weaponClass: 'lmg', reqMasteryLevel: 9, note: '重型制退，机枪连发的最后一块拼图' },
  twin_drum: { weaponClass: 'shotgun', reqMasteryLevel: 10, note: '双鼓弹仓，霰弹压制的极限' },
  match_trigger: { weaponClass: 'marksman', reqMasteryLevel: 9, note: '竞赛扳机，精准位的手感上限' },
};
const LEVEL_BY_XP = (() => {
  const table = MASTERY.xpTable;
  return total => {
    let level = 1;
    while (level < MASTERY.maxLevel && total >= table[level]) level++;
    return level;
  };
})();

// 单局每把武器的原始贡献（kills / hits），供 masteryXpFromMatch 与客户端复用。
export function weaponContributions(summary = {}) {
  const s = summary || {};
  const list = weaponsFromSummary(s);
  if (!list.length) return [];
  const share = 1 / list.length;
  const stats = s.weaponStats && typeof s.weaponStats === 'object' ? s.weaponStats : null;
  return list.map((entry) => {
    const own = stats && stats[entry.id] ? stats[entry.id] : null;
    return {
      weaponId: entry.id,
      kills: Math.max(0, num(own?.kills, num(entry.kills, num(s.kills) * share))),
      hits: Math.max(0, num(own?.hits, num(entry.hits, num(s.shotsHit) * share))),
    };
  });
}

// 本局「主武器」：贡献最高的一把；options.primaryWeapon 在平票时优先。
export function primaryWeaponOf(summary = {}, options = {}) {
  const rows = weaponContributions(summary);
  if (!rows.length) return null;
  const preferred = options && options.primaryWeapon;
  let best = null;
  for (const row of rows) {
    const score = row.kills * MASTERY.xpPerKill + row.hits * MASTERY.xpPerHit
      + (preferred && row.weaponId === preferred ? 1e-6 : 0);
    if (!best || score > best.score) best = { weaponId: row.weaponId, score };
  }
  return best ? best.weaponId : null;
}

// 单把武器本局经验（kills × xpPerKill + hits × xpPerHit，主武器额外拿参战/吃鸡分）。
// summary.weapons 支持 ['ar7','p9'] / [{ id, kills, hits }] / { ar7: true } 三种形态；
// 只给 id 时按武器数均分击杀与命中。训练场恒为 0（防刷）。
export function masteryXpFromMatch(summary = {}, weaponId = null, options = {}) {
  const s = summary || {};
  if (s.mode === 'training' || !weaponId) return 0;
  const row = weaponContributions(s).find(item => item.weaponId === weaponId);
  if (!row) return 0;
  let xp = row.kills * MASTERY.xpPerKill + row.hits * MASTERY.xpPerHit;
  if (primaryWeaponOf(s, options) === weaponId) {
    xp += MASTERY.xpPerMatch;
    if (s.won) xp += MASTERY.xpPerWin;
  }
  return Math.max(0, Math.round(xp));
}

// 单局出现过的武器（去重、过滤不存在的 id）；供客户端逐把结算，也供 UI 展示。
export function weaponsFromSummary(summary = {}) {
  const s = summary || {};
  return normalizeWeaponEntries(s.weapons ?? s.weaponsUsed);
}

function normalizeWeaponEntries(value) {
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || !entry.id || seen.has(entry.id) || !WEAPONS[entry.id]) return;
    seen.add(entry.id);
    out.push(entry);
  };
  if (typeof value === 'string') push({ id: value });
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') push({ id: item });
      else if (item && typeof item === 'object') push({ ...item, id: item.id || item.weapon });
    }
  } else if (value && typeof value === 'object') {
    for (const [id, flag] of Object.entries(value)) if (flag) push({ id });
  }
  return out;
}

// 累计 XP → { level, current, needed, progress, maxed }；0 XP 视为 Lv1（入门但尚未升级）。
export function masteryLevelFromXp(xp = 0) {
  const table = MASTERY.xpTable;
  const total = Math.max(0, Math.floor(num(xp)));
  const level = LEVEL_BY_XP(total);
  const maxed = level >= MASTERY.maxLevel;
  const base = table[level - 1];
  const nextAt = maxed ? null : table[level];
  const needed = maxed ? 0 : nextAt - base;
  const current = maxed ? 0 : Math.min(needed, total - base);
  return {
    level, current, needed, nextAt, maxed, total,
    progress: maxed ? 1 : clamp(current / Math.max(1, needed), 0, 1),
  };
}

export function masteryTitle(level) {
  const lv = clamp(Math.floor(num(level, 1)), 1, MASTERY.maxLevel);
  return MASTERY.levels[lv - 1]?.title || MASTERY_TITLES[0];
}

// 某级奖励深拷贝；传 weaponId 时把 {weapon} 占位符换成真实 id，并给名称加武器简称。
export function rewardsAtLevel(level = 1, weaponId = null) {
  const lv = clamp(Math.floor(num(level, 1)), 1, MASTERY.maxLevel);
  const def = MASTERY.levels[lv - 1];
  if (!def) return [];
  const short = weaponId ? WEAPONS[weaponId]?.short || weaponId : '';
  return def.rewards.map((reward) => {
    const item = { ...reward, level: lv };
    if (typeof item.id === 'string') item.id = item.id.replaceAll('{weapon}', weaponId || '{weapon}');
    if (short && ['skin', 'voice', 'charm', 'emblem', 'title'].includes(item.kind)) {
      item.name = `${short} · ${item.name}`;
    }
    return item;
  });
}

// 同一把枪从 fromLevel 升到 toLevel 之间的所有奖励（含 toLevel）
export function rewardsBetween(fromLevel, toLevel, weaponId = null) {
  const from = clamp(Math.floor(num(fromLevel, 0)), 0, MASTERY.maxLevel);
  const to = clamp(Math.floor(num(toLevel, 0)), 0, MASTERY.maxLevel);
  const out = [];
  for (let lv = Math.max(1, from + 1); lv <= to; lv++) out.push(...rewardsAtLevel(lv, weaponId));
  return out;
}

// 某配件在某把枪上的实际解锁等级（跨系 +2，上限 10）
export function requiredLevelFor(attachmentId, weaponId) {
  const rule = ATTACHMENT_UNLOCKS[attachmentId];
  const w = WEAPONS[weaponId];
  if (!rule || !w) return Infinity;
  if (rule.universal) return 1;
  if (rule.weaponId) {
    return rule.weaponId === weaponId ? rule.reqMasteryLevel : Math.min(MASTERY.maxLevel, rule.reqMasteryLevel + CROSS_CLASS_PENALTY);
  }
  if (rule.weaponClass === w.cls) return rule.reqMasteryLevel;
  return Math.min(MASTERY.maxLevel, rule.reqMasteryLevel + CROSS_CLASS_PENALTY);
}

// 当前精通等级下，这把枪实际能装的配件 id（只返回该枪有对应槽位的）
export function unlockCheck(weaponId, masteryLevel = 0) {
  const w = WEAPONS[weaponId];
  if (!w) return [];
  const lv = clamp(Math.floor(num(masteryLevel, 0)), 0, MASTERY.maxLevel);
  return ATTACHMENT_ORDER.filter((id) => {
    const att = ATTACHMENTS[id];
    if (!att || !ATTACHMENT_UNLOCKS[id]) return false;
    if (Array.isArray(w.slots) && !w.slots.includes(att.slot)) return false;
    return lv >= requiredLevelFor(id, weaponId);
  });
}

// 下一个即将解锁的配件（用于「再打 3 局解锁 4 倍镜」提示）
export function nextAttachmentUnlock(weaponId, masteryLevel = 0) {
  const w = WEAPONS[weaponId];
  if (!w) return null;
  const lv = clamp(Math.floor(num(masteryLevel, 0)), 0, MASTERY.maxLevel);
  let best = null;
  for (const id of ATTACHMENT_ORDER) {
    const att = ATTACHMENTS[id];
    if (!att || !ATTACHMENT_UNLOCKS[id]) continue;
    if (Array.isArray(w.slots) && !w.slots.includes(att.slot)) continue;
    const need = requiredLevelFor(id, weaponId);
    if (!Number.isFinite(need) || need <= lv) continue;
    if (!best || need < best.atLevel) best = { attachmentId: id, name: att.name, atLevel: need };
  }
  return best;
}

// 汇总表：始终返回 18 条（与 WEAPON_ORDER 对齐），未使用武器 level 0 / xp 0。
export function masterySummary(playerMastery = {}) {
  const source = playerMastery && typeof playerMastery === 'object' ? playerMastery : {};
  return WEAPON_ORDER.map((weaponId) => {
    const entry = source[weaponId] && typeof source[weaponId] === 'object' ? source[weaponId] : {};
    const xp = Math.max(0, Math.floor(num(entry.xp)));
    if (xp <= 0) {
      return {
        weaponId, name: WEAPONS[weaponId].name, class: WEAPONS[weaponId].cls,
        level: 0, title: '未入门', xp: 0, nextAt: MASTERY.xpTable[0],
        progress: 0, maxed: false, unlockedSkin: null, kills: 0, hits: 0, matches: 0,
      };
    }
    const info = masteryLevelFromXp(xp);
    const skin = info.level >= 10 ? `${weaponId}_gold` : info.level >= 4 ? `${weaponId}_field` : null;
    return {
      weaponId, name: WEAPONS[weaponId].name, class: WEAPONS[weaponId].cls,
      level: info.level, title: masteryTitle(info.level), xp,
      nextAt: info.nextAt, progress: info.progress, maxed: info.maxed,
      unlockedSkin: skin,
      kills: Math.max(0, num(entry.kills)), hits: Math.max(0, num(entry.hits)),
      matches: Math.max(0, num(entry.matches)),
    };
  });
}

// 全部武器等级之和（成就/称号用；18 × 10 = 180 满值）
export function totalMasteryLevel(playerMastery = {}) {
  return masterySummary(playerMastery).reduce((sum, row) => sum + row.level, 0);
}
