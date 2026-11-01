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

/** 射线与轴对齐矩形（遗留导出，保留供外部工具使用）。 */
export function rayRect(px, pz, ux, uz, range, o) {
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

/** 紧凑索引网格：把障碍边界烤成 Float64Array，避免逐次对象属性访问。 */
class IndexGrid {
  constructor(cell) {
    this.cell = cell;
    this.buckets = new Map();
    this.stamp = new Uint32Array(64);
    this.mark = 1;
  }
  build(bounds, count) {
    const c = this.cell;
    for (let i = 0; i < count; i++) {
      const x0 = Math.floor(bounds[i * 4] / c);
      const z0 = Math.floor(bounds[i * 4 + 1] / c);
      const x1 = Math.floor(bounds[i * 4 + 2] / c);
      const z1 = Math.floor(bounds[i * 4 + 3] / c);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = (cx + GRID_ORIGIN) * 4096 + (cz + GRID_ORIGIN);
          const bucket = this.buckets.get(k);
          if (bucket) bucket.push(i);
          else this.buckets.set(k, [i]);
        }
      }
    }
    if (this.stamp.length < count) this.stamp = new Uint32Array(count + 64);
  }
  /** 收集矩形范围内的候选索引（去重）。 */
  gather(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    const c = this.cell;
    const m = this.mark++;
    if (m >= 0xffffffff) { this.stamp.fill(0); this.mark = 1; }
    const stamp = this.stamp;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.buckets.get((cx + GRID_ORIGIN) * 4096 + (cz + GRID_ORIGIN));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const idx = bucket[i];
          if (stamp[idx] === m) continue;
          stamp[idx] = m;
          out.push(idx);
        }
      }
    }
    return out.length;
  }
}

/** 基于障碍列表构造碰撞/射线闭包（每张地图一份，紧凑索引 + 空间哈希加速）。
 *  terrain 可选：提供时 moveBody 会按坡度减慢上坡位移（签名保持不变）。 */
