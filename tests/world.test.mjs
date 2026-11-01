import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWorld, makeWorldUncached, worldCache, makeCollision, mulberry32,
  MIN_BUILDINGS, MIN_OBSTACLES, MIN_TREES, MIN_LOOT, MIN_ANCHORS, ANCHOR_SPACING,
  NAV_CELL, PLAYER_RADIUS, WORLD_RADIUS,
} from '../shared/map.mjs';
import { MAPS, MAP_ORDER } from '../shared/data/maps.mjs';
import { budget } from './perf-budget.mjs';

const IDS = ['qinglan', 'chisha', 'baiye'];
const worlds = new Map();

function world(id) {
  let w = worlds.get(id);
  if (!w) { w = makeWorldUncached(id); worlds.set(id, w); }
  return w;
}

/** 门洞法向：返回该入口的朝向（指向墙外）。 */
function outwardNormal(side) {
  if (side === 0) return { x: 0, z: -1 };
  if (side === 2) return { x: 0, z: 1 };
  if (side === 1) return { x: 1, z: 0 };
  return { x: -1, z: 0 };
}

/** 沿墙扫描入口净宽：门洞切向连续可通行段落的最大长度。 */
function doorwayWidth(w, entrance) {
  const n = outwardNormal(entrance.side);
  const tx = 1 - Math.abs(n.x);
  const tz = 1 - Math.abs(n.z);
  let best = 0;
  let run = 0;
  for (let t = -4; t <= 4; t += 0.05) {
    const bx = entrance.x + tx * t;
    const bz = entrance.z + tz * t;
    const ok = !w.blocked(bx, bz, PLAYER_RADIUS)
      && !w.blocked(bx + n.x, bz + n.z, PLAYER_RADIUS)
      && !w.blocked(bx - n.x, bz - n.z, PLAYER_RADIUS);
    if (ok) { run += 0.05; if (run > best) best = run; } else run = 0;
  }
  return best;
}

test(`world: 三张地图都能生成，且每图生成耗时 < ${budget(1500)}ms（3 次取最优，抗负载抖动；本地预算 1500ms）`, () => {
  // 预热：排除 Node 首次 JIT 编译开销（契约规定的是地图生成耗时，不是解释器冷启动）
  makeWorldUncached(IDS[0]);
  const times = {};
  for (const id of IDS) {
    // 同机上并行跑测试/构建时单次耗时会抖 2–3 倍；取 3 次最优值，
    // 测的是「生成算法本身」而不是当时的 CPU 队列。
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const w = makeWorldUncached(id);
      const ms = Date.now() - t0;
      if (ms < best) best = ms;
      assert.equal(w.id, id);
      assert.equal(w.radius, MAPS[id].radius);
      assert.ok(w.buildings.length > 0, `${id} 没有建筑`);
    }
    times[id] = best;
    console.log(`  ${id}: ${best}ms（3 次最优）`);
    assert.ok(best < budget(1500), `${id} 生成耗时 ${best}ms 超过 ${budget(1500)}ms`);
  }
  // 三图总生成时间（缓存冷启动）
  worldCache.clear();
  const t0 = Date.now();
  for (const id of IDS) makeWorld(id);
  const total = Date.now() - t0;
  console.log(`  三图总计: ${total}ms`);
  assert.ok(total < budget(4000), `三图总耗时 ${total}ms 超过 ${budget(4000)}ms 预算`);
  assert.ok(Object.values(times).every((ms) => ms < budget(1500)));
});

