// 雾岛突围 / MIST ISLE — 武器精通测试（node --test tests/mastery.test.mjs）
// 覆盖：数据表结构 / 等级边界 / 单局 XP / 配件矩阵引用完整性 / Tracker 累加与幂等 /
//       满级封顶 / 配件随等级增长 / 旧档迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTERY, ATTACHMENT_UNLOCKS, masteryLevelFromXp, masteryXpFromMatch, rewardsAtLevel,
  rewardsBetween, unlockCheck, masterySummary, masteryTitle, requiredLevelFor,
  nextAttachmentUnlock, weaponsFromSummary, weaponContributions,
  totalMasteryLevel as sharedTotal, MASTERY_MAX_XP,
} from '../shared/data/mastery.mjs';
import { WEAPONS, WEAPON_ORDER, ATTACHMENTS, ATTACHMENT_ORDER } from '../shared/data/weapons.mjs';
import { MasteryTracker, migrateMastery, matchKeyOf, MAX_MATCH_KEYS } from '../client/mastery.js';
import { MemoryStorage, Meta } from '../client/meta.js';

const CLASSES = ['pistol', 'smg', 'rifle', 'shotgun', 'marksman', 'sniper', 'lmg', 'special'];
const newTracker = () => new MasteryTracker(new Meta(new MemoryStorage()));
const view = (t, id) => { const v = t.get(id); return [v.xp, v.level, v.kills, v.hits, v.matches]; };
const match = (over = {}) => ({
  matchId: `m-${Math.random().toString(36).slice(2)}`, weapons: ['ar7'], kills: 3, shotsHit: 15, ...over,
});

test('1. MASTERY 结构：10 级、xpTable 单调递增、每级有 rewards', () => {
  assert.deepEqual([MASTERY.maxLevel, MASTERY.levels.length, MASTERY.xpTable.length], [10, 10, 10]);
  assert.deepEqual([MASTERY.xpTable[0], MASTERY.xpTable[9]], [0, 6900], 'Lv1=0，满级 6900');
  for (let i = 1; i < 10; i++) assert.ok(MASTERY.xpTable[i] > MASTERY.xpTable[i - 1], `xpTable[${i}] 必须递增`);
  const titles = new Set();
  MASTERY.levels.forEach((def, i) => {
    assert.equal(def.level, i + 1);
    assert.ok(def.title && def.title.length >= 2, `Lv${i + 1} 需要称号`);
    assert.ok(Array.isArray(def.rewards) && def.rewards.length > 0, `Lv${i + 1} 必须有奖励`);
    for (const r of def.rewards) assert.ok(r.kind, `Lv${i + 1} 奖励缺 kind`);
    titles.add(def.title);
  });
  assert.equal(titles.size, 10, '10 级称号不能重复');
  // 关键等级奖励类型：Lv2 配件 / Lv4 皮肤 / Lv6 播报 / Lv8 挂件 / Lv10 称号 + 金皮
  for (const [lv, kind] of [[2, 'attachment'], [4, 'skin'], [6, 'voice'], [8, 'charm']]) {
    assert.ok(rewardsAtLevel(lv).some(r => r.kind === kind), `Lv${lv} 应有 ${kind}`);
  }
  assert.deepEqual(rewardsAtLevel(10, 'awm').map(r => r.id).sort(), ['awm_gold', 'master_awm'], 'Lv10 称号+金皮');
  assert.deepEqual([MASTERY.xpPerKill, MASTERY.xpPerHit, MASTERY.xpPerMatch, MASTERY.xpPerWin], [45, 3, 25, 120]);
});