export function makeCollision(obstacles, insideLand, terrain = null) {
  const n = obstacles.length;
  const bounds = new Float64Array(n * 4);
  const blocksBullets = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = obstacles[i];
    bounds[i * 4] = o.x - o.w * 0.5;
    bounds[i * 4 + 1] = o.z - o.d * 0.5;
    bounds[i * 4 + 2] = o.x + o.w * 0.5;
    bounds[i * 4 + 3] = o.z + o.d * 0.5;
    blocksBullets[i] = o.blocksBullets === false ? 0 : 1;
  }
  const grid = new IndexGrid(COLLIDE_CELL);
  grid.build(bounds, n);
  const cand = [];
  const grid24 = new IndexGrid(24);
  grid24.build(bounds, n);

  function blocked(x, z, r = PLAYER_RADIUS) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return true;
    if (!insideLand(x, z)) return true;
    const radius = Number.isFinite(r) && r > 0 ? r : PLAYER_RADIUS;
    const cnt = grid.gather(x - radius, z - radius, x + radius, z + radius, cand);
    for (let i = 0; i < cnt; i++) {
      const k = cand[i] * 4;
      const dx = x - (x < bounds[k] ? bounds[k] : x > bounds[k + 2] ? bounds[k + 2] : x);
      const dz = z - (z < bounds[k + 1] ? bounds[k + 1] : z > bounds[k + 3] ? bounds[k + 3] : z);
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  function moveBody(body, dx, dz, r = PLAYER_RADIUS) {
    if (!body || !Number.isFinite(body.x) || !Number.isFinite(body.z)) return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    // 地形：上坡减速（speed *= 1 - slope*0.5），下坡略加速，陡坡基本走不动。
    // 注意：moveBody 的签名是冻结契约，地形修正只能在这里内部缩放位移。
    if (terrain) {
      const slope = terrain.slopeAt(body.x, body.z);
      if (slope > 0.02) {
        const uphill = terrain.heightAt(body.x + dx, body.z + dz) > terrain.heightAt(body.x, body.z);
        const factor = clamp(1 - slope * (uphill ? 0.5 : 0.28), 0.28, 1.14);
        dx *= factor; dz *= factor;
      }
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.3));
    const sx = dx / steps;
    const sz = dz / steps;
    let moved = false;
    for (let i = 0; i < steps; i++) {
      if (!blocked(body.x + sx, body.z, r)) { body.x += sx; moved = true; }
      if (!blocked(body.x, body.z + sz, r)) { body.z += sz; moved = true; }
    }
    return moved;
  }

  /** 带高度推进：供需要贴地的高度更新使用（不影响 moveBody 契约）。 */
  function stepElevation(body, maxStep = 1.2) {
    if (!terrain || !body) return 0;
    const target = terrain.heightAt(body.x, body.z);
    const d = target - (body.y || 0);
    body.y = (body.y || 0) + (Math.abs(d) > maxStep ? Math.sign(d) * maxStep : d);
    return body.y;
  }

  function wallDistance(x, z, dx, dz, range = 120) {
    const len = Math.hypot(dx, dz);
    const maxRange = Number.isFinite(range) && range > 0 ? range : 120;
    if (!(len > 1e-9)) return maxRange;
    const ux = dx / len;
    const uz = dz / len;
    const ex = x + ux * maxRange;
    const ez = z + uz * maxRange;
    const cnt = grid24.gather(
      Math.min(x, ex) - 0.7, Math.min(z, ez) - 0.7,
      Math.max(x, ex) + 0.7, Math.max(z, ez) + 0.7,
      cand,
    );
    let best = maxRange;
    for (let i = 0; i < cnt; i++) {
      const idx = cand[i];
      if (blocksBullets[idx] === 0) continue;
      const k = idx * 4;
      let tmin = 0;
      let tmax = best;
      let ok = true;
      // X 轴
      if (ux > -1e-9 && ux < 1e-9) {
        if (x < bounds[k] || x > bounds[k + 2]) ok = false;
      } else {
        const t1 = (bounds[k] - x) / ux;
        const t2 = (bounds[k + 2] - x) / ux;
        const lo = t1 < t2 ? t1 : t2;
        const hi = t1 < t2 ? t2 : t1;
        if (lo > tmin) tmin = lo;
        if (hi < tmax) tmax = hi;
        if (tmin > tmax) ok = false;
      }
      if (ok) {
        if (uz > -1e-9 && uz < 1e-9) {
          if (z < bounds[k + 1] || z > bounds[k + 3]) ok = false;
        } else {
          const t1 = (bounds[k + 1] - z) / uz;
          const t2 = (bounds[k + 3] - z) / uz;
          const lo = t1 < t2 ? t1 : t2;
          const hi = t1 < t2 ? t2 : t1;
          if (lo > tmin) tmin = lo;
          if (hi < tmax) tmax = hi;
          if (tmin > tmax) ok = false;
        }
      }
      if (ok && tmin >= 0 && tmin < best) best = tmin;
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

  return { blocked, moveBody, wallDistance, clearLine, stepElevation };
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
      // 区域差异化（房型/物资档位/密度），客户端小地图与统计也会读
      zone: r.zone || 'wild',
      lootTier: clamp(Math.round(r.lootTier ?? r.tier ?? 1), 1, 3),
      density: Number.isFinite(r.density) ? r.density : 1,
      note: r.note || '',
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

  /** 该点周围 pad 米内是否有水域（深水不可建，冰湖可建但一般留空）。 */
  nearWater(x, z, pad = 4) {
    for (let i = 0; i < this.waters.length; i++) {
      const w = this.waters[i];
      if (w.r) {
        const d = Math.hypot(x - w.x, z - w.z);
        if (d <= w.r + pad) return true;
      } else if (Math.abs(x - w.x) <= w.w * 0.5 + pad && Math.abs(z - w.z) <= w.d * 0.5 + pad) {
        return true;
      }
    }
    return false;
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
    // 水面/冰面保持开阔：树不长在水里（冰湖上出现黑树会毁掉「开阔冰面」的读感）
    if (this.nearWater(x, z, 2.5)) return null;
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

  landmark(kind, x, z, r = 8, label = '', extra = null) {
    const l = { kind, x, z, r, label, radius: r, name: label || kind, hero: false };
    if (extra) Object.assign(l, extra);
    this.landmarks.push(l);
    return l;
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
  // 楼层数：urban 多层楼显著高出（视觉差异化），wild 一律单层
  const floors = clamp(opts.floors || (rng() < 0.45 ? 2 : 1), 1, 3);
  const baseWallH = opts.h ?? rand(rng, 3.0, 3.6);
  const wallH = opts.h != null ? opts.h : (floors > 1 ? baseWallH * (1 + (floors - 1) * 0.82) : baseWallH);
  const theme = bd.def.theme;
  const b = {
    id: 'b' + bd._id.b++,
    x, z, w, d, h: wallH,
    rot,
    walls: true,
    roofColor: pick(rng, theme.roof),
    floorColor: pick(rng, theme.wall),
    regionId: region ? region.id : null,
    regionName: region ? region.name : '',
    radius: region ? region.r : 30,
    entrances: [],
    kind: opts.kind || 'house',
    floors,
    tier: clamp(region ? (region.lootTier ?? region.tier) : 1, 1, 3),
  };
  bd.buildings.push(b);
  bd._registerBuilding(b);
  if (region) bd.regionHits[region.index] += 1;

  // 局部坐标 -> 世界坐标（门洞判断用局部坐标即可，因为 rot=0 时一致；带 rot 的建筑按网格近似）
  const wall = (cx, cz, ww, dd) => bd.obstacle(cx, cz, ww, dd, 'wall', {
    h: wallH, regionId: b.regionId, rot: 0, building: b.id,
    blocksVision: wallH >= 2.4,
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
    // 水域（含冰湖等可走水面）保持开阔：不放岩石，避免踩点被石头堵住
    if (bd.nearWater(x, z, 4)) continue;
    if (!bd.free(x, z, 2, 2, 1.6)) continue;
    if (roadOverlap(bd, x, z, 2, 2, 1)) continue;
    addRock(bd, rng, x, z, rand(rng, 0.7, 1.8), rand(rng, 0.6, 1.6));
  }
}

/** 出生/交火通道净空：中心 26m 内不放岩石类硬掩体（保证从 (0,0) 四向都有射界）。 */
const CENTER_CLEAR_R = 26;
function clearCenterHardCover(bd) {
  const r2 = CENTER_CLEAR_R * CENTER_CLEAR_R;
  let removed = 0;
  for (let i = bd.obstacles.length - 1; i >= 0; i--) {
    const o = bd.obstacles[i];
    if (o.kind !== 'rock') continue;
    if (dist2(o.x, o.z, 0, 0) > r2) continue;
    bd.obstacles.splice(i, 1);
    removed++;
  }
  return removed;
}

/** 在矩形区域内尝试放置一栋建筑；失败返回 null。 */
function placeBuilding(bd, rng, x, z, w, d, opts = {}) {
  if (!bd.insideLand(x, z, Math.max(w, d) * 0.5 + 6)) return null;
  // 冰湖/港湾保持开阔：建筑不得压在水域上（含 6m 缓冲）
  if (!opts.allowWater && bd.nearWater(x, z, Math.max(w, d) * 0.5 + 6)) return null;
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
// zone（urban/wild/industrial/water/landmark）决定建筑形态，density 决定数量
// ---------------------------------------------------------------------------

/** 区域密度倍率（1 = 基准），限制在 0.35–1.6 避免极端值撑爆几何预算。 */
function regionDensity(region) {
  const d = Number.isFinite(region.density) ? region.density : 1;
  return clamp(d, 0.35, 1.6);
}

/** 区域物资档位（1–3）：lootTier 优先，回退到 tier。 */
function regionLootTier(region) {
  const t = Number.isFinite(region.lootTier) ? region.lootTier : (region.tier ?? 1);
  return clamp(Math.round(t), 1, 3);
}

/** 该区域「核心」半径：地标类区域内部留空给地标本体。 */
function regionCore(region) {
  return region.zone === 'landmark' ? Math.min(region.r * 0.52, 26) : 0;
}

/** 点是否落在地标核心里（建筑不要压上来；中心广场保持开阔）。 */
function inRegionCore(bd, x, z) {
  const cores = (bd && bd.heroCores) || [];
  for (let i = 0; i < cores.length; i++) {
    const c = cores[i];
    if (dist2(x, z, c.x, c.z) < c.r * c.r) return true;
  }
  return false;
}

/** 按 zone 生成建筑参数：urban 多层 / industrial 大跨度 / wild 小屋 / water 栈桥仓库。 */
function styleFor(region, rng, base = {}) {
  const zone = region.zone || 'wild';
  if (zone === 'urban') {
    return {
      ...base,
      pad: base.pad ?? 2.0,
      floors: rng() < 0.62 ? 2 + (rng() < 0.22 ? 1 : 0) : 2,
      kind: 'tenement',
      doorWidth: base.doorWidth ?? rand(rng, 3.8, 4.8),
    };
  }
  if (zone === 'industrial') {
    return {
      ...base, pad: base.pad ?? 3.4, floors: 1, kind: 'hall',
      doorWidth: base.doorWidth ?? rand(rng, 4.6, 6.4),
    };
  }
  if (zone === 'water') {
    return {
      ...base, pad: base.pad ?? 2.8, floors: 1, kind: 'warehouse',
      doorWidth: base.doorWidth ?? rand(rng, 4.4, 6.0),
    };
  }
  if (zone === 'landmark') {
    return { ...base, pad: base.pad ?? 2.6, floors: 1, kind: base.kind ?? 'outpost' };
  }
  return { ...base, pad: base.pad ?? 2.4, floors: 1, kind: 'cottage' };
}

/** 城镇：密集民宅 + 中央广场 + 商店/仓库。 */
function buildTown(bd, rng, region, count = 11) {
  const dens = regionDensity(region);
  const n = Math.max(4, Math.round(count * dens));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rand(rng, -0.12, 0.12);
    const rr = rand(rng, region.r * 0.22, region.r * 0.78);
    const x = region.x + Math.cos(a) * rr;
    const z = region.z + Math.sin(a) * rr;
    if (inRegionCore(bd, x, z)) continue;
    const w = rand(rng, 8, 13) * (region.zone === 'urban' ? 1.1 : 1);
    const d = rand(rng, 7, 11) * (region.zone === 'urban' ? 1.1 : 1);
    placeBuilding(bd, rng, x, z, w, d, {
      ...styleFor(region, rng), roadPad: 0.3, doorSide: randInt(rng, 0, 3),
    });
  }
  // 广场/院墙/路灯/长椅
  const crates = Math.max(2, Math.round(6 * dens));
  for (let i = 0; i < crates; i++) {
    const a = (i / crates) * TAU;
    addCrates(bd, rng, region.x + Math.cos(a) * region.r * 0.2, region.z + Math.sin(a) * region.r * 0.2, 2, 2.4);
  }
  for (let i = 0; i < 4; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.5, region.r * 0.5), region.z + rand(rng, -region.r * 0.5, region.r * 0.5), regionLootTier(region));
  }
}

/** 村庄/棚户区：小房子密集、巷子窄。 */
function buildVillage(bd, rng, region) {
  const dens = regionDensity(region);
  const n = Math.max(6, Math.round(14 * dens));
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const rr = rand(rng, region.r * 0.15, region.r * 0.85);
    const x = region.x + Math.cos(a) * rr;
    const z = region.z + Math.sin(a) * rr;
    if (inRegionCore(bd, x, z)) continue;
    placeBuilding(bd, rng, x, z, rand(rng, 6, 9), rand(rng, 5, 8), {
      ...styleFor(region, rng), roadPad: 0.2, doorSide: randInt(rng, 0, 3),
    });
  }
  const lootN = Math.max(2, Math.round(5 * dens));
  for (let i = 0; i < lootN; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.6, region.r * 0.6), region.z + rand(rng, -region.r * 0.6, region.r * 0.6), regionLootTier(region));
  }
}

/** 港口/工业区：大厂房 + 集装箱迷宫 + 龙门吊 + 路障。 */
function buildPort(bd, rng, region) {
  const dens = regionDensity(region);
  const halls = Math.max(2, Math.round(randInt(rng, 4, 6) * dens));
  for (let i = 0; i < halls; i++) {
    const a = (i / halls) * TAU + rand(rng, -0.2, 0.2);
    const rr = rand(rng, region.r * 0.25, region.r * 0.7);
    const x = region.x + Math.cos(a) * rr;
    const z = region.z + Math.sin(a) * rr;
    if (inRegionCore(bd, x, z)) continue;
    placeHall(bd, rng, x, z, rand(rng, 14, 22), rand(rng, 10, 15), { ...styleFor(region, rng, { kind: 'hall' }), roadPad: 0.5 });
  }
  // 集装箱阵列（迷宫）：chisha/baiye 的 industrial 区更密
  const cols = region.zone === 'industrial' ? 5 : 4;
  const rows = region.zone === 'industrial' ? 4 : 3;
  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      if (rng() < 0.22) continue;
      const x = region.x + (cx - cols / 2) * 8.5 + rand(rng, -0.8, 0.8);
      const z = region.z + (cz - rows / 2) * 8.5 + rand(rng, -0.8, 0.8);
      if (inRegionCore(bd, x, z)) continue;
      addContainer(bd, rng, x, z, rng() < 0.5 ? 0 : HALF_PI);
      if (rng() < 0.3) bd.loot(x, z, regionLootTier(region));
    }
  }
  const barriers = Math.max(4, Math.round(10 * dens));
  for (let i = 0; i < barriers; i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.5, region.r);
    addBarrier(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, rand(rng, 0, TAU));
  }
  for (let i = 0; i < Math.max(3, Math.round(6 * dens)); i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.8, region.r * 0.8), region.z + rand(rng, -region.r * 0.8, region.r * 0.8), regionLootTier(region));
  }
}