test('world: 每图建筑/障碍/树/物资点/出生锚点数量达标', () => {
  for (const id of IDS) {
    const w = world(id);
    assert.ok(w.buildings.length >= MIN_BUILDINGS, `${id} 建筑 ${w.buildings.length} < ${MIN_BUILDINGS}`);
    assert.ok(w.obstacles.length >= MIN_OBSTACLES, `${id} 障碍 ${w.obstacles.length} < ${MIN_OBSTACLES}`);
    assert.ok(w.trees.length >= MIN_TREES, `${id} 树 ${w.trees.length} < ${MIN_TREES}`);
    assert.ok(w.lootSpots.length >= MIN_LOOT && w.lootSpots.length <= 320, `${id} 物资点 ${w.lootSpots.length} 不在 200-320`);
    assert.ok(w.spawnAnchors.length >= MIN_ANCHORS, `${id} 出生锚点 ${w.spawnAnchors.length} < ${MIN_ANCHORS}`);
    assert.ok(w.carSpots.length >= 10 && w.carSpots.length <= 14, `${id} 载具点 ${w.carSpots.length} 不在 10-14`);
    assert.ok(w.regions.length >= 8, `${id} 区域数 ${w.regions.length} < 8`);
    // 物资点 tier 合法
    for (const l of w.lootSpots) assert.ok(l.tier >= 1 && l.tier <= 3, `tier 非法 ${l.tier}`);
    // 载具类型合法
    for (const c of w.carSpots) {
      assert.ok(['buggy', 'jeep', 'bike', 'truck'].includes(c.type), `载具类型非法 ${c.type}`);
      assert.ok(Number.isFinite(c.rot));
    }
    // 建筑内部中心必须有物资点
    for (const b of w.buildings) {
      const has = w.lootSpots.some(l => Math.abs(l.x - b.x) < b.w * 0.5 && Math.abs(l.z - b.z) < b.d * 0.5);
      assert.ok(has, `${id} 建筑 ${b.id} 内部缺少物资点`);
    }
  }
});

test('world: 每栋建筑至少有一个 ≥1.6m 的可行走门洞', () => {
  for (const id of IDS) {
    const w = world(id);
    let checked = 0;
    for (const b of w.buildings) {
      assert.equal(b.walls, true, `${id} ${b.id} walls 标记缺失`);
      assert.ok(b.entrances.length >= 1, `${id} ${b.id} 没有门洞`);
      const best = Math.max(...b.entrances.map(e => doorwayWidth(w, e)));
      assert.ok(best >= 1.6, `${id} 建筑 ${b.id} 门洞净宽 ${best.toFixed(2)}m < 1.6m`);
      checked++;
    }
    console.log(`  ${id}: ${checked} 栋建筑门洞全部可通行`);
  }
});

/** 圆内均匀采样（避免落在方形包围盒的四角）。 */
function diskPoint(rng, radius) {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * radius;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

test('world: 碰撞/射线/视线函数自洽（暴力校验）', () => {
  for (const id of IDS) {
    const w = world(id);
    // blocked 与逐障碍暴力检测一致（排除水域造成的额外阻挡）
    const rng = mulberry32(4242);
    let mismatch = 0;
    for (let i = 0; i < 3000; i++) {
      const p = diskPoint(rng, w.radius - 8);
      const x = p.x;
      const z = p.z;
      let brute = false;
      for (const o of w.obstacles) {
        const dx = x - Math.max(o.x - o.w * 0.5, Math.min(x, o.x + o.w * 0.5));
        const dz = z - Math.max(o.z - o.d * 0.5, Math.min(z, o.z + o.d * 0.5));
        if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) { brute = true; break; }
      }
      if (brute !== w.blocked(x, z, PLAYER_RADIUS) && !w.isWater(x, z)) mismatch++;
    }
    assert.ok(mismatch === 0, `${id} blocked 与暴力检测有 ${mismatch} 处不一致`);

    // 越界必须 blocked
    assert.equal(w.blocked(w.radius + 5, 0, PLAYER_RADIUS), true, `${id} 越界点应 blocked`);
    assert.equal(w.blocked(NaN, 0, PLAYER_RADIUS), true, `${id} NaN 应 blocked`);

    // randomPoint 永不 blocked
    const prng = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const p = w.randomPoint(prng, w.radius - 16, 4);
      assert.equal(w.blocked(p.x, p.z, PLAYER_RADIUS), false, `${id} randomPoint 返回 blocked 点`);
      assert.ok(Math.hypot(p.x, p.z) <= w.radius, `${id} randomPoint 越界`);
    }
  }
});

