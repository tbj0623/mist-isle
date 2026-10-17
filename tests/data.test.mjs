// 雾岛突围 / MIST ISLE — 游戏数据自测（node --test tests/data.test.mjs）
// 覆盖：武器数量与字段、数值区间、TTK/DPS 平衡、配件合成、掉落表引用完整性、
//       稀有度分布、tier 掉落差异、确定性（同一 rng 序列结果可复现）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AMMO_TYPES, WEAPON_CLASSES, WEAPONS, WEAPON_ORDER, ATTACHMENTS, LOOT_WEAPON_POOL,
  getWeapon, getAttachment, applyAttachmentMods, hitsToKill, timeToKill, sustainedDps,
} from '../shared/data/weapons.mjs';
import {
  ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, ITEM_LOOKUP, ITEM_NAMES, ITEM_ICONS, getItem,
} from '../shared/data/items.mjs';
import {
  LOOT_TABLES, RARITY_WEIGHTS, RARITY_WEIGHTS_BY_TIER, RARITY_INDEX,
  rollRarity, randomWeaponForTier, randomAttachment, buildLootForSpot,
} from '../shared/data/loot.mjs';
import * as DATA from '../shared/data/index.mjs';

const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const CLASSES = ['pistol', 'smg', 'rifle', 'shotgun', 'marksman', 'sniper', 'lmg', 'special'];

// 确定性线性同余 rng（与游戏无关，仅测试用）
function makeRng(seed = 20261018) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const sample = (rng, n, fn) => Array.from({ length: n }, () => fn(rng));
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

test('武器数量、顺序与类别覆盖符合契约', () => {
  const ids = Object.keys(WEAPONS);
  assert.equal(ids.length, 18, '必须正好 18 把武器');
  assert.equal(WEAPON_ORDER.length, 18);
  assert.deepEqual(new Set(WEAPON_ORDER), new Set(ids), 'WEAPON_ORDER 必须与 WEAPONS 一一对应');
  const classes = new Set(ids.map((id) => WEAPONS[id].cls));
  assert.deepEqual([...classes].sort(), [...CLASSES].sort(), '8 个类别都要有武器');
  for (const cls of CLASSES) delete classes.delete(cls);
  for (const cls of CLASSES) assert.ok(ids.some((id) => WEAPONS[id].cls === cls), `${cls} 至少一把`);
  for (const [id, klass] of Object.entries(WEAPON_CLASSES)) {
    assert.ok(CLASSES.includes(id));
    assert.ok(klass.name && klass.desc, `${id} 类别要有中文名与描述`);
  }
});

test('每把武器字段齐全且数值在合理区间', () => {
  const required = ['id', 'name', 'short', 'cls', 'ammo', 'damage', 'interval', 'magazine', 'reload',
    'spread', 'recoil', 'range', 'pellets', 'auto', 'moveMul', 'adsZoom', 'noise', 'rarity', 'tier',
    'unlock', 'price', 'slots', 'art', 'desc'];
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    for (const key of required) assert.ok(w[key] !== undefined, `${id} 缺字段 ${key}`);
    assert.equal(w.id, id, `${id}.id 必须与键一致`);
    assert.ok(typeof w.name === 'string' && w.name.length >= 3, `${id} 需要中文名`);
    assert.ok(/[\u4e00-\u9fa5]/.test(w.name), `${id} 名称应为中文`);
    assert.ok(/[\u4e00-\u9fa5]/.test(w.desc) && w.desc.length >= 8, `${id} 需要中文描述`);
    assert.ok(AMMO_TYPES[w.ammo], `${id} 弹药类型 ${w.ammo} 不在 AMMO_TYPES`);
    assert.ok(CLASSES.includes(w.cls), `${id} 类别非法`);
    assert.ok(RARITY.includes(w.rarity), `${id} 稀有度非法`);
    assert.ok(w.tier >= 1 && w.tier <= 3, `${id} tier 应为 1-3`);
    assert.ok(w.damage >= 8 && w.damage <= 130, `${id} damage 异常：${w.damage}`);
    assert.ok(w.interval >= 0.05 && w.interval <= 1.6, `${id} interval 异常：${w.interval}`);
    assert.ok(w.magazine >= 1 && w.magazine <= 80, `${id} magazine 异常`);
    assert.ok(w.reload >= 0.9 && w.reload <= 6, `${id} reload 异常`);
    assert.ok(w.spread > 0.002 && w.spread < 0.2, `${id} spread 异常`);
    assert.ok(w.recoil >= 0.4 && w.recoil <= 5, `${id} recoil 异常`);
    assert.ok(w.range >= 12 && w.range <= 120, `${id} range 异常`);
    assert.ok(w.pellets >= 1 && w.pellets <= 12, `${id} pellets 异常`);
    assert.equal(typeof w.auto, 'boolean');
    assert.ok(w.moveMul >= 0.7 && w.moveMul <= 1.2, `${id} moveMul 异常`);
    assert.ok(w.adsZoom >= 1 && w.adsZoom <= 3.5, `${id} adsZoom 异常`);
    assert.ok(w.noise > 0 && w.noise <= 2, `${id} noise 异常`);
    assert.ok(w.unlock >= 1 && w.unlock <= 60, `${id} unlock 异常`);
    assert.ok(w.price >= 0, `${id} price 异常`);
    assert.ok(Array.isArray(w.slots) && w.slots.length >= 2, `${id} 至少两个配件槽`);
    for (const slot of w.slots) assert.ok(['optic', 'muzzle', 'mag', 'grip'].includes(slot), `${id} 槽位非法：${slot}`);
    assert.ok(w.art.len > 0 && w.art.body > 0 && w.art.accent > 0, `${id} art 缺失`);
    assert.ok(w.art.size > 0);
    if (w.cls === 'rifle') assert.ok(w.burst === undefined || w.burst >= 2, `${id} burst 非法`);
    if (w.falloff) {
      assert.ok(w.falloff.start > 0.1 && w.falloff.start < 1, `${id} falloff.start 异常`);
      assert.ok(w.falloff.keep > 0.05 && w.falloff.keep <= 1, `${id} falloff.keep 异常`);
    }
  }
});