test('2. masteryLevelFromXp 全边界 0/119/120/…/6900/99999', () => {
  const table = MASTERY.xpTable;
  const cases = [[0, 1], [1, 1], [119, 1], [120, 2], [319, 2], [320, 3], [639, 3], [640, 4],
    [1099, 4], [1100, 5], [1749, 5], [1750, 6], [2599, 6], [2600, 7], [3699, 7], [3700, 8],
    [5099, 8], [5100, 9], [6899, 9], [6900, 10], [99999, 10]];
  for (const [xp, level] of cases) {
    const info = masteryLevelFromXp(xp);
    assert.equal(info.level, level, `${xp} XP 应为 Lv${level}`);
    assert.ok(info.progress >= 0 && info.progress <= 1);
  }
  for (let i = 0; i < table.length - 2; i++) {
    const info = masteryLevelFromXp(table[i + 1]);
    assert.equal(info.current, 0, `Lv${i + 2} 门槛处 current=0`);
    assert.equal(info.needed, table[i + 2] - table[i + 1], `Lv${i + 2} needed 为下一档差`);
  }
  const top = masteryLevelFromXp(6900), below = masteryLevelFromXp(119);
  assert.deepEqual([top.maxed, top.needed, top.progress, top.nextAt], [true, 0, 1, null]);
  assert.deepEqual([below.current, below.needed, below.nextAt], [119, 120, 120]);
  assert.deepEqual([masteryLevelFromXp(-50).level, masteryLevelFromXp(NaN).level, masteryLevelFromXp('320').level], [1, 1, 3]);
  assert.deepEqual([masteryTitle(1), masteryTitle(10), masteryTitle(99)], ['初识', '本命', '本命']);
});

test('3. masteryXpFromMatch：吃鸡 vs 落地成盒，205 XP 基准 → 34 局满级', () => {
  assert.equal(masteryXpFromMatch({ weapons: ['ar7'], kills: 3, shotsHit: 15 }, 'ar7'), 205, '45*3+3*15+25');
  assert.equal(masteryXpFromMatch({ weapons: ['ar7'], kills: 3, shotsHit: 15, won: true }, 'ar7'), 325, '吃鸡 +120');
  assert.equal(masteryXpFromMatch({ weapons: ['ar7'], kills: 0, shotsHit: 0, placement: 40 }, 'ar7'), 25, '落地成盒只有参战分');
  assert.equal(masteryXpFromMatch({ weapons: ['ar7'], kills: 3, shotsHit: 15 }, 'p9'), 0, '未出场武器不加分');
  assert.equal(masteryXpFromMatch({ weapons: [], kills: 3, shotsHit: 15 }, 'ar7'), 0);
  assert.equal(masteryXpFromMatch({ mode: 'training', weapons: ['ar7'], kills: 3, shotsHit: 15 }, 'ar7'), 0, '训练场不计');
  const dual = { weapons: ['ar7', 'p9'], kills: 4, shotsHit: 20, won: true };
  const ar = masteryXpFromMatch(dual, 'ar7'), p9 = masteryXpFromMatch(dual, 'p9');
  assert.ok(ar > p9, '主武器分更高');
  assert.equal(ar + p9, 45 * 4 + 3 * 20 + 25 + 120, '分枪不膨胀总分');
  const perWeapon = { weapons: [{ id: 'ar7', kills: 3, hits: 10 }, { id: 'p9', kills: 1, hits: 5 }] };
  assert.deepEqual([masteryXpFromMatch(perWeapon, 'ar7'), masteryXpFromMatch(perWeapon, 'p9')], [45 * 3 + 3 * 10 + 25, 45 + 15]);
  assert.equal(Math.ceil(6900 / 205), 34, '满级约 34 局');
  assert.ok(masteryXpFromMatch(match(), 'ar7') * 34 >= 6900 && masteryXpFromMatch(match(), 'ar7') * 33 < 6900);
  const rows = weaponContributions({ weapons: ['ar7', 'p9'], kills: 4, shotsHit: 20 });
  assert.deepEqual([rows.reduce((s, r) => s + r.kills, 0), weaponsFromSummary({ weapons: { ar7: true, p9: true, bad: true } }).length], [4, 2]);
});