/** 农场：谷仓 + 长条田垄 + 少量小屋。 */
function buildFarm(bd, rng, region) {
  const dens = regionDensity(region);
  for (let i = 0; i < Math.max(2, Math.round(4 * dens)); i++) {
    const a = (i / 4) * TAU;
    const x = region.x + Math.cos(a) * region.r * 0.45;
    const z = region.z + Math.sin(a) * region.r * 0.45;
    if (inRegionCore(bd, x, z)) continue;
    placeHall(bd, rng, x, z, rand(rng, 13, 18), rand(rng, 9, 13), { ...styleFor(region, rng, { kind: 'barn' }), roadPad: 0.5 });
  }
  for (let i = 0; i < 8; i++) {
    const x = region.x + rand(rng, -region.r * 0.7, region.r * 0.7);
    const z = region.z + rand(rng, -region.r * 0.7, region.r * 0.7);
    bd.prop(x, z, rand(rng, 4, 9), 1.6, 'hay', 0xc9b06a, 0.9);
  }
  for (let i = 0; i < 4; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.6, region.r * 0.6), region.z + rand(rng, -region.r * 0.6, region.r * 0.6), regionLootTier(region));
  }
  scatterTrees(bd, rng, region.x, region.z, region.r * 1.1, Math.round(40 * dens));
}

/** 矿坑：同心岩石环 + 矿车/碎石 + 少量工棚。 */
function buildMine(bd, rng, region) {
  const dens = regionDensity(region);
  rockRing(bd, rng, region.x, region.z, region.r * 0.42, 22, 3);
  rockRing(bd, rng, region.x, region.z, region.r * 0.68, 30, 3.4);
  for (let i = 0; i < Math.max(2, Math.round(5 * dens)); i++) {
    const a = rng() * TAU;
    const x = region.x + Math.cos(a) * region.r * 0.3;
    const z = region.z + Math.sin(a) * region.r * 0.3;
    if (inRegionCore(bd, x, z)) continue;
    placeBuilding(bd, rng, x, z, rand(rng, 8, 12), rand(rng, 7, 10), styleFor(region, rng, { kind: 'shack' }));
  }
  for (let i = 0; i < 12; i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.3, region.r * 0.9);
    addWreck(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, rand(rng, 0, TAU));
  }
  for (let i = 0; i < 10; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.8, region.r * 0.8), region.z + rand(rng, -region.r * 0.8, region.r * 0.8), regionLootTier(region));
  }
}

/** 检查站/哨卡：小屋 + 路障阵列 + 掩体墙（中心广场保持开阔）。 */
function buildCheckpoint(bd, rng, region) {
  const dens = regionDensity(region);
  // 开阔广场半径：中央检查站必须留出可穿行的空地（出生/交火都靠它）
  const plaza = Math.max(14, region.r * 0.42);
  for (let i = 0; i < Math.max(2, Math.round(5 * dens)); i++) {
    const a = (i / 5) * TAU;
    const x = region.x + Math.cos(a) * region.r * 0.4;
    const z = region.z + Math.sin(a) * region.r * 0.4;
    if (inRegionCore(bd, x, z)) continue;
    placeBuilding(bd, rng, x, z, rand(rng, 7, 11), rand(rng, 6, 9), styleFor(region, rng, { kind: 'outpost' }));
  }
  for (let i = 0; i < 16; i++) {
    const a = rng() * TAU, rr = rand(rng, plaza, region.r);
    addBarrier(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, rand(rng, 0, TAU), rand(rng, 3, 5));
  }
  for (let i = 0; i < 6; i++) {
    const a = rng() * TAU, rr = rand(rng, plaza * 1.05, region.r * 0.75);
    addCrates(bd, rng, region.x + Math.cos(a) * rr, region.z + Math.sin(a) * rr, 2, 2.2);
  }
  for (let i = 0; i < 8; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.7, region.r * 0.7), region.z + rand(rng, -region.r * 0.7, region.r * 0.7), regionLootTier(region));
  }
}

/** 野地：散落小屋 + 树丛 + 岩石。 */
function buildWild(bd, rng, region) {
  const dens = regionDensity(region);
  for (let i = 0; i < Math.max(1, Math.round(5 * dens)); i++) {
    const a = rng() * TAU, rr = rand(rng, region.r * 0.2, region.r * 0.8);
    const x = region.x + Math.cos(a) * rr;
    const z = region.z + Math.sin(a) * rr;
    if (inRegionCore(bd, x, z)) continue;
    placeBuilding(bd, rng, x, z, rand(rng, 6, 9), rand(rng, 5, 8), styleFor(region, rng, { kind: 'cottage' }));
  }
  scatterTrees(bd, rng, region.x, region.z, region.r * 1.15, Math.round(70 * (0.65 + dens * 0.5)));
  scatterRocks(bd, rng, region.x, region.z, region.r * 0.9, Math.round(16 * dens));
  for (let i = 0; i < 5; i++) {
    bd.loot(region.x + rand(rng, -region.r * 0.7, region.r * 0.7), region.z + rand(rng, -region.r * 0.7, region.r * 0.7), Math.max(1, regionLootTier(region) - 1));
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
    if (bd.nearWater(x, z, 4)) continue;   // 水面/冰面保持开阔
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

/** 出生锚点：六边形候选网格 + 贪心最大间隔，保证 ≥40 且彼此间距 ≥ ANCHOR_SPACING。 */
function fillAnchors(bd, rng) {
  const minD2 = ANCHOR_SPACING * ANCHOR_SPACING;
  const cands = [];
  const step = 16;
  const lim = bd.radius - 18;
  for (let gz = -lim; gz <= lim; gz += step) {
    const off = (Math.round(gz / step) % 2) * step * 0.5;
    for (let gx = -lim; gx <= lim; gx += step) {
      const x = gx + off + rand(rng, -2, 2);
      const z = gz + rand(rng, -2, 2);
      if (x * x + z * z > lim * lim) continue;
      if (bd.inWater(x, z)) continue;
      if (bd.nearSolid(x, z, 2.0)) continue;
      cands.push({ x, z });
    }
  }
  const pts = [];
  // 打乱候选顺序（确定性）
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cands[i]; cands[i] = cands[j]; cands[j] = tmp;
  }
  for (let i = 0; i < cands.length && pts.length < 48; i++) {
    const c = cands[i];
    let ok = true;
    for (let j = 0; j < pts.length; j++) {
      if (dist2(pts[j].x, pts[j].z, c.x, c.z) < minD2) { ok = false; break; }
    }
    if (ok) pts.push(c);
  }
  // 兜底：放宽间距挑够下限
  if (pts.length < MIN_ANCHORS) {
    for (let i = 0; i < cands.length && pts.length < MIN_ANCHORS; i++) {
      const c = cands[i];
      let ok = true;
      for (let j = 0; j < pts.length; j++) {
        if (dist2(pts[j].x, pts[j].z, c.x, c.z) < minD2) { ok = false; break; }
      }
      if (ok) pts.push(c);
    }
  }
  // 锚点顺序稳定化：按角度排序，使 anchor[0] 落在可预期的方位。
  // （原顺序来自打乱后的候选表，anchor[0] 会随生成流变化飘到任意角落，
  //   依赖它的工具/测试因此不稳定。）
  pts.sort((a, b) => {
    const aa = Math.atan2(a.z, a.x), ab = Math.atan2(b.z, b.x);
    if (Math.abs(aa - ab) > 1e-9) return aa - ab;
    return Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z);
  });
  for (let i = 0; i < pts.length; i++) bd.anchor(pts[i].x, pts[i].z);
}

/** 导航网格：4m 单元，供 Bot A* 与快速通行检查。
 *  地形启用时，坡度 > 35° 的单元标记为不可走（陡崖/矿坑壁）。 */
