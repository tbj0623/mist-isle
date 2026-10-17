// 雾岛突围 / MIST ISLE — 世界生成与空间查询（owner: worldgen · shared/map.mjs）
// 三张地图由 shared/data/maps.mjs 的 seed 确定性生成：禁止 Math.random，禁止 DOM/Node API。
// 坐标单位：米；角度：弧度（0 = +Z 方向，x 分量 = sin(angle)）。
import { MAPS } from './data/maps.mjs';

export const VERSION = '1.0.0';
export const WORLD_RADIUS = 182;
export const NAV_CELL = 4;
export const COLLIDE_CELL = 16;
export const PLAYER_RADIUS = 0.55;
export const MIN_BUILDINGS = 70;
export const MIN_OBSTACLES = 550;
export const MIN_TREES = 900;
export const MIN_LOOT = 200;
export const MAX_LOOT_SPOTS = 320;
export const MIN_ANCHORS = 40;
export const ANCHOR_SPACING = 25;

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const GRID_ORIGIN = 1024;

/** 本地确定性随机数（mulberry32），只接受整数种子。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randomGenerator = mulberry32;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const rand = (rng, lo, hi) => lo + rng() * (hi - lo);
export const randInt = (rng, lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
export const pick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
};

/** 轴对齐矩形是否重叠（pad 为额外间距）。 */
export function rectOverlap(a, b, pad = 0) {
  return Math.abs(a.x - b.x) < (a.w + b.w) * 0.5 + pad
    && Math.abs(a.z - b.z) < (a.d + b.d) * 0.5 + pad;
}

/** 点到轴对齐矩形的距离（矩形内为 0）。 */
export function pointRectDist(px, pz, o) {
  const dx = px - clamp(px, o.x - o.w * 0.5, o.x + o.w * 0.5);
  const dz = pz - clamp(pz, o.z - o.d * 0.5, o.z + o.d * 0.5);
  return Math.hypot(dx, dz);
}

/** 16m 空间哈希：碰撞与射线加速。 */
export class SpatialGrid {
  constructor(cell = COLLIDE_CELL) {
    this.cell = cell;
    this.buckets = new Map();
    this._out = [];
  }
  _key(cx, cz) {
    return (cx + GRID_ORIGIN) * 4096 + (cz + GRID_ORIGIN);
  }
  add(o) {
    const c = this.cell;
    const x0 = Math.floor((o.x - o.w * 0.5) / c);
    const x1 = Math.floor((o.x + o.w * 0.5) / c);
    const z0 = Math.floor((o.z - o.d * 0.5) / c);
    const z1 = Math.floor((o.z + o.d * 0.5) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz);
        const bucket = this.buckets.get(k);
        if (bucket) bucket.push(o);
        else this.buckets.set(k, [o]);
      }
    }
  }
  query(minX, minZ, maxX, maxZ, out = this._out) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.buckets.get(this._key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out.length;
  }
}

