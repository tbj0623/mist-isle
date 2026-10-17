// 雾岛突围 / MIST ISLE 1.0 — 场景渲染（owner: renderfx）
// 契约 §10.1：constructor(canvas) / setQuality / showHome / setMap / beginMatch / setState / render /
//             aimAt / groundAt / predictInput / shake / hitmarker / dispose
import * as THREE from 'three';
import * as mapModule from '../shared/map.mjs';
import { MAX_LOOT, MAX_CARS, QUALITY } from '../shared/rules.mjs';
import {
  createCharacter, createVehicle, createLootModel, createTree, createProp,
  createAirdrop, createPingMarker, createTextSprite, disposeModel,
  glowMaterial, UNIT_BOX, UNIT_CYL, UNIT_SPHERE, UNIT_CONE, UNIT_CIRCLE, teamColorOf, weaponClassOf,
  createList, bake, finishList, DEFAULT_SKIN,
} from './models.js';
import { Fx } from './fx.js';
import { themeFor, lightingFor, CAMERA, WEATHER_FX } from './theme.js';

const MAX_VISIBLE_PLAYERS = 30;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _c = new THREE.Color(), _m = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const makeWorldImpl = (...args) => (typeof mapModule.makeWorld === 'function' ? mapModule.makeWorld(...args) : null);
const MAP_RADIUS = () => mapModule.WORLD_RADIUS || 180;
const legacyExport = (name) => Reflect.get(mapModule, name) ?? null;
const RARITY_RGB = {
  common: [0.79, 0.82, 0.8], uncommon: [0.49, 0.83, 0.65], rare: [0.44, 0.72, 0.94],
  epic: [0.77, 0.55, 0.94], legendary: [0.96, 0.71, 0.27],
};
function rarityRgbCompat(rarity) { return RARITY_RGB[rarity] || RARITY_RGB.common; }

let _vcm = null;
/** 静态世界专用：单材质顶点色（所有静态几何共享，1 个 program）。 */
function vertexColorMaterial() {
  if (!_vcm) _vcm = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return _vcm;
}
/** 只摘除节点、不释放几何（模板几何被 InstancedMesh 复用）。 */
function disposeModelSoft(root) { if (!root) return; root.parent?.remove(root); root.clear?.(); }

/** 墙体配色：按建筑区域/障碍 id 稳定取色。 */
function pickWallColor(palette, obstacle) {
  const walls = palette.wall || [0xe6d6b5, 0xaebcb2, 0xd1c6ac, 0xc8b59d];
  const h = obstacle.h || 2.4;
  if (h <= 1.3) return 0xc6bfa6;
  const n = Math.abs((obstacle.x || 0) * 3.1 + (obstacle.z || 0) * 7.7) | 0;
  return walls[n % walls.length];
}