test('TTK 与命中数满足类别平衡区间（无甲 100 HP）', () => {
  const expected = {
    pistol: [3, 4], smg: [6, 8], rifle: [3, 5], shotgun: [1, 2], marksman: [2, 3], lmg: [5, 7], sniper: [1, 2], special: [1, 4],
  };
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    const hits = hitsToKill(w);
    const [lo, hi] = expected[w.cls];
    assert.ok(hits >= lo && hits <= hi, `${id}(${w.cls}) 命中数 ${hits} 不在 [${lo},${hi}]`);
    const ttk = timeToKill(w);
    assert.ok(ttk >= 0 && ttk < 1.9, `${id} TTK ${ttk}s 不合理`);
  }
  // 步枪 kill 3-5 发、冲锋枪更多、狙击 1-2 发
  assert.ok(hitsToKill('ar7') >= 3 && hitsToKill('ar7') <= 5);
  assert.ok(hitsToKill('v9') > hitsToKill('ar7'), '冲锋枪应比步枪需要更多命中');
  assert.ok(hitsToKill('awm') <= 2 && hitsToKill('sr338') <= 2, '重型狙击应 1-2 发致死');
  // 站桩 DPS 必须随类别分层，且没有破格武器
  for (const id of WEAPON_ORDER) {
    const dps = sustainedDps(WEAPONS[id]);
    assert.ok(dps > 25 && dps < 210, `${id} 持续 DPS ${dps} 越界`);
  }
  const smgDps = mean(['v9', 'mp5k', 'vector'].map((id) => sustainedDps(WEAPONS[id])));
  const sniperDps = mean(['sr338', 'awm'].map((id) => sustainedDps(WEAPONS[id])));
  assert.ok(smgDps > sniperDps, '冲锋枪持续 DPS 应高于狙击枪');
});