/** 射线与轴对齐矩形：返回进入距离（m），无交集返回 -1。 */
function rayRect(px, pz, ux, uz, range, o) {
  let tmin = 0;
  let tmax = range;
  const minX = o.x - o.w * 0.5;
  const maxX = o.x + o.w * 0.5;
  if (Math.abs(ux) < 1e-9) {
    if (px < minX || px > maxX) return -1;
  } else {
    let t1 = (minX - px) / ux;
    let t2 = (maxX - px) / ux;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  const minZ = o.z - o.d * 0.5;
  const maxZ = o.z + o.d * 0.5;
  if (Math.abs(uz) < 1e-9) {
    if (pz < minZ || pz > maxZ) return -1;
  } else {
    let t1 = (minZ - pz) / uz;
    let t2 = (maxZ - pz) / uz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** 基于障碍列表构造碰撞/射线闭包（每张地图一份，空间哈希加速）。 */
export function makeCollision(obstacles, insideLand) {
  const grid = new SpatialGrid(COLLIDE_CELL);
  for (let i = 0; i < obstacles.length; i++) grid.add(obstacles[i]);
  const queryOut = [];

  function collides(x, z, r) {
    const n = grid.query(x - r, z - r, x + r, z + r, queryOut);
    for (let i = 0; i < n; i++) {
      if (pointRectDist(x, z, queryOut[i]) < r) return true;
    }
    return false;
  }

  function blocked(x, z, r = PLAYER_RADIUS) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return true;
    if (!insideLand(x, z)) return true;
    const radius = Number.isFinite(r) && r > 0 ? r : PLAYER_RADIUS;
    return collides(x, z, radius);
  }

  function moveBody(body, dx, dz, r = PLAYER_RADIUS) {
    if (!body || !Number.isFinite(body.x) || !Number.isFinite(body.z)) return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    const steps = Math.max(1, Math.ceil(len / 0.3));
    const sx = dx / steps;
    const sz = dz / steps;
    let moved = false;
    for (let i = 0; i < steps; i++) {
      if (!blocked(body.x + sx, body.z, r)) { body.x += sx; moved = true; }
      if (!blocked(body.x, body.z + sz, r)) { body.z += sz; moved = true; }
    }
    return moved;
  }

  function wallDistance(x, z, dx, dz, range = 120) {
    const len = Math.hypot(dx, dz);
    const maxRange = Number.isFinite(range) && range > 0 ? range : 120;
    if (!(len > 1e-9)) return maxRange;
    const ux = dx / len;
    const uz = dz / len;
    const n = grid.query(
      Math.min(x, x + ux * maxRange) - 0.6,
      Math.min(z, z + uz * maxRange) - 0.6,
      Math.max(x, x + ux * maxRange) + 0.6,
      Math.max(z, z + uz * maxRange) + 0.6,
      queryOut,
    );
    let best = maxRange;
    for (let i = 0; i < n; i++) {
      const o = queryOut[i];
      if (o.blocksBullets === false) continue;
      const t = rayRect(x, z, ux, uz, best, o);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }

  function clearLine(a, b) {
    if (!a || !b) return true;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return true;
    if (!insideLand(a.x, a.z) || !insideLand(b.x, b.z)) return false;
    return wallDistance(a.x, a.z, dx / len, dz / len, len) >= len - 0.35;
  }

  return { blocked, moveBody, wallDistance, clearLine };
}

// ---------------------------------------------------------------------------
// 生成上下文：统一 id、命中记录、与已生成内容的间距检查
// ---------------------------------------------------------------------------

class Builder {
  constructor(def) {
    this.def = def;
    this.seed = def.seed >>> 0;
    this.radius = def.radius;
    this.buildings = [];
    this.obstacles = [];
    this.props = [];
    this.trees = [];
    this.roads = [];
    this.waters = [];
    this.lootSpots = [];
    this.carSpots = [];
    this.spawnAnchors = [];
    this.landmarks = [];
    this.regions = def.regions.map((r, i) => ({
      id: r.id, name: r.name, x: r.x, z: r.z, tier: r.tier, kind: r.kind, r: r.r || 36, index: i,
    }));
    this._id = { b: 0, o: 0, p: 0 };
    this.regionHits = this.regions.map(() => 0);
    this.buildingCells = new Map();
    this.bigs = [];
    this.doors = [];
    this.treeGrid = new SpatialGrid(8);
    this.solidGrid = new SpatialGrid(16);
    this._qSolid = [];
    this._qTree = [];
    this.rng = mulberry32((def.seed ^ 0x9e3779b9) >>> 0);
    this.waters = [];
  }

  distToEdge(x, z) { return this.radius - Math.hypot(x, z); }
  insideLand(x, z, pad = 0) {
    if (Math.hypot(x, z) > this.radius - pad) return false;
    for (let i = 0; i < this.waters.length; i++) {
      const w = this.waters[i];
      if (w.solid && this._inWaterShape(w, x, z)) return false;
    }
    return true;
  }

  _inWaterShape(w, x, z) {
    if (w.r) {
      const d = Math.hypot(x - w.x, z - w.z);
      return d <= w.r + (w.pad || 0);
    }
    return Math.abs(x - w.x) <= w.w * 0.5 && Math.abs(z - w.z) <= w.d * 0.5;
  }

  inWater(x, z) {
    if (this.def.water === 'sea' && Math.hypot(x, z) > this.radius - 6) return true;
    for (let i = 0; i < this.waters.length; i++) {
      if (this._inWaterShape(this.waters[i], x, z)) return true;
    }
    return false;
  }

  treeFree(x, z, minDist = 1.6) {
    if (this.nearSolid(x, z, minDist * 0.5)) return false;
    const md = minDist * minDist;
    for (let i = this.trees.length - 1; i >= 0 && i > this.trees.length - 260; i--) {
      const t = this.trees[i];
      if (t.x < x - minDist || t.x > x + minDist || t.z < z - minDist || t.z > z + minDist) continue;
      if (dist2(x, z, t.x, t.z) < md) return false;
    }
    return true;
  }

  regionOf(x, z, fallback = 0) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < this.regions.length; i++) {
      const rg = this.regions[i];
      const d = Math.hypot(x - rg.x, z - rg.z) / Math.max(10, rg.r);
      if (d < bestScore) { bestScore = d; best = rg; }
    }
    return best || this.regions[fallback] || null;
  }

  /** 某点是否与已有建筑（含间距）或障碍冲突；ignoreTrees 用于在树丛中放小屋。 */
  free(x, z, w, d, pad = 3.5, opts = {}) {
    const cell = 24;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const list = this.buildingCells.get(ix * 4096 + iz);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (rectOverlap({ x, z, w, d }, b, pad)) return false;
        }
      }
    }
    if (opts.keepOut) {
      for (let i = 0; i < this.bigs.length; i++) {
        if (rectOverlap({ x, z, w, d }, this.bigs[i], pad * 0.6)) return false;
      }
    }
    return true;
  }

  _registerBuilding(b) {
    const cell = 24;
    const cx = Math.floor(b.x / cell);
    const cz = Math.floor(b.z / cell);
    const key = cx * 4096 + cz;
    const list = this.buildingCells.get(key);
    if (list) list.push(b);
    else this.buildingCells.set(key, [b]);
  }

  /** 该矩形是否与已有建筑重叠（含 pad）。 */
  buildingAt(x, z, w, d, pad = 0.8) {
    const cell = 24;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const list = this.buildingCells.get(ix * 4096 + iz);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          if (rectOverlap({ x, z, w, d }, list[i], pad)) return list[i];
        }
      }
    }
    return null;
  }

  /** 该点是否堵住某个已生成门洞（默认 3.2m 半径视为门口缓冲区）。 */
  nearDoor(x, z, rad = 3.2) {
    const r2 = rad * rad;
    for (let i = 0; i < this.doors.length; i++) {
      const d = this.doors[i];
      if (dist2(x, z, d.x, d.z) < r2) return true;
    }
    return false;
  }

  obstacle(x, z, w, d, kind, extra = {}) {
    if (!this.insideLand(x, z, 1.5)) return null;
    if (kind !== 'wall') {
      if (this.buildingAt(x, z, w, d, 0.9)) return null;
      if (!extra.ignoreDoor && this.nearDoor(x, z)) return null;
    }
    const o = {
      id: this._id.o++, x, z, w, d,
      h: extra.h ?? 2.4,
      kind,
      blocksBullets: extra.blocksBullets !== false,
      blocksVision: extra.blocksVision === true,
      rot: extra.rot || 0,
      big: extra.big === true,
      regionId: extra.regionId || this.regionOf(x, z).id,
    };
    if (extra.building) o.building = extra.building;
    this.obstacles.push(o);
    this.solidGrid.add(o);
    if (o.big) this.bigs.push(o);
    return o;
  }

  /** 该点周围 rad 米内是否有障碍（含树），用于生成期快速避让。 */
  nearSolid(x, z, rad) {
    const n = this.solidGrid.query(x - rad, z - rad, x + rad, z + rad, this._qSolid);
    for (let i = 0; i < n; i++) {
      if (pointRectDist(x, z, this._qSolid[i]) < rad) return true;
    }
    return false;
  }

  clearSpot(x, z, rad) {
    if (!this.insideLand(x, z, rad + 1)) return false;
    if (this.nearSolid(x, z, rad)) return false;
    for (let i = 0; i < this.buildings.length; i++) {
      if (pointRectDist(x, z, this.buildings[i]) < rad + 1.5) return false;
    }
    return true;
  }

  prop(x, z, w, d, kind, color, h = 1) {
    if (!this.insideLand(x, z, 1)) return null;
    const p = { id: this._id.p++, x, z, w, d, h, kind, color };
    this.props.push(p);
    return p;
  }

  /** 清除矩形范围内的树（生成后期门口清障用）。 */
  clearTrees(x, z, w, d) {
    const hw = w * 0.5;
    const hd = d * 0.5;
    const lim = Math.max(w, d) + 2;
    let removed = 0;
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i];
      if (Math.abs(t.x - x) > lim || Math.abs(t.z - z) > lim) continue;
      if (Math.abs(t.x - x) <= hw && Math.abs(t.z - z) <= hd) {
        this.trees.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  tree(x, z, kind = 0) {
    if (!this.insideLand(x, z, 2.5)) return null;
    if (this.nearDoor(x, z, 2.8)) return null;
    if (!this.treeFree(x, z, 1.7)) return null;
    const scale = 0.78 + this.rng() * 0.75;
    const t = { x, z, scale, kind };
    this.trees.push(t);
    this.solidGrid.add({ x, z, w: 0.9 * scale + 0.4, d: 0.9 * scale + 0.4, tree: true });
    return t;
  }

  /** 所有树统一转成障碍（一次性，避免生成期空间哈希开销）。 */
  commitTrees() {
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const w = 0.85 * t.scale + 0.4;
      this.obstacles.push({
        id: this._id.o++, x: t.x, z: t.z, w, d: w, h: 6 * t.scale,
        kind: 'tree', blocksBullets: true, blocksVision: false, rot: 0, big: false,
        regionId: this.regionOf(t.x, t.z).id,
      });
    }
  }

  loot(x, z, tier) {
    if (this.lootSpots.length >= MAX_LOOT_SPOTS) return;
    this.lootSpots.push({ x, z, tier: clamp(Math.round(tier), 1, 3) });
  }

  car(x, z, type, rot) {
    this.carSpots.push({ x, z, type, rot });
  }

  anchor(x, z) {
    this.spawnAnchors.push({ x, z });
  }

  landmark(kind, x, z, r = 8, label = '') {
    this.landmarks.push({ kind, x, z, r, label });
  }
}

