// 雾岛突围 / MIST ISLE — 1.3.0 内容扩容质量门禁（node --test tests/content-expansion.test.mjs）
// ─────────────────────────────────────────────────────────────────────────────
// 只做「断言级」校验，不修改任何数据：失败即数据缺陷信号，按消息里的 file:line 去处修。
// 与既有测试的分工：
//   · tests/data.test.mjs 守字段区间、TTK 命中数、掉落表权重与配件合成的局部正确性；
//   · tests/progression.test.mjs 守任务结算流程与商店购买流程；
//   · tests/mastery.test.mjs 守精通等级曲线与配件随等级增长。
// 本文件补的是扩容后最容易失守的「横向约束」：顺序表一致、付费枪不该更弱、tier 不该倒挂、
// 配件 mods 必须真的被 applyAttachmentMods 读取、精通矩阵与配件表一一对应、metric 可结算、
// 商店价格-稀有度梯度、掉落池只引用真实 id。
//
// 口径说明（避免把设计取舍误判成数据缺陷）：
//   1) DPS 一律用 weapons.mjs 导出的 sustainedDps()（含换弹循环的「持续 DPS」）。这与
//      weapons.mjs 的平衡注释（P226 换弹 1.40→1.20 修掉「付费更差」、M14 换弹 2.30→3.00
//      修掉「最贵更弱」）以及 docs/ACCEPTANCE.md「持续 DPS 在 25–210 之间」的口径一致。
//      面板 DPS（damage × pellets / interval）不进门禁：1.3.0 明确让部分高阶枪
//      「用射速换稳定/单发」（AK12 重弹头慢射速、VSS 慢射速换单发、SVD 降射速保 TTK、
//      AWM 重狙），用面板 DPS 会把这些写进注释的设计意图判成失败，产生噪声。
//   2) ACHIEVEMENTS 的 metric 判定为「可结算」而非「必须属于 MISSION_METRICS」：
//      achievements.mjs 头部写明「metric 与 MISSION_METRICS 对齐，另加单局型与特殊型计数」，
//      progression.achievementValue() 负责 matchDamage / top3Streak / bestAccuracy 等单局键，
//      emptyMeta().stats 提供其余累计键。只有三者都不认的 metric 才是真缺陷（进度恒为 0）。
//   3) STORE_ITEMS 里 price:0 但 rarity 非 common 的条目，只允许是成就奖励
//      （unlock.achievement）——那是进度解锁的替代路径，不是「免费商品」。
//      凡能用信用点购买（unlockSource().kind === 'credits'）的条目，price 必须 > 0。
//   4) 商店稀有度梯度按 item.kind 分组（STORE_ITEMS 的 kind 统一是 'other'），
//      同稀有度内自由定价；只有「更贵却更稀有度低」才判倒挂。
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AMMO_TYPES,
  WEAPON_CLASSES,
  WEAPONS,
  WEAPON_ORDER,
  ATTACHMENTS,
  ATTACHMENT_ORDER,
  LOOT_WEAPON_POOL,
  sustainedDps,
  burstDps,
} from '../shared/data/weapons.mjs';
import { ARMORS, CONSUMABLES, ITEM_LOOKUP } from '../shared/data/items.mjs';
import { LOOT_TABLES } from '../shared/data/loot.mjs';
import { DAILY_POOL, WEEKLY_POOL, MISSION_METRICS } from '../shared/data/missions.mjs';
import { ACHIEVEMENTS } from '../shared/data/achievements.mjs';
import { ATTACHMENT_UNLOCKS, MASTERY } from '../shared/data/mastery.mjs';
import { STORE_ITEMS, unlockSource } from '../shared/data/store.mjs';
import { RARITY } from '../shared/rules.mjs';
import { emptyMeta } from '../shared/progression.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = join(HERE, '..', 'shared');
const readSharedSource = (relativePath) => readFileSync(join(SHARED_DIR, relativePath), 'utf8');