test('武器池、配件池与弹药表结构正确', () => {
  assert.equal(Object.keys(AMMO_TYPES).length, 5);
  for (const [id, ammo] of Object.entries(AMMO_TYPES)) {
    assert.equal(ammo.id, id);
    assert.ok(ammo.name && ammo.pickup > 0 && ammo.cap > ammo.pickup);
  }
  assert.equal(Object.keys(ATTACHMENTS).length, 14);
  const slots = { optic: 0, muzzle: 0, mag: 0, grip: 0 };
  for (const [id, att] of Object.entries(ATTACHMENTS)) {
    assert.equal(att.id, id);
    assert.ok(slots[att.slot] !== undefined, `${id} 槽位非法`);
    slots[att.slot] += 1;
    assert.ok(att.name && att.desc && att.mods, `${id} 字段缺失`);
    assert.ok(Object.keys(att.mods).length >= 1, `${id} 无 mods`);
    for (const value of Object.values(att.mods)) assert.equal(typeof value, 'number');
  }
  assert.deepEqual(slots, { optic: 4, muzzle: 4, mag: 3, grip: 3 });
  for (const [bucket, pool] of Object.entries(LOOT_WEAPON_POOL)) {
    assert.ok(pool.length >= 6, `${bucket} 武器池太小`);
    for (const id of pool) assert.ok(WEAPONS[id], `${bucket} 含未知武器 ${id}`);
  }
  for (let i = 0; i < 30; i++) {
    const w = randomWeaponForTier(makeRng(i + 1), 3);
    assert.ok(WEAPONS[w.id], '随机武器 id 非法');
    assert.ok(Array.isArray(w.attachments));
    for (const att of w.attachments) {
      assert.ok(ATTACHMENTS[att], `随机武器带未知配件 ${att}`);
      assert.ok(WEAPONS[w.id].slots.includes(ATTACHMENTS[att].slot), `${w.id} 不能装 ${att}`);
    }
  }
});

test('getWeapon / getAttachment / getItem 容错与查找', () => {
  assert.equal(getWeapon('ak12').id, 'ak12');
  assert.equal(getWeapon('nope').id, 'p9', '未知武器回退 p9');
  assert.equal(getAttachment('scope_8x').slot, 'optic');
  assert.equal(getAttachment('nope'), null);
  assert.equal(getItem('medkit').heal, 75);
  assert.equal(getItem('armor2').tier, 2);
  assert.equal(getItem('nope'), null);
  assert.equal(ITEM_LOOKUP.bandage, CONSUMABLES.bandage);
  assert.equal(ITEM_NAMES.frag, THROWABLES.frag.name);
  assert.equal(ITEM_ICONS.bp3, BACKPACKS.bp3.icon);
  assert.equal(ITEM_LOOKUP.med, CONSUMABLES.medkit, "兼容别名 med 应指向医疗包");
  assert.equal(Object.keys(ITEM_LOOKUP).filter((id) => id !== 'med').length, 3 + 4 + 4 + 3);
  // index.mjs 汇总出口一致性
  assert.equal(DATA.WEAPONS, WEAPONS);
  assert.equal(DATA.ITEM_LOOKUP, ITEM_LOOKUP);
  assert.equal(typeof DATA.buildLootForSpot, 'function');
  assert.equal(DATA.MAPS.qinglan.name, '青岚岛');
});

test('applyAttachmentMods 合成正确且不修改原对象', () => {
  const ar7 = WEAPONS.ar7;
  const before = JSON.stringify(ar7);
  const modded = applyAttachmentMods(ar7, ['red_dot', 'ext_mag', 'vertical_grip']);
  assert.equal(JSON.stringify(ar7), before, '原武器对象必须保持不变');
  assert.notEqual(modded, ar7);
  assert.equal(modded.id, 'ar7');
  assert.ok(modded.magazine > ar7.magazine, '扩容弹匣应提高弹容');
  assert.ok(modded.spread < ar7.spread, '配件应降低散布');
  assert.ok(modded.adsZoom > ar7.adsZoom, '红点应提升开镜倍率');
  assert.deepEqual(modded.attachments, ['red_dot', 'ext_mag', 'vertical_grip']);

  // 同类槽只取第一个；武器不支持的槽位被忽略；未知 id 被忽略
  const dup = applyAttachmentMods(ar7, ['red_dot', 'holo', 'nope']);
  assert.deepEqual(dup.attachments, ['red_dot']);
  const p9 = applyAttachmentMods('p9', ['vertical_grip', 'scope_4x', 'suppressor']);
  assert.deepEqual(p9.attachments, ['suppressor'], 'P9 只有 muzzle/mag 槽');

  // 消音器降低噪声、狙击 8 倍镜提升缩放；数值都在合理域
  const awm = applyAttachmentMods('awm', ['scope_8x', 'suppressor', 'ext_mag']);
  assert.ok(awm.noise < WEAPONS.awm.noise);
  assert.ok(awm.adsZoom > 4.5 && awm.adsZoom < 6);
  assert.ok(awm.magazine >= 4);
  for (const id of WEAPON_ORDER) {
    const m = applyAttachmentMods(id, Object.keys(ATTACHMENTS));
    assert.ok(m.spread > 0 && m.reload > 0 && m.interval > 0 && m.range > 0);
    assert.ok(m.magazine >= 1 && m.recoil > 0 && m.noise > 0 && m.moveMul > 0);
  }
});