/** 生成一个矩形房子的四面墙 + 一个门洞（gap ≥ 2.2m），返回建筑对象。 */
function addHouse(bd, rng, x, z, w, d, opts = {}) {
  w = Math.max(5, w);
  d = Math.max(4.5, d);
  const rot = 0; // 墙体统一轴对齐；rot 仅记录供渲染微调
  const region = opts.region || bd.regionOf(x, z);
  const T = 0.6; // 墙厚
  const hw0 = w * 0.5;
  const hd0 = d * 0.5;
  // 门洞：优先选择「门外 3m 内没有已有障碍」的一面，避免门外被树/岩石堵死
  const doorWidthRaw = opts.doorWidth ?? rand(rng, 3.8, 5.0);
  let doorSide = -1;
  const sideOrder = [];
  for (let i = 0; i < 4; i++) sideOrder.push(i);
  for (let i = sideOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = sideOrder[i]; sideOrder[i] = sideOrder[j]; sideOrder[j] = tmp;
  }
  // 给定门面作为首选，但门外被堵时自动换面
  const preferred = opts.doorSide;
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < 4) {
    const idx = sideOrder.indexOf(preferred);
    if (idx > 0) { sideOrder.splice(idx, 1); sideOrder.unshift(preferred); }
  }
  for (const s of sideOrder) {
    const along = s % 2 === 0 ? w : d;
    const g = Math.min(doorWidthRaw, Math.max(3.6, along - 2.4));
    const nx = s === 1 ? 1 : s === 3 ? -1 : 0;
    const nz = s === 0 ? -1 : s === 2 ? 1 : 0;
    const dx = x + nx * (s % 2 === 0 ? hd0 : hw0);
    const dz = z + nz * (s % 2 === 0 ? hd0 : hw0);
    // 门洞两侧沿墙、以及门外 1.2 / 2.6 / 3.8m 采样
    let ok = true;
    const tx = 1 - Math.abs(nx);
    const tz = 1 - Math.abs(nz);
    for (let t = -g * 0.5; t <= g * 0.5 + 1e-6 && ok; t += g / 6) {
      for (const off of [0, 1.2, 2.6, 3.8]) {
        const px = dx + tx * t + nx * off;
        const pz = dz + tz * t + nz * off;
        if (!bd.insideLand(px, pz, 0.8) || bd.nearSolid(px, pz, 0.75)) { ok = false; break; }
      }
    }
    if (ok) { doorSide = s; break; }
  }
  if (doorSide < 0) doorSide = sideOrder[0];
  const alongDoor = doorSide % 2 === 0 ? w : d;
  const gapW = Math.min(doorWidthRaw, Math.max(3.6, alongDoor - 2.4));
  const maxOff = Math.max(0, alongDoor * 0.5 - gapW * 0.5 - 0.5);
  const doorOffset = rand(rng, -1, 1) * Math.min(maxOff, alongDoor * 0.28);
  const wallH = opts.h ?? rand(rng, 3.0, 3.6);
  const theme = bd.def.theme;
  const b = {
    id: 'b' + bd._id.b++,
    x, z, w, d, h: opts.h ?? wallH,
    rot,
    walls: true,
    roofColor: pick(rng, theme.roof),
    floorColor: pick(rng, theme.wall),
    regionId: region ? region.id : null,
    regionName: region ? region.name : '',
    radius: region ? region.r : 30,
    entrances: [],
    kind: opts.kind || 'house',
    floors: opts.floors || (rng() < 0.45 ? 2 : 1),
    tier: clamp(region ? region.tier : 1, 1, 3),
  };
  bd.buildings.push(b);
  bd._registerBuilding(b);
  if (region) bd.regionHits[region.index] += 1;

  // 局部坐标 -> 世界坐标（门洞判断用局部坐标即可，因为 rot=0 时一致；带 rot 的建筑按网格近似）
  const wall = (cx, cz, ww, dd) => bd.obstacle(cx, cz, ww, dd, 'wall', {
    h: wallH, regionId: b.regionId, rot: 0, building: b.id,
  });
  const hw = w * 0.5;
  const hd = d * 0.5;
  // 四面墙：每面按门洞切分。side: 0 = z-hd 面（-z），1 = x+hw 面（+x），2 = z+hd 面（+z），3 = x-hw 面（-x）
  for (let side = 0; side < 4; side++) {
    const along = side % 2 === 0 ? w : d;      // 该面的长度
    const isDoor = side === doorSide;
    const gap = isDoor ? gapW : 0;
    const segs = isDoor
      ? [[-along * 0.5, doorOffset - gap * 0.5], [doorOffset + gap * 0.5, along * 0.5]]
      : [[-along * 0.5, along * 0.5]];
    for (const [a0, a1] of segs) {
      const len = a1 - a0;
      if (len <= 0.05) continue;
      const mid = (a0 + a1) * 0.5;
      if (side === 0) wall(x + mid, z - hd, len, T);
      else if (side === 2) wall(x + mid, z + hd, len, T);
      else if (side === 3) wall(x - hw, z + mid, T, len);
      else wall(x + hw, z + mid, T, len);
    }
    if (isDoor) {
      const ox = side === 0 || side === 2 ? doorOffset : (side === 1 ? hw : -hw);
      const oz = side === 0 ? -hd : side === 2 ? hd : doorOffset;
      b.entrances.push({ x: x + ox, z: z + oz, side });
      bd.doors.push({ x: x + ox, z: z + oz, side, gap });
      // 门框：与墙面齐平加厚，保证门洞净宽不被门柱吃掉
      const frameH = 2.9;
      const fw = 0.36;
      if (side === 0 || side === 2) {
        const zz = z + (side === 0 ? -hd : hd);
        bd.obstacle(x + doorOffset - gap * 0.5 - fw * 0.5, zz, fw, T, 'wall', { h: frameH, regionId: b.regionId });
        bd.obstacle(x + doorOffset + gap * 0.5 + fw * 0.5, zz, fw, T, 'wall', { h: frameH, regionId: b.regionId });
      } else {
        const xx = x + (side === 1 ? hw : -hw);
        bd.obstacle(xx, z + doorOffset - gap * 0.5 - fw * 0.5, T, fw, 'wall', { h: frameH, regionId: b.regionId });
        bd.obstacle(xx, z + doorOffset + gap * 0.5 + fw * 0.5, T * 1, fw, 'wall', { h: frameH, regionId: b.regionId });
      }
    }
  }

  // 建筑内部中心必有一个物资点
  bd.loot(x, z, b.tier);
  const indoor = opts.indoorLoot ?? randInt(rng, 0, 2);
  for (let i = 0; i < indoor; i++) {
    bd.loot(x + rand(rng, -w * 0.3, w * 0.3), z + rand(rng, -d * 0.3, d * 0.3), b.tier);
  }
  // 门外/墙角杂物（纯装饰，不加碰撞，避免堵门）
  if (opts.prop !== false && rng() < 0.72) {
    const side = pick(rng, [-1, 1]);
    const px = x + side * (w * 0.5 + 1.4);
    const pz = z + rand(rng, -d * 0.3, d * 0.3);
    bd.prop(px, pz, 1.2, 1.2, 'crate', 0x9a8259, 1.1);
  }
  return b;
}

/** 道路：旋转矩形，kind 只允许 asphalt/dirt。 */
function addRoad(bd, x, z, w, d, rot = 0, kind = 'dirt') {
  bd.roads.push({ x, z, w, d, rot, kind });
}

/** 点是否落在已生成的道路上（含 pad），用于避免建筑压路。 */
function roadOverlap(bd, x, z, w, d, pad = 1.2) {
  const hw = w * 0.5;
  const hd = d * 0.5;
  for (let i = 0; i < bd.roads.length; i++) {
    const r = bd.roads[i];
    const cos = Math.cos(-r.rot);
    const sin = Math.sin(-r.rot);
    const dx = x - r.x;
    const dz = z - r.z;
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    if (Math.abs(lx) < r.w * 0.5 + hw + pad && Math.abs(lz) < r.d * 0.5 + hd + pad) return true;
  }
  return false;
}