function buildNav(world) {
  const cell = NAV_CELL;
  const radius = world.radius;
  const span = Math.ceil((radius * 2) / cell) + 2;
  const minX = -radius - cell;
  const minZ = -radius - cell;
  const cols = span;
  const rows = span;
  const walkable = new Uint8Array(cols * rows);
  const steep = new Uint8Array(cols * rows);
  const blocked = world.blocked;
  const terrain = world.terrain || null;
  for (let r = 0; r < rows; r++) {
    const z = minZ + (r + 0.5) * cell;
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * cell;
      walkable[r * cols + c] = blocked(x, z, 0.9) ? 0 : 1;
      // 坡度 > 35° 单独标记（walkable 保持与 blocked 严格一致：
      // 碰撞契约测试逐格比对二者，坡度是不可走性的「叠加层」而非替代品）
      if (terrain && terrain.slopeAt(x, z) > MAX_SLOPE) steep[r * cols + c] = 1;
    }
  }
  const nav = {
    cell, cols, rows, minX, minZ, walkable, steep,
    colOf(x) { return Math.floor((x - minX) / cell); },
    rowOf(z) { return Math.floor((z - minZ) / cell); },
    idxOf(x, z) { return this.rowOf(z) * cols + this.colOf(x); },
    /** 坡度 > 35° 的单元：不能被 Bot 规划为路径（陡崖/矿坑壁）。 */
    isSteep(x, z) {
      const c = nav.colOf(x); const r = nav.rowOf(z);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
      return steep[r * cols + c] === 1;
    },
    /** 可通行 = 碰撞空闲 且 坡度不超限。 */
    isWalkable(x, z) {
      const c = nav.colOf(x); const r = nav.rowOf(z);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
      const i = r * cols + c;
      return walkable[i] === 1 && steep[i] !== 1;
    },
    blockedAt(x, z) { return !nav.isWalkable(x, z); },
    nearestWalkable(x, z, maxR = 24) {
      const c0 = nav.colOf(x);
      const r0 = nav.rowOf(z);
      if (c0 >= 0 && r0 >= 0 && c0 < cols && r0 < rows && nav.isWalkable(x, z)) {
        return { x, z };
      }
      // 以单元中心为起点做环形搜索，命中后返回单元中心（保证落在该单元内）
      for (let rr = cell; rr <= maxR; rr += cell) {
        const steps = Math.max(8, Math.round((TAU * rr) / cell));
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * TAU;
          const nx = x + Math.cos(a) * rr;
          const nz = z + Math.sin(a) * rr;
          const c = nav.colOf(nx);
          const r = nav.rowOf(nz);
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const idx = r * cols + c;
          if (walkable[idx] !== 1 || steep[idx] === 1) continue;
          return { x: minX + (c + 0.5) * cell, z: minZ + (r + 0.5) * cell };
        }
      }
      // 兜底 1：只要求碰撞空闲（陡坡也比卡死好）
      for (let rr = cell; rr <= maxR * 2; rr += cell) {
        const steps = Math.max(8, Math.round((TAU * rr) / cell));
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * TAU;
          const nx = x + Math.cos(a) * rr;
          const nz = z + Math.sin(a) * rr;
          const c = nav.colOf(nx);
          const r = nav.rowOf(nz);
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          if (walkable[r * cols + c] !== 1) continue;
          return { x: minX + (c + 0.5) * cell, z: minZ + (r + 0.5) * cell };
        }
      }
      // 全图兜底：找任意碰撞空闲单元
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (walkable[r * cols + c] === 1) {
            return { x: minX + (c + 0.5) * cell, z: minZ + (r + 0.5) * cell };
          }
        }
      }
      return { x: 0, z: 0 };
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
    /** 数据统计：供诊断查看陡坡单元占比。 */
    stats() {
      let wall = 0, cliff = 0;
      for (let i = 0; i < walkable.length; i++) {
        if (walkable[i] === 0) wall++;
        else if (steep[i] === 1) cliff++;
      }
      return { cells: walkable.length, blocked: wall, steepCliff: cliff, walkable: walkable.length - wall - cliff };
    },
  };
  return nav;
}

// ---------------------------------------------------------------------------
// 高度场（地形层次）：低频噪声 + 平地掩码 + 地标造型，供渲染与坡度导航使用
// ---------------------------------------------------------------------------
export const TERRAIN_RES = 96;         // 采样格数（跨整个直径）
export const MAX_SLOPE = 0.70;         // tan(35°)：超过即视为不可行走
const TERRAIN_PAD = 4;                 // 生成边界外扩

/** 整数坐标哈希 → [0,1)，用于确定性值噪声。 */
function hash2i(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 平滑值噪声（0..1）。 */
function noise2(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2i(xi, zi, seed), b = hash2i(xi + 1, zi, seed);
  const c = hash2i(xi, zi + 1, seed), d = hash2i(xi + 1, zi + 1, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

const smooth01 = (t) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};
const DEG = Math.PI / 180;

/** 点到旋转矩形的距离，返回 {d, inside}；inside 表示距离内部边界（负值）。 */
function rotRectDist(px, pz, r) {
  const cos = Math.cos(-(r.rot || 0)), sin = Math.sin(-(r.rot || 0));
  const dx = px - r.x, dz = pz - r.z;
  const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
  const ox = Math.abs(lx) - r.w * 0.5, oz = Math.abs(lz) - r.d * 0.5;
  const outside = Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
  return { d: outside, inside: outside === 0 ? Math.max(ox, oz) : -outside };
}

/** 地标造型对高度的贡献（additive）。 */
function landmarkShape(lm, x, z) {
  const dx = x - lm.x, dz = z - lm.z;
  const d = Math.hypot(dx, dz);
  const r = lm.radius || lm.r || 12;
  if (d > r * 1.5) return 0;
  const t = clamp(d / r, 0, 1.5);
  if (lm.kind === 'open_pit') {
    // 下沉式矿坑：外圈阶梯台地 + 一条角度窗口内的平直坡道（可走上下）
    const depth = lm.depth || 20;
    if (t >= 1) return 0;
    const ang = Math.atan2(dz, dx);
    const da = Math.atan2(Math.sin(ang - (lm.rampAngle ?? 2.2)), Math.cos(ang - (lm.rampAngle ?? 2.2)));
    if (Math.abs(da) < 0.30) return -depth * (1 - t) * 0.92;
    const steps = 5;
    const idx = t * steps;
    const tier = Math.floor(idx) / steps;
    const frac = idx - Math.floor(idx);
    const profile = tier + smooth01(frac) / steps;
    return -depth * (1 - profile) * 0.92;
  }
  if (lm.kind === 'radar_station') {
    const pid = lm.hill || 9;
    return pid * Math.pow(1 - smooth01(clamp(t / 0.72, 0, 1)), 1.6);
  }
  if (lm.kind === 'signal_tower') {
    return 2.2 * (1 - smooth01(clamp(t / 0.7, 0, 1)));
  }
  if (lm.kind === 'waterfall') {
    // 断崖：沿局部 -x 方向抬升成台地，台地边缘 7m 内做陡坎
    const c = Math.cos(lm.rot || 0), s = Math.sin(lm.rot || 0);
    const lx = dx * c - dz * s;
    const edge = r * 0.30;
    const h = (lm.cliff || 11) * smooth01((edge - lx) / 7 + 0.5) * (1 - smooth01((Math.abs(dz) - r * 0.9) / (r * 0.4)));
    return h;
  }
  if (lm.kind === 'bridge') {
    // 桥头引桥：两端缓坡抬升
    return 1.8 * (1 - smooth01(clamp(t / 0.8, 0, 1)));
  }
  if (lm.kind === 'shipwreck' || lm.kind === 'container_maze' || lm.kind === 'warehouse') {
    return 0.6 * (1 - smooth01(t));
  }
  return 0;
}

/**
 * 构建高度场。flat 掩码来自建筑/道路/水域（含距离衰减），地标造型叠加在上面。
 * 返回 { heightAt, slopeAt, min, max, step, res, flatAt }。
 */
export function makeTerrain(def, world) {
  const cfg = def.terrain || {};
  const amplitude = cfg.amplitude ?? 4.5;
  const wavelength = cfg.wavelength ?? 140;
  const flats = cfg.flats ?? 13;
  const seed = cfg.seed ?? 0x1234;
  const radius = world.radius;
  const res = TERRAIN_RES;
  const minX = -radius - TERRAIN_PAD;
  const span = (radius + TERRAIN_PAD) * 2;
  const step = span / res;
  const gw = res + 1;
  const heights = new Float32Array(gw * gw);
  const flats2 = new Float32Array(gw * gw);
  const buildings = world.buildings || [];
  const roads = world.roads || [];
  const waters = world.waters || [];
  const landmarks = world.landmarks || [];
  const shapes = landmarks.filter((l) => ['open_pit', 'radar_station', 'signal_tower', 'waterfall', 'bridge', 'shipwreck', 'container_maze', 'warehouse'].includes(l.kind));

  for (let gz = 0; gz < gw; gz++) {
    const z = minX + gz * step;
    for (let gx = 0; gx < gw; gx++) {
      const x = minX + gx * step;
      // 1) 平地权重：建筑/道路/水域越近越平
      let flat = 0;
      for (let i = 0; i < buildings.length && flat < 1; i++) {
        const b = buildings[i];
        if (Math.abs(x - b.x) > b.w * 0.5 + flats + 4 || Math.abs(z - b.z) > b.d * 0.5 + flats + 4) continue;
        const ox = Math.abs(x - b.x) - b.w * 0.5, oz = Math.abs(z - b.z) - b.d * 0.5;
        const dd = Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
        flat = Math.max(flat, 1 - smooth01(dd / flats));
      }
      for (let i = 0; i < roads.length && flat < 1; i++) {
        const rd = roads[i];
        if (Math.abs(x - rd.x) > rd.w * 0.5 + rd.d * 0.5 + flats + 4) continue;
        const { d } = rotRectDist(x, z, rd);
        flat = Math.max(flat, 1 - smooth01(d / (flats * 0.85)));
      }
      for (let i = 0; i < waters.length && flat < 1; i++) {
        const w = waters[i];
        const dd = w.r ? Math.max(0, Math.hypot(x - w.x, z - w.z) - w.r)
          : Math.hypot(Math.max(Math.abs(x - w.x) - w.w * 0.5, 0), Math.max(Math.abs(z - w.z) - w.d * 0.5, 0));
        flat = Math.max(flat, 1 - smooth01(dd / (flats * 1.2)));
      }
      flats2[gz * gw + gx] = flat;
      // 2) 低频噪声（两个八度）
      const nx = x / wavelength, nz = z / wavelength;
      let n = (noise2(nx, nz, seed) - 0.5) * 2;
      n += (noise2(nx * 2.7 + 11.3, nz * 2.7 + 7.1, seed ^ 0x5f5f) - 0.5) * 0.7;
      let h = n * amplitude * (1 - flat);
      // 3) 地标造型
      for (let i = 0; i < shapes.length; i++) h += landmarkShape(shapes[i], x, z);
      // 4) 外圈海岸压平到 0（避免海岸线出现高差断崖）
      const rr = Math.hypot(x, z);
      if (rr > radius - 22) h *= 1 - smooth01((rr - (radius - 22)) / 18);
      heights[gz * gw + gx] = h;
    }
  }

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < heights.length; i++) { if (heights[i] < lo) lo = heights[i]; if (heights[i] > hi) hi = heights[i]; }

  const sampleAt = (arr, x, z) => {
    const fx = (x - minX) / step, fz = (z - minX) / step;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    if (x0 < 0 || z0 < 0 || x0 >= res || z0 >= res) return arr === heights ? 0 : 1;
    const tx = fx - x0, tz = fz - z0;
    const i00 = z0 * gw + x0, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
    const top = arr[i00] + (arr[i10] - arr[i00]) * tx;
    const bot = arr[i01] + (arr[i11] - arr[i01]) * tx;
    return top + (bot - top) * tz;
  };

  const heightAt = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    return sampleAt(heights, x, z);
  };
  /** 坡度（rise/run）；> MAX_SLOPE 即 35° 以上。 */
  const slopeAt = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const d = step * 0.5;
    const hx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d);
    const hz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
    return Math.hypot(hx, hz);
  };
  return {
    heightAt, slopeAt, min: lo, max: hi, step, res, minX, gw,
    flatAt: (x, z) => sampleAt(flats2, x, z),
    heights,
  };
}