export class GameScene {
  constructor(canvas) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('GameScene 需要浏览器环境（WebGL2 canvas）');
    }
    if (!window.WebGL2RenderingContext) throw new Error('需要 WebGL2 支持：请更新浏览器或 Android System WebView');
    this.canvas = canvas;
    this.quality = 'balanced';
    this.qualityCfg = QUALITY.balanced;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true });
    if (!renderer.capabilities?.isWebGL2) { renderer.dispose(); throw new Error('需要 WebGL2 支持：当前上下文仅提供 WebGL1'); }
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = false;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x86b5b6, 120, 340);
    this.scene.background = new THREE.Color(0x86b5b6);
    this.ambient = new THREE.HemisphereLight(0xdfe9e2, 0x4a5a4a, 1.35);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff0d4, 2.3);
    this.sun.position.set(70, 150, 55);
    this.scene.add(this.sun);
    this.lamp = new THREE.PointLight(0xffc978, 0, 46, 2);
    this.scene.add(this.lamp);
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.5, 900);
    this.camera.position.set(0, 40, 40);
    this.camPitch = CAMERA.pitch;
    this.camDist = CAMERA.distance.balanced;
    this.camYaw = 0;
    this.orbit = 0;
    this.shakeAmount = 0;
    this.hitmarkerTime = 0;
    this.elapsed = 0;
    this.predicted = null;
    this.muzzleUntil = 0;
    this.follow = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.shakeAmount = 0;
    this.hitmarkerTime = 0;
    this.home = true;
    this.worlds = new Map();
    this.worldGroup = null;
    this.mapId = null;
    this.theme = themeFor('qinglan');
    this.lighting = lightingFor(this.theme, 'day', 'clear');
    this.world = null;
    this.roofs = [];
    this.players = new Map();
    this.cars = new Map();
    this.drops = new Map();
    this.pings = new Map();
    this.state = null;
    this.selfId = null;
    this.entityGroup = new THREE.Group();
    this.scene.add(this.entityGroup);
    this.fx = new Fx(this.scene);
    this.zoneRing = this.makeZoneRing();
    this.stormWall = this.makeStormWall();
    this.pointer = this.makePointer();
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.hit = new THREE.Vector3();
    this.eventId = 0;
    this.pendingInputs = [];
    this.predicted = null;
    this.time = 0;
    this.visiblePlayers = 0;
    this.visibleCars = 0;
    this.corpseTimer = 0;
    this.lootCap = MAX_LOOT;
    this.resize();
    this.setQuality('balanced');
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
  }

  /* ---------------- 尺寸 / 质量 ---------------- */
  resize() {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality) {
    this.quality = QUALITY[quality] ? quality : 'balanced';
    this.qualityCfg = QUALITY[this.quality];
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.qualityCfg.pixelRatio));
    this.camDist = CAMERA.distance[this.quality];
    this.viewDistance = this.qualityCfg.viewDistance;
    this.fx.setQuality(this.quality);
    this.renderer.setSize(this.width, this.height, false);
    if (this.scene.fog) { this.scene.fog.near = this.lighting.fogNear; this.scene.fog.far = this.lighting.fogFar; }
    if (this.lootMesh) this.lootMesh.visible = true;
  }

  /* ---------------- 常驻叠加物件 ---------------- */
  makeZoneRing() {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 160), new THREE.MeshBasicMaterial({ color: 0x7fe6dc, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.12; mesh.visible = false; mesh.frustumCulled = false;
    this.scene.add(mesh); return mesh;
  }

  makeStormWall() {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 26, 72, 1, true), new THREE.MeshBasicMaterial({ color: 0x6ad4ce, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
    mesh.position.y = 13; mesh.visible = false; mesh.frustumCulled = false;
    this.scene.add(mesh); return mesh;
  }

  makePointer() {
    const mesh = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0xf6c76e, 0.55));
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.08; mesh.scale.setScalar(0.6); mesh.visible = false;
    this.scene.add(mesh); return mesh;
  }

  /* ---------------- 光照 / 雾 / 天气 ---------------- */
  applyAtmosphere(timeOfDay = 'day', weather = 'clear') {
    this.lighting = lightingFor(this.theme, timeOfDay, weather);
    const L = this.lighting;
    this.scene.fog.color.set(L.fogColor);
    this.scene.fog.near = L.fogNear; this.scene.fog.far = L.fogFar;
    this.scene.background = this.scene.background || new THREE.Color();
    this.scene.background.set(L.clearColor);
    this.renderer.setClearColor(L.clearColor, 1);
    this.renderer.toneMappingExposure = L.exposure;
    this.ambient.color.set(L.ambient.sky);
    this.ambient.groundColor.set(L.ambient.ground ?? 0x4a5a4a);
    this.ambient.intensity = L.ambient.intensity;
    this.sun.color.set(L.sun.color);
    this.sun.intensity = L.sun.intensity;
    this.sun.position.set(L.sun.position[0], L.sun.position[1], L.sun.position[2]);
    this.lamp.visible = false;
    const wfx = WEATHER_FX[weather] || WEATHER_FX.clear;
    this.fx.setWeather(wfx.kind);
  }

  /** 夜间点光源：跟随相机中心，模拟路灯冷却光。 */
  updateLamps(nearX, nearZ, elapsed) {
    if (!this.lighting.lamps) { this.lamp.visible = false; return; }
    this.lamp.visible = true;
    this.lamp.color.set(this.lighting.lampColor || 0xffc978);
    this.lamp.intensity = 26 + Math.sin(elapsed * 0.9) * 2.4;
    this.lamp.position.set(nearX - 6, 9, nearZ + 4);
  }

  /* ---------------- 世界：makeWorld + 合并/实例化 ---------------- */
  getWorld(mapId) {
    try {
      const world = typeof mapModule.worldCache?.get === 'function' ? mapModule.worldCache.get(mapId) : null;
      if (world) return world;
      const made = makeWorldImpl(mapId);
      if (made) return made;
    } catch (err) {
      console.warn('[scene] makeWorld 失败，使用兜底世界:', err?.message || err);
    }
    return this.fallbackWorld(mapId);
  }

  fallbackWorld(mapId) {
    const def = this.theme?.def || {};
    const radius = def.radius || MAP_RADIUS();
    const legacy = legacyExport('MAP');
    const buildings = (legacy?.buildings || []).map((b, i) => ({
      id: `fb${i}`, x: b.x, z: b.z, w: b.w || 9, d: b.d || 8, h: 3.6, rot: 0,
      roofColor: b.color, regionId: 0, entrances: [{ x: b.x, z: b.z + (b.d || 8) / 2 }],
    }));
    const trees = (legacy?.trees || []).map((t) => ({ x: t.x, z: t.z, scale: t.scale || 1, kind: t.color ?? 0 }));
    const obstacles = [
      ...(legacy?.obstacles || []).map((o, i) => ({ id: `fo${i}`, x: o.x, z: o.z, w: o.w || 1, d: o.d || 1, h: o.h || 1.2, kind: o.kind || 'wall' })),
      ...(legacy?.props || []).map((p, i) => ({ id: `fp${i}`, x: p.x, z: p.z, w: p.w || 1.4, d: p.d || 1.4, h: p.h || 1.1, kind: p.kind || 'crate' })),
    ];
    const regions = (legacy?.regions || []).map((r, i) => ({ id: `r${i}`, name: r.name, x: r.x, z: r.z, tier: 2, kind: 'wild' }));
    return {
      id: mapId, def, radius, regions, buildings, obstacles, props: [],
      trees, roads: legacy?.regions ? [{ x: 0, z: 0, w: 8, d: radius * 2 - 10, rot: 0, kind: 'asphalt' }, { x: 0, z: 0, w: 8, d: radius * 2 - 10, rot: Math.PI / 2, kind: 'asphalt' }] : [],
      waters: [], lootSpots: [], carSpots: [], spawnAnchors: [{ x: 0, z: 0 }],
      landmarks: [], bounds: { minX: -radius, maxX: radius, minZ: -radius, maxZ: radius },
      fallback: true,
    };
  }

  /** 一次性构建静态世界并缓存（切换地图复用，不重建几何/纹理）。 */
  setMap(mapId, options = {}) {
    const id = mapId || 'qinglan';
    this.theme = themeFor(id);
    this.mapId = id;
    let cached = this.worlds.get(id);
    if (!cached || options.rebuild) {
      if (cached) { this.disposeWorld(cached); this.worlds.delete(id); }
      cached = this.buildStaticWorld(id);
      this.worlds.set(id, cached);
    }
    if (this.worldGroup) this.scene.remove(this.worldGroup);
    this.worldGroup = cached.group;
    this.world = cached.world;
    this.currentWorld = cached;
    this.roofs = cached.roofs;
    this.scene.add(this.worldGroup);
    this.applyAtmosphere(cached.world?.def?.timeOfDay || 'day', cached.world?.def?.weather || 'clear');
    if (this.lootMesh) this.buildLootMeshes();
    this.home = false;
    return this.world;
  }

  /** 兜底地面（世界构建失败或没有 world 时也可渲染）。 */
  makeGroundBase(theme, radius) {
    const group = new THREE.Group();
    const list = createList();
    const seed = 20261018;
    const cells = 40;
    const unit = (radius * 2.1) / cells;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const x = (i / (cells - 1) - 0.5) * radius * 2.1, z = (j / (cells - 1) - 0.5) * radius * 2.1;
        const dist = Math.hypot(x, z) / radius;
        const n = Math.sin(x * 0.07 + seed) * Math.cos(z * 0.06) * 0.5 + Math.sin((x + z) * 0.021) * 0.5;
        const col = dist > 1.04 ? theme.water.color : dist > 0.94 ? theme.ground.sandRing : n > 0.18 ? theme.ground.grassAlt : theme.ground.grass;
        bake(list, UNIT_BOX, col, x, -0.18 + n * 0.07, z, unit + 0.6, 0.34, unit + 0.6);
      }
    }
    const terrain = new THREE.Mesh(finishList(list), vertexColorMaterial());
    terrain.renderOrder = 0;
    group.add(terrain);
    const sea = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(theme.water.color, 0.96, false));
    sea.rotation.x = -Math.PI / 2; sea.position.y = -0.62; sea.scale.setScalar(radius * 4.2); group.add(sea);
    const shore = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(theme.ground.sandRing, 0.95, false));
    shore.rotation.x = -Math.PI / 2; shore.position.y = -0.12; shore.scale.setScalar(radius * 1.07); group.add(shore);
    return { group, terrain, sea, shore };
  }

  buildStaticWorld(id) {
    const theme = this.theme;
    const world = this.getWorld(id);
    const radius = world.radius || world.def?.radius || MAP_RADIUS();
    const group = new THREE.Group();
    group.name = `world:${id}`;
    const roofs = [];
    const base = this.makeGroundBase(theme, radius);
    group.add(base.group);
    const staticGroup = new THREE.Group(); group.add(staticGroup);
    const palette = theme.def?.theme || {};
    // 水域（海/湖/港湾/冰面）：扁平圆盘，叠在地形之上
    for (const water of world.waters || []) {
      const isIce = water.kind === 'ice' || water.slippery;
      const color = isIce ? 0xd9e6e4 : water.kind === 'oasis' ? 0x76a9a0 : theme.water.color;
      const disc = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(color, isIce ? 0.98 : 0.92, false));
      disc.rotation.x = -Math.PI / 2; disc.position.set(water.x || 0, -0.02, water.z || 0);
      disc.scale.setScalar(Math.max(3, water.r || Math.max(water.w || 8, water.d || 8) * 0.5));
      staticGroup.add(disc);
    }
    // 道路
    if (world.roads?.length) {
      const list = createList();
      for (const road of world.roads) {
        const color = road.kind === 'dirt' ? 0x9c8a63 : palette.road ?? 0x77847b;
        bake(list, UNIT_BOX, color, road.x || 0, 0.03, road.z || 0, road.w || 8, 0.06, road.d || 60, 0, road.rot || 0, 0);
        if (road.kind === 'asphalt') {
          const len = (road.d || 60) * 0.5, dash = Math.max(2, Math.floor(len / 8));
          for (let d = -dash; d <= dash; d++) {
            const ox = Math.sin(road.rot || 0) * (d * 7), oz = Math.cos(road.rot || 0) * (d * 7);
            bake(list, UNIT_BOX, 0xd8d3ae, (road.x || 0) + ox, 0.08, (road.z || 0) + oz, 0.22, 0.02, 3.2, 0, road.rot || 0, 0);
          }
        }
      }
      staticGroup.add(new THREE.Mesh(finishList(list), vertexColorMaterial()));
    }
    // 地面细节：草丛/石子/沙纹（单 draw call，纯装饰）
    if (theme.ground.detail > 0) {
      const detail = createList();
      let seed = 1234567;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const count = this.quality === 'low' ? 160 : this.quality === 'high' ? 420 : 280;
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (radius - 14);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const col = rnd() > 0.55 ? theme.ground.grassAlt : theme.ground.grass;
        bake(detail, UNIT_BOX, col, x, 0.045, z, 1.4 + rnd() * 2.2, 0.05, 1.4 + rnd() * 2.2, 0, rnd() * 3, 0);
      }
      staticGroup.add(new THREE.Mesh(finishList(detail), vertexColorMaterial()));
    }
    // 建筑：楼层地板 + 墙体（与碰撞体一致）+ 屋顶实例（近处独立 mesh 可淡出）
    const wallList = createList();
    const floorList = createList();
    const roofBuckets = new Map();
    for (const building of world.buildings || []) {
      const bx = building.x || 0, bz = building.z || 0;
      const w = building.w || 10, d = building.d || 9, h = building.h || 3.4;
      const floorColor = building.floorColor ?? palette.wall?.[0] ?? 0xd1c6ac;
      bake(floorList, UNIT_BOX, floorColor, bx, 0.06, bz, w + 0.6, 0.12, d + 0.6);
      const roofColor = building.roofColor ?? palette.roof?.[0] ?? 0xae6855;
      if (!roofBuckets.has(roofColor)) roofBuckets.set(roofColor, []);
      roofBuckets.get(roofColor).push({ building, x: bx, y: h + 0.22, z: bz, sx: w + 0.9, sy: 0.42, sz: d + 0.9 });
      roofs.push({ building, opacity: 1, mesh: null, instance: null });
    }
    // 墙体：直接复用碰撞障碍（kind wall/container 等）保证视觉=物理
    const propBuckets = new Map();
    for (const obstacle of world.obstacles || []) {
      const kind = obstacle.kind || 'wall';
      if (kind === 'tree') continue;
      if (kind === 'wall') {
        const h = Math.max(1.2, obstacle.h || 2.4);
        const color = pickWallColor(palette, obstacle);
        bake(wallList, UNIT_BOX, color, obstacle.x || 0, h * 0.5, obstacle.z || 0, obstacle.w || 1, h, obstacle.d || 1, 0, obstacle.rot || 0, 0);
        if (h > 2.2) bake(wallList, UNIT_BOX, 0xf0e6cc, obstacle.x || 0, h - 0.1, obstacle.z || 0, (obstacle.w || 1) * 1.02, 0.14, (obstacle.d || 1) * 1.02, 0, obstacle.rot || 0, 0);
      } else {
        if (!propBuckets.has(kind)) propBuckets.set(kind, []);
        propBuckets.get(kind).push(obstacle);
      }
    }
    for (const prop of world.props || []) {
      const kind = prop.kind || 'crate';
      if (!propBuckets.has(kind)) propBuckets.set(kind, []);
      propBuckets.get(kind).push(prop);
    }
    staticGroup.add(new THREE.Mesh(finishList(floorList), vertexColorMaterial()));
    staticGroup.add(new THREE.Mesh(finishList(wallList), vertexColorMaterial()));
    // 屋顶实例：按颜色桶各 1 个 InstancedMesh
    const roofMeshes = [];
    for (const [color, items] of roofBuckets) {
      const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
      const mesh = new THREE.InstancedMesh(UNIT_BOX, mat, items.length);
      items.forEach((item, i) => {
        _e.set(0, 0, 0); _q.setFromEuler(_e);
        _m.compose(_v.set(item.x, item.y, item.z), _q, _s.set(item.sx, item.sy, item.sz));
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData.items = items;
      staticGroup.add(mesh);
      roofMeshes.push(mesh);
    }
    // 绑定 roofs[] 与实例索引
    for (const mesh of roofMeshes) {
      mesh.userData.items.forEach((item, i) => {
        const target = roofs.find((r) => r.building === item.building);
        if (target) target.instance = { mesh, index: i, item };
      });
    }
    // 近处屋顶叠加池（可淡出）
    const roofOverlay = [];
    for (let i = 0; i < 22; i++) {
      const mesh = new THREE.Mesh(UNIT_BOX, new THREE.MeshLambertMaterial({ color: 0xae6855, transparent: true, opacity: 1, depthWrite: true }));
      mesh.visible = false; staticGroup.add(mesh); roofOverlay.push({ mesh, building: null, opacity: 1, color: 0xae6855 });
    }
    // 树（3 种树型各 1 个 InstancedMesh）
    const treeGroups = [[], [], []];
    for (const tree of world.trees || []) treeGroups[clamp(tree.kind | 0, 0, 2)].push(tree);
    for (let kind = 0; kind < 3; kind++) {
      const list = treeGroups[kind];
      if (!list.length) continue;
      const template = createTree({ x: 0, z: 0, scale: 1, kind }, palette);
      const mesh = new THREE.InstancedMesh(template.parts.mesh.geometry, vertexColorMaterial(), list.length);
      list.forEach((tree, i) => {
        _e.set(0, ((tree.x || 0) * 7.1 + (tree.z || 0) * 3.3) % 6.28, 0); _q.setFromEuler(_e);
        _s.setScalar(tree.scale || 1);
        _m.compose(_v.set(tree.x || 0, 0, tree.z || 0), _q, _s);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
      staticGroup.add(mesh);
      disposeModelSoft(template.group);
    }
    // 其余障碍/道具：单位几何 + 实例缩放（视觉尺寸=碰撞尺寸）
    const propMeshes = [];
    for (const [kind, items] of propBuckets) {
      if (!items.length) continue;
      const template = createProp({ kind }, palette);
      const mesh = new THREE.InstancedMesh(template.parts.mesh.geometry, vertexColorMaterial(), items.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      items.forEach((item, i) => {
        _e.set(0, item.rot || 0, 0); _q.setFromEuler(_e);
        _s.set(item.w || 1.4, item.h || 1.2, item.d || 1.4);
        _m.compose(_v.set(item.x || 0, 0, item.z || 0), _q, _s);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
      staticGroup.add(mesh);
      propMeshes.push(mesh);
      disposeModelSoft(template.group);
    }
    // 区域招牌 + 地标
    const regionSigns = [];
    for (const region of world.regions || []) {
      const sign = createTextSprite(region.name || '', '#f4f2dc', 40, { plate: 'rgba(20,32,34,.5)' });
      sign.scale.set(9, 2.2, 1); sign.position.set(region.x || 0, 7.4, (region.z || 0) - 8);
      staticGroup.add(sign); regionSigns.push(sign);
    }
    staticGroup.add(this.buildLandmarks(world, theme));
    // 边界提示环
    const border = new THREE.Mesh(new THREE.RingGeometry(radius * 0.985, radius, 96), new THREE.MeshBasicMaterial({ color: palette.accent ?? 0xefb657, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }));
    border.rotation.x = -Math.PI / 2; border.position.y = 0.16; staticGroup.add(border);
    return { group, world, roofs, roofOverlay, base, mapId: id, radius };
  }

  buildLandmarks(world, theme) {
    const group = new THREE.Group();
    for (const lm of world.landmarks || []) {
      const list = createList();
      const accent = theme.def?.theme?.accent ?? 0xefb657;
      if (lm.kind === 'radio_tower' || lm.kind === 'mine_head' || lm.kind === 'crane') {
        bake(list, UNIT_CYL, 0x6f7873, 0, 6, 0, 1.1, 12, 1.1);
        for (let i = 0; i < 4; i++) bake(list, UNIT_BOX, 0x59625d, 0, 2 + i * 2.6, 0, 3.2 - i * 0.5, 0.18, 3.2 - i * 0.5, 0, i * 0.4, 0);
        bake(list, UNIT_SPHERE, accent, 0, 12.4, 0, 0.5, 0.5, 0.5);
        const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
        mesh.position.set(lm.x, 0, lm.z); group.add(mesh);
        const beacon = new THREE.Mesh(UNIT_SPHERE, glowMaterial(accent, 0.9));
        beacon.scale.setScalar(0.9); beacon.position.set(lm.x, 12.6, lm.z); group.add(beacon);
      } else if (lm.kind === 'lighthouse') {
        bake(list, UNIT_CYL, 0xe8e4d8, 0, 5, 0, 1.5, 10, 1.5);
        bake(list, UNIT_CYL, 0xb8452f, 0, 8.4, 0, 1.7, 1.6, 1.7);
        bake(list, UNIT_SPHERE, accent, 0, 11, 0, 1.2, 1.2, 1.2);
        const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
        mesh.position.set(lm.x, 0, lm.z); group.add(mesh);
        const beam = new THREE.Mesh(new THREE.ConeGeometry(3.2, 34, 10, 1, true), glowMaterial(accent, 0.16));
        beam.rotation.z = Math.PI / 2; beam.position.set(lm.x, 11, lm.z); group.add(beam);
      } else if (lm.kind === 'wreck') {
        bake(list, UNIT_BOX, 0x5d6663, 0, 3, 0, 8, 4, 22, 0.07, 0.2, 0.04);
        bake(list, UNIT_BOX, 0x49514f, 0, 5.6, 4, 6, 3, 8, 0.07, 0.2, 0.04);
        const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
        mesh.position.set(lm.x, 0, lm.z); group.add(mesh);
      } else if (lm.kind === 'beacon' || lm.kind === 'objective') {
        const pole = new THREE.Mesh(UNIT_CYL, glowMaterial(accent, 0.28));
        pole.scale.set(0.16, 10, 0.16); pole.position.set(lm.x, 5, lm.z); group.add(pole);
      }
      const label = createTextSprite(lm.label || lm.name || '', '#ffe9b8', 36, { plate: 'rgba(18,28,30,.6)' });
      label.scale.set(8, 2, 1); label.position.set(lm.x, (lm.kind === 'lighthouse' ? 13.5 : 10) + 2, lm.z);
      group.add(label);
    }
    return group;
  }

  disposeWorld(cached) {
    if (!cached) return;
    this.scene.remove(cached.group);
    cached.group.traverse((node) => {
      if (node.isInstancedMesh) { node.geometry.dispose(); node.dispose?.(); }
      else if (node.isMesh && node.geometry) node.geometry.dispose();
      else if (node.isSprite && node.material?.map) node.material.map.dispose();
    });
    cached.group.clear();
  }

  /* ---------------- 主菜单英雄场景 ---------------- */
  showHome() {
    this.home = true;
    this.clearEntities();
    try { this.setMap(this.mapId || 'qinglan'); } catch (err) { console.warn('[scene] showHome 建图失败', err); }
    this.home = true;
    this.zoneRing.visible = false; this.stormWall.visible = false; this.pointer.visible = false;
    this.fx.clear();
    this.state = null;
    this.eventId = 0;
    this.pendingInputs.length = 0;
    this.predicted = null;
    this.follow.set(0, 0, 0);
    this.applyAtmosphere(this.world?.def?.timeOfDay || 'day', this.world?.def?.weather || 'clear');
    if (this.lootMesh) this.lootMesh.count = 0;
    this.renderer.setClearColor(this.lighting.clearColor, 1);
  }

  clearEntities() {
    for (const model of this.players.values()) { this.entityGroup.remove(model.group); disposeModel(model.group); }
    this.players.clear();
    for (const car of this.cars.values()) { this.entityGroup.remove(car.group); disposeModel(car.group); }
    this.cars.clear();
    for (const drop of this.drops.values()) { this.entityGroup.remove(drop.group); disposeModel(drop.group); }
    this.drops.clear();
    for (const ping of this.pings.values()) { this.entityGroup.remove(ping.group); disposeModel(ping.group); }
    this.pings.clear();
    for (const roof of this.roofs) {
      if (roof.mesh) { roof.mesh.material.opacity = 1; roof.mesh.material.depthWrite = true; }
      roof.opacity = 1;
      if (roof.instanceFaded && roof.instance) {
        const item = roof.instance.item;
        _m.compose(_v.set(item.x, item.y, item.z), _q.identity(), _s.set(item.sx, item.sy, item.sz));
        roof.instance.mesh.setMatrixAt(roof.instance.index, _m);
        roof.instance.mesh.instanceMatrix.needsUpdate = true;
        roof.instanceFaded = false;
      }
    }
    if (this.currentWorld?.roofOverlay) for (const slot of this.currentWorld.roofOverlay) { slot.building = null; slot.mesh.visible = false; }
    this.fx.clear();
    if (this.lootMesh) { this.lootMesh.count = 0; if (this.lootGlow) this.lootGlow.count = 0; }
    this.eventId = 0;
    this.pendingInputs.length = 0;
    this.predicted = null;
  }

  /* ---------------- 局内准备 ---------------- */
  beginMatch(config = {}) {
    this.home = false;
    if (config.mapId && config.mapId !== this.mapId) this.setMap(config.mapId);
    else if (!this.world) this.setMap(config.mapId || 'qinglan');
    this.clearEntities();
    if (config.quality) this.setQuality(config.quality);
    const self = config.selfId || null;
    if (self) { this.selfId = self; const p = config.spawn || { x: 0, z: 0 }; this.follow.set(p.x, 0, p.z); this.predicted = { x: p.x, z: p.z }; }
    this.camDist = CAMERA.distance[this.quality];
    this.zoneRing.visible = true; this.stormWall.visible = true;
    this.shakeAmount = 0;
    this.applyAtmosphere(config.timeOfDay || this.world?.def?.timeOfDay || 'day', config.weather || this.world?.def?.weather || 'clear');
    this.buildLootMeshes();
    return this;
  }

  buildLootMeshes() {
    if (this.lootMesh) { this.entityGroup.remove(this.lootMesh); this.lootMesh.dispose(); this.lootMesh = null; }
    if (this.lootGlow) { this.entityGroup.remove(this.lootGlow); this.lootGlow.dispose(); this.lootGlow = null; }
    const template = createLootModel('weapon', 'rifle', 'common');
    const geo = template.parts.mesh.geometry;
    this.lootMesh = new THREE.InstancedMesh(geo, vertexColorMaterial(), MAX_LOOT);
    this.lootMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lootMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LOOT * 3), 3);
    this.lootMesh.count = 0; this.lootMesh.frustumCulled = false;
    this.entityGroup.add(this.lootMesh);
    const glowGeo = UNIT_CYL;
    this.lootGlow = new THREE.InstancedMesh(glowGeo, glowMaterial(0xffffff, 0.3), MAX_LOOT);
    this.lootGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lootGlow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LOOT * 3), 3);
    this.lootGlow.count = 0; this.lootGlow.frustumCulled = false;
    this.entityGroup.add(this.lootGlow);
    disposeModelSoft(template.group);
  }

  /* ---------------- 玩家模型池 ---------------- */
  playerColorFor(player) {
    const selfTeam = this.state?.players?.find((p) => p.id === this.selfId)?.team ?? -1;
    if (player.id === this.selfId) return DEFAULT_SKIN;
    const teamColor = teamColorOf(player.team ?? 0);
    return { primary: teamColor, secondary: 0x2b3f45, accent: player.team === selfTeam ? 0x9ff0c8 : 0xd9a27a };
  }

  ensurePlayer(player) {
    let entry = this.players.get(player.id);
    if (entry) return entry;
    const isSelf = player.id === this.selfId;
    const model = createCharacter({ colors: this.playerColorFor(player), team: player.team ?? 0, isSelf });
    model.setWeapon(player.weapon || 'rifle');
    model.group.position.set(player.x || 0, 0, player.z || 0);
    this.entityGroup.add(model.group);
    entry = { model, group: model.group, target: { x: player.x || 0, z: player.z || 0, angle: player.angle || 0 }, label: null, bar: null, hitAt: -10, last: { x: player.x || 0, z: player.z || 0, t: 0 } };
    const selfTeam = this.selfTeamCache ?? this.state?.players?.find((p) => p.id === this.selfId)?.team;
    if (player.team === selfTeam) {
      entry.label = createTextSprite(isSelf ? '▼ 你' : (player.name || '队友'), isSelf ? '#ffdc8c' : '#a9f0cf', 42, { plate: 'rgba(20,32,34,.45)' });
      entry.label.scale.set(4.4, 1.1, 1);
      entry.label.position.y = 2.72;
      model.parts.labelAnchor.add(entry.label);
    } else if (!player.bot) {
      entry.label = createTextSprite(player.name || '', '#ffd0c0', 34, { plate: 'rgba(30,16,14,.4)' });
      entry.label.scale.set(3.4, 0.9, 1); entry.label.position.y = 2.72;
      model.parts.labelAnchor.add(entry.label);
    }
    entry.bar = this.makeHealthBar();
    entry.bar.position.y = 2.3;
    model.group.add(entry.bar);
    this.players.set(player.id, entry);
    return entry;
  }

  makeHealthBar() {
    const group = new THREE.Group();
    const bg = new THREE.Mesh(UNIT_BOX, glowMaterial(0x11201e, 0.6, false));
    bg.scale.set(1.05, 0.12, 0.02); group.add(bg);
    const fill = new THREE.Mesh(UNIT_BOX, glowMaterial(0x77e08f, 0.95, false));
    fill.scale.set(1, 0.08, 0.03); fill.position.z = 0.01; group.add(fill);
    const armor = new THREE.Mesh(UNIT_BOX, glowMaterial(0x76b8f0, 0.9, false));
    armor.scale.set(1, 0.035, 0.03); armor.position.set(0, -0.09, 0.01); group.add(armor);
    group.visible = false;
    group.userData = { fill, armor };
    return group;
  }

  updatePlayer(entry, player, dt, elapsed) {
    const model = entry.model;
    const isSelf = player.id === this.selfId;
    const predicted = isSelf && this.predicted ? this.predicted : null;
    const tx = predicted ? predicted.x : player.x || 0;
    const tz = predicted ? predicted.z : player.z || 0;
    const follow = clamp(1 - Math.exp(-(isSelf ? 26 : 14) * dt), 0, 1);
    entry.group.position.x += (tx - entry.group.position.x) * follow;
    entry.group.position.z += (tz - entry.group.position.z) * follow;
    entry.target.angle = player.angle || 0;
    const dy = Math.atan2(Math.sin(entry.target.angle - entry.group.rotation.y), Math.cos(entry.target.angle - entry.group.rotation.y));
    entry.group.rotation.y += dy * clamp(1 - Math.exp(-16 * dt), 0, 1);
    const speed = Math.hypot(tx - entry.last.x, tz - entry.last.z) / Math.max(0.0001, dt);
    entry.last.x = tx; entry.last.z = tz;
    const moving = speed > 1.2;
    const state = player.state || (player.downed ? 'downed' : (player.chute || 0) > 0.02 ? 'sprint' : moving && speed > 6.4 ? 'sprint' : 'normal');
    model.setPose(player.downed ? 'downed' : state === 'crouch' ? 'crouch' : state === 'sprint' ? 'sprint' : 'normal');
    if (model.weapon !== weaponClassOf(player.weapon || 'rifle')) model.setWeapon(player.weapon || 'rifle');
    model.update(dt, { speed, lookYaw: dy });
    const air = player.y != null && player.y > 0.1 ? player.y : 0;
    const chuting = (player.chute || 0) > 0.02 || air > 0.4;
    model.parts.chute.visible = !player.car && chuting && !player.downed;
    entry.group.position.y = player.car && !player.downed ? 0 : air;
    entry.group.visible = !!player.alive && !player.car;
    if (model.parts.shadow) model.parts.shadow.visible = !chuting && !player.car;
    // 血条：受伤后短暂显示 / 队友常显
    if (entry.bar) {
      const hurt = elapsed - entry.hitAt < 3;
      const show = !!player.alive && (hurt || player.team === this.selfTeam());
      entry.bar.visible = show && !player.car;
      if (show) {
        const hpRatio = clamp((player.hp || 0) / 100, 0, 1);
        const fill = entry.bar.userData.fill;
        fill.scale.x = Math.max(0.02, hpRatio);
        fill.position.x = -(1 - hpRatio) * 0.5;
        fill.material.color.set(hpRatio > 0.55 ? 0x77e08f : hpRatio > 0.25 ? 0xf0c85a : 0xf06a54);
        const armorRatio = clamp((player.armor || 0) / 100, 0, 1);
        const armorMesh = entry.bar.userData.armor;
        armorMesh.visible = armorRatio > 0.02;
        armorMesh.scale.x = Math.max(0.02, armorRatio);
        armorMesh.position.x = -(1 - armorRatio) * 0.5;
        entry.bar.quaternion.copy(this.camera.quaternion);
      }
    }
    if (entry.label) entry.label.quaternion.copy(this.camera.quaternion);
    return entry;
  }

  selfTeam() { return this.state?.players?.find((p) => p.id === this.selfId)?.team ?? -2; }

  /* ---------------- 载具 ---------------- */
  ensureCar(car) {
    let entry = this.cars.get(car.id);
    if (entry) return entry;
    const model = createVehicle(car.type || 'jeep', car.color || 0xe9b766);
    model.group.position.set(car.x || 0, 0, car.z || 0);
    model.group.rotation.y = car.angle || 0;
    this.entityGroup.add(model.group);
    entry = { model, group: model.group, target: { x: car.x || 0, z: car.z || 0, angle: car.angle || 0, speed: 0 }, last: { x: car.x || 0, z: car.z || 0 }, bar: this.makeHealthBar() };
    entry.bar.position.y = 2.6; entry.bar.visible = false;
    model.group.add(entry.bar);
    this.cars.set(car.id, entry);
    return entry;
  }

  updateCar(entry, car, dt) {
    const t = entry.target;
    t.x = car.x || 0; t.z = car.z || 0; t.angle = car.angle || 0;
    const smooth = clamp(1 - Math.exp(-13 * dt), 0, 1);
    entry.group.position.x += (t.x - entry.group.position.x) * smooth;
    entry.group.position.z += (t.z - entry.group.position.z) * smooth;
    const speed = Math.hypot(t.x - entry.last.x, t.z - entry.last.z) / Math.max(0.0001, dt);
    entry.last.x = t.x; entry.last.z = t.z;
    const dy = Math.atan2(Math.sin(t.angle - entry.group.rotation.y), Math.cos(t.angle - entry.group.rotation.y));
    entry.group.rotation.y += dy * clamp(1 - Math.exp(-12 * dt), 0, 1);
    entry.model.update(dt, speed, dy * 2, dy * 0.08);
    entry.group.visible = (car.hp ?? 1) > 0;
    if (entry.bar && car.hp != null) {
      const ratio = clamp(car.hp / Math.max(1, car.maxHp || 100), 0, 1);
      entry.bar.visible = ratio < 0.999;
      const fill = entry.bar.userData.fill;
      fill.scale.x = Math.max(0.02, ratio);
      fill.position.x = -(1 - ratio) * 0.5;
      fill.material.color.set(ratio > 0.5 ? 0xf0c85a : 0xf06a54);
      entry.bar.userData.armor.visible = false;
      entry.bar.quaternion.copy(this.camera.quaternion);
    }
  }

  /* ---------------- 快照消费（契约 §3） ---------------- */
  setState(snapshot, selfId) {
    if (!snapshot || !snapshot.players) return;
    if (this.home) this.beginMatch({ mapId: snapshot.mapId, selfId, weather: snapshot.weather });
    this.state = snapshot;
    this.selfId = selfId || snapshot.selfId || this.selfId;
    this.time = snapshot.matchTime ?? snapshot.time ?? this.time;
    if (snapshot.mapId && snapshot.mapId !== this.mapId) this.setMap(snapshot.mapId);
    this.applyWeather(snapshot);
    this.updateLoot(snapshot.loot || []);
    this.updatePlayers(snapshot);
    this.updateCars(snapshot.cars || []);
    this.updateWorldObjects(snapshot);
    this.updateZone(snapshot.zone, snapshot.time || 0);
    this.consumeEvents(snapshot.events || [], snapshot);
    this.tickRoofs(1 / 60);
    this.updatePrediction(snapshot);
    return this;
  }

  applyWeather(snapshot) {
    const tod = snapshot.timeOfDay || this.world?.def?.timeOfDay || 'day';
    const weather = snapshot.weather || this.world?.def?.weather || 'clear';
    if (this.lastTod !== tod || this.lastWeather !== weather) {
      this.lastTod = tod; this.lastWeather = weather;
      this.applyAtmosphere(tod, weather);
    }
  }

  updateLoot(loot) {
    if (!this.lootMesh) this.buildLootMeshes();
    const max = Math.min(loot.length, MAX_LOOT, this.lootCap || MAX_LOOT);
    this.lootMesh.count = max;
    this.lootGlow.count = max;
    this.lootItems = max ? loot.slice(0, max) : [];
    for (let i = 0; i < max; i++) {
      const item = this.lootItems[i];
      _m.compose(_v.set(item.x || 0, 0.34, item.z || 0), _q.identity(), _s.setScalar(1));
      this.lootMesh.setMatrixAt(i, _m);
      const rb = rarityRgbCompat(item.rarity);
      this.lootMesh.setColorAt(i, _c.setRGB(rb[0], rb[1], rb[2]));
      _m.compose(_v.set(item.x || 0, 0.9, item.z || 0), _q.identity(), _s.set(0.16, 1.6, 0.16));
      this.lootGlow.setMatrixAt(i, _m);
      this.lootGlow.setColorAt(i, _c.setRGB(rb[0] * 0.9, rb[1] * 0.9, rb[2] * 0.9));
    }
    this.lootMesh.instanceMatrix.needsUpdate = true;
    this.lootGlow.instanceMatrix.needsUpdate = true;
    if (this.lootMesh.instanceColor) this.lootMesh.instanceColor.needsUpdate = true;
    if (this.lootGlow.instanceColor) this.lootGlow.instanceColor.needsUpdate = true;
  }

  updatePlayers(snapshot) {
    const seen = new Set();
    this.selfTeamCache = this.state?.players?.find((p) => p.id === this.selfId)?.team ?? -2;
    for (const player of snapshot.players) {
      if (!player.alive) { seen.add(player.id); this.hidePlayer(player.id); continue; }
      const entry = this.ensurePlayer(player);
      seen.add(player.id);
      entry.source = player;
      entry.visibleWanted = true;
    }
    for (const id of this.players.keys()) if (!seen.has(id)) this.hidePlayer(id);
  }

  /** 每帧插值 + 视距剔除（数据 10Hz，这里补到 60FPS）。 */
  tickPlayers(dt, elapsed) {
    let visible = 0;
    const cx = this.follow.x, cz = this.follow.z;
    const maxDist = this.viewDistance;
    for (const entry of this.players.values()) {
      const player = entry.source;
      if (!player || entry.visibleWanted !== true) { entry.group.visible = false; if (entry.bar) entry.bar.visible = false; continue; }
      const isSelf = player.id === this.selfId;
      const isMate = player.team === this.selfTeamCache;
      const dist = Math.hypot((player.x || 0) - cx, (player.z || 0) - cz);
      const within = isSelf || isMate || dist <= maxDist;
      if (!within || (!isSelf && !isMate && visible >= MAX_VISIBLE_PLAYERS)) { entry.group.visible = false; if (entry.bar) entry.bar.visible = false; continue; }
      visible++;
      entry.group.visible = true;
      this.updatePlayer(entry, player, dt, elapsed);
    }
    this.visiblePlayers = visible;
  }

  hidePlayer(id) {
    const entry = this.players.get(id);
    if (entry) { entry.group.visible = false; if (entry.bar) entry.bar.visible = false; }
  }

  updateCars(cars) {
    for (const car of cars.slice(0, MAX_CARS)) {
      if ((car.hp ?? 1) <= 0) continue;
      const entry = this.ensureCar(car);
      entry.source = car;
    }
    for (const entry of this.cars.values()) if (!entry.source) entry.group.visible = false;
  }

  updateWorldObjects(snapshot) {
    // 空投
    const drops = new Map();
    for (const drop of snapshot.drops || []) {
      drops.set(drop.id, drop);
      let entry = this.drops.get(drop.id);
      if (!entry) {
        const model = createAirdrop();
        model.group.position.set(drop.x || 0, 0, drop.z || 0);
        this.entityGroup.add(model.group);
        entry = { model, group: model.group, y: 30 };
        this.drops.set(drop.id, entry);
      }
      const targetY = drop.opened ? 0 : (drop.landsIn > 0 ? Math.min(26, drop.landsIn * 3.2) : 0);
      entry.y += (targetY - entry.y) * 0.12;
      entry.group.position.set(drop.x || 0, entry.y, drop.z || 0);
      entry.model.parts.chute.visible = entry.y > 1.2 && !drop.opened;
      entry.model.parts.beacon.visible = !drop.opened;
      if (drop.opened) entry.model.parts.ring.visible = false;
    }
    for (const [id, entry] of this.drops) {
      if (!drops.has(id)) { this.entityGroup.remove(entry.group); disposeModel(entry.group); this.drops.delete(id); }
    }
    // 队内标记
    const pings = new Map();
    for (const ping of snapshot.pings || []) {
      if (ping.team != null && ping.team !== this.selfTeam()) continue;
      pings.set(ping.id, ping);
      let entry = this.pings.get(ping.id);
      if (!entry) {
        const model = createPingMarker(ping.kind || 'move');
        model.group.position.set(ping.x || 0, 0, ping.z || 0);
        this.entityGroup.add(model.group);
        entry = { model, group: model.group, ttl: ping.ttl || 6 };
        this.pings.set(ping.id, entry);
      }
      entry.group.position.set(ping.x || 0, 0.1, ping.z || 0);
      entry.model.parts.cone.position.y = 3.2 + Math.sin(this.elapsed * 3.4) * 0.2;
      entry.model.parts.ring.rotation.z = this.elapsed * 1.2;
    }
    for (const [id, entry] of this.pings) {
      if (!pings.has(id)) { this.entityGroup.remove(entry.group); disposeModel(entry.group); this.pings.delete(id); }
    }
    // 手雷 / 烟雾 / 火焰
    for (const grenade of snapshot.grenades || []) {
      if (grenade.y != null && grenade.y > 0 && !grenade.ground) {
        // 空中手雷：抛壳式火花提示（避免为每个手雷建 mesh）
        if (Math.sin(this.elapsed * 22 + (grenade.x || 0)) > 0.86) this.fx.spawn('muzzle', { x: grenade.x, y: grenade.y + 0.2, z: grenade.z, size: 0.16, color: grenade.kind === 'smoke' ? 0xcfd8cf : grenade.kind === 'molotov' ? 0xff8a3c : 0xffd08a });
      }
    }
    for (const smoke of snapshot.smokes || []) this.fx.zone('smoke', smoke);
    for (const fire of snapshot.fires || []) this.fx.zone('fire', fire);
    // 区域移除：把 ttl 收尾，让 fx 自己淡出回收
    const smokeIds = new Set((snapshot.smokes || []).map((s) => String(s.id)));
    const fireIds = new Set((snapshot.fires || []).map((f) => String(f.id)));
    for (const [id, zone] of this.fx.zones) {
      const live = zone.kind === 'smoke' ? smokeIds.has(zone.snapId) : fireIds.has(zone.snapId);
      if (!live && zone.ttl > 0.6) zone.ttl = 0.6;
    }
  }

  updateZone(zone, time) {
    if (!zone) { this.zoneRing.visible = false; this.stormWall.visible = false; return; }
    const radius = Math.max(0.5, zone.radius ?? zone.r ?? 0);
    this.zoneRing.visible = true;
    this.zoneRing.scale.set(radius, radius, 1);
    this.zoneRing.position.set(zone.x || 0, 0.12, zone.z || 0);
    this.zoneRing.material.opacity = zone.closing ? 0.75 + Math.sin(time * 6) * 0.18 : 0.45;
    this.zoneRing.material.color.set(zone.closing ? 0xffa06a : 0x7fe6dc);
    const base = (this.world?.radius || MAP_RADIUS());
    this.stormWall.visible = radius < base - 1;
    if (this.stormWall.visible) {
      this.stormWall.position.set(zone.x || 0, 13, zone.z || 0);
      this.stormWall.scale.set(radius, 1.6, radius);
      this.stormWall.material.opacity = 0.1 + Math.sin(time * 1.6) * 0.03;
    }
    const next = zone.target;
    if (next && Number.isFinite(next.r)) {
      this.pointer.visible = true;
      this.pointer.position.set(next.x || 0, 0.09, next.z || 0);
      this.pointer.scale.setScalar(Math.max(1.2, next.r * 0.08));
      this.pointer.material.opacity = 0.28 + Math.sin(time * 2.2) * 0.08;
    } else this.pointer.visible = false;
  }


  updatePrediction(snapshot) {
    const self = snapshot.players?.find((p) => p.id === this.selfId);
    if (!self) return;
    if (!this.predicted) this.predicted = { x: self.x || 0, z: self.z || 0 };
    const err = Math.hypot((self.x || 0) - this.predicted.x, (self.z || 0) - this.predicted.z);
    if (err > 2.5) { this.predicted.x = self.x || 0; this.predicted.z = self.z || 0; }
    else {
      this.predicted.x += ((self.x || 0) - this.predicted.x) * 0.1;
      this.predicted.z += ((self.z || 0) - this.predicted.z) * 0.1;
    }
  }

  /* ---------------- 事件 → 特效 ---------------- */
  consumeEvents(events, snapshot) {
    const now = snapshot.time || 0;
    for (const event of events) {
      if (!event || event.id <= this.eventId) continue;
      this.eventId = Math.max(this.eventId, event.id);
      const fresh = now - (event.time || now) < 0.6;
      if (!fresh) continue;
      switch (event.type) {
        case 'shot': this.onShot(event, snapshot); break;
        case 'hit': {
          const target = this.players.get(event.target);
          if (target) { target.hitAt = this.elapsed; target.model.hitFlash(0.14); }
          if (event.target === this.selfId) this.shake(0.06);
          this.fx.spawn('blood', { x: event.x ?? target?.group.position.x, z: event.z ?? target?.group.position.z, y: 1.1 });
          break;
        }
        case 'explosion': this.fx.spawn('explosion', { x: event.x, z: event.z, r: event.r || 6 }); this.shake(0.5); break;
        case 'smoke': this.fx.zone('smoke', { id: `ev${event.id}`, x: event.x, z: event.z, r: event.r || 6, ttl: 16 }); break;
        case 'fire': this.fx.zone('fire', { id: `ev${event.id}`, x: event.x, z: event.z, r: event.r || 5, ttl: 9 }); break;
        case 'flash': this.fx.spawn('flash', { x: event.x, z: event.z, r: event.r || 8 }); break;
        case 'throw': this.fx.spawn('pickup', { x: event.x ?? 0, z: event.z ?? 0 }); break;
        case 'down': {
          const model = this.players.get(event.player);
          if (model) model.model.setPose('downed');
          this.fx.spawn('blood', { x: event.x ?? model?.group.position.x, z: event.z ?? model?.group.position.z, y: 0.8 });
          break;
        }
        case 'kill': {
          const model = this.players.get(event.player);
          if (model) { model.group.visible = false; }
          this.fx.spawn('blood', { x: event.x ?? 0, z: event.z ?? 0, y: 1.1 });
          break;
        }
        case 'revive': {
          const model = this.players.get(event.player);
          this.fx.spawn('heal', { x: model?.group.position.x ?? 0, z: model?.group.position.z ?? 0 });
          break;
        }
        case 'heal': {
          const model = this.players.get(event.player);
          this.fx.spawn('heal', { x: model?.group.position.x ?? 0, z: model?.group.position.z ?? 0 });
          break;
        }
        case 'pickup': {
          const model = this.players.get(event.player);
          if (model) this.fx.spawn('pickup', { x: model.group.position.x, z: model.group.position.z });
          break;
        }
        case 'levelup': this.fx.spawn('levelup', { x: this.follow.x, z: this.follow.z }); break;
        case 'wave': this.fx.spawn('wave', { x: this.follow.x, z: this.follow.z }); break;
        case 'boss': this.fx.spawn('boss', { x: event.x, z: event.z }); this.shake(0.6); break;
        case 'airdrop': this.fx.spawn('pickup', { x: event.x || 0, z: event.z || 0 }); break;
        case 'vehicle': if (event.action === 'destroy') this.fx.spawn('explosion', { x: event.x ?? 0, z: event.z ?? 0, r: 7 }); break;
        case 'ping': this.fx.spawn('pickup', { x: event.x || 0, z: event.z || 0 }); break;
        case 'basehit': this.shake(0.35); break;
        default: break;
      }
    }
  }

  onShot(event, snapshot) {
    const shooter = this.players.get(event.player);
    const mzY = 1.32;
    const sx = event.x ?? shooter?.group.position.x ?? 0;
    const sz = event.z ?? shooter?.group.position.z ?? 0;
    const tx = event.tx ?? sx;
    const tz = event.tz ?? sz;
    if (shooter) {
      shooter.model.playRecoil();
      shooter.model.parts.muzzle.visible = true;
      shooter.muzzleUntil = (this.elapsed || 0) + 0.055;
    }
    this.fx.spawn('muzzle', { x: sx, y: mzY, z: sz, dx: tx - sx, dz: tz - sz, color: event.player === this.selfId ? 0xffe2a0 : 0xffc684 });
    const isSelf = event.player === this.selfId;
    this.fx.spawn('tracer', { x: sx, z: sz, tx, tz, y: mzY - 0.1, color: isSelf ? 0xfff0b8 : 0xffc07a });
    if (event.hit) {
      this.fx.spawn('impact', { x: tx, z: tz, y: 0.75 });
    }
    if (isSelf) { this.shake(0.09); this.hitmarker(); }
  }

  /* ---------------- 相机 / 渲染 ---------------- */
  shake(amount = 0.2) { this.shakeAmount = Math.min(1.4, this.shakeAmount + amount); }
  hitmarker() { this.hitmarkerTime = 0.12; }

  camBasis(px, pz, out) {
    const pitch = this.camPitch;
    const dist = this.camDist;
    out.x = px + Math.sin(this.camYaw) * Math.cos(pitch) * dist;
    out.y = Math.sin(pitch) * dist;
    out.z = pz + Math.cos(this.camYaw) * Math.cos(pitch) * dist;
    return out;
  }

  updateCamera(dt, elapsed) {
    const state = this.state;
    if (this.home) {
      this.orbit += dt * 0.055;
      const radius = (this.world?.radius || MAP_RADIUS()) * 1.18;
      const dist = CAMERA.lobbyDistance;
      this.camera.position.set(Math.cos(this.orbit) * dist * 0.72, dist * 0.62, Math.sin(this.orbit) * dist * 0.72);
      this.lookTarget.set(0, 3, 0);
      this.camera.lookAt(this.lookTarget);
      this.camera.fov = 42; this.camera.updateProjectionMatrix();
      this.follow.set(0, 0, 0);
      return;
    }
    let self = state?.players?.find((p) => p.id === this.selfId);
    if (!self || (!self.alive && !self.downed)) {
      self = state?.players?.find((p) => p.alive && p.team === this.selfTeam()) || state?.players?.find((p) => p.alive) || self;
    }
    if (self) {
      const px = self.id === this.selfId && this.predicted ? this.predicted.x : self.x || 0;
      const pz = self.id === this.selfId && this.predicted ? this.predicted.z : self.z || 0;
      const followLerp = clamp(1 - Math.exp(-CAMERA.follow[this.quality] * dt), 0, 1);
      this.follow.x += (px - this.follow.x) * followLerp;
      this.follow.z += (pz - this.follow.z) * followLerp;
      const aim = self.angle || 0;
      const ahead = CAMERA.lookAhead[this.quality];
      const targetX = this.follow.x + Math.sin(aim) * ahead;
      const targetZ = this.follow.z + Math.cos(aim) * ahead;
      this.camYaw += Math.atan2(Math.sin(aim - this.camYaw), Math.cos(aim - this.camYaw)) * clamp(1 - Math.exp(-1.6 * dt), 0, 1);
      this.camBasis(targetX, targetZ, _v);
      if (this.shakeAmount > 0.0005) {
        const s = this.shakeAmount;
        _v.x += (Math.sin(elapsed * 47.3) * 0.5 + Math.sin(elapsed * 91.7) * 0.5) * s * 0.7;
        _v.z += (Math.sin(elapsed * 53.1) * 0.5 + Math.cos(elapsed * 83.3) * 0.5) * s * 0.7;
        _v.y += Math.sin(elapsed * 61.9) * s * 0.35;
        this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeDecay * dt * (0.6 + s));
      }
      this.camera.position.x += (_v.x - this.camera.position.x) * clamp(1 - Math.exp(-22 * dt), 0, 1);
      this.camera.position.y = _v.y;
      this.camera.position.z += (_v.z - this.camera.position.z) * clamp(1 - Math.exp(-22 * dt), 0, 1);
      this.lookTarget.set(targetX, 0.9, targetZ);
      this.camera.lookAt(this.lookTarget);
      const fov = CAMERA.fov + (self.state === 'sprint' ? 1.6 : 0) + (self.car ? 2.4 : 0);
      if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov += (fov - this.camera.fov) * clamp(1 - Math.exp(-6 * dt), 0, 1); this.camera.updateProjectionMatrix(); }
    }
  }

  /** 主渲染：每帧调用（数据 10Hz，内部插值）。 */
  render(dt = 0.016, elapsed = 0) {
    const step = clamp(dt, 0, 0.05);
    this.frameDt = step;
    this.elapsed = elapsed;
    this.updateCamera(step, elapsed);
    const px = this.follow.x, pz = this.follow.z;
    this.fx.setWeatherFocus(px, pz);
    if (!this.home) {
      this.tickPlayers(step, elapsed);
      this.tickCars(step, elapsed);
      this.tickLoot(elapsed);
      this.tickRoofs(step);
    }
    this.fx.update(step);
    this.updateLamps(px, pz, elapsed);
    if (this.hitmarkerTime > 0) this.hitmarkerTime -= step;
    this.renderer.render(this.scene, this.camera);
  }

  tickCars(dt, elapsed) {
    let visible = 0;
    const cx = this.follow.x, cz = this.follow.z;
    for (const entry of this.cars.values()) {
      const car = entry.source;
      if (!car) { entry.group.visible = false; continue; }
      if ((car.hp ?? 1) <= 0 || Math.hypot((car.x || 0) - cx, (car.z || 0) - cz) > this.viewDistance + 14) { entry.group.visible = false; continue; }
      visible++;
      entry.group.visible = true;
      this.updateCar(entry, car, dt);
    }
    this.visibleCars = visible;
  }

  tickLoot(elapsed) {
    if (!this.lootMesh || !this.lootMesh.count) return;
    const count = this.lootMesh.count;
    for (let i = 0; i < count; i++) {
      const item = this.lootItems?.[i];
      if (!item) continue;
      const bob = Math.sin(elapsed * 1.9 + (item.x || 0) * 0.7) * 0.05;
      _e.set(0, elapsed * 0.85 + (item.z || 0) * 0.2, 0); _q.setFromEuler(_e);
      _m.compose(_v.set(item.x || 0, 0.34 + bob + (item.y || 0), item.z || 0), _q, _s.setScalar(item.type === 'weapon' ? 1 : 0.82));
      this.lootMesh.setMatrixAt(i, _m);
      const h = item.rarity === 'legendary' ? 2.6 : item.rarity === 'epic' ? 2.1 : 1.6;
      _m.compose(_v.set(item.x || 0, h * 0.5 + 0.1, item.z || 0), _q.identity(), _s.set(0.16 + Math.sin(elapsed * 2.4 + i) * 0.02, h, 0.16 + Math.sin(elapsed * 2.4 + i) * 0.02));
      this.lootGlow.setMatrixAt(i, _m);
    }
    this.lootMesh.instanceMatrix.needsUpdate = true;
    this.lootGlow.instanceMatrix.needsUpdate = true;
  }

  tickRoofs(dt) {
    if (!this.roofs.length || !this.state) return;
    const candidates = (this.state.players || []).filter((p) => p.id === this.selfId || p.team === this.selfTeamCache);
    const lerp = clamp(1 - Math.exp(-9 * dt), 0, 1);
    const overlay = this.currentWorld?.roofOverlay || [];
    const occupied = new Set();
    for (const roof of this.roofs) {
      const b = roof.building;
      const inside = candidates.some((p) => Math.abs((p.x || 0) - (b.x || 0)) < (b.w || 10) / 2 + 1.4 && Math.abs((p.z || 0) - (b.z || 0)) < (b.d || 9) / 2 + 1.4);
      const target = inside ? 0.06 : 1;
      roof.opacity += (target - roof.opacity) * lerp;
      roof.mesh = null;
      if (inside && overlay.length) {
        // 淡出：隐藏实例，改用独立半透明 mesh 承担
        if (roof.instance) { _m.makeScale(0, 0, 0); roof.instance.mesh.setMatrixAt(roof.instance.index, _m); roof.instance.mesh.instanceMatrix.needsUpdate = true; }
        const slot = overlay.find((o) => !o.building) || overlay[occupied.size % overlay.length];
        if (slot) {
          occupied.add(slot);
          slot.building = b; slot.mesh.visible = true;
          slot.mesh.position.set(b.x || 0, (b.h || 3.4) + 0.22, b.z || 0);
          slot.mesh.scale.set((b.w || 10) + 0.9, 0.42, (b.d || 9) + 0.9);
          slot.mesh.material.color.set(b.roofColor ?? this.theme.roof?.[0] ?? 0xae6855);
          slot.mesh.material.opacity = roof.opacity;
          slot.mesh.material.depthWrite = false;
        }
        roof.instanceFaded = true;
      } else if (roof.instanceFaded) {
        roof.instanceFaded = false;
        if (roof.instance) {
          const item = roof.instance.item;
          _m.compose(_v.set(item.x, item.y, item.z), _q.identity(), _s.set(item.sx, item.sy, item.sz));
          roof.instance.mesh.setMatrixAt(roof.instance.index, _m);
          roof.instance.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    for (const slot of overlay) {
      if (slot.building && !occupied.has(slot)) { slot.building = null; slot.mesh.visible = false; }
    }
  }

  /* ---------------- 输入辅助 ---------------- */
  screenToWorld(screenX, screenY, out = new THREE.Vector3()) {
    const nx = (screenX / Math.max(1, this.width)) * 2 - 1;
    const ny = 1 - (screenY / Math.max(1, this.height)) * 2;
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    if (this.raycaster.ray.intersectPlane(this.groundPlane, out)) return out;
    out.copy(this.camera.position).addScaledVector(this.raycaster.ray.direction, this.camDist);
    out.y = 0;
    return out;
  }

  aimAt(screenX, screenY, self) {
    const hit = this.screenToWorld(screenX, screenY, this.hit);
    this.pointer.visible = true;
    this.pointer.position.set(hit.x, 0.09, hit.z);
    this.pointer.scale.setScalar(0.55 + Math.sin((this.elapsed || 0) * 4) * 0.05);
    if (!self) return 0;
    return Math.atan2(hit.x - (self.x || 0), hit.z - (self.z || 0));
  }

  groundAt(screenX, screenY) {
    const hit = this.screenToWorld(screenX, screenY, this.hit);
    return { x: hit.x, z: hit.z };
  }

  /** 本地输入预测：把输入推进预测位置（服务端纠正时回拉）。 */
  predictInput(input, dt) {
    const self = this.state?.players?.find((p) => p.id === this.selfId);
    if (!self || !input) return this.predicted;
    if (!this.predicted) this.predicted = { x: self.x || 0, z: self.z || 0 };
    if (!self.alive || self.downed) return this.predicted;
    const step = clamp(dt || 0, 0, 0.12);
    const car = this.state?.cars?.find((c) => c.id === self.car);
    const driving = car && car.driver === self.id;
    const speed = self.car ? (driving ? (car.speed || 18) : 0) : self.state === 'crouch' ? 3.4 : (input.sprint || self.state === 'sprint') ? 8.9 : self.healTime > 0 || self.reloadTime > 0 ? 0 : 6.2;
    const mx = Number(input.mx) || 0, mz = Number(input.mz) || 0;
    const len = Math.hypot(mx, mz);
    const nx = len > 1 ? mx / len : mx, nz = len > 1 ? mz / len : mz;
    const dx = nx * speed * step, dz = nz * speed * step;
    this.pendingInputs.push({ seq: input.seq || 0, dx, dz });
    while (this.pendingInputs.length > 32) this.pendingInputs.shift();
    try {
      const moveBody = this.world?.moveBody || legacyExport('moveBody');
      if (typeof moveBody === 'function') moveBody.call(this.world, this.predicted, dx, dz, self.car ? 1.35 : 0.55);
      else { this.predicted.x += dx; this.predicted.z += dz; }
    } catch { this.predicted.x += dx; this.predicted.z += dz; }
    if (this.state.zone) {
      const dist = Math.hypot(this.predicted.x - (this.state.zone.x || 0), this.predicted.z - (this.state.zone.z || 0));
      if (dist > (this.state.zone.radius || 999) + 2) { this.shake(0.03); }
    }
    return this.predicted;
  }

  /* ---------------- 诊断 / 释放 ---------------- */
  getInfo() {
    const info = this.renderer.info;
    return {
      calls: info.render.calls, triangles: info.render.triangles, points: info.render.points,
      geometries: info.memory.geometries, textures: info.memory.textures,
      visiblePlayers: this.visiblePlayers, visibleCars: this.visibleCars,
      quality: this.quality, mapId: this.mapId, home: this.home,
    };
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('orientationchange', this.onResize);
    }
    this.clearEntities();
    for (const cached of this.worlds.values()) this.disposeWorld(cached);
    this.worlds.clear();
    this.fx.dispose?.();
    this.zoneRing.geometry.dispose(); this.zoneRing.material.dispose();
    this.stormWall.geometry.dispose(); this.stormWall.material.dispose();
    this.renderer.dispose();
  }
}

export default GameScene;