/** 旋转矩形的轴对齐包围盒尺寸（碰撞统一用 AABB，保守一点）。 */
function aabbExtent(len, wid, rot) {
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  return { w: len * c + wid * s, d: len * s + wid * c };
}

/** 集装箱：kind container，6.1×2.5 或 12.2×2.5（40ft）。 */
function addContainer(bd, rng, x, z, rot = 0, opts = {}) {
  const long = opts.long ?? rng() < 0.35;
  const len = long ? 12.2 : 6.1;
  const wid = 2.55;
  const { w, d } = aabbExtent(len, wid, rot);
  if (!bd.insideLand(x, z, 3)) return null;
  const color = pick(rng, [0xc4563f, 0x3f6d7a, 0xc99a45, 0x5f7a55, 0x8a8f95, 0x9a5b4a]);
  const o = bd.obstacle(x, z, w, d, 'container', { h: opts.h ?? 2.7, rot });
  if (!o) return null;
  o.color = color;
  return o;
}

/** 岩石：kind rock。 */
function addRock(bd, rng, x, z, r = 2, h = 2.4) {
  const o = bd.obstacle(x, z, r * 2, r * 1.7, 'rock', { h, rot: rand(rng, 0, TAU) });
  if (o) o.radius = r;
  return o;
}

/** 矿坑/环形岩石带。 */
function rockRing(bd, rng, cx, cz, radius, count, thick = 2.4) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rand(rng, -0.06, 0.06);
    const rr = radius + rand(rng, -thick * 0.5, thick * 0.5);
    addRock(bd, rng, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, rand(rng, 1.6, 3.2), rand(rng, 1.8, 4.2));
  }
}

/** 路障/护栏：barrier。 */
function addBarrier(bd, rng, x, z, rot = 0, len = 3.6) {
  const { w, d } = aabbExtent(len, 0.6, rot);
  const o = bd.obstacle(x, z, w, d, 'barrier', { h: 1.1, rot });
  if (o) o.color = pick(rng, [0xd9a34a, 0xcf5c4a, 0xb9bec2]);
  return o;
}

/** 木箱堆。 */
function addCrates(bd, rng, x, z, count = 3, spread = 3.2) {
  for (let i = 0; i < count; i++) {
    const px = x + rand(rng, -spread, spread);
    const pz = z + rand(rng, -spread, spread);
    const s = rand(rng, 0.9, 1.5);
    bd.obstacle(px, pz, s, s, 'crate', { h: s * 0.85, rot: rand(rng, -0.4, 0.4) });
    bd.prop(px, pz, s, s, 'crate', 0x9a8259, s * 0.8);
  }
}

/** 车辆残骸：kind vehicle。 */
function addWreck(bd, rng, x, z, rot = 0) {
  const o = bd.obstacle(x, z, rand(rng, 4.2, 5.4), rand(rng, 2.0, 2.3), 'vehicle', { h: 1.5, rot });
  if (o) o.color = pick(rng, [0x7d5a48, 0x5c6b6a, 0x8b3f35, 0x6a6252]);
  return o;
}

/** 树丛：kind 0/1/2 对应主题树的三种形态。 */
function scatterTrees(bd, rng, cx, cz, radius, count, kinds = [0, 1, 2]) {
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * radius;
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr;
    if (!bd.insideLand(x, z, 3)) continue;
    if (bd.free(x, z, 1.2, 1.2, 1.4)) {
      if (!roadOverlap(bd, x, z, 1.2, 1.2, 0.6)) bd.tree(x, z, pick(rng, kinds));
    }
  }
}

/** 野地零散岩石/灌木（装饰）。 */
function scatterRocks(bd, rng, cx, cz, radius, count) {
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * radius;
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr;
    if (!bd.insideLand(x, z, 3)) continue;
    if (!bd.free(x, z, 2, 2, 1.6)) continue;
    if (roadOverlap(bd, x, z, 2, 2, 1)) continue;
    addRock(bd, rng, x, z, rand(rng, 0.7, 1.8), rand(rng, 0.6, 1.6));
  }
}

/** 在矩形区域内尝试放置一栋建筑；失败返回 null。 */
function placeBuilding(bd, rng, x, z, w, d, opts = {}) {
  if (!bd.insideLand(x, z, Math.max(w, d) * 0.5 + 6)) return null;
  if (!bd.free(x, z, w, d, opts.pad ?? 3.2, { keepOut: opts.keepOut !== false })) return null;
  if (roadOverlap(bd, x, z, w, d, opts.roadPad ?? 0.6)) return null;
  return addHouse(bd, rng, x, z, w, d, opts);
}

/** 在矩形区域内尝试放置一栋大厂房/仓库；失败返回 null。 */
function placeHall(bd, rng, x, z, w, d, opts = {}) {
  if (!bd.insideLand(x, z, Math.max(w, d) * 0.5 + 6)) return null;
  if (!bd.free(x, z, w, d, opts.pad ?? 4, { keepOut: opts.keepOut !== false })) return null;
  if (roadOverlap(bd, x, z, w, d, opts.roadPad ?? 0.8)) return null;
  return addHall(bd, rng, x, z, w, d, opts);
}

/** 用墙把一栋建筑围成更大厂房的变体（复用的高层/大门结构）。 */
function addHall(bd, rng, x, z, w, d, opts = {}) {
  const b = addHouse(bd, rng, x, z, w, d, {
    ...opts, kind: opts.kind || 'hall', doorWidth: opts.doorWidth ?? rand(rng, 4.2, 6.0),
    floors: 1,
  });
  const tier = b.tier;
  const count = opts.loot ?? randInt(rng, 2, 4);
  for (let i = 0; i < count; i++) {
    bd.loot(x + rand(rng, -w * 0.35, w * 0.35), z + rand(rng, -d * 0.35, d * 0.35), tier);
  }
  return b;
}


// ---------------------------------------------------------------------------
// 区域生成配方：按 region.kind 组合基础构件，保证三张地图风格差异明显
// ---------------------------------------------------------------------------

/** 城镇：密集民宅 + 中央广场 + 商店/仓库。 */
function buildTown(bd, rng, region, count = 11) {
  const pads = [[0, 0, 12, 10]];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rand(rng, -0.12, 0.12);
    const rr = rand(rng, region.r * 0.22, region.r * 0.78);
    const x = region.x + Math.cos(a) * rr;
    const z = region.z + Math.sin(a) * rr;
    const w = rand(rng, 8, 13);
    const d = rand(rng, 7, 11);
    placeBuilding(bd, rng, x, z, w, d, { pad: 2.4, roadPad: 0.3, doorSide: randInt(rng, 0, 3) });
  }
  // 广场/院墙/路灯/长椅
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    addCrates(bd, rng, region.x + Math.cos(a) * region.r * 0.2, region.z + Math.sin(a) * region.r * 0.2, 2, 2.4);
  }
  for (let i = 0; i < 4; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.5, region.r * 0.5), region.z + rand(rng, -region.r * 0.5, region.r * 0.5), region.tier);
  }
}