// ±5% 容差：只吸收数值微调，不放过「贵 10% 以上还更弱」的档位倒挂。
const DPS_TOLERANCE = 0.05;
const fmtDps = (value) => value.toFixed(1);
const fmtDrop = (value, reference) => (((reference - value) / reference) * 100).toFixed(1) + '%';

// 反解 sustainedDps：要把某把枪的持续 DPS 拉到 target 以上，reload 最多能是多少秒。
// 失败消息里带上这个数，修数据时不用再手算（改 magazine/interval 也能改，但先看得到边界）。
function maxReloadForSustainedDps(weapon, target) {
  const perShot = weapon.damage * (weapon.pellets || 1);
  const mag = Math.max(1, weapon.magazine);
  return (perShot * mag) / target - (mag - 1) * weapon.interval;
}

// 定位道具 id 在源文件里的行号，让失败消息能直接 file:line 跳转。
function lineOf(sourceText, id) {
  const lines = sourceText.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(`'${id}'`));
  return index >= 0 ? index + 1 : 0;
}

// 剥离 // 行注释、/* */ 块注释，但保留字符串/模板串内容（URL 里的 // 不能被误删）。
// 静态扫描必须先过这一层：weapons.mjs 的注释里写了大量 `mods.adsZoom`、`noise` 等字样，
// 直接 regex 会把「文档承诺」当成「代码读取」。
function stripComments(source) {
  let out = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === '\\') {
        if (next !== undefined) out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
    index += 1;
  }
  return out;
}

// 按 cls 分组，保持 WEAPON_ORDER 的稳定顺序（失败消息里的 id 顺序固定，便于 diff）。
const weaponsByClass = () => {
  const groups = new Map();
  for (const id of WEAPON_ORDER) {
    const weapon = WEAPONS[id];
    if (!groups.has(weapon.cls)) groups.set(weapon.cls, []);
    groups.get(weapon.cls).push(weapon);
  }
  return groups;
};

test('1. 顺序表一致性：WEAPON_ORDER / ATTACHMENT_ORDER 与数据表一一对应', () => {
  const weaponIds = Object.keys(WEAPONS);
  assert.equal(
    WEAPON_ORDER.length,
    weaponIds.length,
    `WEAPON_ORDER 长度 ${WEAPON_ORDER.length} 必须等于 WEAPONS 键数 ${weaponIds.length}`,
  );
  const weaponMissing = weaponIds.filter((id) => !WEAPON_ORDER.includes(id));
  const weaponUnknown = WEAPON_ORDER.filter((id) => !Object.hasOwn(WEAPONS, id));
  assert.deepEqual(weaponUnknown, [], `WEAPON_ORDER 含 WEAPONS 里不存在的武器 id：${weaponUnknown.join(', ')}`);
  assert.deepEqual(
    weaponMissing,
    [],
    `WEAPONS 里有武器未进 WEAPON_ORDER（UI/精通遍历会漏枪）：${weaponMissing.join(', ')}`,
  );
  assert.equal(
    new Set(WEAPON_ORDER).size,
    WEAPON_ORDER.length,
    `WEAPON_ORDER 存在重复 id，集合与长度不自洽：${WEAPON_ORDER.join(', ')}`,
  );
  assert.deepEqual(new Set(WEAPON_ORDER), new Set(weaponIds), 'WEAPON_ORDER 集合必须与 Object.keys(WEAPONS) 完全相等');

  const attachmentIds = Object.keys(ATTACHMENTS);
  assert.equal(
    ATTACHMENT_ORDER.length,
    attachmentIds.length,
    `ATTACHMENT_ORDER 长度 ${ATTACHMENT_ORDER.length} 必须等于 ATTACHMENTS 键数 ${attachmentIds.length}`,
  );
  const attachmentMissing = attachmentIds.filter((id) => !ATTACHMENT_ORDER.includes(id));
  const attachmentUnknown = ATTACHMENT_ORDER.filter((id) => !Object.hasOwn(ATTACHMENTS, id));
  assert.deepEqual(attachmentUnknown, [], `ATTACHMENT_ORDER 含不存在的配件 id：${attachmentUnknown.join(', ')}`);
  assert.deepEqual(
    attachmentMissing,
    [],
    `ATTACHMENTS 里有配件未进 ATTACHMENT_ORDER（图鉴/精通遍历会漏件）：${attachmentMissing.join(', ')}`,
  );
  assert.equal(
    new Set(ATTACHMENT_ORDER).size,
    ATTACHMENT_ORDER.length,
    `ATTACHMENT_ORDER 存在重复 id：${ATTACHMENT_ORDER.join(', ')}`,
  );
  assert.deepEqual(
    new Set(ATTACHMENT_ORDER),
    new Set(attachmentIds),
    'ATTACHMENT_ORDER 集合必须与 Object.keys(ATTACHMENTS) 完全相等',
  );
});