test('world: moveBody 不会穿墙；墙滑行表现正常', () => {
  for (const id of IDS) {
    const w = world(id);
    // 找一面足够长的墙，从正面连续推进
    const wall = w.obstacles
      .filter(o => o.kind === 'wall' && Math.max(o.w, o.d) >= 4)
      .sort((a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d))[0];
    assert.ok(wall, `${id} 找不到可用测试墙`);
    const horizontal = wall.w >= wall.d;
    const body = horizontal
      ? { x: wall.x - wall.w * 0.5 - 3, z: wall.z }
      : { x: wall.x, z: wall.z - wall.d * 0.5 - 3 };
    for (let i = 0; i < 400; i++) {
      if (horizontal) w.moveBody(body, 0.1, 0, PLAYER_RADIUS);
      else w.moveBody(body, 0, 0.1, PLAYER_RADIUS);
    }
    const face = horizontal ? wall.x - wall.w * 0.5 : wall.z - wall.d * 0.5;
    const pos = horizontal ? body.x : body.z;
    assert.ok(pos <= face - PLAYER_RADIUS + 0.02, `${id} moveBody 穿墙：pos=${pos.toFixed(2)} face=${face.toFixed(2)}`);

    // 斜向滑墙：受控场景下沿墙方向仍应能移动
    const wallObj = { id: 0, x: 0, z: 0, w: 30, d: 0.6, kind: 'wall', blocksBullets: true };
    const coll = makeCollision([wallObj], () => true);
    const slider = { x: 3, z: -3 };
    for (let i = 0; i < 40; i++) coll.moveBody(slider, 0.1, 0.1, PLAYER_RADIUS);
    assert.ok(slider.x > 5, `滑墙时沿墙位移不足：x=${slider.x.toFixed(2)}`);
    assert.ok(slider.z <= -0.3 - PLAYER_RADIUS + 0.06, `滑墙时穿入墙体：z=${slider.z.toFixed(2)}`);

    // 超远位移分步处理，不应瞬移穿过大量障碍
    const walkable = w.nav.nearestWalkable(0, 0);
    const far = { x: walkable.x, z: walkable.z };
    w.moveBody(far, 0, 60, PLAYER_RADIUS);
    assert.equal(w.blocked(far.x, far.z, PLAYER_RADIUS), false, `${id} moveBody 终点被阻塞`);
    // 移动距离不应超过请求值
    assert.ok(Math.hypot(far.x - walkable.x, far.z - walkable.z) <= 60.01);
  }
});

test('world: wallDistance 对已知墙面距离准确（±0.2m），clearLine 正确', () => {
  // 用受控障碍图构造已知墙面，精确验证射线测距
  const wall = { id: 0, x: 20, z: 0, w: 1, d: 30, kind: 'wall', blocksBullets: true };
  const far = { id: 1, x: 60, z: 0, w: 2, d: 2, kind: 'rock', blocksBullets: true };
  const coll = makeCollision([wall, far], () => true);
  for (const gap of [1, 4.5, 12, 25]) {
    const dist = coll.wallDistance(20 - 0.5 - gap, 3, 1, 0, 80);
    assert.ok(Math.abs(dist - gap) <= 0.2, `受控场景 gap=${gap} 测得 ${dist.toFixed(2)}`);
    assert.equal(coll.clearLine({ x: 20 - 0.5 - gap, z: 3 }, { x: 20 + 0.5 + gap, z: 3 }), false, '应被墙挡住');
  }
  // 无遮挡方向畅通
  assert.ok(coll.wallDistance(-40, 0, -1, 0, 20) >= 20);
  assert.equal(coll.clearLine({ x: -40, z: 0 }, { x: -20, z: 0 }), true);
  // 命中其它对象：远墙
  assert.ok(Math.abs(coll.wallDistance(20 - 0.5 - 10, 0, 1, 0, 80) - 10) <= 0.2);

  // 真实地图：与暴力射线检测一致
  for (const id of IDS) {
    const w = world(id);
    const rng = mulberry32(2024);
    let maxErr = 0;
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const p = diskPoint(rng, w.radius - 12);
      const a = rng() * Math.PI * 2;
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      let brute = 80;
      for (const o of w.obstacles) {
        if (o.blocksBullets === false) continue;
        let lo = 0;
        let hi = brute;
        let ok = true;
        const x0 = o.x - o.w * 0.5;
        const x1 = o.x + o.w * 0.5;
        const z0 = o.z - o.d * 0.5;
        const z1 = o.z + o.d * 0.5;
        if (Math.abs(ux) < 1e-9) { if (p.x < x0 || p.x > x1) ok = false; } else {
          const t1 = (x0 - p.x) / ux;
          const t2 = (x1 - p.x) / ux;
          lo = Math.max(lo, Math.min(t1, t2));
          hi = Math.min(hi, Math.max(t1, t2));
          if (lo > hi) ok = false;
        }
        if (ok) {
          if (Math.abs(uz) < 1e-9) { if (p.z < z0 || p.z > z1) ok = false; } else {
            const t1 = (z0 - p.z) / uz;
            const t2 = (z1 - p.z) / uz;
            lo = Math.max(lo, Math.min(t1, t2));
            hi = Math.min(hi, Math.max(t1, t2));
            if (lo > hi) ok = false;
          }
        }
        if (ok && lo < brute) brute = lo;
      }
      const got = w.wallDistance(p.x, p.z, ux, uz, 80);
      maxErr = Math.max(maxErr, Math.abs(got - brute));
      compared++;
    }
    assert.ok(maxErr <= 0.05, `${id} wallDistance 与暴力射线最大误差 ${maxErr.toFixed(3)}`);
    assert.ok(compared > 300);
  }
});