test('4. ATTACHMENT_UNLOCKS：全部配件有规则，引用 id 全部真实，门槛合法', () => {
  const ids = Object.keys(ATTACHMENT_UNLOCKS);
  assert.equal(ids.length, ATTACHMENT_ORDER.length,
    `每个配件都必须有精通规则：ATTACHMENT_UNLOCKS ${ids.length} vs ATTACHMENT_ORDER ${ATTACHMENT_ORDER.length}`);
  const classes = new Set(WEAPON_ORDER.map(id => WEAPONS[id].cls));
  const ruleOf = (id) => ATTACHMENT_UNLOCKS[id];
  for (const [attachmentId, rule] of Object.entries(ATTACHMENT_UNLOCKS)) {
    assert.ok(ATTACHMENTS[attachmentId], `${attachmentId} 必须是真实配件`);
    // 门槛必须落在 [2, MASTERY.maxLevel]：2 = 「不能开局就有」，上限 = 精通满级。
    // 1.3.0 新增的 4 件高阶件故意放在 9–10（满级档），不能再写死 ≤6。
    assert.ok(Number.isInteger(rule.reqMasteryLevel) && rule.reqMasteryLevel >= 2 && rule.reqMasteryLevel <= MASTERY.maxLevel,
      `${attachmentId} 门槛须是 Lv2–${MASTERY.maxLevel} 整数，实际 ${rule.reqMasteryLevel}`);
    const owner = rule.weaponClass || rule.weaponId;
    assert.ok(owner, `${attachmentId} 必须指定 weaponClass 或 weaponId`);
    if (rule.weaponClass) assert.ok(classes.has(rule.weaponClass), `${attachmentId} 的 class 不存在`);
    if (rule.weaponId) assert.ok(WEAPONS[rule.weaponId], `${attachmentId} 的 weaponId 不存在`);
    const slot = ATTACHMENTS[attachmentId].slot;
    const pool = rule.weaponId ? [rule.weaponId] : WEAPON_ORDER.filter(id => WEAPONS[id].cls === rule.weaponClass);
    assert.ok(pool.some(id => WEAPONS[id].slots.includes(slot)), `${attachmentId}(${slot}) 在 ${owner} 上没有槽位`);
  }
  for (const cls of CLASSES) {
    const attainable = ATTACHMENT_ORDER.filter((id) => ruleOf(id).weaponClass === cls && ruleOf(id).reqMasteryLevel <= 2
      && WEAPON_ORDER.some(w => WEAPONS[w].cls === cls && WEAPONS[w].slots.includes(ATTACHMENTS[id].slot)));
    assert.ok(attainable.length >= 1, `${cls} 缺少 Lv2 可兑现配件`);
  }
  assert.equal(requiredLevelFor('red_dot', 'p9'), ruleOf('red_dot').reqMasteryLevel + 2, '跨系 +2');
  assert.equal(requiredLevelFor('nope', 'ar7'), Infinity);
  for (const id of WEAPON_ORDER) {
    assert.deepEqual(unlockCheck(id, 1), [], `${id} Lv1 不能有任何配件`);
    const counts = Array.from({ length: MASTERY.maxLevel + 1 }, (_, lv) => unlockCheck(id, lv).length);
    counts.forEach((n, lv) => assert.ok(lv === 0 || n >= counts[lv - 1], `${id} Lv${lv} 解锁数单调不减`));
    assert.ok(counts.at(-1) > 0, `${id} 满级解锁数须多于 Lv1`);
    const slots = new Set(unlockCheck(id, MASTERY.maxLevel).map(a => ATTACHMENTS[a].slot));
    for (const slot of WEAPONS[id].slots) {
      if (ATTACHMENT_ORDER.some(a => ATTACHMENTS[a].slot === slot)) assert.ok(slots.has(slot), `${id} 满级 ${slot} 应有配件`);
    }
  }
  assert.deepEqual(unlockCheck('ar7', 2), ['red_dot']);
  assert.deepEqual([nextAttachmentUnlock('ar7', 1).attachmentId, nextAttachmentUnlock('ar7', 1).atLevel], ['red_dot', 2]);
  assert.equal(nextAttachmentUnlock('ar7', 10), null);
});