/** 村庄/棚户区：小房子密集、巷子窄。 */
function buildVillage(bd, rng, region) {
  for (let i = 0; i < 14; i++) {
    const a = rng() * TAU;
    const rr = rand(rng, region.r * 0.15, region.r * 0.85);
    const x = region.x + Math.cos(a) * rr;
    const z = region.z + Math.sin(a) * rr;
    placeBuilding(bd, rng, x, z, rand(rng, 6, 9), rand(rng, 5, 8), {
      pad: 1.8, roadPad: 0.2, doorSide: randInt(rng, 0, 3), floors: 1,
    });
  }
  for (let i = 0; i < 5; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.6, region.r * 0.6), region.z + rand(rng, -region.r * 0.6, region.r * 0.6), Math.min(3, region.tier));
  }
}

/** 港口/工业区：大厂房 + 集装箱迷宫 + 龙门吊 + 路障。 */
function buildPort(bd, rng, region) {
  const halls = randInt(rng, 4, 6);
  for (let i = 0; i < halls; i++) {
    const a = (i / halls) * TAU + rand(rng, -0.2, 0.2);
    const rr = rand(rng, region.r * 0.25, region.r * 0.7);
    placeHall(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr,
      rand(rng, 14, 22), rand(rng, 10, 15), { pad: 3.6, roadPad: 0.5 });
  }
  // 集装箱阵列（迷宫）
  const cols = 5, rows = 4;
  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      if (rng() < 0.22) continue;
      const x = region.x + (cx - cols / 2) * 8.5 + rand(rng, -0.8, 0.8);
      const z = region.z + (cz - rows / 2) * 8.5 + rand(rng, -0.8, 0.8);
      addContainer(bd, rng, x, z, rng() < 0.5 ? 0 : HALF_PI);
      if (rng() < 0.3) bd.loot(x, z, region.tier);
    }
  }
  for (let i = 0; i < 10; i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.5, region.r);
    addBarrier(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, rand(rng, 0, TAU));
  }
  for (let i = 0; i < 6; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.8, region.r * 0.8), region.z + rand(rng, -region.r * 0.8, region.r * 0.8), region.tier);
  }
}

/** 农场：谷仓 + 长条田垄 + 少量小屋。 */
function buildFarm(bd, rng, region) {
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    placeHall(bd, rng, region.x + Math.cos(a) * region.r * 0.45, region.z + Math.sin(a) * region.r * 0.45,
      rand(rng, 13, 18), rand(rng, 9, 13), { pad: 4, roadPad: 0.5 });
  }
  for (let i = 0; i < 8; i++) {
    const x = region.x + rand(rng, -region.r * 0.7, region.r * 0.7);
    const z = region.z + rand(rng, -region.r * 0.7, region.r * 0.7);
    bd.prop(x, z, rand(rng, 4, 9), 1.6, 'hay', 0xc9b06a, 0.9);
  }
  for (let i = 0; i < 4; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.6, region.r * 0.6), region.z + rand(rng, -region.r * 0.6, region.r * 0.6), region.tier);
  }
  scatterTrees(bd, rng, region.x, region.z, region.r * 1.1, 40);
}

/** 矿坑：同心岩石环 + 矿车/碎石 + 少量工棚。 */
function buildMine(bd, rng, region) {
  rockRing(bd, rng, region.x, region.z, region.r * 0.42, 22, 3);
  rockRing(bd, rng, region.x, region.z, region.r * 0.68, 30, 3.4);
  for (let i = 0; i < 5; i++) {
    const a = rng() * TAU;
    placeBuilding(bd, rng, region.x + Math.cos(a) * region.r * 0.3, region.z + Math.sin(a) * region.r * 0.3,
      rand(rng, 8, 12), rand(rng, 7, 10), { pad: 2.6 });
  }
  for (let i = 0; i < 12; i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.3, region.r * 0.9);
    addWreck(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, rand(rng, 0, TAU));
  }
  for (let i = 0; i < 10; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.8, region.r * 0.8), region.z + rand(rng, -region.r * 0.8, region.r * 0.8), region.tier);
  }
}

/** 检查站/哨卡：小屋 + 路障阵列 + 掩体墙。 */
function buildCheckpoint(bd, rng, region) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    placeBuilding(bd, rng, region.x + Math.cos(a) * region.r * 0.4, region.z + Math.sin(a) * region.r * 0.4,
      rand(rng, 7, 11), rand(rng, 6, 9), { pad: 2.2 });
  }
  for (let i = 0; i < 16; i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.2, region.r);
    addBarrier(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, rand(rng, 0, TAU), rand(rng, 3, 5));
  }
  for (let i = 0; i < 6; i++) addCrates(bd, rng, region.x + rand(rng, -region.r * 0.6, region.r * 0.6), region.z + rand(rng, -region.r * 0.6, region.r * 0.6), 2, 2.2);
  for (let i = 0; i < 8; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.7, region.r * 0.7), region.z + rand(rng, -region.r * 0.7, region.r * 0.7), region.tier);
  }
}

/** 野地：散落小屋 + 树丛 + 岩石。 */
function buildWild(bd, rng, region) {
  for (let i = 0; i < 5; i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.2, region.r * 0.8);
    placeBuilding(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr,
      rand(rng, 6, 9), rand(rng, 5, 8), { pad: 2.4, floors: 1 });
  }
  scatterTrees(bd, rng, region.x, region.z, region.r * 1.15, 70);
  scatterRocks(bd, rng, region.x, region.z, region.r * 0.9, 16);
  for (let i = 0; i < 5; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.7, region.r * 0.7), region.z + rand(rng, -region.r * 0.7, region.r * 0.7), Math.max(1, region.tier - 1));
  }
}

/** 按 kind 分发区域生成。 */
function buildRegion(bd, rng, region) {
  switch (region.kind) {
    case 'town': buildTown(bd, rng, region); break;
    case 'village': buildVillage(bd, rng, region); break;
    case 'port': buildPort(bd, rng, region); break;
    case 'industrial': buildPort(bd, rng, region); break;
    case 'farm': buildFarm(bd, rng, region); break;
    case 'mine': buildMine(bd, rng, region); break;
    case 'checkpoint': buildCheckpoint(bd, rng, region); break;
    case 'wild': buildWild(bd, rng, region); break;
    case 'ruins': buildMine(bd, rng, region); break;
    default: buildWild(bd, rng, region);
  }
}

/** 野外补白：随机小屋、车点、物资点、岩石树丛。 */
function fillWilderness(bd, rng, def) {
  for (let i = 0; i < 2400 && bd.lootSpots.length < MIN_LOOT + 40; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * (bd.radius - 12);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (!bd.clearSpot(x, z, 1.4)) continue;
    if (roadOverlap(bd, x, z, 1, 1, 1.2)) continue;
    bd.loot(x, z, rng() < 0.22 ? 2 : 1);
  }
  // 野外小屋
  for (let i = 0; i < 900 && bd.buildings.length < MIN_BUILDINGS; i++) {
    const a = rng() * TAU;
    const rr = rand(rng, 40, bd.radius - 20);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    placeBuilding(bd, rng, x, z, rand(rng, 6, 9), rand(rng, 5, 8), { pad: 3, roadPad: 0.6, floors: 1 });
  }
  // 树与岩石（多生成 40 棵，门洞清障后仍满足 ≥900）
  for (let i = 0; i < 9000 && bd.trees.length < MIN_TREES + 40; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * (bd.radius - 8);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (bd.nearSolid(x, z, 2.2)) continue;
    if (roadOverlap(bd, x, z, 1, 1, 0.8)) continue;
    bd.tree(x, z, randInt(rng, 0, 2));
  }
  for (let i = 0; i < 900 && bd.obstacles.length < MIN_OBSTACLES + bd.trees.length; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * (bd.radius - 10);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (!bd.clearSpot(x, z, 2)) continue;
    addRock(bd, rng, x, z, rand(rng, 0.8, 2.2), rand(rng, 0.8, 2.4));
  }
}