/** 水域先行注册（建筑/树木/物资点需避开深水）。 */
function applyWaters(bd, def) {
  if (def.id === 'qinglan') {
    bd.waters.push({ x: 118, z: 112, r: 18, kind: 'bay', solid: true });
    bd.waters.push({ x: -126, z: 116, r: 13, kind: 'bay', solid: true });
  } else if (def.id === 'chisha') {
    bd.waters.push({ x: 122, z: 8, r: 12, kind: 'oasis', solid: true });
  } else if (def.id === 'baiye') {
    // 冰湖：可走但减速（isWater 语义 = 特殊地形）
    bd.waters.push({ x: 48, z: 118, r: 40, kind: 'ice', solid: false, slippery: true });
    // 港湾：贴东南海岸，港区陆地在西北侧
    bd.waters.push({ x: 136, z: -126, r: 46, kind: 'harbor', solid: true });
    bd.waters.push({ x: 70, z: -150, r: 30, kind: 'harbor', solid: true });
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
      bd.landmark('windmill', x, z, 3, '风车', { hero: false });
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
}

// ---------------------------------------------------------------------------
// 地标（每图 4 个）：注册 → 占位 → 生成形态 → 战利品分布
// 约定：landmark { id, name, kind, x, z, radius, r, tier, rot }，写进 world.landmarks
// ---------------------------------------------------------------------------
const LANDMARK_CLEAR = 6;   // 地标本体周围留空（米）

/**
 * 注册地标本体（在常规区域生成之前调用）。
 * 把核心区登记为 bigs（禁止常规建筑压上来），并补齐元数据。
 */
function registerLandmarks(bd, def) {
  const specs = def.landmarks || [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const l = {
      id: `${def.id}_${s.kind}_${i}`,
      name: s.name || s.kind,
      kind: s.kind,
      x: s.x, z: s.z,
      radius: s.r || s.radius || 10,
      r: s.r || s.radius || 10,
      tier: clamp(s.tier ?? 2, 1, 3),
      rot: s.rot || 0,
      mapId: def.id,
      hero: true,
    };
    for (const key of ['height', 'depth', 'hill', 'cliff', 'rampAngle']) {
      if (s[key] != null) l[key] = s[key];
    }
    bd.landmarks.push(l);
    // 占位：常规建筑/障碍不得侵入地标核心
    bd.bigs.push({ x: l.x, z: l.z, w: l.r * 2, d: l.r * 2, landmark: l.id });
    if (!bd.heroCores) bd.heroCores = [];
    bd.heroCores.push({ x: l.x, z: l.z, r: l.r * 0.72, id: l.id });
  }
}

/** 地标中心附近的物资点：中心 tier3 概率更高，向外围递减。 */
function landmarkLoot(bd, rng, l, count) {
  const R = l.radius;
  const centerTier = clamp(l.tier + 1, 1, 3);
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * R * 0.92;
    const x = l.x + Math.cos(a) * rr;
    const z = l.z + Math.sin(a) * rr;
    if (!bd.insideLand(x, z, 1.2)) continue;
    if (bd.nearSolid(x, z, 0.7)) continue;
    // 中心 40% 半径内必给高档位，外圈按地标档位
    const t = rr < R * 0.4 ? centerTier : (rng() < 0.34 ? clamp(l.tier + 1, 1, 3) : l.tier);
    bd.loot(x, z, t);
  }
  // 中心永久放一个最高档点（地标「心脏」，可攀爬/可争夺）
  if (bd.insideLand(l.x, l.z, 0.5)) bd.loot(l.x, l.z, 3);
}

/** 在地标周围清出场地（移除会压进本体的树）。 */
function clearLandmarkArea(bd, l, pad = 3) {
  const lim = l.radius + pad;
  for (let i = bd.trees.length - 1; i >= 0; i--) {
    const t = bd.trees[i];
    if (dist2(t.x, t.z, l.x, l.z) < lim * lim) bd.trees.splice(i, 1);
  }
}

/** 木栈道：从 (x,z) 沿 rot 方向铺 len 米（板条 + 桩），并可选地伸入水中。 */
function buildWoodPier(bd, rng, x, z, rot, len, width = 3.2) {
  const ux = Math.sin(rot), uz = Math.cos(rot);
  const px = -uz, pz = ux;
  const planks = Math.max(4, Math.round(len / 1.4));
  for (let i = 0; i < planks; i++) {
    const t = (i + 0.5) / planks * len;
    const cx = x + ux * t, cz = z + uz * t;
    if (!bd.insideLand(cx, cz, 0.5)) {
      // 水上段：只做视觉 prop（不挡路，避免把玩家困在海上）
      bd.prop(cx, cz, width, 1.5, 'plank', 0x9a7a52, 0.24);
      continue;
    }
    bd.prop(cx, cz, width, 1.5, 'plank', 0x9a7a52, 0.24);
    if (i % 3 === 0) {
      for (const side of [-1, 1]) {
        bd.prop(cx + px * width * 0.5 * side, cz + pz * width * 0.5 * side, 0.28, 0.28, 'post', 0x6d5334, 1.2);
      }
    }
  }
  return { ux, uz, px, pz };
}