test('2. 武器经济性：同类付费武器持续 DPS 不低于免费武器（±5% 容差）', () => {
  let compared = 0;
  for (const [cls, list] of weaponsByClass()) {
    const free = list.filter((weapon) => weapon.price === 0);
    if (!free.length) continue;
    // 同类别可能有多把免费枪，取其中 DPS 最高的一把作为基准（最严口径）。
    const freeTop = free.reduce((best, weapon) => (sustainedDps(weapon) > sustainedDps(best) ? weapon : best));
    const freeDps = sustainedDps(freeTop);
    for (const paid of list.filter((weapon) => weapon.price > 0)) {
      const paidDps = sustainedDps(paid);
      compared += 1;
      assert.ok(
        paidDps >= freeDps * (1 - DPS_TOLERANCE),
        `武器经济性倒挂：${cls} 内付费 ${paid.id}（price ${paid.price}）持续 DPS ${fmtDps(paidDps)} ` +
          `低于免费 ${freeTop.id} 的 ${fmtDps(freeDps)}，低 ${fmtDrop(paidDps, freeDps)}（容差 5%）；` +
          `面板 DPS 参考 ${paid.id} ${fmtDps(burstDps(paid))} vs ${freeTop.id} ${fmtDps(burstDps(freeTop))}`,
      );
    }
  }
  assert.ok(compared >= 4, `应至少对比 4 把付费枪，实际 ${compared}：有免费基准的类别是不是被删空了？`);
});

test('3. tier 单调性：同类别高阶武器持续 DPS 不低于低阶（±5% 容差）', () => {
  const weaponSource = readFileSync(join(SHARED_DIR, 'data', 'weapons.mjs'), 'utf8');
  const violations = [];
  let pairs = 0;
  for (const [cls, list] of weaponsByClass()) {
    for (const higher of list) {
      for (const lower of list) {
        if (higher.tier <= lower.tier) continue;
        pairs += 1;
        const higherDps = sustainedDps(higher);
        const lowerDps = sustainedDps(lower);
        if (higherDps < lowerDps * (1 - DPS_TOLERANCE)) {
          violations.push(
            `shared/data/weapons.mjs:${lineOf(weaponSource, higher.id)} ${higher.id}` +
              `（T${higher.tier}, price ${higher.price}, magazine ${higher.magazine}, reload ${higher.reload}）` +
              ` 持续 DPS ${fmtDps(higherDps)} < ${lower.id}（T${lower.tier}, reload ${lower.reload}）` +
              ` ${fmtDps(lowerDps)}，低 ${fmtDrop(higherDps, lowerDps)}；` +
              `要过门禁需 reload ≤ ${maxReloadForSustainedDps(higher, lowerDps * (1 - DPS_TOLERANCE)).toFixed(2)}s ` +
              `（现 ${higher.reload}s）；面板 DPS ${higher.id} ${fmtDps(burstDps(higher))} vs ` +
              `${lower.id} ${fmtDps(burstDps(lower))}`,
          );
        }
      }
    }
  }
  assert.ok(pairs > 0, '没有任何跨 tier 同类对比，tier 字段或类别分组已失效');
  assert.deepEqual(violations, [], `tier 倒挂（高级枪更弱，与「高级枪不该更弱」冲突）：\n${violations.join('\n')}`);
});