/** 车辆刷新点：沿道路与区域外围。 */
function fillCars(bd, rng) {
  const types = ['buggy', 'jeep', 'bike', 'truck'];
  let guard = 0;
  while (bd.carSpots.length < 12 && guard++ < 800) {
    const a = rng() * TAU;
    const rr = rand(rng, 20, bd.radius - 24);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (!bd.clearSpot(x, z, 3.4)) continue;
    bd.car(x, z, types[bd.carSpots.length % types.length], rand(rng, 0, TAU));
  }
}

/** 出生锚点：均匀分布在陆地内，彼此间距 ≥ ANCHOR_SPACING。 */
function fillAnchors(bd, rng) {
  const target = 48;
  const minD2 = ANCHOR_SPACING * ANCHOR_SPACING;
  const pts = [];
  for (let guard = 0; guard < 30000 && pts.length < target; guard++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * (bd.radius - 26);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (bd.inWater(x, z)) continue;
    if (bd.nearSolid(x, z, 2.0)) continue;
    let ok = true;
    for (let i = 0; i < pts.length; i++) {
      if (dist2(pts[i].x, pts[i].z, x, z) < minD2) { ok = false; break; }
    }
    if (ok) pts.push({ x, z });
  }
  // 兜底：六边形网格采样，保证 ≥40 且间距不破
  if (pts.length < MIN_ANCHORS) {
    const step = ANCHOR_SPACING + 1.5;
    for (let gx = -bd.radius + 20; gx <= bd.radius - 20 && pts.length < target; gx += step) {
      for (let gz = -bd.radius + 20; gz <= bd.radius - 20 && pts.length < target; gz += step) {
        const x = gx + (((gz / step) | 0) % 2) * step * 0.5;
        if (bd.inWater(x, gz)) continue;
        if (bd.nearSolid(x, gz, 2.0)) continue;
        let ok = true;
        for (let i = 0; i < pts.length; i++) {
          if (dist2(pts[i].x, pts[i].z, x, gz) < minD2) { ok = false; break; }
        }
        if (ok) pts.push({ x, z: gz });
      }
    }
  }
  for (let i = 0; i < pts.length; i++) bd.anchor(pts[i].x, pts[i].z);
}

/** 导航网格：4m 单元，供 Bot A* 与快速通行检查。 */
function buildNav(world) {
  const cell = NAV_CELL;
  const radius = world.radius;
  const span = Math.ceil((radius * 2) / cell) + 2;
  const minX = -radius - cell;
  const minZ = -radius - cell;
  const cols = span;
  const rows = span;
  const walkable = new Uint8Array(cols * rows);
  const blocked = world.blocked;
  for (let r = 0; r < rows; r++) {
    const z = minZ + r * cell;
    for (let c = 0; c < cols; c++) {
      const x = minX + c * cell;
      walkable[r * cols + c] = blocked(x, z, 0.9) ? 0 : 1;
    }
  }
  const nav = {
    cell, cols, rows, minX, minZ, walkable,
    colOf(x) { return Math.floor((x - minX) / cell); },
    rowOf(z) { return Math.floor((z - minZ) / cell); },
    idxOf(x, z) { return this.rowOf(z) * cols + this.colOf(x); },
    isWalkable(x, z) {
      const c = nav.colOf(x); const r = nav.rowOf(z);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
      return nav.walkable[r * cols + c] === 1;
    },
    blockedAt(x, z) { return !nav.isWalkable(x, z); },
    nearestWalkable(x, z, maxR = 14) {
      if (nav.isWalkable(x, z)) return { x, z };
      for (let rr = cell; rr <= maxR; rr += cell) {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TAU;
          const nx = x + Math.cos(a) * rr;
          const nz = z + Math.sin(a) * rr;
          if (nav.isWalkable(nx, nz)) return { x: nx, z: nz };
        }
      }
      return { x, z };
    },
    pathClear(ax, az, bx, bz) {
      const dx = bx - ax; const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) return true;
      const steps = Math.ceil(len / (cell * 0.45));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (nav.blockedAt(ax + dx * t, az + dz * t)) return false;
      }
      return true;
    },
  };
  return nav;
}

/** 采集点是否落在水里（建筑/车点/锚点/物资点排除）。 */
function dryLand(bd, x, z) {
  return !bd.inWater(x, z);
}

/** 水域先行注册（建筑/树木/物资点需避开深水）。 */
function applyWaters(bd, def) {
  if (def.id === 'qinglan') {
    bd.waters.push({ x: 118, z: 112, r: 18, kind: 'bay', solid: true });
    bd.waters.push({ x: -126, z: 116, r: 13, kind: 'bay', solid: true });
  } else if (def.id === 'chisha') {
    bd.waters.push({ x: 122, z: 8, r: 12, kind: 'oasis', solid: true });
  } else if (def.id === 'baiye') {
    bd.waters.push({ x: 48, z: 118, r: 40, kind: 'ice', solid: false, slippery: true });
    bd.waters.push({ x: 96, z: -96, r: 34, kind: 'harbor', solid: true });
    bd.waters.push({ x: 140, z: -70, r: 20, kind: 'harbor', solid: true });
  }
}

/** 每张地图的建筑/树/障碍目标（均高于契约下限，且三图数量不同以体现地形差异）。 */
const MAP_TARGETS = {
  qinglan: { buildings: 78, trees: 960, extraRocks: 60 },
  chisha: { buildings: 72, trees: 900, extraRocks: 150 },
  baiye: { buildings: 84, trees: 930, extraRocks: 80 },
};