/** 生成地标本体形态（几何 + 碰撞 + 物资）。 */
function buildLandmark(bd, rng, l) {
  const tier = l.tier;
  const addWall = (x, z, w, d, h, extra = {}) => bd.obstacle(x, z, w, d, 'wall', {
    h, regionId: bd.regionOf(l.x, l.z).id, ...extra,
  });
  const addBeam = (x, z, w, d, h) => {
    const o = bd.obstacle(x, z, w, d, 'beam', { h, rot: 0 });
    return o;
  };
  switch (l.kind) {
    case 'signal_tower': {
      // 40m 桁架塔：四根斜柱 + 3 层平台 + 顶部机房（可攀爬=平台是走位掩体）
      const H = l.height || 40;
      const base = 7.5;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const x = l.x + Math.cos(a) * base;
        const z = l.z + Math.sin(a) * base;
        addWall(x, z, 1.5, 1.5, H, { big: true });
      }
      for (let f = 0; f < 3; f++) {
        const y = 10 + f * 10;
        const r = 5.4 - f * 0.9;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          const x = l.x + Math.cos(a) * r, z = l.z + Math.sin(a) * r;
          addWall(x, z, 2.4, 0.5, 1.0, { rot: a, floor: y });
        }
      }
      addWall(l.x, l.z, 5.2, 5.2, 2.6, { big: true });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        addCrates(bd, rng, l.x + Math.cos(a) * (base + 2.4), l.z + Math.sin(a) * (base + 2.4), 1, 1.2);
      }
      landmarkLoot(bd, rng, l, 7);
      break;
    }
    case 'dock': {
      // 废弃渔村码头：3 条木栈道伸向海面 + 岸边鱼市 + 船壳
      const len = l.radius * 1.15;
      for (let k = -1; k <= 1; k++) {
        const rot = l.rot + k * 0.36;
        const ox = Math.cos(rot + HALF_PI) * k * 7;
        const oz = Math.sin(rot + HALF_PI) * k * 7;
        buildWoodPier(bd, rng, l.x + ox, l.z + oz, rot, len * (k === 0 ? 1 : 0.78), 3.4);
      }
      // 鱼市棚：3 间小屋
      for (let i = 0; i < 3; i++) {
        const a = l.rot + Math.PI + (i - 1) * 0.5;
        const x = l.x + Math.sin(a) * 10, z = l.z + Math.cos(a) * 10;
        placeBuilding(bd, rng, x, z, rand(rng, 7, 9), rand(rng, 6, 8), {
          kind: 'fishmarket', floors: 1, pad: 2.2, allowWater: true,
        });
      }
      // 倒扣的船壳
      for (let i = 0; i < 4; i++) {
        const a = rng() * TAU, rr = rand(rng, 6, 15);
        bd.prop(l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr, rand(rng, 4, 7), rand(rng, 1.8, 2.6), 'hull', 0x6d5a4a, 1.6);
      }
      for (let i = 0; i < 8; i++) {
        const a = rng() * TAU, rr = rand(rng, 3, l.radius);
        bd.obstacle(l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr, rand(rng, 1.0, 1.6), rand(rng, 1.0, 1.6), 'crate', { h: 1.1 });
      }
      landmarkLoot(bd, rng, l, 8);
      break;
    }
    case 'radar_station': {
      // 雷达站：半球罩 + 天线阵 + 机房 + 上山道路
      const y0 = l.hill || 9;
      addWall(l.x, l.z, 9.5, 9.5, 7.2, { big: true });
      bd.prop(l.x, l.z, 10, 10, 'radome', 0xe4ebe4, 7.6);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + 0.4;
        const rr = l.radius * 0.62;
        addWall(l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr, 0.6, 0.6, 12 + (i % 3) * 3, { big: true });
      }
      for (let i = 0; i < 2; i++) {
        placeBuilding(bd, rng, l.x + (i ? 13 : -13), l.z + 8, 9, 7, { kind: 'outpost', floors: 1, pad: 2.0 });
      }
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        addBarrier(bd, rng, l.x + Math.cos(a) * (l.radius * 0.55), l.z + Math.sin(a) * (l.radius * 0.55), a, 3.4);
      }
      landmarkLoot(bd, rng, l, 9);
      break;
    }
    case 'waterfall': {
      // 断崖瀑布：崖壁 + 上层水池 + 下层水潭 + 观景栈道
      const cliff = l.cliff || 11;
      const c = Math.cos(l.rot), sn = Math.sin(l.rot);
      const edge = l.radius * 0.30;
      for (let i = 0; i < 14; i++) {
        const u = (i / 13 - 0.5) * l.radius * 1.7;
        const x = l.x + c * edge + sn * u;
        const z = l.z - sn * edge + c * u;
        addWall(x, z, 2.6, 3.2, cliff, { big: true, rot: l.rot });
      }
      // 上层水池（视觉）
      bd.prop(l.x + c * (edge + 7), l.z - sn * (edge + 7), 18, 12, 'pool', 0x6fa6ad, 0.5);
      // 下层水潭（可走，视觉为浅水）
      bd.waters.push({ x: l.x - c * 15, z: l.z + sn * 15, r: 8.5, kind: 'pond', solid: false });
      bd.prop(l.x - c * 15, l.z + sn * 15, 17, 17, 'pool', 0x7fb8bd, 0.35);
      for (let i = 0; i < 9; i++) {
        const a = rng() * TAU, rr = rand(rng, 6, l.radius * 0.85);
        addRock(bd, rng, l.x - c * 12 + Math.cos(a) * rr, l.z + sn * 12 + Math.sin(a) * rr, rand(rng, 1.4, 2.8), rand(rng, 1.2, 2.8));
      }
      for (let i = 0; i < 4; i++) {
        bd.prop(l.x - c * (18 + i * 2.4), l.z + sn * (18 + i * 2.4), 2.6, 1.2, 'plank', 0x9a7a52, 0.22);
      }
      landmarkLoot(bd, rng, l, 7);
      break;
    }
    case 'open_pit': {
      // 露天矿坑：地形已下沉，这里放坑底机房、坑壁台阶与矿车轨道
      const depth = l.depth || 20;
      const bottom = -depth * 0.86;
      for (let ring = 1; ring <= 3; ring++) {
        const rr = l.radius * (ring / 4.2);
        const n = 10 + ring * 6;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + ring * 0.3;
          const px = l.x + Math.cos(a) * rr, pz = l.z + Math.sin(a) * rr;
          // 地图中心留空：中央交火区不能被坑壁/台阶堵死
          if (dist2(px, pz, 0, 0) < 20 * 20) continue;
          addWall(px, pz, 2.4, 1.6, 1.1, { rot: a, big: false });
        }
      }
      // 坑底破碎机 + 工棚（坑中心避开地图原点）
      const cx0 = l.x, cz0 = l.z;
      const blockedCore = dist2(cx0, cz0, 0, 0) < 22 * 22;
      if (!blockedCore) {
        addWall(cx0, cz0, 8.5, 8.5, 6.5, { big: true });
        bd.prop(cx0, cz0, 9, 9, 'crusher', 0x8a6a4a, 7.2);
      }
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        addWreck(bd, rng, l.x + Math.cos(a) * 9, l.z + Math.sin(a) * 9, a);
      }
      // 螺旋矿车道（视觉轨枕）
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * TAU * 1.05 + 2.2;
        const rr = l.radius * (0.28 + (i / 26) * 0.55);
        bd.prop(l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr, 5.2, 0.6, 'rail', 0x5b5b5b, 0.16);
      }
      // 坑底高级物资
      bd.loot(l.x, l.z, 3);
      landmarkLoot(bd, rng, l, 10);
      void bottom;
      break;
    }
    case 'conveyor': {
      // 传送带塔：斜向长条结构 + 支柱 + 顶端料斗
      const len = l.radius * 1.9;
      const ux = Math.sin(l.rot), uz = Math.cos(l.rot);
      const px = -uz, pz = ux;
      const H = l.height || 18;
      for (let i = 0; i < 7; i++) {
        const t = (i / 6 - 0.5) * len;
        const cx = l.x + ux * t, cz = l.z + uz * t;
        const h = 3 + (1 - Math.abs(i / 6 - 0.5) * 2) * H * 0.55;
        for (const side of [-1, 1]) {
          addWall(cx + px * 2.4 * side, cz + pz * 2.4 * side, 0.55, 0.55, h, { big: true });
        }
        if (i % 2 === 0) {
          addBeam(cx, cz, len / 7 + 0.6, 2.2, 1.2, l.rot);
        }
      }
      // 顶端料斗 + 机头
      const hx = l.x + ux * (len * 0.42), hz = l.z + uz * (len * 0.42);
      addWall(hx, hz, 6.5, 6.5, H, { big: true });
      bd.prop(hx, hz, 7, 7, 'crusher', 0x7a6a52, H * 0.9);
      for (let i = 0; i < 5; i++) addCrates(bd, rng, l.x + rand(rng, -9, 9), l.z + rand(rng, -9, 9), 2, 2.4);
      landmarkLoot(bd, rng, l, 8);
      break;
    }
    case 'shipwreck': {
      // 沉船残骸：半埋在沙里的大船（船体 + 上层建筑 + 断桅）
      const c = Math.cos(l.rot), sn = Math.sin(l.rot);
      const L = 34, W = 11;
      for (let i = 0; i < 7; i++) {
        const t = (i / 6 - 0.5) * L;
        const taper = 1 - Math.abs(i / 6 - 0.5) * 0.55;
        addWall(l.x + sn * t, l.z + c * t, W * taper, 5, 4.2 + taper * 2.6, { rot: l.rot, big: true });
      }
      // 上层建筑
      for (let i = 0; i < 3; i++) {
        addWall(l.x + sn * (i * 5 - 5), l.z + c * (i * 5 - 5), 8, 7, 9.5, { rot: l.rot, big: true });
      }
      // 断桅
      addWall(l.x + sn * 4, l.z + c * 4, 1.0, 1.0, 17, { big: true });
      for (let i = 0; i < 9; i++) {
        const a = rng() * TAU, rr = rand(rng, 6, l.radius);
        addWreck(bd, rng, l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr, rand(rng, 0, TAU));
      }
      bd.prop(l.x, l.z, 12, 6, 'hull', 0x5d6663, 5.2);
      landmarkLoot(bd, rng, l, 10);
      break;
    }
    case 'derrick': {
      // 钻井平台：四层钢架 + 平台甲板 + 储罐 + 管线
      const H = l.height || 22;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const x = l.x + Math.cos(a) * 6.4, z = l.z + Math.sin(a) * 6.4;
        addWall(x, z, 1.1, 1.1, H, { big: true });
      }
      for (let f = 0; f < 4; f++) {
        const y = 5.5 + f * 5;
        const r = 6.0 - f * 0.55;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + Math.PI / 4;
          addWall(l.x + Math.cos(a) * r, l.z + Math.sin(a) * r, 4.4, 0.55, 0.8, { rot: a, floor: y });
        }
      }
      addWall(l.x, l.z, 5.5, 5.5, H * 0.55, { big: true });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.7;
        bd.prop(l.x + Math.cos(a) * 12, l.z + Math.sin(a) * 12, 4.5, 4.5, 'tank', 0xb7a58a, 5.5);
        bd.obstacle(l.x + Math.cos(a) * 12, l.z + Math.sin(a) * 12, 4.4, 4.4, 'container', { h: 5.5 });
      }
      for (let i = 0; i < 6; i++) {
        const a = rng() * TAU, rr = rand(rng, 8, l.radius);
        bd.prop(l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr, rand(rng, 6, 12), 0.7, 'pipe', 0x9a8a6a, 0.7);
      }
      landmarkLoot(bd, rng, l, 9);
      break;
    }
    case 'container_maze': {
      // 集装箱迷宫：成排堆叠 1–3 层，留出可通行走廊
      const cell = 8.4;
      const cols = 5, rows = 5;
      for (let cx = 0; cx < cols; cx++) {
        for (let cz = 0; cz < rows; cz++) {
          // 走廊：每隔一行留空
          if (cx % 2 === 1) continue;
          if (rng() < 0.18) continue;
          const x = l.x + (cx - (cols - 1) / 2) * cell + rand(rng, -0.4, 0.4);
          const z = l.z + (cz - (rows - 1) / 2) * cell + rand(rng, -0.4, 0.4);
          const stack = rng() < 0.3 ? 3 : rng() < 0.55 ? 2 : 1;
          const rot = rng() < 0.5 ? 0 : HALF_PI;
          for (let s = 0; s < stack; s++) {
            const o = addContainer(bd, rng, x, z, rot, { h: 2.7, stack: s });
            if (o && s > 0) o.stacked = s;
          }
          if (rng() < 0.4) bd.loot(x, z, rng() < 0.45 ? 3 : 2);
        }
      }
      // 迷宫外围护栏
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * TAU;
        addBarrier(bd, rng, l.x + Math.cos(a) * (l.radius * 0.95), l.z + Math.sin(a) * (l.radius * 0.95), a, 3.6);
      }
      landmarkLoot(bd, rng, l, 10);
      break;
    }
    case 'lighthouse': {
      // 灯塔：视觉塔身由 client/models.js 的 createLandmark('lighthouse') 提供。
      // 这里只留「细核心」碰撞柱，避免再生成一根 6.4m 粗的实心墙把塔糊成黑柱。
      const H = l.height || 34;
      addWall(l.x, l.z, 2.2, 2.2, H, { big: true });
      // 底座附属房
      placeBuilding(bd, rng, l.x + 10, l.z - 6, 8, 6, { kind: 'outpost', floors: 1, pad: 2.0 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        addRock(bd, rng, l.x + Math.cos(a) * (l.radius * 0.85), l.z + Math.sin(a) * (l.radius * 0.85), rand(rng, 1.4, 2.6), rand(rng, 1.2, 2.6));
      }
      for (let i = 0; i < 4; i++) addCrates(bd, rng, l.x + rand(rng, -8, 8), l.z + rand(rng, -8, 8), 2, 2.2);
      landmarkLoot(bd, rng, l, 8);
      break;
    }
    case 'bridge': {
      // 跨海大桥断段：两截桥面 + 斜拉索塔 + 断口
      const len = l.radius * 1.9;
      const ux = Math.sin(l.rot), uz = Math.cos(l.rot);
      const px = -uz, pz = ux;
      const W = 9;
      const segs = 11;
      for (let i = 0; i < segs; i++) {
        const t = (i / (segs - 1) - 0.5) * len;
        // 中间 2 跨断开（断口）
        const gap = Math.abs(i - (segs - 1) / 2) < 1.2;
        if (gap) {
          // 断口两侧的断梁
          if (Math.abs(i - (segs - 1) / 2) > 0.6) {
            const cx = l.x + ux * t, cz = l.z + uz * t;
            for (let k = 0; k < 3; k++) {
              const off = (k - 1) * 2.8;
              addWall(cx + px * off, cz + pz * off, 2.2, W / 3, 1.0, { rot: l.rot, big: true });
            }
          }
          continue;
        }
        const cx = l.x + ux * t, cz = l.z + uz * t;
        // 桥面（双侧护栏，中间可走）
        for (const side of [-1, 1]) {
          addWall(cx + px * (W * 0.5) * side, cz + pz * (W * 0.5) * side, 4.6, 0.8, 1.15, { rot: l.rot });
        }
        bd.prop(cx, cz, 8.6, len / segs + 0.4, 'deck', 0x8b8f8a, 0.5);
        if (i % 3 === 1) {
          for (const side of [-1, 1]) {
            addWall(cx + px * (W * 0.62) * side, cz + pz * (W * 0.62) * side, 1.0, 1.0, 16, { big: true });
          }
        }
      }
      // 斜拉索塔
      for (let i = 0; i < 2; i++) {
        const t = (i ? 1 : -1) * len * 0.28;
        const cx = l.x + ux * t, cz = l.z + uz * t;
        for (const side of [-1, 1]) {
          addWall(cx + px * (W * 0.7) * side, cz + pz * (W * 0.7) * side, 1.6, 1.6, 26, { big: true });
        }
      }
      landmarkLoot(bd, rng, l, 8);
      break;
    }
    case 'warehouse': {
      // 大跨度仓库群：3 间厂房 + 内部隔墙（多房间）
      for (let i = 0; i < 3; i++) {
        const x = l.x + (i - 1) * 17;
        const z = l.z + (i % 2 ? 10 : -9);
        addHall(bd, rng, x, z, 15, 12, { kind: 'warehouse', floors: 1, pad: 2.4, doorWidth: 6.2 });
        // 内部隔墙（留 3m 通道）
        addWall(x - 3.6, z, 0.5, 7.5, 3.4);
        addWall(x + 4.2, z, 0.5, 5.5, 3.4);
      }
      // 装卸平台 + 集装箱
      for (let i = 0; i < 6; i++) {
        const x = l.x + rand(rng, -22, 22);
        const z = l.z + rand(rng, -18, 18);
        if (bd.nearSolid(x, z, 2.6)) continue;
        addContainer(bd, rng, x, z, rng() < 0.5 ? 0 : HALF_PI);
      }
      for (let i = 0; i < 8; i++) {
        addBarrier(bd, rng, l.x + rand(rng, -l.radius, l.radius), l.z + rand(rng, -l.radius, l.radius), rand(rng, 0, TAU), 3.4);
      }
      landmarkLoot(bd, rng, l, 12);
      break;
    }
    default:
      landmarkLoot(bd, rng, l, 5);
      break;
  }
}