test('5. recordMatch 正确累加 xp/kills/hits/matches 并持久化', () => {
  const t = newTracker();
  assert.deepEqual([t.all().length, t.totalMasteryLevel(), t.all().every(r => r.level === 0)], [WEAPON_ORDER.length, 0, true], `新档 ${WEAPON_ORDER.length} 条全 0 级`);
  const [up] = t.recordMatch(match({ matchId: 'a1' })).updates;
  assert.deepEqual([up.weaponId, up.gained, up.before, up.after, up.beforeLevel, up.afterLevel, up.leveledUp],
    ['ar7', 205, 0, 205, 0, 2, true]);
  const v = t.get('ar7');
  assert.deepEqual([v.title, v.current, v.needed, v.nextAt], ['熟练', 85, 200, 320]);
  t.recordMatch(match({ matchId: 'a2', kills: 4, shotsHit: 20 }));
  assert.deepEqual(view(t, 'ar7'), [205 + 45 * 4 + 3 * 20 + 25, 3, 7, 35, 2], '第二局累加而非覆盖');
  t.recordMatch({ matchId: 'a3', weapons: ['p9', 'v9'], kills: 2, shotsHit: 10 });
  assert.ok(t.get('p9').xp > 0 && t.get('v9').xp > 0, '多武器各自累加');
  assert.deepEqual(view(new MasteryTracker(t.meta), 'ar7'), view(t, 'ar7'), '重新实例化能读回');
  assert.ok(Array.isArray(t.meta.data.masteryMeta.lastMatchKeys), '去重键随档落盘');
});

test('6. recordMatch 幂等：matchId / endedAt 去重，最多 20 个键', () => {
  const t = newTracker();
  const summary = { matchId: 'dup-1', weapons: ['ar7'], kills: 3, shotsHit: 15 };
  assert.equal(t.recordMatch(summary).skipped, null);
  const snapshot = view(t, 'ar7');
  const second = t.recordMatch({ ...summary });
  assert.deepEqual([second.skipped, second.updates.length], ['duplicate', 0]);
  assert.deepEqual(view(t, 'ar7'), snapshot, '重复结算不加 XP / 场次');
  const t2 = newTracker();
  const ended = { endedAt: 1730000000000, weapons: ['ar7'], kills: 3, shotsHit: 15 };
  t2.recordMatch(ended);
  assert.deepEqual([t2.recordMatch({ ...ended }).skipped, t2.recordMatch({ ...ended, endedAt: 1730000000001 }).skipped], ['duplicate', null]);
  const fp = newTracker();
  const firstFingerprint = fp.recordMatch({ weapons: ['ar7'], kills: 1, shotsHit: 1 });
  assert.ok(String(firstFingerprint.key).startsWith('c:'), '无 matchId 时用内容指纹兜底');
  assert.equal(fp.recordMatch({ weapons: ['ar7'], kills: 1, shotsHit: 1 }).skipped, 'duplicate', '同内容同窗口去重');
  assert.deepEqual([newTracker().recordMatch({}).skipped, newTracker().recordMatch({}).key], ['no-match-key', null], '空 summary 无法识别');
  const t4 = newTracker();
  for (let i = 0; i < MAX_MATCH_KEYS + 8; i++) t4.recordMatch({ matchId: `k-${i}`, weapons: ['ar7'], kills: 1 });
  assert.equal(t4.lastMatchKeys.length, MAX_MATCH_KEYS);
  assert.equal(t4.lastMatchKeys.at(-1), `m:k-${MAX_MATCH_KEYS + 7}`);
  assert.ok(!t4.lastMatchKeys.includes('m:k-0'), '最老的键被淘汰');
  assert.equal(t4.get('ar7').matches, MAX_MATCH_KEYS + 8, '淘汰键不影响已结算场次');
  assert.deepEqual([matchKeyOf({ matchId: 7 }), matchKeyOf({ endedAt: 99 }), matchKeyOf({})], ['m:7', 't:99', null]);
  assert.ok(matchKeyOf({ matchId: '', weapons: ['ar7'], kills: 2 }).startsWith('c:'), '空 matchId 退回指纹');
});