/** 三图各自的标志性地形：地标、特色阵列（水域已在 applyWaters 中注册）。 */
function applyThemeFeatures(bd, rng, def) {
  const radius = bd.radius;
  const lm = def.landmarks || [];
  if (def.id === 'qinglan') {
    // 外海由 isWater 处理；采石场坑 + 风车 + 松林
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const x = -88 + Math.cos(a) * 22;
      const z = 78 + Math.sin(a) * 22;
      bd.obstacle(x, z, 2.2, 2.2, 'crate', { h: 7.5, big: true });
      bd.landmark('windmill', x, z, 3, '风车');
    }
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      bd.prop(-88 + Math.cos(a) * 18, 78 + Math.sin(a) * 18, 3, 1.2, 'hay', 0xc9b06a, 0.8);
    }
    // 采石矿坑：大型岩石围坑（留一个斜坡口）
    rockRingSkip(bd, rng, 0, 130, 30, 34, 3.2, 0.6);
    for (let i = 0; i < 10; i++) {
      const a = rand(rng, 0, TAU), rr = rand(rng, 6, 22);
      addRock(bd, rng, Math.cos(a) * rr, 130 + Math.sin(a) * rr * 0.6, rand(rng, 1.4, 2.8), rand(rng, 1.2, 2.6));
    }
    bd.landmark('quarry', 0, 130, 30, '旧采石场');
    // 松林（大片）
    for (let i = 0; i < 520; i++) {
      const a = rng() * TAU;
      const rr = Math.sqrt(rng()) * 46;
      const x = 66 + Math.cos(a) * rr;
      const z = -72 + Math.sin(a) * rr;
      bd.tree(x, z, rng() < 0.7 ? 0 : 1);
    }
    // 中央检查站：四组建筑群 + 路障阵
    for (let q = 0; q < 4; q++) {
      const qx = (q < 2 ? -1 : 1) * 24;
      const qz = (q % 2 === 0 ? -1 : 1) * 24;
      for (let i = 0; i < 3; i++) {
        placeBuilding(bd, rng, qx + rand(rng, -7, 7), qz + rand(rng, -7, 7), rand(rng, 7, 10), rand(rng, 6, 9), { pad: 1.6, roadPad: 0.2 });
      }
    }
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU;
      addBarrier(bd, rng, Math.cos(a) * 16, Math.sin(a) * 16, a + HALF_PI, rand(rng, 3, 5));
    }
    // 北方哨站路障带
    for (let i = 0; i < 12; i++) {
      addBarrier(bd, rng, rand(rng, -30, 30), -118 + rand(rng, -6, 6), rand(rng, 0, TAU), rand(rng, 3, 5));
    }
    for (const l of lm) bd.landmark(l.kind, l.x, l.z, l.r, l.name);
    return;
  }
  if (def.id === 'chisha') {
    // 无真正水域（沙地），只有沙丘与盐碱滩（视觉 prop）
    for (let i = 0; i < 40; i++) {
      const a = rng() * TAU;
      const rr = rand(rng, 120, radius - 18);
      bd.prop(Math.cos(a) * rr, Math.sin(a) * rr, rand(rng, 8, 20), rand(rng, 4, 8), 'dune', 0xcfa878, rand(rng, 1.2, 3.2));
    }
    // 巨大矿坑：同心圆岩石环 + 斜坡通道（缺口）
    const px = -14, pz = 8;
    rockRingSkip(bd, rng, px, pz, 16, 20, 3, 0.5);
    rockRingSkip(bd, rng, px, pz, 26, 26, 3.4, 0.5);
    rockRingSkip(bd, rng, px, pz, 36, 32, 3.6, 0.5);
    for (let i = 0; i < 16; i++) {
      const a = rand(rng, 0, TAU), rr = rand(rng, 5, 30);
      addRock(bd, rng, px + Math.cos(a) * rr, pz + Math.sin(a) * rr, rand(rng, 1.2, 2.6), rand(rng, 1, 2.4));
    }
    // 集装箱堆场：密集矩形阵列形成迷宫
    for (let cx = 0; cx < 8; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        if (rng() < 0.16) continue;
        const x = 96 + (cx - 3.5) * 8.2 + rand(rng, -0.6, 0.6);
        const z = -58 + (cz - 2.5) * 8.2 + rand(rng, -0.6, 0.6);
        addContainer(bd, rng, x, z, rng() < 0.5 ? 0 : HALF_PI);
        if (rng() < 0.25) bd.loot(x, z, 3);
      }
    }
    // 炼油厂：储油罐（方形近似）+ 管道
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const x = -104 + Math.cos(a) * 20;
      const z = 52 + Math.sin(a) * 20;
      bd.obstacle(x, z, 7.4, 7.4, 'container', { h: 8.5, big: true, rot: 0 });
      bd.prop(x, z, 7, 7, 'tank', 0xb7a58a, 8);
      bd.loot(x + 6, z, 3);
    }
    for (let i = 0; i < 10; i++) {
      const y = 52 + (i - 5) * 4.4;
      bd.obstacle(-104 + rand(rng, -1, 1), y, rand(rng, 22, 34), 0.9, 'wall', { h: 1.2 });
    }
    // 废车场：车辆残骸阵列
    for (let i = 0; i < 26; i++) {
      const x = 86 + rand(rng, -26, 26);
      const z = 94 + rand(rng, -22, 22);
      addWreck(bd, rng, x, z, rng() < 0.5 ? 0 : HALF_PI);
      if (rng() < 0.25) bd.loot(x, z, 2);
    }
    // 货运车站 + 铁轨走廊
    for (let i = 0; i < 8; i++) {
      bd.prop(-128 + (i - 3.5) * 9, -48, 8, 3.2, 'wagon', 0x6d5a4a, 3.4);
    }
    for (let i = 0; i < 55; i++) {
      const t = i / 54;
      bd.prop(-176 + t * 96, -104 + t * 112, 12, 0.5, 'rail', 0x5b5b5b, 0.2);
    }
    for (let i = 0; i < 8; i++) bd.loot(-168 + i * 11, -100 + i * 14, 2);
    for (const l of lm) bd.landmark(l.kind, l.x, l.z, l.r, l.name);
    return;
  }
  // baiye 白夜港
  // 冰湖/港湾已在 applyWaters 注册；港区集装箱 + 龙门吊
  for (let i = 0; i < 40; i++) {
    const x = 96 + rand(rng, -34, 34);
    const z = -96 + rand(rng, -30, 30);
    if (bd.insideLand(x, z, 2)) addContainer(bd, rng, x, z, rng() < 0.5 ? 0 : HALF_PI);
  }
  for (let i = 0; i < 3; i++) {
    const x = 78 + i * 16;
    const z = -104;
    bd.obstacle(x - 7, z, 1.4, 1.4, 'wall', { h: 16, big: true });
    bd.obstacle(x + 7, z, 1.4, 1.4, 'wall', { h: 16, big: true });
    bd.obstacle(x, z, 15.5, 1.4, 'wall', { h: 2.2 });
    bd.landmark('crane', x, z, 9, '龙门吊');
  }
  // 连排冷库
  for (let i = 0; i < 6; i++) {
    placeHall(bd, rng, 20 + (i - 2.5) * 17, -40 + rand(rng, -6, 6), 14, 10, { pad: 2.2, roadPad: 0.3 });
  }
  // 中央广场商厦
  placeHall(bd, rng, 0, 0, 30, 24, { pad: 5, roadPad: 2, doorWidth: 7 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    addCrates(bd, rng, Math.cos(a) * 34, Math.sin(a) * 34, 2, 2);
  }
  // 棚户区窄巷
  for (let i = 0; i < 22; i++) {
    const a = rng() * TAU;
    const rr = rand(rng, 4, 36);
    placeBuilding(bd, rng, -58 + Math.cos(a) * rr, 92 + Math.sin(a) * rr, rand(rng, 5, 7), rand(rng, 4, 6), { pad: 1.2, roadPad: 0.1, floors: 1 });
  }
  // 造船厂钢架
  for (let i = 0; i < 6; i++) {
    const x = -112 + (i - 2.5) * 10;
    bd.obstacle(x, -20, 1.1, 1.1, 'wall', { h: 14, big: true });
    bd.obstacle(x, -8, 1.1, 1.1, 'wall', { h: 14, big: true });
    bd.obstacle(x, -14, 1.2, 12.5, 'wall', { h: 1.6 });
  }
  // 灯塔岬礁石
  for (let i = 0; i < 12; i++) {
    const a = rng() * TAU, rr = rand(rng, 8, 26);
    addRock(bd, rng, 132 + Math.cos(a) * rr, 44 + Math.sin(a) * rr, rand(rng, 1.6, 3.4), rand(rng, 1.4, 3.6));
  }
  for (const l of lm) bd.landmark(l.kind, l.x, l.z, l.r, l.name);
}

/** 带缺口的环形岩带（用于斜坡通道）。 */
function rockRingSkip(bd, rng, cx, cz, radius, count, thick, gapWidth) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    let da = a - 0.35;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) < gapWidth) continue;
    const rr = radius + rand(rng, -thick * 0.4, thick * 0.4);
    addRock(bd, rng, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, rand(rng, 1.5, 2.8), rand(rng, 1.6, 3.4));
  }
}