test('world: nav 网格覆盖 bounds，pathClear 与 blocked 采样一致', () => {
  for (const id of IDS) {
    const w = world(id);
    const nav = w.nav;
    assert.equal(nav.cell, NAV_CELL);
    assert.equal(nav.walkable.length, nav.cols * nav.rows);
    assert.ok(nav.minX <= w.bounds.minX + NAV_CELL && nav.minZ <= w.bounds.minZ + NAV_CELL);
    assert.ok(nav.minX + nav.cols * nav.cell >= w.bounds.maxX);
    assert.ok(nav.minZ + nav.rows * nav.cell >= w.bounds.maxZ);
    // 单元状态与 blocked(0.9) 一致（以单元中心采样）
    let mismatch = 0;
    for (let r = 0; r < nav.rows; r++) {
      for (let c = 0; c < nav.cols; c++) {
        const x = nav.minX + (c + 0.5) * nav.cell;
        const z = nav.minZ + (r + 0.5) * nav.cell;
        const expect = w.blocked(x, z, 0.9) ? 0 : 1;
        if (nav.walkable[r * nav.cols + c] !== expect) mismatch++;
      }
    }
    assert.equal(mismatch, 0, `${id} nav 有 ${mismatch} 个单元与 blocked 不一致`);
    // pathClear 与逐点采样一致
    const rng = mulberry32(31);
    let bad = 0;
    for (let i = 0; i < 300; i++) {
      const a = w.randomPoint(rng, w.radius - 20, 4);
      const b = w.randomPoint(rng, w.radius - 20, 4);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1e-6;
      let sampled = true;
      for (let t = 0; t <= len; t += nav.cell * 0.45) {
        if (nav.blockedAt(a.x + (dx / len) * t, a.z + (dz / len) * t)) { sampled = false; break; }
      }
      if (nav.pathClear(a.x, a.z, b.x, b.z) !== sampled) bad++;
    }
    assert.ok(bad <= 3, `${id} pathClear 与采样有 ${bad}/300 处不一致`);
    // nearestWalkable 永远落在可行走单元上
    for (let i = 0; i < 200; i++) {
      const x = (rng() * 2 - 1) * w.radius;
      const z = (rng() * 2 - 1) * w.radius;
      const p = nav.nearestWalkable(x, z);
      assert.equal(nav.blockedAt(p.x, p.z), false, `${id} nearestWalkable 返回不可走点`);
    }
  }
});

test('world: regionAt / isWater / 缓存 / 确定性', () => {
  for (const id of IDS) {
    const w = world(id);
    for (const r of w.regions) {
      const got = w.regionAt(r.x, r.z);
      assert.ok(got, `${id} regionAt(${r.name} 中心) 返回 null`);
      assert.equal(got.id, r.id, `${id} regionAt 返回 ${got.id}，期望 ${r.id}`);
    }
    assert.equal(w.regionAt(99999, 99999), null);
    // 区域结构
    for (const r of w.regions) {
      assert.ok(['town', 'village', 'port', 'mine', 'farm', 'industrial', 'wild', 'checkpoint', 'ruins'].includes(r.kind));
      assert.ok(r.tier >= 1 && r.tier <= 3);
    }
  }
  // 水域语义：qinglan 有海、baiye 有冰湖且可走、chisha 无大水
  const q = world('qinglan');
  assert.equal(q.isWater(q.radius - 2, 0), true, 'qinglan 外海应为水');
  const b = world('baiye');
  assert.equal(b.isWater(48, 118), true, 'baiye 冰湖应为水/特殊地形');
  assert.equal(b.blocked(48, 118, PLAYER_RADIUS), false, 'baiye 冰湖应可行走（仅减速）');
  assert.ok(b.waters.length >= 2, 'baiye 应有冰湖 + 港湾');
  const c = world('chisha');
  assert.ok(c.waters.length <= 1, 'chisha 不应有大面积水域');

  // 缓存返回同一实例
  const a1 = makeWorld('qinglan');
  const a2 = makeWorld('qinglan');
  assert.equal(a1, a2);
  assert.equal(worldCache.get('qinglan'), a1);

  // 确定性：同 seed 生成完全一致
  const d1 = makeWorldUncached('chisha');
  const d2 = makeWorldUncached('chisha');
  assert.equal(d1.buildings.length, d2.buildings.length);
  for (let i = 0; i < 20; i++) {
    assert.equal(d1.buildings[i].x, d2.buildings[i].x);
    assert.equal(d1.buildings[i].z, d2.buildings[i].z);
  }
  assert.deepEqual(d1.lootSpots.slice(0, 40), d2.lootSpots.slice(0, 40));
  assert.deepEqual(d1.spawnAnchors, d2.spawnAnchors);
});