test('7. Lv10 封顶：XP 不再增长，场次/击杀继续累计', () => {
  const t = newTracker();
  t.data = { ar7: { xp: MASTERY_MAX_XP, level: 10, kills: 100, hits: 400, matches: 34 } };
  const before = t.get('ar7');
  assert.deepEqual([before.level, before.maxed, before.nextAt, before.progress], [10, true, null, 1]);
  const [up] = t.recordMatch({ matchId: 'cap-1', weapons: ['ar7'], kills: 12, shotsHit: 60, won: true }).updates;
  assert.deepEqual([up.gained, up.after, up.leveledUp, up.rewards.length], [0, MASTERY_MAX_XP, false, 0]);
  assert.deepEqual(view(t, 'ar7'), [MASTERY_MAX_XP, 10, 112, 460, 35]);
  const t2 = newTracker();
  t2.data = { ar7: { xp: 6850, level: 9, kills: 0, hits: 0, matches: 0 } };
  t2.recordMatch({ matchId: 'cap-2', weapons: ['ar7'], kills: 10, shotsHit: 60 });
  assert.deepEqual([t2.get('ar7').xp, t2.get('ar7').level], [MASTERY_MAX_XP, 10], '越界 XP 夹到 6900');
  const t3 = newTracker();
  t3.data = { ar7: { xp: 999999, level: 10, kills: 0, hits: 0, matches: 0 } };
  assert.deepEqual([t3.get('ar7').xp, t3.totalMasteryLevel()], [MASTERY_MAX_XP, 10]);
});

test('8. unlockedAttachments 随等级增长并遵守槽位约束', () => {
  const t = newTracker();
  assert.deepEqual(t.unlockedAttachments('ar7'), [], 'Lv1 无配件');
  const growth = [];
  for (const [xp, level] of [[120, 2], [640, 4], [1750, 6], [3700, 8], [6900, 10]]) {
    t.data.ar7 = { xp, level: 0, kills: 0, hits: 0, matches: 0 };
    const unlocked = t.unlockedAttachments('ar7');
    assert.equal(t.get('ar7').level, level, `${xp} XP 应为 Lv${level}`);
    growth.push(unlocked.length);
    for (const id of unlocked) assert.ok(WEAPONS.ar7.slots.includes(ATTACHMENTS[id].slot), `${id} 槽位在 ar7 不存在`);
    if (level >= 2) assert.ok(unlocked.includes('red_dot'), `Lv${level} 应解锁红点`);
  }
  for (let i = 1; i < growth.length; i++) assert.ok(growth[i] >= growth[i - 1], '解锁数单调不减');
  t.data.ar7 = { xp: MASTERY_MAX_XP, level: 10, kills: 0, hits: 0, matches: 0 };
  assert.deepEqual(t.unlockedAttachments('ar7'),
    ATTACHMENT_ORDER.filter(id => WEAPONS.ar7.slots.includes(ATTACHMENTS[id].slot)), '满级解锁全部合法配件');
  assert.deepEqual(t.unlockedAttachments('awm'), [], '未使用武器为空');
  t.data.ar7 = { xp: 120, level: 2, kills: 0, hits: 0, matches: 0 };
  assert.deepEqual(t.lockedAttachments('ar7', ['red_dot', 'scope_8x']), ['scope_8x']);
  assert.deepEqual(t.sanitizeAttachments('ar7', ['red_dot', 'scope_8x']), ['red_dot']);
});

