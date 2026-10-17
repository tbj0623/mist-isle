export const WORLD_RADIUS = 180;
export const MAP_SEED = 74129;
export const REGIONS = [
  { name: '青岚镇', x: -65, z: -65, color: 0 },
  { name: '松林营地', x: 60, z: -64, color: 2 },
  { name: '南湾港', x: 88, z: 74, color: 1 },
  { name: '风车农场', x: -80, z: 70, color: 3 },
  { name: '北方哨站', x: 0, z: -127, color: 1 },
  { name: '旧采石场', x: 0, z: 123, color: 3 },
  { name: '西岸仓库', x: -131, z: 0, color: 1 },
  { name: '东部居民区', x: 127, z: 0, color: 0 },
];

export function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeMap() {
  const rng = randomGenerator(MAP_SEED);
  const buildings = [];
  const obstacles = [];
  const locations = [...REGIONS, {name:'中央检查站', x:0,z:0,color:2,central:true}];
  for (const region of locations) {
    for (const [ox, oz] of region.central ? [[-25,-24],[25,-24],[-25,24],[25,24]] : [[-13, -15], [13, -15], [-13, 12], [13, 12], [0, 35]]) {
      const x = region.x + ox, z = region.z + oz;
      if (Math.hypot(x, z) > WORLD_RADIUS - 12) continue;
      const w = 9 + Math.floor(rng() * 3);
      const d = 8 + Math.floor(rng() * 3);
      buildings.push({ id: buildings.length, x, z, w, d, color: region.color });
      const wall = (cx, cz, width, depth) => obstacles.push({ x: cx, z: cz, w: width, d: depth, kind: 'wall' });
      wall(x, z - d / 2, w + .5, .5);
      wall(x - w / 2, z, .5, d);
      wall(x + w / 2, z, .5, d);
      const piece = (w - 3) / 2;
      wall(x - (w + 3) / 4, z + d / 2, piece, .5);
      wall(x + (w + 3) / 4, z + d / 2, piece, .5);
    }
  }
  const trees = [];
  for (let i = 0; i < 400; i++) {
    const x = rng() * (WORLD_RADIUS * 2 - 8) - WORLD_RADIUS + 4, z = rng() * (WORLD_RADIUS * 2 - 8) - WORLD_RADIUS + 4;
    if (Math.hypot(x, z) > WORLD_RADIUS - 3 || Math.abs(x) < 11 || Math.abs(z) < 11) continue;
    if (buildings.some(b => Math.abs(x - b.x) < b.w / 2 + 5 && Math.abs(z - b.z) < b.d / 2 + 5)) continue;
    trees.push({ x, z, scale: .8 + rng() * .8, color: Math.floor(rng() * 3) });
    obstacles.push({ x, z, w: .8, d: .8, kind: 'tree' });
  }
  const props = [];
  for (const b of buildings) {
    const x=b.x-b.w/2-2, z=b.z-2;
    if(Math.hypot(x,z)<WORLD_RADIUS-3) {
      props.push({x,z,w:1.5,d:2,h:1.1,kind:'crate'});
      obstacles.push({x,z,w:1.5,d:2,kind:'crate'});
    }
  }
  return { buildings, obstacles, trees, props, regions: REGIONS };
}

export const MAP = makeMap();
const CELL = 16;
const obstacleGrid = new Map();
for (const obstacle of MAP.obstacles) {
  for (let x = Math.floor((obstacle.x - obstacle.w / 2) / CELL); x <= Math.floor((obstacle.x + obstacle.w / 2) / CELL); x++) {
    for (let z = Math.floor((obstacle.z - obstacle.d / 2) / CELL); z <= Math.floor((obstacle.z + obstacle.d / 2) / CELL); z++) {
      const key = `${x},${z}`; if (!obstacleGrid.has(key)) obstacleGrid.set(key, []);
      obstacleGrid.get(key).push(obstacle);
    }
  }
}
export function obstaclesNear(x1, z1, x2, z2) {
  const result = new Set();
  for (let x = Math.floor(Math.min(x1, x2) / CELL); x <= Math.floor(Math.max(x1, x2) / CELL); x++) {
    for (let z = Math.floor(Math.min(z1, z2) / CELL); z <= Math.floor(Math.max(z1, z2) / CELL); z++) {
      for (const obstacle of obstacleGrid.get(`${x},${z}`) || []) result.add(obstacle);
    }
  }
  return result;
}

export function blocked(x, z, radius = .55) {
  if (Math.hypot(x, z) > WORLD_RADIUS - radius) return true;
  for (const o of obstaclesNear(x - radius, z - radius, x + radius, z + radius)) {
    const dx = x - Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const dz = z - Math.max(o.z - o.d / 2, Math.min(z, o.z + o.d / 2));
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

export function moveBody(body, dx, dz, radius = .55) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / .3));
  for (let i = 0; i < steps; i++) {
    if (!blocked(body.x + dx / steps, body.z, radius)) body.x += dx / steps;
    if (!blocked(body.x, body.z + dz / steps, radius)) body.z += dz / steps;
  }
}

export function segmentRect(ax, az, bx, bz, o) {
  let lo = 0, hi = 1;
  for (const [start, delta, min, max] of [
    [ax, bx - ax, o.x - o.w / 2, o.x + o.w / 2],
    [az, bz - az, o.z - o.d / 2, o.z + o.d / 2],
  ]) {
    if (Math.abs(delta) < 1e-8) { if (start < min || start > max) return null; }
    else {
      const a = (min - start) / delta, b = (max - start) / delta;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
      if (lo > hi) return null;
    }
  }
  return lo;
}

export function wallDistance(x, z, dx, dz, range) {
  let distance = range;
  for (const o of obstaclesNear(x, z, x + dx * range, z + dz * range)) {
    const t = segmentRect(x, z, x + dx * range, z + dz * range, o);
    if (t !== null) distance = Math.min(distance, t * range);
  }
  return distance;
}

export function clearLine(a, b) {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  return dist < .01 || wallDistance(a.x, a.z, (b.x - a.x) / dist, (b.z - a.z) / dist, dist) >= dist - .1;
}