test('world: 三张地图几何统计显著不同（不是换皮）', () => {
  const sig = {};
  for (const id of IDS) {
    const w = world(id);
    const kinds = {};
    for (const o of w.obstacles) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
    const tiers = [0, 0, 0, 0];
    for (const l of w.lootSpots) tiers[l.tier]++;
    const centers = w.buildings.map(b => `${b.x.toFixed(1)},${b.z.toFixed(1)}`).join('|');
    sig[id] = {
      buildings: w.buildings.length,
      obstacles: w.obstacles.length,
      trees: w.trees.length,
      roads: w.roads.length,
      waters: w.waters.length,
      props: w.props.length,
      kinds,
      tiers,
      centerHash: centers,
    };
    // 建筑必须分布在各区域周围
    const byRegion = new Set(w.buildings.map(b => b.regionId).filter(Boolean));
    assert.ok(byRegion.size >= 6, `${id} 建筑只覆盖 ${byRegion.size} 个区域（需要围绕 regions 聚集）`);
    // 出生锚点间距
    for (let i = 0; i < w.spawnAnchors.length; i++) {
      for (let j = i + 1; j < w.spawnAnchors.length; j++) {
        const a = w.spawnAnchors[i];
        const b2 = w.spawnAnchors[j];
        const dist = Math.hypot(a.x - b2.x, a.z - b2.z);
        assert.ok(dist >= ANCHOR_SPACING - 0.2, `${id} 出生锚点间距 ${dist.toFixed(1)} < ${ANCHOR_SPACING}`);
      }
    }
  }
  // 建筑中心坐标必须完全不同
  assert.notEqual(sig.qinglan.centerHash, sig.chisha.centerHash);
  assert.notEqual(sig.qinglan.centerHash, sig.baiye.centerHash);
  assert.notEqual(sig.chisha.centerHash, sig.baiye.centerHash);
  // 地形统计（建筑/障碍/水域/道路）不能三项全同
  const shape = id => `${sig[id].buildings}/${sig[id].obstacles}/${sig[id].waters}/${sig[id].roads}`;
  assert.notEqual(shape('qinglan'), shape('chisha'));
  assert.notEqual(shape('qinglan'), shape('baiye'));
  assert.notEqual(shape('chisha'), shape('baiye'));
  // 障碍构成不同：chisha 集装箱最多，qinglan 树/岩更多
  assert.ok(sig.chisha.kinds.container > sig.baiye.kinds.container, 'chisha 集装箱应多于 baiye');
  assert.ok(sig.chisha.kinds.rock > 300, 'chisha 应有大量矿坑岩石');
  assert.notEqual(sig.qinglan.tiers.join(), sig.chisha.tiers.join());
  console.log('  三图签名:', IDS.map(id => `${id}=${shape(id)}`).join('  '));
});

test('world: 共享层纯净（无 Math.random / DOM / Node API）', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../shared/map.mjs', import.meta.url), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/Math\.random/.test(body), false, '禁止 Math.random');
  assert.equal(/\bwindow\./.test(body), false, '禁止 window');
  assert.equal(/\bdocument\./.test(body), false, '禁止 document');
  assert.equal(/\bprocess\./.test(body), false, '禁止 process');
  assert.equal(/\bperformance\.now/.test(body), false, '禁止 performance.now');
  assert.equal(/\brequire\(/.test(body), false, '禁止 require');
  assert.equal(WORLD_RADIUS > 0, true);
  assert.deepEqual(MAP_ORDER, IDS);
});