// __DOOR_CLEAR__

/** 由 Builder 产物组装 World 对象。 */
function inWaterShape(w, x, z, pad = 0) {
  if (w.r) return (x - w.x) * (x - w.x) + (z - w.z) * (z - w.z) <= (w.r + pad) * (w.r + pad);
  return Math.abs(x - w.x) <= w.w * 0.5 + pad && Math.abs(z - w.z) <= w.d * 0.5 + pad;
}
function assembleWorld(def, bd) {
  const radius = def.radius;
  const insideLand = (x, z, pad = 0) => {
    if (Math.hypot(x, z) > radius - pad) return false;
    for (let i = 0; i < bd.waters.length; i++) {
      const w = bd.waters[i];
      if (w.solid && inWaterShape(w, x, z)) return false;
    }
    return true;
  };
  const collision = makeCollision(bd.obstacles, insideLand);
  const bounds = { minX: -radius - 4, maxX: radius + 4, minZ: -radius - 4, maxZ: radius + 4 };
  const world = {
    id: def.id,
    def,
    radius,
    regions: bd.regions,
    buildings: bd.buildings,
    obstacles: bd.obstacles,
    props: bd.props,
    trees: bd.trees,
    roads: bd.roads,
    waters: bd.waters,
    lootSpots: bd.lootSpots,
    carSpots: bd.carSpots,
    spawnAnchors: bd.spawnAnchors,
    landmarks: bd.landmarks,
    bounds,
    blocked: collision.blocked,
    moveBody: collision.moveBody,
    wallDistance: collision.wallDistance,
    clearLine: collision.clearLine,
    isWater(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      if (def.water === 'sea' && Math.hypot(x, z) > radius - 7) return true;
      if (def.water === 'ice' && !inWaterShape({ x: 48, z: 118, r: 40 }, x, z)) {
        if (Math.hypot(x, z) > radius - 12) return true;
      }
      for (let i = 0; i < bd.waters.length; i++) {
        if (inWaterShape(bd.waters[i], x, z)) return true;
      }
      return false;
    },
    randomPoint(rng, rad = radius - 12, margin = 3) {
      for (let i = 0; i < 200; i++) {
        const a = rng() * TAU;
        const rr = Math.sqrt(rng()) * Math.max(4, rad - margin);
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        if (!collision.blocked(x, z, 1.1)) return { x, z };
      }
      return { x: 0, z: 0 };
    },
    regionAt(x, z) {
      let best = null; let bestD = Infinity;
      for (let i = 0; i < bd.regions.length; i++) {
        const rg = bd.regions[i];
        const d = Math.hypot(x - rg.x, z - rg.z);
        if (d < rg.r && d < bestD) { best = rg; bestD = d; }
      }
      return best;
    },
  };
  world.nav = buildNav(world);
  return world;
}

/** 生成指定地图（不缓存）。 */
export function makeWorldUncached(mapId) {
  const def = MAPS[mapId] || MAPS.qinglan;
  const bd = new Builder(def);
  const rng = bd.rng;
  applyWaters(bd, def);
  for (let i = 0; i < (def.roads || []).length; i++) {
    const rd = def.roads[i];
    addRoad(bd, rd.x, rd.z, rd.w, rd.d, rd.rot || 0, rd.kind === 'rail' ? 'dirt' : (rd.kind === 'highway' ? 'asphalt' : 'dirt'));
  }
  for (let i = 0; i < bd.regions.length; i++) buildRegion(bd, rng, bd.regions[i]);
  applyThemeFeatures(bd, rng, def);
  fillWilderness(bd, rng, def);
  fillCars(bd, rng);
  fillAnchors(bd, rng);
  bd.commitTrees();
  // 兜底：先补足建筑与树（门洞清障后可能不足），再统一清理门口走廊
  const targetB = (MAP_TARGETS[def.id] && MAP_TARGETS[def.id].buildings) || MIN_BUILDINGS;
  const targetT = (MAP_TARGETS[def.id] && MAP_TARGETS[def.id].trees) || MIN_TREES;
  if (bd.buildings.length < targetB) {
    for (let i = 0; i < 8000 && bd.buildings.length < targetB; i++) {
      const a = rng() * TAU;
      const rr = rand(rng, 34, bd.radius - 18);
      placeBuilding(bd, rng, Math.cos(a) * rr, Math.sin(a) * rr, rand(rng, 6, 9), rand(rng, 5, 8), { pad: 2.4 });
    }
  }
  if (bd.trees.length < targetT) {
    for (let i = 0; i < 12000 && bd.trees.length < targetT; i++) {
      const a = rng() * TAU;
      const rr = Math.sqrt(rng()) * (bd.radius - 8);
      bd.tree(Math.cos(a) * rr, Math.sin(a) * rr, randInt(rng, 0, 2));
    }
  }
  // 门洞净空：移除门口走廊/门内的树、岩石、箱子，保证 ≥1.6m 净宽
  clearDoorwayObstacles(bd);
  // 若某次清障后仍有建筑入口被别处残留堵住，再做一轮更宽的清理
  if (bd.trees.length < MIN_TREES) {
    for (let i = 0; i < 4000 && bd.trees.length < MIN_TREES; i++) {
      const a = rng() * TAU;
      const rr = Math.sqrt(rng()) * (bd.radius - 8);
      bd.tree(Math.cos(a) * rr, Math.sin(a) * rr, randInt(rng, 0, 2));
    }
  }
  return assembleWorld(def, bd);
}

/** 门洞净空：清掉门口走廊与门内的树/岩石/箱子等，保证每栋建筑都能走进去。 */
function clearDoorwayObstacles(bd) {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < bd.doors.length; i++) {
      const d = bd.doors[i];
      const s = d.side;
      const nx = s === 1 ? 1 : s === 3 ? -1 : 0;
      const nz = s === 0 ? -1 : s === 2 ? 1 : 0;
      const tx = 1 - Math.abs(nx);
      const tz = 1 - Math.abs(nz);
      const halfT = d.gap * 0.5 + 0.75;
      for (let k = bd.obstacles.length - 1; k >= 0; k--) {
        const o = bd.obstacles[k];
        const out = (o.x - d.x) * nx + (o.z - d.z) * nz;
        if (o.kind === 'wall' && Math.abs(out) < 0.6) continue;
        const along = (o.x - d.x) * tx + (o.z - d.z) * tz;
        const oExt = Math.max(o.w, o.d) * 0.5;
        if (Math.abs(along) > halfT + oExt) continue;
        if (out < -2.2 - oExt || out > 5.2 + oExt) continue;
        bd.obstacles.splice(k, 1);
      }
    }
    // 清理门口 3.0m 内的树
    const keep = [];
    for (let i = 0; i < bd.trees.length; i++) {
      const t = bd.trees[i];
      let gone = false;
      for (let j = 0; j < bd.doors.length; j++) {
        const d = bd.doors[j];
        if (dist2(t.x, t.z, d.x, d.z) < 3.0 * 3.0) { gone = true; break; }
      }
      if (!gone) keep.push(t);
    }
    bd.trees = keep;
  }
}

/** 地图缓存：同图重复调用返回同一实例。 */
export const worldCache = new Map();

export function makeWorld(mapId = 'qinglan') {
  const id = MAPS[mapId] ? mapId : 'qinglan';
  const cached = worldCache.get(id);
  if (cached) return cached;
  const world = makeWorldUncached(id);
  worldCache.set(id, world);
  return world;
}

export default makeWorld;