test('4. 配件 mods 白名单：applyAttachmentMods 读取的 key 覆盖全部配件 mods', () => {
  // 扫描器自检：注释必须被剔除，字符串里的 // 必须保留，否则后面两条断言都不可信。
  const probe = stripComments("const a = 1; // mul('fakeLineKey')\n/* mods.fakeBlockKey */\nconst u = 'http://x//y';");
  assert.ok(!probe.includes('fakeLineKey'), '行注释未被剥离：扫描会把注释里的 key 当成真实读取点');
  assert.ok(!probe.includes('fakeBlockKey'), '块注释未被剥离：扫描会把注释里的 key 当成真实读取点');
  assert.ok(probe.includes('http://x//y'), '字符串里的 // 被误判成注释，源码被截断');

  const raw = readSharedSource('data/weapons.mjs');
  const code = stripComments(raw);
  assert.notEqual(code, raw, '剔除注释后源码没有变化：weapons.mjs 的注释剥离逻辑已失效');
  assert.ok(!code.includes('平衡口径'), '剔除注释后仍能看到注释正文「平衡口径」，剥离不彻底');

  // 只扫 applyAttachmentMods 的函数体：函数外的 mods.x 引用不算「被消费」，
  // 否则别处随便出现一个 mods.foo 就能把白名单门禁掩盖过去。
  const bodyStart = code.indexOf('export function applyAttachmentMods');
  assert.ok(bodyStart >= 0, '找不到 applyAttachmentMods 定义，静态扫描锚点失效');
  const body = code.slice(bodyStart);
  const returnIndex = body.indexOf('export const WEAPON_ORDER');
  const bodyScoped = returnIndex > 0 ? body.slice(0, returnIndex) : body;

  // applyAttachmentMods 的两种读取形态：乘算 mul('key')，加算 w.xxx + (mods.key || 0)。
  assert.match(
    bodyScoped,
    /const\s+mul\s*=\s*\(key\)\s*=>/,
    'applyAttachmentMods 里找不到 `const mul = (key) => ...`：配件乘算结构变了，静态扫描锚点失效',
  );
  const consumed = new Set();
  for (const match of bodyScoped.matchAll(/\bmul\(\s*(['"])([A-Za-z_$][\w$]*)\1\s*\)/g)) consumed.add(match[2]);
  for (const match of bodyScoped.matchAll(/\bmods\.([A-Za-z_$][\w$]*)/g)) consumed.add(match[1]);
  assert.ok(
    consumed.size >= 8,
    `被消费的 mods key 只扫到 ${consumed.size} 个（${[...consumed].sort().join(', ') || '空'}），扫描器可能已失效`,
  );

  const declared = new Map();
  for (const [attachmentId, attachment] of Object.entries(ATTACHMENTS)) {
    for (const key of Object.keys(attachment.mods || {})) {
      if (!declared.has(key)) declared.set(key, []);
      declared.get(key).push(attachmentId);
    }
  }
  assert.ok(declared.size >= 5, `配件只用到 ${declared.size} 个 mods key，配件表可能被清空`);
  const orphans = [...declared]
    .filter(([key]) => !consumed.has(key))
    .map(([key, ids]) => `${key}（${ids.join(', ')}）`);
  assert.deepEqual(
    orphans,
    [],
    `配件写了 mods 但 applyAttachmentMods 从不读取（承诺了永不生效的手感）：\n${orphans.join('\n')}`,
  );
});

test('5. 精通覆盖：ATTACHMENT_UNLOCKS 与配件表一一对应且门槛合法', () => {
  const unlockIds = Object.keys(ATTACHMENT_UNLOCKS);
  assert.equal(
    new Set(unlockIds).size,
    unlockIds.length,
    `ATTACHMENT_UNLOCKS 存在重复键（Object.keys 不会重复，说明数据被手工拼接过）：${unlockIds.join(', ')}`,
  );
  const missing = ATTACHMENT_ORDER.filter((id) => !Object.hasOwn(ATTACHMENT_UNLOCKS, id));
  const unknown = unlockIds.filter((id) => !ATTACHMENT_ORDER.includes(id));
  assert.deepEqual(missing, [], `配件没有精通解锁规则（练满也拿不到，精通奖励断档）：${missing.join(', ')}`);
  assert.deepEqual(unknown, [], `ATTACHMENT_UNLOCKS 含配件表里不存在的 id：${unknown.join(', ')}`);
  assert.deepEqual(
    new Set(unlockIds),
    new Set(ATTACHMENT_ORDER),
    'ATTACHMENT_UNLOCKS 的键集合必须与 ATTACHMENT_ORDER 完全相等',
  );

  const classes = Object.keys(WEAPON_CLASSES);
  for (const [attachmentId, rule] of Object.entries(ATTACHMENT_UNLOCKS)) {
    assert.ok(ATTACHMENTS[attachmentId], `${attachmentId} 不在 ATTACHMENTS，解锁规则指向不存在的配件`);
    assert.ok(
      Number.isInteger(rule.reqMasteryLevel),
      `${attachmentId}.reqMasteryLevel 必须是整数，实际 ${rule.reqMasteryLevel}`,
    );
    assert.ok(
      rule.reqMasteryLevel >= 2 && rule.reqMasteryLevel <= MASTERY.maxLevel,
      `${attachmentId}.reqMasteryLevel ${rule.reqMasteryLevel} 超出 [2, ${MASTERY.maxLevel}]：Lv1 送配件或永远解锁不了`,
    );
    assert.ok(
      classes.includes(rule.weaponClass),
      `${attachmentId}.weaponClass "${rule.weaponClass}" 不是 WEAPON_CLASSES 里的真实类别`,
    );
    assert.ok(
      WEAPON_ORDER.some((weaponId) => WEAPONS[weaponId].cls === rule.weaponClass),
      `${attachmentId}.weaponClass "${rule.weaponClass}" 没有任何一把武器，规则永远不可达`,
    );
  }
});

test('6. 任务/成就 metric 合法：metric 可结算、id 唯一、target 与 xp 为正', () => {
  const metricSet = new Set(MISSION_METRICS);
  for (const [poolName, pool] of [
    ['DAILY_POOL', DAILY_POOL],
    ['WEEKLY_POOL', WEEKLY_POOL],
  ]) {
    const seen = new Set();
    for (const mission of pool) {
      assert.ok(
        metricSet.has(mission.metric),
        `${poolName} 任务 ${mission.id} 的 metric "${mission.metric}" 不在 MISSION_METRICS`,
      );
      assert.equal(seen.has(mission.id), false, `${poolName} 任务 id 重复：${mission.id}`);
      seen.add(mission.id);
      assert.ok(mission.target > 0, `${poolName} 任务 ${mission.id} 的 target 必须 > 0，实际 ${mission.target}`);
      assert.ok(mission.xp > 0, `${poolName} 任务 ${mission.id} 的 xp 必须 > 0，实际 ${mission.xp}`);
    }
  }

  // missionContribution 的 case 覆盖：新增 metric 忘了接线时，任务进度会恒为 0 且无人报错。
  const progressionCode = stripComments(readSharedSource('progression.mjs'));
  const contributionStart = progressionCode.indexOf('export function missionContribution');
  const achievementStart = progressionCode.indexOf('export function achievementValue');
  assert.ok(
    contributionStart >= 0 && achievementStart > contributionStart,
    'progression.mjs 里找不到 missionContribution / achievementValue，静态扫描锚点失效',
  );
  const contributionCode = progressionCode.slice(contributionStart, achievementStart);
  const contributionCases = new Set(
    [...contributionCode.matchAll(/\bcase\s+'([A-Za-z_$][\w$]*)'\s*:/g)].map((match) => match[1]),
  );
  const unhandled = MISSION_METRICS.filter((metric) => !contributionCases.has(metric));
  assert.deepEqual(
    unhandled,
    [],
    `MISSION_METRICS 里的 metric 在 missionContribution 中没有 case（任务进度恒为 0）：${unhandled.join(', ')}`,
  );

  // 成就：「可结算」口径 = MISSION_METRICS ∪ 两个 switch 的 case ∪ emptyMeta().stats 键。
  const achievementCode = progressionCode.slice(achievementStart);
  const achievementCases = new Set(
    [...achievementCode.matchAll(/\bcase\s+'([A-Za-z_$][\w$]*)'\s*:/g)].map((match) => match[1]),
  );
  const statKeys = new Set(Object.keys(emptyMeta().stats));
  const supported = new Set([...metricSet, ...contributionCases, ...achievementCases, ...statKeys]);
  for (const achievement of ACHIEVEMENTS) {
    assert.ok(
      supported.has(achievement.metric),
      `成就 ${achievement.id} 的 metric "${achievement.metric}" 无法被结算：` +
        '既不在 MISSION_METRICS，也不在 missionContribution/achievementValue 的 case 或 emptyMeta().stats',
    );
  }
});

test('7. 商店经济：免费不给高稀有度，同 kind 内价格与稀有度不出现倒挂', () => {
  for (const item of STORE_ITEMS) {
    assert.ok(RARITY.includes(item.rarity), `商店物品 ${item.id} 稀有度 "${item.rarity}" 不在 RARITY`);
    assert.ok(Number.isFinite(item.price) && item.price >= 0, `商店物品 ${item.id} price 非法：${item.price}`);
    const source = unlockSource(item.id);
    assert.ok(source, `商店物品 ${item.id} 查不到获取方式（unlockSource 返回 null）`);
    if (item.price === 0 && item.rarity !== 'common') {
      assert.equal(
        source.kind,
        'achievement',
        `商店物品 ${item.id} 标价 0 却给 ${item.rarity} 稀有度，且获取方式不是成就奖励（${source.kind}）：` +
          '免费商品不能直接给高稀有度',
      );
    }
    if (source.kind === 'credits') {
      assert.ok(item.price > 0, `商店物品 ${item.id} 能用信用点购买却标价 0（等于免费发放 ${item.rarity}）`);
    }
  }

  // 同 kind 内按 price 升序：更贵的条目稀有度不得低于任何更便宜的条目（同稀有度自由定价）。
  const groups = new Map();
  for (const item of STORE_ITEMS) {
    if (unlockSource(item.id).kind !== 'credits') continue;
    if (!groups.has(item.kind)) groups.set(item.kind, []);
    groups.get(item.kind).push(item);
  }
  const violations = [];
  const storeSource = readFileSync(join(SHARED_DIR, 'data', 'store.mjs'), 'utf8');
  let compared = 0;
  for (const [kind, list] of groups) {
    const sorted = [...list].sort((a, b) => a.price - b.price || RARITY.indexOf(a.rarity) - RARITY.indexOf(b.rarity));
    let ceiling = null;
    for (const item of sorted) {
      const rank = RARITY.indexOf(item.rarity);
      if (ceiling && rank < ceiling.rank) {
        violations.push(
          `shared/data/store.mjs:${lineOf(storeSource, item.id)} ${item.id}` +
            `（price ${item.price}, ${item.rarity}）比更便宜的 ${ceiling.item.id}` +
            `（price ${ceiling.item.price}, ${ceiling.item.rarity}，line ${lineOf(storeSource, ceiling.item.id)}）` +
            ' 稀有度更低，应当提档或降价',
        );
      } else if (!ceiling || rank > ceiling.rank) {
        ceiling = { rank, item };
      }
      compared += 1;
    }
  }
  assert.ok(compared >= 10, `可购买商店条目只对比了 ${compared} 件，扫描面过小（unlockSource 判定是否已变）`);
  assert.deepEqual(violations, [], `商店价格-稀有度倒挂（贵反而更不稀有）：\n${violations.join('\n')}`);
});

test('8. 掉落池引用完整性：LOOT_WEAPON_POOL / LOOT_TABLES / 空投池只引用真实 id', () => {
  for (const [bucket, pool] of Object.entries(LOOT_WEAPON_POOL)) {
    assert.ok(Array.isArray(pool) && pool.length > 0, `${bucket} 武器池为空`);
    assert.equal(new Set(pool).size, pool.length, `${bucket} 武器池内 id 重复：${pool.join(', ')}`);
    for (const id of pool) {
      assert.ok(Object.hasOwn(WEAPONS, id), `${bucket} 武器池引用了不存在的武器 id：${id}`);
    }
  }

  for (const [tier, table] of Object.entries(LOOT_TABLES)) {
    for (const [kind, entries] of Object.entries(table)) {
      for (const [id, weight] of entries) {
        assert.ok(weight > 0, `${tier}.${kind}.${id} 权重必须 > 0，实际 ${weight}`);
        if (kind === 'weapon') {
          assert.ok(Object.hasOwn(WEAPONS, id), `${tier}.weapon 引用了不存在的武器 id：${id}`);
        } else if (kind === 'attachment') {
          assert.ok(Object.hasOwn(ATTACHMENTS, id), `${tier}.attachment 引用了不存在的配件 id：${id}`);
        } else if (kind === 'ammo') {
          assert.ok(Object.hasOwn(AMMO_TYPES, id), `${tier}.ammo 引用了不存在的弹药 id：${id}`);
        } else {
          assert.ok(Object.hasOwn(ITEM_LOOKUP, id), `${tier}.${kind} 引用了不存在的道具 id：${id}`);
        }
      }
    }
  }

  // weapons.mjs 的注释承诺 LOOT_WEAPON_POOL「与 LOOT_TABLES 的 weapon 列保持一致」。
  const bucketToTier = { low: 'tier1', mid: 'tier2', high: 'tier3' };
  for (const [bucket, tier] of Object.entries(bucketToTier)) {
    assert.ok(LOOT_TABLES[tier], `LOOT_TABLES 缺少 ${tier} 档`);
    const tableIds = new Set(LOOT_TABLES[tier].weapon.map(([id]) => id));
    const poolIds = new Set(LOOT_WEAPON_POOL[bucket]);
    const onlyPool = [...poolIds].filter((id) => !tableIds.has(id));
    const onlyTable = [...tableIds].filter((id) => !poolIds.has(id));
    assert.deepEqual(
      { onlyPool, onlyTable },
      { onlyPool: [], onlyTable: [] },
      `${bucket} 桶与 ${tier}.weapon 不一致：仅池内 [${onlyPool.join(', ')}]；仅表内 [${onlyTable.join(', ')}]`,
    );
  }

  // 空投池是 loot.mjs 里第二处硬编码 [id, weight]，写错不会抛错，只会让 buildAirdropLoot
  // 把未知 id 当武器兜底（WEAPONS[id] 为 undefined，落地即崩）。静态扫描兜住它。
  const lootCode = stripComments(readSharedSource('data/loot.mjs'));
  const airdropStart = lootCode.indexOf('export function buildAirdropLoot');
  assert.ok(airdropStart >= 0, 'loot.mjs 里找不到 buildAirdropLoot，静态扫描锚点失效');
  const airdropBody = lootCode.slice(airdropStart);
  const airdropIds = [...airdropBody.matchAll(/\[\s*'([A-Za-z0-9_]+)'\s*,\s*\d+\s*\]/g)].map((match) => match[1]);
  assert.ok(airdropIds.length >= 8, `空投池只扫到 ${airdropIds.length} 个 id，扫描可能失效`);
  for (const id of airdropIds) {
    const known =
      Object.hasOwn(WEAPONS, id) ||
      Object.hasOwn(ATTACHMENTS, id) ||
      Object.hasOwn(CONSUMABLES, id) ||
      Object.hasOwn(ARMORS, id);
    assert.ok(known, `空投池引用了不存在的 id：${id}`);
  }
});