test('道具数据字段与数值合理', () => {
  assert.equal(Object.keys(ARMORS).length, 3);
  let lastAbsorb = 0;
  for (const [id, armor] of Object.entries(ARMORS)) {
    assert.equal(armor.id, id);
    assert.ok(armor.absorb > lastAbsorb && armor.absorb < 0.7, '护甲档位吸收应递增且不过强');
    assert.ok(armor.durability >= 40 && armor.durability <= 200);
    assert.ok(armor.name && armor.desc);
    lastAbsorb = armor.absorb;
  }
  for (const id of ['bandage', 'medkit', 'energy', 'shield']) {
    const item = CONSUMABLES[id];
    assert.ok(item, `${id} 缺失`);
    assert.ok(item.name && item.desc && item.use > 0 && item.stack >= 1);
    if (id === 'shield') assert.ok(item.shield > 0);
    else assert.ok(item.heal > 0);
  }
  assert.ok(CONSUMABLES.medkit.heal > CONSUMABLES.bandage.heal);
  assert.ok(CONSUMABLES.energy.haste > 1 && CONSUMABLES.energy.hasteTime > 0);
  for (const id of ['frag', 'smoke', 'flash', 'molotov']) {
    const item = THROWABLES[id];
    assert.ok(item, `${id} 缺失`);
    assert.ok(item.fuse > 0 && item.radius > 0 && item.stack > 0 && item.desc);
  }
  assert.ok(THROWABLES.frag.damage > 0);
  assert.ok(THROWABLES.smoke.duration > 0);
  assert.ok(THROWABLES.flash.blind > 0);
  assert.ok(THROWABLES.molotov.burn > 0 && THROWABLES.molotov.duration > 0);
  assert.ok(BACKPACKS.bp3.ammoCap > BACKPACKS.bp2.ammoCap && BACKPACKS.bp2.ammoCap > BACKPACKS.bp1.ammoCap);
  assert.ok(BACKPACKS.bp3.consumableStack > BACKPACKS.bp1.consumableStack);
});

test('掉落表引用的所有 id 都真实存在', () => {
  for (const [tier, table] of Object.entries(LOOT_TABLES)) {
    for (const [kind, entries] of Object.entries(table)) {
      assert.ok(entries.length >= 3, `${tier}.${kind} 条目太少`);
      for (const entry of entries) {
        assert.equal(entry.length, 2, `${tier}.${kind} 条目应为 [id, weight]`);
        const [id, weight] = entry;
        assert.ok(weight > 0, `${tier}.${kind}.${id} 权重应为正`);
        if (kind === 'weapon') assert.ok(WEAPONS[id], `${tier} 含未知武器 ${id}`);
        else if (kind === 'attachment') assert.ok(ATTACHMENTS[id], `${tier} 含未知配件 ${id}`);
        else if (kind === 'ammo') assert.ok(AMMO_TYPES[id], `${tier} 含未知弹药 ${id}`);
        else assert.ok(ITEM_LOOKUP[id], `${tier}.${kind} 含未知道具 ${id}`);
      }
    }
  }
  // 穷地不出高倍镜/重甲，富地不出残疾配置：抽查关键差异
  const tier1Att = LOOT_TABLES.tier1.attachment.map(([id]) => id);
  const tier3Att = LOOT_TABLES.tier3.attachment.map(([id]) => id);
  assert.ok(!tier1Att.some((id) => ATTACHMENTS[id].rarity === 'epic'), 'tier1 不应出史诗配件');
  assert.ok(tier3Att.includes('scope_8x'), 'tier3 应能出 8 倍镜');
  assert.ok(!LOOT_TABLES.tier1.weapon.some(([id]) => WEAPONS[id].rarity === 'legendary'));
  assert.ok(LOOT_TABLES.tier3.weapon.some(([id]) => WEAPONS[id].rarity === 'legendary'), 'tier3 应能出传说武器');
});