/** 带缺口的环形岩带（用于斜坡通道）。 */function rockRingSkip(bd, rng, cx, cz, radius, count, thick, gapWidth) {
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

/** 保证每栋建筑内部中心有物资点；超出上限时先丢弃 tier1 野外点。 */
function ensureBuildingLoot(bd) {
  const has = new Set();
  const inBuilding = (l, b) => Math.abs(l.x - b.x) < b.w * 0.5 - 0.2 && Math.abs(l.z - b.z) < b.d * 0.5 - 0.2;
  const need = [];
  for (let i = 0; i < bd.buildings.length; i++) {
    const b = bd.buildings[i];
    let found = false;
    for (let j = 0; j < bd.lootSpots.length; j++) {
      if (inBuilding(bd.lootSpots[j], b)) { found = true; break; }
    }
    if (!found) need.push(b);
  }
  if (!need.length) return;
  // 先删除野外 tier1 稀疏点腾出配额
  let drop = bd.lootSpots.length + need.length - MAX_LOOT_SPOTS;
  for (let i = bd.lootSpots.length - 1; i >= 0 && drop > 0; i--) {
    const l = bd.lootSpots[i];
    let inside = false;
    for (let j = 0; j < bd.buildings.length; j++) {
      if (inBuilding(l, bd.buildings[j])) { inside = true; break; }
    }
    if (!inside && l.tier === 1) { bd.lootSpots.splice(i, 1); drop--; }
  }
  for (const b of need) {
    if (bd.lootSpots.length >= MAX_LOOT_SPOTS) bd.lootSpots.pop();
    bd.lootSpots.push({ x: b.x, z: b.z, tier: clamp(b.tier, 1, 3) });
  }
  has.clear();
}

/** 三图地形差异统计（写入 world.stats 供诊断/测试/客户端小地图使用）。 */
function worldStats(def, bd) {
  const kinds = {};
  for (let i = 0; i < bd.obstacles.length; i++) {
    const k = bd.obstacles[i].kind;
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const tiers = [0, 0, 0, 0];
  for (let i = 0; i < bd.lootSpots.length; i++) tiers[bd.lootSpots[i].tier]++;
  let tileSum = 0;
  for (let i = 0; i < bd.buildings.length; i++) tileSum += bd.buildings[i].w * bd.buildings[i].d;
  // 地标签名：数量 + 每类计数（可区分「地标种类」而不是只看总数）
  const lmKinds = {};
  for (let i = 0; i < bd.landmarks.length; i++) {
    const k = bd.landmarks[i].kind;
    lmKinds[k] = (lmKinds[k] || 0) + 1;
  }
  const zones = {};
  for (let i = 0; i < bd.regions.length; i++) {
    const z = bd.regions[i].zone || 'wild';
    zones[z] = (zones[z] || 0) + 1;
  }
  return {
    mapId: def.id,
    buildings: bd.buildings.length,
    obstacles: bd.obstacles.length,
    trees: bd.trees.length,
    props: bd.props.length,
    roads: bd.roads.length,
    waters: bd.waters.length,
    loot: bd.lootSpots.length,
    cars: bd.carSpots.length,
    anchors: bd.spawnAnchors.length,
    regions: bd.regions.length,
    kinds,
    lootTiers: { tier1: tiers[1], tier2: tiers[2], tier3: tiers[3] },
    buildingArea: Math.round(tileSum),
    landmarks: bd.landmarks.length,
    landmarkKinds: lmKinds,
    zones,
    // 签名：建筑/障碍/水域/道路 + 地标数 + 集装箱/岩石（三图必须彼此可区分）
    signature: `${bd.buildings.length}/${bd.obstacles.length}/${bd.waters.length}/${bd.roads.length}/lm${bd.landmarks.length}/c${kinds.container || 0}/r${kinds.rock || 0}`,
  };
}

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
  const bounds = { minX: -radius - 4, maxX: radius + 4, minZ: -radius - 4, maxZ: radius + 4 };
  // 先出陆地占位（水域语义），碰撞闭包只依赖障碍+陆地，不依赖地形；地形后建一次
  const collision = makeCollision(bd.obstacles, insideLand);
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
    // 高度场（地形层次）：±5m 低频噪声，建筑/道路/水域压平，地标造型叠加
    heightAt(x, z) { return 0; },
    slopeAt() { return 0; },
    terrain: null,
  };
  // 地形只算一次（≈37×37m 格网），然后重建带坡度的碰撞/导航
  const terrain = makeTerrain(def, world);
  world.terrain = terrain;
  world.heightAt = terrain.heightAt;
  world.slopeAt = terrain.slopeAt;
  const collisionT = makeCollision(bd.obstacles, insideLand, terrain);
  world.blocked = collisionT.blocked;
  world.moveBody = collisionT.moveBody;
  world.wallDistance = collisionT.wallDistance;
  world.clearLine = collisionT.clearLine;
  world.stepElevation = collisionT.stepElevation;
  // 地标对象补齐元数据（id/radius/tier），供客户端与测试消费
  for (let i = 0; i < bd.landmarks.length; i++) {
    const l = bd.landmarks[i];
    if (l.id == null) l.id = `${def.id}_${l.kind}_${i}`;
    if (l.radius == null) l.radius = l.r || 10;
    if (l.tier == null) l.tier = 2;
    if (l.name == null) l.name = l.label || l.kind;
  }
  world.nav = buildNav(world);
  world.stats = worldStats(def, bd);
  return world;
}
/** 生成指定地图（不缓存）。timings 可选：若传入对象，会写入各阶段耗时（ms）。 */
export function makeWorldUncached(mapId, timings = null) {
  const now = () => (timings ? Date.now() : 0);
  let tPrev = now();
  const mark = (key) => {
    if (!timings) return;
    const t = Date.now();
    timings[key] = Math.round(t - tPrev);
    tPrev = t;
  };
  const def = MAPS[mapId] || MAPS.qinglan;
  const bd = new Builder(def);
  const rng = bd.rng;
  applyWaters(bd, def);
  registerLandmarks(bd, def);
  for (let i = 0; i < (def.roads || []).length; i++) {
    const rd = def.roads[i];
    addRoad(bd, rd.x, rd.z, rd.w, rd.d, rd.rot || 0, rd.kind === 'rail' ? 'dirt' : (rd.kind === 'highway' ? 'asphalt' : 'dirt'));
  }
  for (let i = 0; i < bd.regions.length; i++) buildRegion(bd, rng, bd.regions[i]);
  applyThemeFeatures(bd, rng, def);
  // 地标本体（在补白之前：先把核心区做实，野外补白自然会绕开）
  // 只构建 def 里声明的「主地标」（hero）；风车/吊机等装饰性 landmark 不生成固定形态
  for (let i = 0; i < bd.landmarks.length; i++) {
    const lm = bd.landmarks[i];
    if (lm.built || !lm.hero) continue;
    lm.built = true;
    buildLandmark(bd, rng, lm);
    // 清场：地标本体范围内不长树（否则锥形树会插进塔身/船体，读感变糊）
    clearLandmarkArea(bd, lm, 1.5);
  }
  fillWilderness(bd, rng, def);
  // 中心交火区净空（岩石硬掩体）：中心检查站必须留出四向射界
  clearCenterHardCover(bd);
  fillCars(bd, rng);
  fillAnchors(bd, rng);
  bd.commitTrees();
  mark('layout');
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
  mark('clear');
  // 保证每栋建筑内部中心都有物资点（数量上限 320，必要时挤掉野外低 tier 点）
  ensureBuildingLoot(bd);
  // 若某次清障后仍有建筑入口被别处残留堵住，再做一轮更宽的清理
  if (bd.trees.length < MIN_TREES) {
    for (let i = 0; i < 4000 && bd.trees.length < MIN_TREES; i++) {
      const a = rng() * TAU;
      const rr = Math.sqrt(rng()) * (bd.radius - 8);
      bd.tree(Math.cos(a) * rr, Math.sin(a) * rr, randInt(rng, 0, 2));
    }
  }
  const world = assembleWorld(def, bd);
  mark('assemble');
  if (timings) timings.total = Math.round(timings.layout + timings.clear + timings.assemble);
  return world;
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

// ---------------------------------------------------------------------------
// 向后兼容导出（0.2.0 接口）：默认地图 + 顶层碰撞函数
// ---------------------------------------------------------------------------
/** 默认地图（青岚岛）世界实例。 */
export const MAP = makeWorld('qinglan');
export const REGIONS = MAP.regions;
export const MAP_SEED = MAPS.qinglan.seed;
export const obstaclesNear = (x1, z1, x2, z2) => {
  const out = [];
  for (let i = 0; i < MAP.obstacles.length; i++) {
    const o = MAP.obstacles[i];
    if (o.x + o.w * 0.5 < x1 || o.x - o.w * 0.5 > x2) continue;
    if (o.z + o.d * 0.5 < z1 || o.z - o.d * 0.5 > z2) continue;
    out.push(o);
  }
  return out;
};
export const blocked = (x, z, r = PLAYER_RADIUS) => MAP.blocked(x, z, r);
export const moveBody = (body, dx, dz, r = PLAYER_RADIUS) => MAP.moveBody(body, dx, dz, r);
export const wallDistance = (x, z, dx, dz, range = 120) => MAP.wallDistance(x, z, dx, dz, range);
export const clearLine = (a, b) => MAP.clearLine(a, b);
export const isWater = (x, z) => MAP.isWater(x, z);
export const segmentRect = (ax, az, bx, bz, o) => {
  const dx = bx - ax;
  const dz = bz - az;
  let lo = 0;
  let hi = 1;
  const x0 = o.x - o.w * 0.5;
  const x1 = o.x + o.w * 0.5;
  if (Math.abs(dx) < 1e-8) { if (ax < x0 || ax > x1) return null; } else {
    const a = (x0 - ax) / dx;
    const b = (x1 - ax) / dx;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
    if (lo > hi) return null;
  }
  const z0 = o.z - o.d * 0.5;
  const z1 = o.z + o.d * 0.5;
  if (Math.abs(dz) < 1e-8) { if (az < z0 || az > z1) return null; } else {
    const a = (z0 - az) / dz;
    const b = (z1 - az) / dz;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
    if (lo > hi) return null;
  }
  return lo;
};

export default makeWorld;