test('9. 旧数据迁移：无 mastery 字段 / 数字形态 / 包裹形态都安全', () => {
  const storage = new MemoryStorage();
  storage.setItem('mist-isle-save-v1', JSON.stringify({
    version: 1, xp: 0, level: 1, credits: 500, stats: {},
    unlocked: { weapons: [], skins: [], modes: [], items: [] },
    loadout: {}, missions: {}, achievements: {}, streak: {}, settings: {},
  }));
  const t = new MasteryTracker(new Meta(storage));
  assert.deepEqual([t.all().length, t.totalMasteryLevel(), t.lastMatchKeys.length], [WEAPON_ORDER.length, 0, 0], 'v1 档安全初始化');
  t.recordMatch({ matchId: 'legacy-1', weapons: ['ar7'], kills: 1, shotsHit: 3 });
  assert.equal(t.get('ar7').xp, 45 + 9 + 25, '迁移后首次结算正常');
  assert.deepEqual(Object.keys(migrateMastery({ ar7: 500, p9: { xp: 120, kills: 2 } })).sort(), ['ar7', 'p9']);
  assert.equal(migrateMastery({ ar7: 500 }).ar7.level, 3, '数字形态按 XP 换算等级');
  assert.equal(migrateMastery({ p9: { xp: 120, kills: 2 } }).p9.kills, 2);
  assert.deepEqual(migrateMastery({ nope: 999 }), {}, '未知武器丢弃');
  assert.deepEqual([migrateMastery(null), migrateMastery('bad'), migrateMastery({ ar7: -5 })], [{}, {}, {}]);
  assert.equal(migrateMastery({ weapons: { v9: 640 } }).v9.level, 4, 'weapons 包裹形态');
  assert.equal(migrateMastery({ mastery: { v9: 640 } }).v9.level, 4, 'mastery 包裹形态');
  const t4 = newTracker();
  t4.data = { ar7: { xp: 1000, level: 4, kills: 5, hits: 20, matches: 3 } };
  t4.migrate({ ar7: 120, p9: 320 });
  assert.deepEqual([t4.get('ar7').xp, t4.get('p9').xp], [1000, 320], '迁移不降级已有 XP');
  t4.migrate({ ar7: 2000 });
});

test('10. 汇总接口：masterySummary / totalMasteryLevel / 文案 / 导出往返', () => {
  const data = { ar7: { xp: 205 }, awm: { xp: 6900 } };
  const rows = masterySummary(data);
  assert.deepEqual([rows.length, rows.map(r => r.weaponId)], [WEAPON_ORDER.length, WEAPON_ORDER], `${WEAPON_ORDER.length} 条且顺序对齐`);
  assert.deepEqual([rows.find(r => r.weaponId === 'ar7').level, rows.find(r => r.weaponId === 'ar7').title, rows.find(r => r.weaponId === 'ar7').nextAt], [2, '熟练', 320]);
  assert.deepEqual([rows.find(r => r.weaponId === 'awm').level, rows.find(r => r.weaponId === 'awm').maxed, rows.find(r => r.weaponId === 'awm').unlockedSkin], [10, true, 'awm_gold']);
  assert.deepEqual([sharedTotal(data), masterySummary({}).length, masterySummary(null).length], [12, WEAPON_ORDER.length, WEAPON_ORDER.length]);
  assert.equal(masterySummary({ ar7: { xp: 640 } }).find(r => r.weaponId === 'ar7').unlockedSkin, 'ar7_field', 'Lv4 战地涂装');
  const lv10ar = rewardsAtLevel(10, 'ar7');
  assert.ok(lv10ar.some(r => r.id === 'master_ar7') && lv10ar.some(r => r.id === 'ar7_gold'));
  assert.deepEqual([rewardsBetween(2, 3, 'ar7').map(r => r.level), rewardsBetween(4, 4, 'ar7').length], [[3], 0]);
  assert.ok(rewardsBetween(7, 10, 'ar7').length >= 3);
  const tracker = newTracker();
  tracker.data = { ar7: { xp: 205, level: 2, kills: 3, hits: 15, matches: 1 } };
  assert.match(tracker.describe('ar7'), /Lv2/);
  tracker.data.ar7 = { xp: 6900, level: 10, kills: 0, hits: 0, matches: 34 };
  assert.match(tracker.describe('ar7'), /已满级/);
  const restored = newTracker();
  restored.fromJSON(tracker.toJSON());
  assert.equal(restored.get('ar7').xp, 6900, 'toJSON/fromJSON 往返');
});