test('rollRarity 分布符合权重（1 万次采样）', () => {
  const rng = makeRng(777);
  const count = 10000;
  for (const tier of [1, 2, 3]) {
    const weights = RARITY_WEIGHTS_BY_TIER[tier];
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    const tally = Object.fromEntries(RARITY.map((r) => [r, 0]));
    for (let i = 0; i < count; i++) tally[rollRarity(rng, tier)] += 1;
    for (const rarity of RARITY) {
      const want = (weights[rarity] / total) * count;
      const got = tally[rarity];
      // 允许 45% 相对误差或 8 个绝对单位（低频档位更宽容）
      assert.ok(Math.abs(got - want) <= Math.max(8, want * 0.45), `tier${tier} ${rarity}: 期望 ${want.toFixed(0)}，实际 ${got}`);
    }
  }
  // tier2 必须等于契约声明的基础权重；且 tier3 稀有度期望显著高于 tier1
  assert.deepEqual(RARITY_WEIGHTS_BY_TIER[2], RARITY_WEIGHTS);
  const expectedIndex = (tier) => {
    const w = RARITY_WEIGHTS_BY_TIER[tier];
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    return RARITY.reduce((sum, r) => sum + (w[r] / total) * RARITY_INDEX[r], 0);
  };
  assert.ok(expectedIndex(3) > expectedIndex(2) && expectedIndex(2) > expectedIndex(1));
});

test('buildLootForSpot: 条目数量、字段合法、tier3 稀有度期望显著高于 tier1', () => {
  const rng = makeRng(424242);
  const tiers = [1, 2, 3];
  const stats = {};
  for (const tier of tiers) {
    const spots = sample(rng, 1500, () => buildLootForSpot(rng, { x: rng() * 100 - 50, z: rng() * 100 - 50, tier }));
    const counts = spots.map((s) => s.length);
    assert.ok(counts.every((c) => c >= 1 && c <= 3), `tier${tier} 条目数必须 1-3`);
    const entries = spots.flat();
    for (const entry of entries) {
      assert.ok(['weapon', 'ammo', 'consumable', 'armor', 'throwable', 'attachment'].includes(entry.kind));
      assert.ok(RARITY.includes(entry.rarity), `未知稀有度 ${entry.rarity}`);
      assert.ok(typeof entry.item === 'string' && entry.item.length > 0);
      if (entry.kind === 'weapon') {
        assert.ok(WEAPONS[entry.item]);
        assert.ok(Array.isArray(entry.attachments) && entry.ammo > 0);
      } else if (entry.kind === 'attachment') assert.ok(ATTACHMENTS[entry.item]);
      else if (entry.kind === 'ammo') assert.ok(AMMO_TYPES[entry.item] && entry.qty > 0);
      else {
        assert.ok(ITEM_LOOKUP[entry.item], `未知道具 ${entry.item}`);
        assert.equal(entry.rarity, ITEM_LOOKUP[entry.item].rarity, '道具稀有度应与其定义一致');
        assert.ok(entry.qty >= 1);
      }
    }
    stats[tier] = {
      meanCount: mean(counts),
      rarityMean: mean(entries.map((e) => RARITY_INDEX[e.rarity])),
      weaponRate: entries.filter((e) => e.kind === 'weapon').length / entries.length,
    };
  }
  assert.ok(stats[3].meanCount > stats[1].meanCount, '富地物资点条目应更多');
  assert.ok(stats[3].rarityMean > stats[1].rarityMean * 1.6,
    `tier3 稀有度期望(${stats[3].rarityMean.toFixed(2)}) 应显著高于 tier1(${stats[1].rarityMean.toFixed(2)})`);
  assert.ok(stats[3].rarityMean > stats[2].rarityMean && stats[2].rarityMean > stats[1].rarityMean, '稀有度期望应逐档递增');

  // 确定性：同一种子两次生成完全一致
  const a = buildLootForSpot(makeRng(99), { x: 1, z: 2, tier: 3 });
  const b = buildLootForSpot(makeRng(99), { x: 1, z: 2, tier: 3 });
  assert.deepEqual(a, b, '同一 rng 种子必须产生相同掉落');
});

test('randomAttachment 与随机武器配件遵守槽位约束', () => {
  const rng = makeRng(2024);
  for (const slot of ['optic', 'muzzle', 'mag', 'grip']) {
    for (let i = 0; i < 40; i++) {
      const id = randomAttachment(rng, 3, { slot });
      assert.equal(ATTACHMENTS[id].slot, slot, `槽位约束失效：${id}`);
    }
  }
  for (const cls of ['sniper', 'smg', 'lmg']) {
    for (let i = 0; i < 60; i++) {
      const id = randomAttachment(rng, 3, { cls });
      assert.notEqual(id, 'choke', '收束器只应出现在霰弹枪上');
    }
  }
  assert.ok(randomAttachment(rng, 3).length > 0);
});
