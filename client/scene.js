// 雾岛突围 / MIST ISLE 1.0 — 场景渲染（owner: renderfx）
// 契约 §10.1：constructor(canvas) / setQuality / showHome / setMap / beginMatch / setState / render /
//             aimAt / groundAt / predictInput / shake / hitmarker / dispose
import * as THREE from 'three';
import * as mapModule from '../shared/map.mjs';
import { MAX_LOOT, MAX_CARS, QUALITY } from '../shared/rules.mjs';
import {
  createCharacter, createVehicle, createLootModel, createTree, createProp,
  createAirdrop, createPingMarker, createTextSprite, disposeModel,
  createHealthBar, setHealthBarColor, CHARACTER_LOD_DISTANCE, isSharedGeometry, isSharedMaterial,
  glowMaterial, UNIT_BOX, UNIT_CYL, UNIT_SPHERE, UNIT_CONE, UNIT_CIRCLE, teamColorOf, weaponClassOf,
  createList, bake, bakeMatrix, finishList, DEFAULT_SKIN, landmarkMesh,
} from './models.js';
import { Fx } from './fx.js';
import { themeFor, lightingFor, CAMERA, WEATHER_FX } from './theme.js';

const MAX_VISIBLE_PLAYERS = 30;
// 渲染分层：地面雾单独一层，必须先于主层绘制（见 render() 与 makeGroundFog()）。
// three.js 的 Camera.layers 默认只开 layer 0，所以主层物体保持 0 不用改。
const LAYER_MAIN = 0;
const LAYER_GROUND = 1;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _c = new THREE.Color(), _m = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const TAU = Math.PI * 2;
// —— 每帧/每快照零分配的复用容器（主循环稳态不 new） ——
const _roofCandidates = [];        // tickRoofs：本机+队友列表（每帧复用）
const _occupiedSlots = [];         // tickRoofs：已占用的屋顶 overlay 槽
const _seenIds = new Set();        // updatePlayers：本快照可见实体 id
const _dropsSeen = new Map();      // updateWorldObjects：本快照空投
const _pingsSeen = new Map();      // updateWorldObjects：本快照队内标记
const _smokeIds = new Set();       // updateWorldObjects：存活烟雾
const _fireIds = new Set();        // updateWorldObjects：存活火焰
const _pendingPool = [];           // predictInput：输入预测记录环形池（32 条复用）
for (let i = 0; i < 32; i++) _pendingPool.push({ seq: 0, dx: 0, dz: 0 });
let _pendingCursor = 0;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
/** 平面两点距离。热路径一律用这个：Math.hypot 带溢出保护与参数归一化，
 *  走 C++ 内置无法内联，比 sqrt 慢 2–10×，而我们的坐标范围（±200m）根本不会溢出。 */
const dist2 = (ax, az, bx, bz) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));
const dist2sq = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
/** 树 LOD 重算的位移阈值（米）。树是静态的，只有玩家走远了才需要重新分配实例。 */
const TREE_LOD_STEP = 2;
/** 树 LOD 边界抖动幅度（米）：避免玩家在半径上来回走时树反复进出、每次全量重传。 */
const TREE_LOD_HYSTERESIS = 1.2;
// 静态世界回收用：复用容器，避免 disposeWorld 每次分配
const _disposeMeshes = new Set(), _disposeMats = new Set();
// 树低模几何跨地图缓存（this._treeLowCache），dispose 世界时不能跟着释放
const _treeLowGeoSet = new WeakSet();
const makeWorldImpl = (...args) => (typeof mapModule.makeWorld === 'function' ? mapModule.makeWorld(...args) : null);
const MAP_RADIUS = () => mapModule.WORLD_RADIUS || 180;
const legacyExport = (name) => Reflect.get(mapModule, name) ?? null;
const RARITY_RGB = {
  common: [0.79, 0.82, 0.8], uncommon: [0.49, 0.83, 0.65], rare: [0.44, 0.72, 0.94],
  epic: [0.77, 0.55, 0.94], legendary: [0.96, 0.71, 0.27],
};
function rarityRgbCompat(rarity) { return RARITY_RGB[rarity] || RARITY_RGB.common; }
/** 不同物资类型的地面高度（武器平放、弹药/护甲略高）。 */
function typeLift(entry) { return entry === undefined ? 0.3 : 0.32; }

let _vcm = null;
/**
 * 静态世界专用：单材质顶点色（所有静态几何共享，1 个 program）。
 *
 * ⚠ 不要开 flatShading。
 * flatShading 在着色器里用 `dFdx(vViewPosition) × dFdy(vViewPosition)` 求面法线。
 * 我们大量使用**极扁的盒子**（屋顶 sy=0.42 / 宽 10+，比例 1:24；路面 sy=0.14 / 宽 9 / 长 6）。
 * 在这种退化比例下 dFdx 的差值落入浮点噪声量级，归一化后方向随机抖动，
 * 于是在屋顶/路面上出现**白色锯齿条纹**（同一块面上一半亮一半暗）。
 * 这个现象在桌面 ANGLE/D3D11 和安卓 WebView 上都会复现。
 *
 * 改用平滑着色 + geometry.computeVertexNormals()（bake 时已经写入了正确的
 * 变换后法线），法线是烘焙期算好的稳定值，不依赖屏幕空间导数。
 * 视觉上盒子仍是硬边（因为每个面的顶点法线本来就垂直于该面），
 * 但矮胖/扁平的面不会再抖。
 */
function vertexColorMaterial() {
  if (!_vcm) _vcm = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false });
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
    this.moon = null;              // 白夜港月光方向光（按需创建）
    this.waterRings = [];          // 水面波纹环
    this.landmarkSigns = [];       // 地标文字牌（按距离显隐）
    this.beaconMeshes = [];        // 地标光点（呼吸动画）
    this.shakeDecay = 2.6;
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
    if (this.lootGlow) this.lootGlow.visible = true;
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
    // 雾：青岚/赤砂用线性雾（远景雾），白夜用 FogExp2（浓密夜色）+ 地面雾层
    if (L.fogMode === 'exp2') {
      if (!(this.scene.fog instanceof THREE.FogExp2)) this.scene.fog = new THREE.FogExp2(L.fogColor, L.fogDensity || 0.004);
      this.scene.fog.color.set(L.fogColor);
      this.scene.fog.density = L.fogDensity || 0.004;
    } else {
      if (!(this.scene.fog instanceof THREE.Fog)) this.scene.fog = new THREE.Fog(L.fogColor, L.fogNear, L.fogFar);
      this.scene.fog.color.set(L.fogColor);
      this.scene.fog.near = L.fogNear; this.scene.fog.far = L.fogFar;
    }
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
    // 月光方向光（白夜港）：冷色、高角度、不投影
    if (L.keyLight) {
      if (!this.moon) {
        this.moon = new THREE.DirectionalLight(L.keyLight.color, L.keyLight.intensity);
        this.scene.add(this.moon);
      }
      this.moon.visible = true;
      this.moon.color.set(L.keyLight.color);
      this.moon.intensity = L.keyLight.intensity;
      this.moon.position.set(L.keyLight.position[0], L.keyLight.position[1], L.keyLight.position[2]);
    } else if (this.moon) this.moon.visible = false;
    this.lamp.visible = false;
    // 地面雾层：切换配色/浓度
    for (const world of this.worlds.values()) {
      const fogLayer = world.groundFog;
      if (fogLayer) {
        fogLayer.material.color.set(L.groundMist.color);
        fogLayer.material.opacity = L.groundMist.opacity;
        fogLayer.position.y = Math.max(0.6, L.groundMist.height || 2.2);
      }
    }
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

  /**
   * 动态元素：
   *  - 旗帜顶点动画（正弦波沿旗面展开，只写 position.y/z，不重建几何）
   *  - 水面波纹环（缩放 + 淡出，材质共享）
   *  - 树 LOD（距离 > 80m 换成低模；因为视距 96m，远处树仍可见但更省）
   *  - 区域/地标文字牌按距离显隐（Sprite 是逐 draw call，必须剔除）
   */
  tickDynamics(dt, elapsed) {
    const cx = this.follow.x, cz = this.follow.z;
    const world = this.currentWorld;
    if (!world) return;
    // 1) 旗帜
    const flagGroup = world.flags;
    const cloth = flagGroup?.userData?.cloth;
    if (cloth && cloth.visible) {
      const data = cloth.userData;
      const attr = cloth.geometry.attributes.position;
      const basePos = data.basePos;
      const t = elapsed * 2.6;
      const amp = 0.34 * (data.strength ?? 1);
      for (let f = 0; f < data.count; f++) {
        const start = f * (data.cols + 1) * (data.rows + 1);
        for (let r = 0; r <= data.rows; r++) {
          for (let c = 0; c <= data.cols; c++) {
            const i = start + r * (data.cols + 1) + c;
            const u = c / data.cols;
            const wave = Math.sin(t - u * 4.2 + f * 1.7) * amp * u;
            attr.array[i * 3 + 2] = basePos[i * 3 + 2] + wave;
            attr.array[i * 3 + 1] = basePos[i * 3 + 1] + Math.cos(t * 0.7 - u * 3.1) * 0.06 * u;
          }
        }
      }
      attr.needsUpdate = true;
    }
    // 2) 水面波纹
    if (this.waterRings?.length) {
      for (const ring of this.waterRings) {
        const d = ring.userData;
        d.t = (d.t + dt * 0.32) % 1;
        const s = d.r * (0.18 + d.t * 0.95);
        ring.scale.set(s, s, 1);
        // 共享材质时不能用 per-mesh opacity，只能整体淡入淡出
      }
      const mat = this.waterRings[0].material;
      mat.opacity = 0.14 + Math.sin(elapsed * 1.4) * 0.05;
    }
    // 3) 树 LOD：按视距在两级 InstancedMesh 间分配实例
    //
    // ⚠ 树是**静态**的（位置永远不变），只有「哪些树进 LOD0/LOD1、哪些被视距剔除」
    // 会随玩家移动而变。旧实现每帧对全部 960 棵树跑 heightAt + compose + toArray，
    // 再让 6 个 InstancedMesh 各自全量 bufferSubData（实测 p50 14 次/帧、291 KB/帧）。
    // 现在只在玩家移动超过 TREE_LOD_STEP 或视距变化时重算，其余帧完全不碰。
    if (world.treeLod?.length && this.viewDistance) {
      const vd = this.viewDistance;
      // 状态按世界实例（= 地图）分开存：world.treeLod 每张图是不同的一组 InstancedMesh，
      // 用一份全局状态在切图后会认为「已经算过」而漏掉首帧分配（树直接不显示）。
      let state = this._treeLod;
      if (!state || state.world !== world || state.viewDistance !== vd) {
        state = this._treeLod = { world, x: NaN, z: NaN, viewDistance: vd, phase: 0 };
      }
      if (this.home) {
        // 主菜单是环绕空镜：相机绕岛转，follow 恒为 0，但树也要按视距铺满。
        // 直接以原点为中心、每帧都重算（开销只有一次，且主菜单不在性能预算内）。
        if (!state.homeInit) { state.homeInit = true; this.updateTreeLod(world, 0, 0, vd, state); }
      } else {
        const dx = cx - state.x, dz = cz - state.z;
        if (!(dx * dx + dz * dz <= TREE_LOD_STEP * TREE_LOD_STEP)) {
          state.x = cx; state.z = cz;
          this.updateTreeLod(world, cx, cz, vd, state);
        }
      }
    }
    // 4) 文字牌剔除（区域 60m / 地标 90m）
    for (const sign of world.regionSigns || []) {
      sign.visible = dist2sq(sign.userData.x, sign.userData.z, cx, cz) < 62 * 62;
    }
    for (const sign of this.landmarkSigns || []) {
      const r = sign.userData.hero ? 96 : 74;
      sign.visible = dist2sq(sign.userData.x, sign.userData.z, cx, cz) < r * r;
    }
    // 5) 地标光点呼吸
    this.tickBeacons(elapsed);
  }

  /**
   * 树 LOD 重算（只在玩家移动 > TREE_LOD_STEP 或视距变化时调用）。
   * 输出与旧版逐帧版本逐字节一致：每棵树按「距玩家距离」决定进 LOD0 / LOD1 / 剔除。
   */
  updateTreeLod(world, cx, cz, viewDistance, state = null) {
    // 滞回：重算时若玩家在上一轮边界附近，把阈值向外推一点，下一次重算就更难落在
    // 同一批树上。state.phase 只在重算之间累积，不会每帧抖动。
    const phase = state ? (state.phase = (state.phase || 0) + 0.37) : 0;
    const cut = Math.min(80, viewDistance * 0.86) + (phase % 2 > 1 ? TREE_LOD_HYSTERESIS : -TREE_LOD_HYSTERESIS);
    const cut2 = cut * cut;
    const visibleR2 = (viewDistance + 8) * (viewDistance + 8);
    for (const entry of world.treeLod) {
      const { mesh, items, lod } = entry;
      let n = 0;
      const attr = mesh.instanceMatrix.array;
      for (let i = 0; i < items.length; i++) {
        const tree = items[i];
        const dx = tree.x - cx, dz = tree.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > visibleR2) continue;
        if ((d2 > cut2 ? 1 : 0) !== lod) continue;
        _e.set(0, ((tree.x || 0) * 7.1 + (tree.z || 0) * 3.3) % 6.28, 0); _q.setFromEuler(_e);
        _s.setScalar(tree.scale || 1);
        _m.compose(_v.set(tree.x, world.heightAt ? world.heightAt(tree.x, tree.z) : 0, tree.z), _q, _s);
        _m.toArray(attr, n * 16);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** 地标光点呼吸（合并到 tickDynamics 里的独立分支，避免每帧遍历整棵树）。 */
  tickBeacons(elapsed) {
    const list = this.beaconMeshes;
    if (!list?.length) return;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const d = m.userData;
      const s = d.base * (1 + Math.sin(elapsed * 2.1 + d.phase) * 0.22);
      m.scale.setScalar(s);
    }
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
    if (this.lootMeshes) this.buildLootMeshes();
    this.home = false;
    return this.world;
  }

  /**
   * 地形网格：128×128 段 PlaneGeometry 按 world.heightAt 位移顶点。
   * 只在 buildStaticWorld 时计算一次（BufferGeometry 一次成形 + computeVertexNormals），
   * 运行时零更新。低于 0 的地形（矿坑）用暗色顶点色，高于 3m 的山脊提亮，
   * 让「高低差」在俯视角也能读出来。
   */
  makeTerrainMesh(theme, radius, world) {
    const SEG = 128;
    const size = radius * 2.16;
    const geometry = new THREE.PlaneGeometry(size, size, SEG, SEG);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position;
    const count = pos.count;
    const colors = new Float32Array(count * 3);
    const heightAtFn = typeof world?.heightAt === 'function' ? world.heightAt : null;
    const grass = _c.set(theme.ground.grass).clone();
    const grassAlt = _c.set(theme.ground.grassAlt).clone();
    const rock = _c.set(theme.ground.rock ?? 0x8d968a).clone();
    const dirt = _c.set(theme.def?.theme?.dirt ?? 0x9c8a63).clone();
    const sand = _c.set(theme.ground.sandRing).clone();
    const waterCol = new THREE.Color(theme.water.color);
    let hMin = 0, hMax = 0;
    for (let i = 0; i < count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const dist = Math.sqrt(x * x + z * z) / radius;
      // 圆盘裁剪：岛外顶点压到海底（由海面环带盖住），避免出现方形地面
      if (dist > 1.0) {
        pos.setY(i, -18);
        colors[i * 3] = waterCol.r; colors[i * 3 + 1] = waterCol.g; colors[i * 3 + 2] = waterCol.b;
        continue;
      }
      const h = heightAtFn ? heightAtFn(x, z) : 0;
      // 岸线附近平滑降到海底，避免出现垂直断崖
      const shoreT = clamp((dist - 0.955) / 0.045, 0, 1);
      pos.setY(i, h * (1 - shoreT) + (-18) * shoreT);
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
      // 顶点色：高度 + 坡度 + 到中心的距离（海/沙）决定混合
      const noise = Math.sin(x * 0.073 + 1.7) * Math.cos(z * 0.061 - 0.4) * 0.5 + 0.5;
      // 坡度：用相邻顶点的实际高差（与 shared/map.mjs 的 slopeAt 近似一致）
      const dSample = Math.max(2.2, size / SEG);
      const hx = (heightAtFn ? heightAtFn(x + dSample, z) - heightAtFn(x - dSample, z) : 0) / (2 * dSample);
      const hz = (heightAtFn ? heightAtFn(x, z + dSample) - heightAtFn(x, z - dSample) : 0) / (2 * dSample);
      const slopeHint = clamp(Math.sqrt(hx * hx + hz * hz) * 2.6, 0, 1.2);
      let r, g, b;
      if (dist > 0.975) { r = sand.r * 255; g = sand.g * 255; b = sand.b * 255; }
      else {
        const t = clamp((noise - 0.35) * 2.2, 0, 1);
        // 陡坡 → 岩石色；深坑 → 暗色（AO 感），让高低差在俯视角一眼可见
        const steepness = clamp(slopeHint * 0.95, 0, 1);
        const deep = clamp(-h / Math.max(3, (world.terrain?.min ? -world.terrain.min : 6)), 0, 1);
        const lift = clamp(h / Math.max(3, (world.terrain?.max || 6)), 0, 1);
        const baseR = grass.r + (grassAlt.r - grass.r) * t;
        const baseG = grass.g + (grassAlt.g - grass.g) * t;
        const baseB = grass.b + (grassAlt.b - grass.b) * t;
        // 深度：压暗 + 偏褐；高度：提亮 + 偏冷（山脊受光）
        r = baseR * (1 - deep * 0.55) * (1 - steepness * 0.45) + rock.r * steepness * 0.62 + dirt.r * deep * 0.42 + lift * 0.06;
        g = baseG * (1 - deep * 0.55) * (1 - steepness * 0.45) + rock.g * steepness * 0.62 + dirt.g * deep * 0.42 + lift * 0.06;
        b = baseB * (1 - deep * 0.55) * (1 - steepness * 0.45) + rock.b * steepness * 0.62 + dirt.b * deep * 0.42 + lift * 0.07;
      }
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    // 湿润度 → 粗糙度（青岚水洼反光、赤砂哑光）
    const wet = theme.wetness ?? 0.2;
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: clamp((theme.ground.roughness ?? 0.86) - wet * 0.42, 0.22, 1),
      metalness: 0.02 + wet * 0.05,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = false;
    mesh.renderOrder = 0;
    mesh.userData = { kind: 'terrain', segments: SEG, hMin, hMax };
    return mesh;
  }

  /** 兜底地面（世界构建失败或没有 world 时也可渲染）。 */
  makeGroundBase(theme, radius, world = null) {
    const group = new THREE.Group();
      if (world) {
      // 有真实地形时：用位移平面替代 40×40 的方块拼贴
      const terrain = this.makeTerrainMesh(theme, radius, world);
      group.add(terrain);
      // 海：环形圆盘（内圈透出地形，外圈铺满到视距外）
      const sea = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(theme.water.color, 0.98, false));
      sea.rotation.x = -Math.PI / 2;
      sea.position.y = Math.max(-1.2, (terrain.userData.hMin || 0) - 0.6);
      sea.scale.setScalar(radius * 3.6); group.add(sea);
      // 浅滩渐变环（沙色 → 海色），避免硬边
      const shallow = new THREE.Mesh(new THREE.RingGeometry(radius * 0.985, radius * 1.06, 96),
        glowMaterial(theme.ground.sandRing, 0.85, false));
      shallow.rotation.x = -Math.PI / 2; shallow.position.y = 0.02; group.add(shallow);
      const foam = new THREE.Mesh(new THREE.RingGeometry(radius * 1.0, radius * 1.035, 96),
        glowMaterial(theme.water.foam ?? 0xd7ece6, 0.35, false));
      foam.rotation.x = -Math.PI / 2; foam.position.y = 0.04; group.add(foam);
      return { group, terrain, sea, shallow, shore: null };
    }
    const list = createList();
    const seed = 20261018;
    const cells = 40;
    const unit = (radius * 2.1) / cells;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const x = (i / (cells - 1) - 0.5) * radius * 2.1, z = (j / (cells - 1) - 0.5) * radius * 2.1;
        const dist = Math.sqrt(x * x + z * z) / radius;
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
    const base = this.makeGroundBase(theme, radius, world);
    group.add(base.group);
    const staticGroup = new THREE.Group(); group.add(staticGroup);
    const palette = theme.def?.theme || {};
    const heightAt = typeof world.heightAt === 'function' ? world.heightAt : () => 0;
    // 水面：UV 偏移做波纹（单材质共享，2 个 draw call 内）
    const waterMeshes = [];
    for (const water of world.waters || []) {
      const isIce = water.kind === 'ice' || water.slippery;
      const color = isIce ? 0xd9e6e4 : water.kind === 'oasis' ? 0x6f9e93 : theme.water.color;
      const mat = glowMaterial(color, isIce ? 0.98 : 0.94, false);
      const disc = new THREE.Mesh(UNIT_CIRCLE, mat);
      const cx = water.x || 0, cz = water.z || 0;
      const r = Math.max(3, water.r || Math.max(water.w || 8, water.d || 8) * 0.5);
      disc.rotation.x = -Math.PI / 2;
      // 水面高度：取中心与四向采样里的最低点（湖/湾是洼地，取中心会浮在地形上方）
      let lowest = heightAt(cx, cz);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        const h = heightAt(cx + Math.cos(a) * r * 0.75, cz + Math.sin(a) * r * 0.75);
        if (h < lowest) lowest = h;
      }
      disc.position.set(cx, lowest + 0.06, cz);
      disc.scale.setScalar(r);
      disc.userData.baseY = disc.position.y;
      staticGroup.add(disc);
      waterMeshes.push({ mesh: disc, water, isIce, mat });
    }
    // 波纹环（青岚/白夜）：每片水 2 个环，随时间缩放淡出（顶点少，1 draw call 共享材质）
    if (theme.motion.water > 0.2) {
      const ringMat = glowMaterial(theme.water.foam ?? 0xd7ece6, 0.22);
      this.waterRings = [];
      for (const { water } of waterMeshes) {
        for (let i = 0; i < 2; i++) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 24), ringMat);
          ring.rotation.x = -Math.PI / 2;
          const r = Math.max(2, water.r || 6);
          ring.position.set((water.x || 0) + (i - 0.5) * r * 0.5, heightAt(water.x || 0, water.z || 0) + 0.02, (water.z || 0) + (i - 0.5) * r * 0.5);
          ring.userData = { t: i * 0.5, r };
          staticGroup.add(ring);
          this.waterRings.push(ring);
        }
      }
    }
    // 道路：沿长度分段，逐段贴合地形（单块 300m 长条在坡地上会浮空/穿地）
    if (world.roads?.length) {
      const list = createList();
      const SEG_LEN = 6;
      for (const road of world.roads) {
        const color = road.kind === 'dirt' ? (palette.dirt ?? 0x9c8a63) : palette.road ?? 0x77847b;
        const len = road.d || 60;
        const segs = Math.max(1, Math.ceil(len / SEG_LEN));
        const segLen = len / segs;
        const ux = Math.sin(road.rot || 0), uz = Math.cos(road.rot || 0);
        const asphalt = road.kind === 'asphalt';
        for (let i = 0; i < segs; i++) {
          const t = (i + 0.5) / segs - 0.5;
          const dx = (road.x || 0) + ux * t * len;
          const dz = (road.z || 0) + uz * t * len;
          const dy = heightAt(dx, dz);
          // 路面：薄板，比段长略长一点消除接缝
          bake(list, UNIT_BOX, color, dx, dy + 0.06, dz, road.w || 8, 0.14, segLen + 0.5, 0, road.rot || 0, 0);
          // 中线虚线：横向细条（沿路宽方向 0.22m），沿长度方向只占 55%。
          // sx 是「路宽方向」的厚度，sz 才是「沿路方向」的长度——两个轴搞反时，
          // rot≈0 的路段看着正常，但 rot=π/2 的路段旋转后视觉上会变成一条贯穿
          // 整段的白条（就是之前那块"白色锯齿板"的成因）。
          if (asphalt && i % 2 === 0) {
            bake(list, UNIT_BOX, 0xd8d3ae, dx, dy + 0.14, dz, 0.22, 0.03, segLen * 0.55, 0, road.rot || 0, 0);
          }
        }
        // 路肩：主路两侧各一条窄亮边，强化「这条路能走」的读图性
        if (asphalt && (road.w || 8) >= 8) {
          const off = (road.w || 8) * 0.5 + 0.35;
          const nx = Math.cos(road.rot || 0);
          const nz = -Math.sin(road.rot || 0);
          for (const side of [-1, 1]) {
            const sx = (road.x || 0) + nx * off * side;
            const sz = (road.z || 0) + nz * off * side;
            bake(list, UNIT_BOX, 0x9aa89c, sx, heightAt(sx, sz) + 0.04, sz, 0.7, 0.1, len, 0, road.rot || 0, 0);
          }
        }
      }
      staticGroup.add(new THREE.Mesh(finishList(list), vertexColorMaterial()));
    }
    // 地面细节：草丛/石子/沙纹（单 draw call，纯装饰，跟随地形高度）
    if (theme.ground.detail > 0) {
      const detail = createList();
      let seed = 1234567;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const count = this.quality === 'low' ? 150 : this.quality === 'high' ? 420 : 280;
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (radius - 14);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const col = rnd() > 0.55 ? theme.ground.grassAlt : theme.ground.grass;
        bake(detail, UNIT_BOX, col, x, heightAt(x, z) + 0.05, z, 1.4 + rnd() * 2.2, 0.05, 1.4 + rnd() * 2.2, 0, rnd() * 3, 0);
      }
      staticGroup.add(new THREE.Mesh(finishList(detail), vertexColorMaterial()));
    }
    // 接触阴影：树/建筑/岩石底部的深色贴地圆盘（1 个 InstancedMesh，让物体"落地"）
    const blobs = [];
    for (const tree of world.trees || []) blobs.push({ x: tree.x, z: tree.z, sx: 1.55 * (tree.scale || 1), sz: 1.55 * (tree.scale || 1) });
    for (const b of world.buildings || []) blobs.push({ x: b.x, z: b.z, sx: (b.w || 10) * 0.66, sz: (b.d || 9) * 0.66 });
    for (const o of world.obstacles || []) if (o.kind === 'rock') blobs.push({ x: o.x, z: o.z, sx: (o.w || 2) * 0.58, sz: (o.d || 2) * 0.58 });
    if (blobs.length) {
      const bloomShadow = new THREE.MeshBasicMaterial({ color: 0x16241f, transparent: true, opacity: 0.22, depthWrite: false });
      const shadow = new THREE.InstancedMesh(UNIT_CIRCLE, bloomShadow, blobs.length);
      blobs.forEach((b, i) => {
        _e.set(-Math.PI / 2, 0, 0); _q.setFromEuler(_e);
        _m.compose(_v.set(b.x, heightAt(b.x, b.z) + 0.07, b.z), _q, _s.set(b.sx, b.sz, 1));
        shadow.setMatrixAt(i, _m);
      });
      shadow.instanceMatrix.needsUpdate = true; shadow.computeBoundingSphere();
      shadow.renderOrder = 1; staticGroup.add(shadow);
    }
    // 建筑：楼层地板 + 墙体（与碰撞体一致）+ 屋顶实例（近处独立 mesh 可淡出）
    const wallList = createList();
    const floorList = createList();
    const glowList = createList();   // 夜间自发光窗（baiye）：单独一批，用 emissive 材质
    const roofBuckets = new Map();
    const windowGlow = (theme.motion?.windowGlow ?? 0) > 0.01;
    for (const building of world.buildings || []) {
      const bx = building.x || 0, bz = building.z || 0;
      const w = building.w || 10, d = building.d || 9, h = building.h || 3.4;
      // 建筑落在压平的地形上：取中心高度（flat 掩码保证整块近似同一高度）
      const by = heightAt(bx, bz);
      building.baseY = by;
      const floorColor = building.floorColor ?? palette.wall?.[0] ?? 0xd1c6ac;
      bake(floorList, UNIT_BOX, floorColor, bx, by + 0.07, bz, w + 0.6, 0.14, d + 0.6);
      // 楼层分隔线（urban 多层楼在俯视角能看出层数）
      if ((building.floors || 1) > 1) {
        const per = h / building.floors;
        for (let f = 1; f < building.floors; f++) {
          bake(floorList, UNIT_BOX, 0x8f8a7c, bx, by + per * f, bz, w + 0.9, 0.16, d + 0.9);
        }
      }
      const roofColor = building.roofColor ?? palette.roof?.[0] ?? 0xae6855;
      if (!roofBuckets.has(roofColor)) roofBuckets.set(roofColor, []);
      // 屋顶必须完全浮在「墙体 + 白色压顶」之上，否则两层面片共面会产生白色锯齿
      // z-fighting（近距离看是条纹，远距离是一整块亮白）。
      //
      // 关键：墙体的 y 用的是**各自墙段位置**的 heightAt，而屋顶用的是**建筑中心**
      // 的 heightAt。地形有起伏时两者能差 0.41m（实测青岚岛最大值），
      // 于是某些墙顶会从屋顶底面穿出来 —— 这就是"怎么调屋顶高度都还有条纹"的原因。
      // 0.78 = 0.42(屋顶厚) + 0.14(压顶厚) + 0.14(余量) + 0.08(安全垫)，
      // 大于三张图实测的最大地形偏差 0.41m。改用这个值后屋顶底面
      // = by + h + 0.57，比任何墙顶都高至少 0.16m。
      const roofY = by + h + 0.78;
      roofBuckets.get(roofColor).push({ building, x: bx, y: roofY, z: bz, sx: w + 0.9, sy: 0.42, sz: d + 0.9 });
      roofs.push({ building, opacity: 1, mesh: null, instance: null });
      // 夜间窗户自发光：每栋楼 3–5 扇，按楼体尺寸分布（单批次，1 draw call）
      if (windowGlow) {
        const n = 3 + Math.abs((bx * 7 + bz * 13) | 0) % 3;
        for (let k = 0; k < n; k++) {
          const fu = (((k * 0.37 + bx * 0.11) % 1) + 1) % 1;
          const fv = (((k * 0.61 + bz * 0.17) % 1) + 1) % 1;
          const side = (Math.round(fu * 4) + k) % 4;
          const wy = by + Math.min(h - 1.0, 1.6 + ((h - 2) * (0.3 + fv * 0.5)));
          const lit = ((k + (bx | 0) + (bz | 0)) % 5) !== 0;   // 20% 熄灯，避免太规整
          const col = lit ? (k % 3 === 0 ? 0xffd79a : 0xffc078) : 0x2a3540;
          if (side === 0) bake(glowList, UNIT_BOX, col, bx, wy, bz - d * 0.5 - 0.06, 1.0, 1.0, 0.1);
          else if (side === 1) bake(glowList, UNIT_BOX, col, bx + w * 0.5 + 0.06, wy, bz, 0.1, 1.0, 1.0);
          else if (side === 2) bake(glowList, UNIT_BOX, col, bx, wy, bz + d * 0.5 + 0.06, 1.0, 1.0, 0.1);
          else bake(glowList, UNIT_BOX, col, bx - w * 0.5 - 0.06, wy, bz, 0.1, 1.0, 1.0);
        }
      }
    }
    // 墙体：直接复用碰撞障碍（kind wall/container 等）保证视觉=物理
    //
    // ⚠ 世界生成会产生大量「位置几乎重合、但高度/厚度不同」的墙段（门框、窗台、
    // 建筑外墙与装饰墙叠在一起）。逐面烘焙会在同一空间里堆出 N 层共面盒子，
    // 深度缓冲在 30–60m 距离下分不清谁在前 → 出现白色锯齿条纹（z-fighting）。
    // 这里做一层渲染侧去重：同一格（0.5m 网格）+ 同一朝向的墙只画「最高最大的那一面」，
    // 物理碰撞完全不变（blocked/moveBody 仍用原始 obstacles 数组）。
    const wallBuckets = new Map();
    const propBuckets = new Map();
    for (const obstacle of world.obstacles || []) {
      const kind = obstacle.kind || 'wall';
      if (kind === 'tree') continue;
      if (kind !== 'wall') {
        if (!propBuckets.has(kind)) propBuckets.set(kind, []);
        propBuckets.get(kind).push(obstacle);
        continue;
      }
      // 用「中心点 + 主轴尺寸」做键：重叠墙会被折叠进同一个桶
      const gx = Math.round((obstacle.x || 0) * 2) / 2;
      const gz = Math.round((obstacle.z || 0) * 2) / 2;
      const key = `${gx}|${gz}`;
      const prev = wallBuckets.get(key);
      const area = (obstacle.w || 1) * (obstacle.d || 1);
      if (!prev || area > prev.area) {
        wallBuckets.set(key, { obstacle, area });
      }
    }
    for (const { obstacle } of wallBuckets.values()) {
      const oy = heightAt(obstacle.x || 0, obstacle.z || 0);
      const h = Math.max(1.2, obstacle.h || 2.4);
      const color = pickWallColor(palette, obstacle);
      bake(wallList, UNIT_BOX, color, obstacle.x || 0, oy + h * 0.5, obstacle.z || 0, obstacle.w || 1, h, obstacle.d || 1, 0, obstacle.rot || 0, 0);
      // 墙顶压顶：**先关掉**排查白条纹来源（见 docs 里的排查记录）
      if (false && h > 2.2) {
        bake(wallList, UNIT_BOX, 0xc9c0a8, obstacle.x || 0, oy + h + 0.05, obstacle.z || 0,
          (obstacle.w || 1) * 0.96, 0.08, (obstacle.d || 1) * 0.96, 0, obstacle.rot || 0, 0);
      }
    }
    for (const prop of world.props || []) {
      const kind = prop.kind || 'crate';
      if (!propBuckets.has(kind)) propBuckets.set(kind, []);
      propBuckets.get(kind).push(prop);
    }
    staticGroup.add(new THREE.Mesh(finishList(floorList), vertexColorMaterial()));
    staticGroup.add(new THREE.Mesh(finishList(wallList), vertexColorMaterial()));
    // 夜间窗户自发光（emissive 材质，无光照也亮）
    if (glowList.pos.length) {
      const glowMat = new THREE.MeshLambertMaterial({
        vertexColors: true, emissive: 0xffb95e, emissiveIntensity: 0.85,
        transparent: true, opacity: 0.94, depthWrite: false,
      });
      const windowMesh = new THREE.Mesh(finishList(glowList), glowMat);
      windowMesh.renderOrder = 2;
      windowMesh.userData = { kind: 'windowGlow' };
      staticGroup.add(windowMesh);
      this.windowGlowMesh = windowMesh;
    }
    // 屋顶：用 bake() 直接烘焙进顶点缓冲，**不用 InstancedMesh**。
    //
    // 之前用 InstancedMesh + UNIT_BOX + 非等比实例缩放（sy=0.42 vs sx≈10）。
    // three.js 对实例化网格的法线只做 mat3(instanceMatrix) * normal，**不做逆转置**，
    // 所以非等比缩放下法线方向是错的；再叠加 flatShading 的 dFdx 求导，
    // 屋顶表面就出现沿长边方向的白色锯齿条纹（怎么调高度/压顶都消不掉）。
    // bake() 在 CPU 端用 getNormalMatrix（= 逆转置）变换法线，是对的。
    // 代价：每个建筑多一点点顶点（无关紧要），但彻底消除条纹，且少一个 program。
    // 屋顶：按颜色分组，每组一个「以原点为中心的单位盒」几何 + InstancedMesh。
    //
    // 关键约束（踩过两次坑，务必保留注释）：
    // 1) **不能**用非等比实例缩放（sx≈10 / sy=0.42）。three.js 对实例化网格的法线
    //    只做 mat3(instanceMatrix)·n、不做逆转置，非等比缩放下法线方向是错的，
    //    叠加上 Lambert 光照会在屋顶上产生白色锯齿条纹。
    //    → 尺寸必须在 CPU 端 bake 进顶点（bake() 用 getNormalMatrix，法线正确）。
    // 2) 但又要保留「逐栋楼单独淡出」的能力（玩家走进建筑时屋顶让开）。
    //    → 实例矩阵**只做平移**（缩放恒为 1，法线不受影响），顶点里已经烘好了尺寸；
    //      淡出时把该实例矩阵缩到 0（此时缩放为 0，三角形退化不可见，法线无所谓）。
    // 3) 历史 bug：改成合并 Mesh 后 tickRoofs 仍在调 InstancedMesh.setMatrixAt（Mesh 上
    //    没有这个方法），每次进楼都抛 TypeError 被 frame 的 try/catch 吞掉，
    //    导致该帧 updatePrediction / processEvents / HUD 全部中断。
    //    → 现在重新用 InstancedMesh，但实例矩阵只做平移，两个问题同时满足。
    const roofMeshes = [];
    for (const [color, items] of roofBuckets) {
      if (!items.length) continue;
      // 该颜色组的「单位屋顶」几何：把每栋楼的尺寸烘进顶点，位置归零
      const list = createList();
      for (const item of items) {
        bake(list, UNIT_BOX, color, 0, 0, 0, item.sx, item.sy, item.sz);
      }
      const geo = finishList(list);
      const mesh = new THREE.InstancedMesh(geo, vertexColorMaterial(), items.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      items.forEach((item, i) => {
        _m.makeTranslation(item.x, item.y, item.z);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData = { kind: 'roof', items };
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
    // 树（3 种树型 × 2 级 LOD，各 1 个 InstancedMesh）
    // LOD：距离相机 80m 内用高模，之外用低模（< 视距 96m，所以远处树仍然存在但更省）
    const treeGroups = [[], [], []];
    for (const tree of world.trees || []) treeGroups[clamp(tree.kind | 0, 0, 2)].push(tree);
    const treeLod = [];
    for (let kind = 0; kind < 3; kind++) {
      const list = treeGroups[kind];
      if (!list.length) continue;
      const template = createTree({ x: 0, z: 0, scale: 1, kind }, palette);
      const highGeo = template.parts.mesh.geometry;
      // 低模：把三种树型统一烘焙成单个锥体+树干（省 60% 三角形）
      const lowGeo = this.treeLowGeometry(palette, kind);
      for (const [lodIndex, geo] of [[0, highGeo], [1, lowGeo]]) {
        const mesh = new THREE.InstancedMesh(geo, vertexColorMaterial(), list.length);
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.userData = { kind: 'tree', lod: lodIndex, items: list };
        staticGroup.add(mesh);
        treeLod.push({ mesh, items: list, lod: lodIndex, kind });
      }
      disposeModelSoft(template.group);
    }
    // 其余障碍/道具：按道具种类各自烘焙成一份「已应用缩放」的合并几何。
    //
    // 历史实现用 InstancedMesh + 非等比实例缩放（干草堆 w≈8 × d≈1.4 × h≈0.9，
    // 长宽比接近 1:6）。three.js 对实例化网格的法线只做 mat3(instanceMatrix)*n，
    // **不做逆转置**，非等比缩放下法线方向就是错的；Lambert 光照把它照成灰白色，
    // 平屋顶上于是出现沿长边方向的白色锯齿条纹（和屋顶那条注释是同一个坑）。
    // 运行时实测：把这类批次隐藏，灰白像素从 2996 降到 280。
    //
    // 改法：逐实例 bake() 进顶点缓冲。bake() 内部用 getNormalMatrix（= 逆转置）
    // 变换法线，非等比缩放下结果正确；顶点色与材质跟静态批次共用同一份。
    // 每个 kind 仍然只有 1 个 draw call，顶点量代价可忽略（道具总共 < 400 个）；
    // 碰撞体积完全不变（world.obstacles 是独立数组）。
    //
    // ⚠ 顺序必须与 Object3D.matrix（= T · R · S）一致：先缩放、再绕 Y 旋转、最后平移。
    // 若把 rot 传给 bake 的第 11 个参数（rx），旋转会发生在缩放之后（R · S），
    // 长条干草堆会绕世界轴翻倒而不是原地转向。这里手工按 T·R·S 组装矩阵：
    // 先把实例矩阵算好，再以「单位矩阵 + 该矩阵」调用 bake —— 等价于
    // bake 的 TRS 组合顺序，且法线仍走逆转置。
    const propMeshes = [];
    for (const [kind, items] of propBuckets) {
      if (!items.length) continue;
      const template = createProp({ kind }, palette);
      const base = template.parts.mesh.geometry;   // 顶点色几何（模板本身已按单位尺寸烘焙）
      const yAxis = _v.set(0, 1, 0);
      const list = createList();
      for (const item of items) {
        const x = item.x || 0, z = item.z || 0;
        // T · R_y · S：与旧 InstancedMesh 的 compose(position, quatFromEulerY, scale) 完全一致
        _q.setFromAxisAngle(yAxis, item.rot || 0);
        _m.compose(_v2.set(x, heightAt(x, z), z), _q, _s.set(item.w || 1.4, item.h || 1.2, item.d || 1.4));
        bakeMatrix(list, base, null, _m);   // null = 保留模板自带的顶点色
      }
      const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
      mesh.userData = { kind: 'prop', propKind: kind, items };
      staticGroup.add(mesh);
      propMeshes.push(mesh);
      disposeModelSoft(template.group);
    }
    // 区域招牌 + 地标
    // 区域招牌只在 60m 内显示（Sprite 逐个 draw call，远处必须剔除）
    const regionSigns = [];
    for (const region of world.regions || []) {
      const sign = createTextSprite(region.name || '', '#f4f2dc', 40, { plate: 'rgba(20,32,34,.5)' });
      sign.scale.set(9, 2.2, 1);
      const sy = heightAt(region.x || 0, region.z || 0) + 7.4;
      sign.position.set(region.x || 0, sy, (region.z || 0) - 8);
      sign.visible = false;
      sign.userData = { kind: 'regionSign', x: region.x || 0, z: region.z || 0, baseY: sy };
      staticGroup.add(sign); regionSigns.push(sign);
    }
    const landmarks = this.buildLandmarks(world, theme, heightAt);
    staticGroup.add(landmarks);
    // 边界提示环
    const border = new THREE.Mesh(new THREE.RingGeometry(radius * 0.985, radius, 96), new THREE.MeshBasicMaterial({ color: palette.accent ?? 0xefb657, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }));
    border.rotation.x = -Math.PI / 2; border.position.y = 0.16; staticGroup.add(border);
    // 旗帜（顶点动画）：每个区域中心杆顶一面旗，单 geometry 合批
    const flags = this.makeFlags(world, heightAt);
    if (flags) staticGroup.add(flags);
    // 地面雾层（低空半透明平面，营造「雾贴地」的层次）
    const groundFog = this.makeGroundFog(radius);
    if (groundFog) group.add(groundFog);
    return { group, world, roofs, roofOverlay, base, mapId: id, radius, treeLod, regionSigns, landmarks, flags, groundFog };
  }

  /** 低模树几何（远景 LOD）：每像素更少的三角形，颜色仍取自主题。 */
  treeLowGeometry(palette, kind) {
    const key = `treelow:${kind}:${palette.tree?.[0] ?? 0}`;
    if (!this._treeLowCache) this._treeLowCache = new Map();
    let geo = this._treeLowCache.get(key);
    if (geo) return geo;
    const list = createList();
    const treePal = palette.tree || [0x285e53, 0x3a7560, 0x548469];
    const green = treePal[kind % treePal.length];
    bake(list, UNIT_CYL, 0x5c4a35, 0, 0.9, 0, 0.18, 1.8, 0.18);
    if (kind === 2) {
      bake(list, UNIT_CYL, green, 0, 1.6, 0, 0.95, 1.0, 0.95);
    } else {
      bake(list, UNIT_CONE, green, 0, 2.6, 0, 1.5, 3.6, 1.5, 0, 0.4, 0);
    }
    geo = finishList(list);
    _treeLowGeoSet.add(geo);
    this._treeLowCache.set(key, geo);
    return geo;
  }

  /**
   * 地标：主地标用 models.createLandmark（每种形态一个合并几何，1 draw call），
   * 其余装饰性 landmark（风车/采石场/龙门吊）走旧的轻量形状。
   * 每个地标都带文字牌（只在 90m 内显示）。
   */
  buildLandmarks(world, theme, heightAt = () => 0) {
    const group = new THREE.Group();
    const accent = theme.def?.theme?.accent ?? theme.landmarkAccent ?? 0xefb657;
    this.landmarkSigns = [];
    this.beaconMeshes = [];
    for (const lm of world.landmarks || []) {
      // 下沉型地标（矿坑）的几何以「地表」为原点向下生长，
      // 所以放在地表高度而不是 heightAt(中心)（那是坑底，会把整个模型埋进地里）
      const sinks = lm.kind === 'open_pit';
      const ly = sinks ? (world.heightAt ? world.heightAt(lm.x + (lm.radius || 10) * 1.1, lm.z) : 0) : heightAt(lm.x, lm.z);
      if (lm.hero) {
        const mesh = landmarkMesh(lm.kind, { ...theme, accent });
        mesh.position.set(lm.x, ly, lm.z);
        mesh.rotation.y = lm.rot || 0;
        mesh.userData.landmark = lm;
        group.add(mesh);
        // 地标光点（远处可辨识：夜里尤其明显）
        for (const part of mesh.userData.glowParts || []) {
          const beacon = new THREE.Mesh(UNIT_SPHERE, glowMaterial(part.color, 0.92));
          beacon.scale.setScalar(Math.max(0.5, (part.r || 0.6) * 1.4));
          beacon.position.set(lm.x + (part.x || 0), ly + (part.y || 0), lm.z + (part.z || 0));
          beacon.userData = { kind: 'landmarkBeacon', base: beacon.scale.x, phase: (lm.x * 0.3 + lm.z * 0.7) % 6.28 };
          group.add(beacon);
          this.beaconMeshes.push(beacon);
        }
      } else {
        const list = createList();
        if (lm.kind === 'radio_tower' || lm.kind === 'mine_head' || lm.kind === 'crane') {
          bake(list, UNIT_CYL, 0x6f7873, 0, 6, 0, 1.1, 12, 1.1);
          for (let i = 0; i < 4; i++) bake(list, UNIT_BOX, 0x59625d, 0, 2 + i * 2.6, 0, 3.2 - i * 0.5, 0.18, 3.2 - i * 0.5, 0, i * 0.4, 0);
          bake(list, UNIT_SPHERE, accent, 0, 12.4, 0, 0.5, 0.5, 0.5);
          const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
          mesh.position.set(lm.x, ly, lm.z); group.add(mesh);
          const beacon = new THREE.Mesh(UNIT_SPHERE, glowMaterial(accent, 0.9));
          beacon.scale.setScalar(0.9); beacon.position.set(lm.x, ly + 12.6, lm.z); group.add(beacon);
        } else if (lm.kind === 'wreck') {
          bake(list, UNIT_BOX, 0x5d6663, 0, 3, 0, 8, 4, 22, 0.07, 0.2, 0.04);
          bake(list, UNIT_BOX, 0x49514f, 0, 5.6, 4, 6, 3, 8, 0.07, 0.2, 0.04);
          const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
          mesh.position.set(lm.x, ly, lm.z); group.add(mesh);
        } else if (lm.kind === 'beacon' || lm.kind === 'objective') {
          const pole = new THREE.Mesh(UNIT_CYL, glowMaterial(accent, 0.28));
          pole.scale.set(0.16, 10, 0.16); pole.position.set(lm.x, ly + 5, lm.z); group.add(pole);
        } else if (lm.kind === 'windmill') {
          bake(list, UNIT_CYL, 0xd8d0b8, 0, 4, 0, 1.0, 8, 1.0);
          bake(list, UNIT_CONE, 0x8a5b3f, 0, 8.6, 0, 1.7, 1.8, 1.7);
          for (let i = 0; i < 4; i++) bake(list, UNIT_BOX, 0xe6ddc2, Math.cos(i * 1.57) * 2.2, 6.4, Math.sin(i * 1.57) * 2.2, 0.24, 4.4, 0.24, 0, i * 1.57, 0);
          const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
          mesh.position.set(lm.x, ly, lm.z); group.add(mesh);
        } else if (lm.kind === 'quarry') {
          for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2;
            bake(list, UNIT_SPHERE, 0x8d968a, Math.cos(a) * (5 + i * 2.4), 1.2, Math.sin(a) * (5 + i * 2.4), 2.4, 1.6, 2.4);
          }
          const mesh = new THREE.Mesh(finishList(list), vertexColorMaterial());
          mesh.position.set(lm.x, ly, lm.z); group.add(mesh);
        }
      }
      // 文字牌：90m 内才显示（Sprite 是逐 draw call，必须控制）
      const label = createTextSprite(lm.name || lm.label || '', lm.hero ? '#ffe9b8' : '#e8e4cc', 36, { plate: 'rgba(18,28,30,.62)' });
      const labelY = ly + (lm.kind === 'lighthouse' ? 38 : lm.kind === 'signal_tower' ? 44 : lm.hero ? Math.max(14, (lm.radius || 12) * 0.9) : 14);
      label.scale.set(lm.hero ? 10 : 8, lm.hero ? 2.5 : 2, 1);
      label.position.set(lm.x, labelY, lm.z);
      label.visible = false;
      label.userData = { kind: 'landmarkSign', x: lm.x, z: lm.z, hero: !!lm.hero };
      group.add(label);
      this.landmarkSigns.push(label);
    }
    return group;
  }

  /** 旗帜：区域中心旗杆 + 单 geometry 顶点动画（不新建 per-frame 对象）。 */
  makeFlags(world, heightAt) {
    const strength = this.theme?.motion?.flags ?? 0;
    if (strength <= 0.01) return null;
    const regions = (world.regions || []).slice(0, 10);
    if (!regions.length) return null;
    const accent = this.theme?.accent ?? 0xefb657;
    // 每面旗：4×5 网格的旗面（可顶点动画），烘焙进一个几何
    const COLS = 4, ROWS = 5, FW = 3.6, FH = 2.2;
    const pos = [], col = [], nor = [], idx = [];
    const base = new THREE.Color(accent);
    const dark = base.clone().multiplyScalar(0.78);
    for (const region of regions) {
      const gy = heightAt(region.x || 0, region.z || 0);
      const ox = region.x || 0, oz = (region.z || 0) + 6;
      const start = pos.length / 3;
      for (let r = 0; r <= ROWS; r++) {
        for (let c = 0; c <= COLS; c++) {
          const u = c / COLS, v = r / ROWS;
          pos.push(ox + u * FW, gy + 6.0 + v * FH, oz + Math.sin(u * 6) * 0.06);
          nor.push(0, 0, 1);
          const mix = u;
          col.push(base.r * (1 - mix * 0.2) + dark.r * mix * 0.2, base.g * (1 - mix * 0.2) + dark.g * mix * 0.2, base.b * (1 - mix * 0.2) + dark.b * mix * 0.2);
        }
      }
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const a = start + r * (COLS + 1) + c;
          const b = a + 1, d = a + (COLS + 1), e = d + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geometry.setIndex(idx);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }));
    mesh.userData = { kind: 'flags', cols: COLS, rows: ROWS, count: regions.length, basePos: Float32Array.from(pos), strength };
    mesh.frustumCulled = false;
    // 旗杆
    const poleList = createList();
    for (const region of regions) {
      const gy = heightAt(region.x || 0, region.z || 0);
      bake(poleList, UNIT_CYL, 0x6d6a5c, region.x || 0, gy + 4.4, (region.z || 0) + 6, 0.09, 8.8, 0.09);
      bake(poleList, UNIT_SPHERE, accent, region.x || 0, gy + 8.9, (region.z || 0) + 6, 0.16, 0.16, 0.16);
    }
    const poles = new THREE.Mesh(finishList(poleList), vertexColorMaterial());
    poles.userData = { kind: 'flagPoles' };
    const group = new THREE.Group();
    group.add(mesh); group.add(poles);
    group.userData = { kind: 'flagGroup', cloth: mesh };
    return group;
  }

  /** 地面雾：半径覆盖全图的半透明平面（配合 FogExp2 形成两层雾）。
   *  用径向渐变的 CanvasTexture，避免出现「方形雾片」的硬边。 */
  makeGroundFog(radius) {
    const mist = this.lighting?.groundMist || this.theme?.groundMist;
    if (!mist || mist.opacity <= 0.01) return null;
    // 径向渐变纹理（一次生成，缓存到 Fx 场景 userData）
    let tex = this.scene.userData.__mistGroundFogTex;
    if (!tex) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.86, 'rgba(255,255,255,0.14)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.userData.__mistGroundFogTex = tex;
    }
    const geo = new THREE.PlaneGeometry(radius * 2.0, radius * 2.0);
    const mat = new THREE.MeshBasicMaterial({
      color: mist.color, map: tex, transparent: true, opacity: mist.opacity,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.NormalBlending,
      // 参与场景雾，远近自然融合（否则雾片在远处会明显「贴」在画面上）
      fog: true,
    });
    // 雾层必须**只压在地面上**。它是半径 180m 的水平大平面（y≈0.6–1.0），
    // 而建筑墙体/屋顶从 y=0 一直长到 6–40m —— 大平面会被它们横穿。
    //
    // 旧实现只有 depthWrite:false + renderOrder:3。关掉「写深度」不等于关掉
    // 「读深度」：雾片的每个片元仍要和已绘制的墙体做深度比较。俯视角下雾面很大，
    // 靠近屏幕下缘的部分深度值比墙顶还小，于是通过深度测试，半透明灰白雾色
    // 叠在屋顶/墙面上，形成一条条白色斜条纹（径向渐变纹理把它切成了细线）。
    //
    // 只把 depthTest 关掉是错的：那样雾会盖住玩家、树、载具等所有东西。
    // 正确做法是让雾**只在地面层内混合**：把它单独放到 LAYER_GROUND（渲染时
    // 先画地面层、再画主层），既不写深度也不受深度测试影响，而主层物体在雾之后
    // 绘制、按各自深度正常覆盖它。见 render() 里的两趟绘制。
    mat.depthTest = false;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    // 贴地：放在海平面略上方；太高会在海岸外露出悬空矩形
    mesh.position.y = Math.min(1.6, Math.max(0.35, (mist.height || 2.2) * 0.45));
    mesh.layers.set(LAYER_GROUND);   // 只在「地面层」这一趟绘制
    mesh.userData = { kind: 'groundFog' };
    return mesh;
  }

  /**
   * 释放一个已构建的世界：几何 + 材质「双清」。
   *
   * 旧实现只 dispose geometry，材质一路漏：每栋楼一个 MeshLambertMaterial（屋顶 overlay 池
   * 22 个、夜间窗 1 个、地面雾/雨/水各 1 个……），三张图切来切去会累积 22×3 个。
   * 材质不释放的另一层代价是 WebGLProgram 缓存不会回收：program 有引用计数，
   * 只要还有一个材质持有它，切图后旧 program 就一直占着。
   *
   * ⚠ 必须跳过共享资源：
   *   - vertexColorMaterial() 是模块级单例，所有静态批次共用，释放后新世界会拿它继续用；
   *   - models.js 缓存的几何/材质（屋顶单位盒之外的地标、血条几何、共享 Lambert 等）
   *     由 SHARED_GEO / SHARED_MAT 标记，用 models.js 导出的判定函数排除。
   *   - 地形几何是每个世界独有的（128×128 位移网格），要释放。
   */
  disposeWorld(cached) {
    if (!cached) return;
    this.scene.remove(cached.group);
    _disposeMeshes.clear(); _disposeMats.clear();
    const sharedMat = _vcm;
    cached.group.traverse((node) => {
      if (node.geometry && !isSharedGeometry(node.geometry) && !_treeLowGeoSet.has(node.geometry)) _disposeMeshes.add(node.geometry);
      const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      for (const m of mats) {
        if (!m || m === sharedMat || isSharedMaterial(m)) continue;
        _disposeMats.add(m);
      }
      if (node.isInstancedMesh) node.dispose?.();
      // Sprite 的贴图是 models.js 缓存出来的共享 CanvasTexture：不在这里释放，
      // 否则下一张图的同名区域牌会拿到一张已被 dispose 的纹理（黑块）。
    });
    for (const g of _disposeMeshes) g.dispose();
    for (const m of _disposeMats) m.dispose();
    _disposeMeshes.clear(); _disposeMats.clear();
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
    // 主菜单不显示物资批次；clearEntities 已连几何一起回收，这里只剩空引用。
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
      roof.overlaySlot = null;
      if (roof.instanceFaded && roof.instance) {
        // 恢复：实例矩阵只做平移（尺寸已烘焙进顶点，缩放必须保持 1，否则法线会被错缩放）
        const item = roof.instance.item;
        _m.makeTranslation(item.x, item.y, item.z);
        roof.instance.mesh.setMatrixAt(roof.instance.index, _m);
        roof.instance.mesh.instanceMatrix.needsUpdate = true;
        roof.instanceFaded = false;
      }
    }
    if (this.currentWorld?.roofOverlay) for (const slot of this.currentWorld.roofOverlay) { slot.building = null; slot.mesh.visible = false; }
    this.fx.clear();
    // 物资批次连几何一起回收：clearEntities 在回主菜单/换图/开新局时都会走，
    // 只把 count 置 0 会把 6 份模板几何永远留在显存里（旧代码就是这么漏的）。
    this.disposeLootMeshes();
    // 树 LOD 缓存失效：下次 tickDynamics 必须无条件重算（否则新一局在原点附近
    // 起步、位移 < 2m，旧的 x/z 判定会认为"没动过"，树全空一帧）。
    if (this._treeLod) this._treeLod.x = NaN;
    this.eventId = 0;
    this.pendingInputs.length = 0;
    this.predicted = null;
    this.hideFlightPath();
  }

  /* ---------------- 空降：航线与运输机 ---------------- */
  /**
   * 航线是一条贴地（y≈0.5m）的发光长带 + 两端箭头；飞机是低模机体。
   * 两者都只在 deploying 阶段可见，落地后整组隐藏（几何保留，跨对局复用）。
   */
  ensureFlightRig() {
    if (this.flightRig) return this.flightRig;
    const group = new THREE.Group();
    group.visible = false;
    // 航线：单位盒沿 +Z 拉长，用 scale 适配两端点
    const pathGeo = new THREE.BoxGeometry(1, 0.06, 1);
    const pathMat = new THREE.MeshBasicMaterial({
      // 空降时相机拉到 2.6× 距离（≈140m 高），0.24 的透明度在浅色地形上几乎看不见；
      // 提到 0.5 并加深青蓝，保证「航线」在俯视角下是一条明确可见的线。
      color: 0x2f7fc4, transparent: true, opacity: 0.5, depthWrite: false,
      depthTest: false,   // 不被建筑/树遮住：航线是战术信息，不是场景装饰
    });
    const path = new THREE.Mesh(pathGeo, pathMat);
    path.renderOrder = 12;
    // 飞机：机身 + 双翼 + 尾翼，全部用共享 UNIT_BOX 缩放，零新几何
    const plane = new THREE.Group();
    const body = new THREE.Mesh(UNIT_BOX, new THREE.MeshLambertMaterial({ color: 0xd9e4ea }));
    body.scale.set(2.2, 1.1, 9);
    const wing = new THREE.Mesh(UNIT_BOX, body.material);
    wing.scale.set(15, 0.35, 2.2);
    const tail = new THREE.Mesh(UNIT_BOX, body.material);
    tail.scale.set(5.5, 0.3, 1.2);
    tail.position.z = -4;
    const fin = new THREE.Mesh(UNIT_BOX, body.material);
    fin.scale.set(0.35, 1.8, 1.6);
    fin.position.set(0, 1, -4);
    plane.add(body, wing, tail, fin);
    // 俯视角下抬太高会离开视野（相机离地 40–100m）。7m 足够产生「在头顶飞过」
    // 的投影错觉，又不会把机体推出画面。
    plane.position.y = 7;
    plane.visible = false;
    group.add(path, plane);
    this.entityGroup.add(group);
    this.flightRig = { group, path, plane, pathMat };
    return this.flightRig;
  }

  updateFlight(flight) {
    const rig = this.ensureFlightRig();
    if (!flight) { rig.group.visible = false; return; }
    rig.group.visible = true;
    rig.plane.visible = true;
    rig.path.visible = true;
    // 航线带：中心取两端中点，长度取两点距离，旋转对齐
    const dx = flight.toX - flight.fromX;
    const dz = flight.toZ - flight.fromZ;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    rig.path.position.set((flight.fromX + flight.toX) / 2, 1.2, (flight.fromZ + flight.toZ) / 2);
    rig.path.scale.set(5.5, 1, len);
    rig.path.rotation.y = Math.atan2(dx, dz);
    // 舱门开启时加亮：航线不只是「从哪飞过」，而是「现在可以跳」的提示
    rig.pathMat.opacity = flight.open ? 0.62 : 0.34;
    // 飞机：沿航线位置 + 朝向
    rig.plane.position.x = flight.x;
    rig.plane.position.z = flight.z;
    rig.plane.rotation.y = Math.atan2(flight.ux, flight.uz);
    // 轻微横滚，避免看起来像贴图
    rig.plane.rotation.z = Math.sin(this.elapsed * 0.7) * 0.06;
  }

  hideFlightPath() {
    if (!this.flightRig) return;
    this.flightRig.group.visible = false;
    this.flightRig.plane.visible = false;
    this.flightRig.path.visible = false;
  }

  /**
   * 落点预览圈：舱内把「当前朝向会落在哪」画在地面上。
   *
   * 没有它的时候，「空中选点」是纯盲操作 —— 玩家只知道自己在转向，
   * 不知道转过去会落在河道里还是屋顶上。一个贴地圆圈 + 一圈脉冲光晕
   * 就够表达落点，且只占 1 个 draw call（共享 UNIT_CIRCLE）。
   */
  ensureDropTarget() {
    if (this.dropTargetRig) return this.dropTargetRig;
    const group = new THREE.Group();
    group.visible = false;
    const ring = new THREE.Mesh(
      UNIT_CIRCLE,
      new THREE.MeshBasicMaterial({
        // 落点圈必须比地面材质「亮一档」才看得见：实测 0.55 不透明度在浅绿草地
        // 上几乎与背景融为一体，玩家会以为没有落点提示。
        color: 0x6fe0c8, transparent: true, opacity: 0.85, depthWrite: false,
        depthTest: false, side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(4.6);
    ring.position.y = 0.08;
    ring.renderOrder = 11;
    const core = new THREE.Mesh(
      UNIT_CIRCLE,
      new THREE.MeshBasicMaterial({
        color: 0xeafffb, transparent: true, opacity: 0.5, depthWrite: false,
        depthTest: false, side: THREE.DoubleSide,
      }),
    );
    core.rotation.x = -Math.PI / 2;
    core.scale.setScalar(1.5);
    core.position.y = 0.09;
    core.renderOrder = 12;
    group.add(ring, core);
    this.entityGroup.add(group);
    this.dropTargetRig = { group, ring, core, ringMat: ring.material };
    return this.dropTargetRig;
  }

  /** 更新落点预览：me 在海里/空中时把圈画在 dropTarget 上，落地后隐藏。 */
  updateDropTarget(me) {
    const stage = me && me.deployStage;
    const flying = stage && stage !== 'ground';
    if (!flying) { this.hideDropTarget(); return; }
    const rig = this.ensureDropTarget();
    // 服务端在快照里给出 dropPreviewX/Z（舱内是当前朝向的预投点，伞降时是真实落点）。
    const x = Number(me.dropPreviewX);
    const z = Number(me.dropPreviewZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) { this.hideDropTarget(); return; }
    rig.group.visible = true;
    rig.group.position.set(x, 0, z);
    // 脉冲：舱内抖快一点提示「可以选」，伞降时慢下来
    const pulse = 1 + Math.sin(this.elapsed * (stage === 'plane' ? 4.2 : 2.1)) * 0.1;
    rig.ring.scale.setScalar(4.6 * pulse);
    rig.ringMat.opacity = stage === 'plane' ? 0.85 : 0.6;
  }

  hideDropTarget() {
    if (this.dropTargetRig) this.dropTargetRig.group.visible = false;
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

  /**
   * 物资模型：6 类各一个 InstancedMesh。
   *
   * ⚠ 模板几何**整个 GameScene 生命周期内只建一次**，跨对局复用。
   * 旧实现每次开局都 createLootModel() 新建 6 份合并几何 + 1 个光柱几何，
   * 而 disposeLootMeshes 只调 InstancedMesh.dispose()（它只释放 instanceMatrix /
   * instanceColor 这两个实例缓冲），geometry 永不释放 —— 每次进出对局 +7，
   * geometries 32→39→45→51 单调上涨。手游反复进出对局会无上限增长。
   *
   * 现在模板几何缓存在 this._lootGeoTemplates（按 type），只在 dispose()（页面销毁）
   * 时释放。buildLootMeshes 可以被反复调用（新开一局），几何始终是同一份。
   * lootGlow 用的是共享的 UNIT_CYL，**绝不能**释放。
   */
  buildLootMeshes() {
    this.disposeLootMeshes();
    const TYPES = ['weapon', 'ammo', 'armor', 'consumable', 'throwable', 'attachment'];
    if (!this._lootGeoTemplates) this._lootGeoTemplates = new Map();
    this.lootMeshes = new Map();
    for (const type of TYPES) {
      let geo = this._lootGeoTemplates.get(type);
      if (!geo) {
        const template = createLootModel(type, type === 'weapon' ? 'rifle' : '', 'common');
        geo = template.parts.mesh.geometry;
        disposeModelSoft(template.group);
        this._lootGeoTemplates.set(type, geo);
      }
      const mesh = new THREE.InstancedMesh(geo, vertexColorMaterial(), MAX_LOOT);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LOOT * 3), 3);
      mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 2;
      this.entityGroup.add(mesh);
      this.lootMeshes.set(type, { mesh, items: [] });
    }
    this.lootGlow = new THREE.InstancedMesh(UNIT_CYL, glowMaterial(0xffffff, 0.28), MAX_LOOT);
    this.lootGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lootGlow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LOOT * 3), 3);
    this.lootGlow.count = 0; this.lootGlow.frustumCulled = false;
    this.entityGroup.add(this.lootGlow);
    this.lootItems = [];
  }

  /** 只摘掉 InstancedMesh 并释放实例缓冲；**保留**模板几何缓存供下一局复用。 */
  disposeLootMeshes() {
    if (this.lootMeshes) { for (const { mesh } of this.lootMeshes.values()) { this.entityGroup.remove(mesh); mesh.dispose(); } this.lootMeshes = null; }
    if (this.lootMesh) { this.entityGroup.remove(this.lootMesh); this.lootMesh.dispose(); this.lootMesh = null; }
    if (this.lootGlow) { this.entityGroup.remove(this.lootGlow); this.lootGlow.dispose(); this.lootGlow = null; }
  }

  /** 连同模板几何一起释放（只给 dispose() 用；实例化批次已由 disposeLootMeshes 收掉）。 */
  disposeLootTemplates() {
    this.disposeLootMeshes();
    if (!this._lootGeoTemplates) return;
    for (const geo of this._lootGeoTemplates.values()) {
      if (geo && !isSharedGeometry(geo)) geo.dispose();
    }
    this._lootGeoTemplates.clear();
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

  /** 血条：models.createHealthBar 的 1 draw call 版本（3 mesh → 1 mesh）。 */
  makeHealthBar() { return createHealthBar(); }

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
    const speed = dist2(tx, tz, entry.last.x, entry.last.z) / Math.max(0.0001, dt);
    entry.last.x = tx; entry.last.z = tz;
    const moving = speed > 1.2;
    const state = player.state || (player.downed ? 'downed' : (player.chute || 0) > 0.02 ? 'sprint' : moving && speed > 6.4 ? 'sprint' : 'normal');
    model.setPose(player.downed ? 'downed' : state === 'crouch' ? 'crouch' : state === 'sprint' ? 'sprint' : 'normal');
    if (model.weapon !== weaponClassOf(player.weapon || 'rifle')) model.setWeapon(player.weapon || 'rifle');
    model.update(dt, { speed, lookYaw: dy });
    const air = player.y != null && player.y > 0.1 ? player.y : 0;
    const chuting = (player.chute || 0) > 0.02 || air > 0.4;
    model.parts.chute.visible = !player.car && chuting && !player.downed;
    // 模型的「空中高度」是表现值，不是快照里的真实米数：150m 抬升在俯视角下
    // 会把角色推出画面（相机离地约 40–100m）。压到 3.2m 以内，靠降落伞与影子
    // 表达「在空中」，真实高度交给 HUD 状态条显示。
    const lift = air > 0.1 ? Math.min(3.2, 0.6 + air * 0.018) : 0;
    entry.group.position.y = player.car && !player.downed ? 0 : lift;
    entry.group.visible = !!player.alive && !player.car;
    if (model.parts.shadow) model.parts.shadow.visible = !chuting && !player.car;
    // 血条：受伤后短暂显示 / 队友常显。宽度走 shader uniform，不碰顶点、不改材质。
    if (entry.bar) {
      const hurt = elapsed - entry.hitAt < 3;
      const show = !!player.alive && (hurt || player.team === this.selfTeam());
      entry.bar.visible = show && !player.car;
      if (show) {
        entry.bar.userData.setHealth(clamp((player.hp || 0) / 100, 0, 1));
        entry.bar.userData.setArmor(clamp((player.armor || 0) / 100, 0, 1));
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
    const speed = dist2(t.x, t.z, entry.last.x, entry.last.z) / Math.max(0.0001, dt);
    entry.last.x = t.x; entry.last.z = t.z;
    const dy = Math.atan2(Math.sin(t.angle - entry.group.rotation.y), Math.cos(t.angle - entry.group.rotation.y));
    entry.group.rotation.y += dy * clamp(1 - Math.exp(-12 * dt), 0, 1);
    entry.model.update(dt, speed, dy * 2, dy * 0.08);
    entry.group.visible = (car.hp ?? 1) > 0;
    if (entry.bar && car.hp != null) {
      const ratio = clamp(car.hp / Math.max(1, car.maxHp || 100), 0, 1);
      entry.bar.visible = ratio < 0.999;
      entry.bar.userData.setHealth(ratio);
      entry.bar.userData.setArmor(0);
      // 车血条只有一档色（旧逻辑：>0.5 黄、否则红），按阈值换一次即可
      const want = ratio > 0.5 ? 0xf0c85a : 0xf06a54;
      if (entry.barColor !== want) { entry.barColor = want; setHealthBarColor(entry.bar, want); }
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
    this.updateFlight(snapshot.flight || null);
    this.updateDropTarget(snapshot.me || null);
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
    if (!this.lootMeshes) this.buildLootMeshes();
    const max = Math.min(loot.length, MAX_LOOT, this.lootCap || MAX_LOOT);
    // 快照数组每次都是新建的：不超额时直接持引用，省一次 slice 拷贝
    this.lootItems = loot.length > max ? loot.slice(0, max) : loot;
    for (const entry of this.lootMeshes.values()) { entry.items.length = 0; entry.mesh.count = 0; }
    for (let i = 0; i < max; i++) {
      const item = this.lootItems[i];
      const type = item.type === 'backpack' ? 'attachment' : (this.lootMeshes.has(item.type) ? item.type : 'ammo');
      const entry = this.lootMeshes.get(type);
      entry.items.push(item);
    }
    let glowCount = 0;
    for (const entry of this.lootMeshes.values()) {
      const { mesh, items } = entry;
      mesh.count = items.length;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        _m.compose(_v.set(item.x || 0, typeLift(entry), item.z || 0), _q.identity(), _s.setScalar(1));
        mesh.setMatrixAt(i, _m);
        const [r, g, b] = rarityRgbCompat(item.rarity);
        mesh.setColorAt(i, _c.setRGB(r, g, b));
        if (glowCount < MAX_LOOT) {
          const h = item.rarity === 'legendary' ? 2.4 : item.rarity === 'epic' ? 1.9 : item.rarity === 'rare' ? 1.5 : 1.15;
          _m.compose(_v.set(item.x || 0, h * 0.5, item.z || 0), _q.identity(), _s.set(0.14, h, 0.14));
          this.lootGlow.setMatrixAt(glowCount, _m);
          this.lootGlow.setColorAt(glowCount, _c.setRGB(r, g, b));
          glowCount++;
        }
      }
      // 只上传本类型实际条目（见 tickLoot 的注释：640 槽 → 40,960 B 全量是浪费）
      if (items.length > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceMatrix.addUpdateRange(0, items.length * 16);
        if (mesh.instanceColor) {
          mesh.instanceColor.needsUpdate = true;
          mesh.instanceColor.addUpdateRange(0, items.length * 3);
        }
      }
    }
    this.lootGlow.count = glowCount;
    if (glowCount > 0) {
      this.lootGlow.instanceMatrix.needsUpdate = true;
      this.lootGlow.instanceMatrix.addUpdateRange(0, glowCount * 16);
      if (this.lootGlow.instanceColor) {
        this.lootGlow.instanceColor.needsUpdate = true;
        this.lootGlow.instanceColor.addUpdateRange(0, glowCount * 3);
      }
    }
  }

  updatePlayers(snapshot) {
    // 复用模块级 Set，避免每快照（10Hz）新建
    const seen = _seenIds;
    seen.clear();
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

  /**
   * 每帧插值 + 视距剔除（数据 10Hz，这里补到 60FPS）。
   *
   * LOD：距离 > CHARACTER_LOD_DISTANCE 的玩家只画 models.js 里早就合并好的
   * `geo.low`（1 个 draw call 全身），隐藏 7 个分件 + 枪 + 枪口。
   * 实测每个可见玩家的网格数从 18 降到约 6（低模 + 阴影 + 血条 + 名字牌），
   * 30 人同屏时 draw call 从 472 降到 200 内。
   * 自己永远走 LOD0（要有肢体动画与枪口火光）。
   */
  tickPlayers(dt, elapsed) {
    let visible = 0;
    const cx = this.follow.x, cz = this.follow.z;
    const maxDist = this.viewDistance;
    const lodFar2 = CHARACTER_LOD_DISTANCE * CHARACTER_LOD_DISTANCE;
    for (const entry of this.players.values()) {
      const player = entry.source;
      if (!player || entry.visibleWanted !== true) { entry.group.visible = false; if (entry.bar) entry.bar.visible = false; continue; }
      const isSelf = player.id === this.selfId;
      const isMate = player.team === this.selfTeamCache;
      const d2 = dist2sq(player.x || 0, player.z || 0, cx, cz);
      const within = isSelf || isMate || d2 <= maxDist * maxDist;
      if (!within || (!isSelf && !isMate && visible >= MAX_VISIBLE_PLAYERS)) { entry.group.visible = false; if (entry.bar) entry.bar.visible = false; continue; }
      visible++;
      entry.group.visible = true;
      entry.model.setLod(isSelf || d2 <= lodFar2 ? 0 : 1);
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
    // 空投（复用模块级 Map/Set，10Hz 快照零分配）
    const drops = _dropsSeen;
    drops.clear();
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
    const pings = _pingsSeen;
    pings.clear();
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
    const smokeIds = _smokeIds;
    const fireIds = _fireIds;
    smokeIds.clear(); fireIds.clear();
    for (const s of snapshot.smokes || []) smokeIds.add(String(s.id));
    for (const f of snapshot.fires || []) fireIds.add(String(f.id));
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
    const err = dist2(self.x || 0, self.z || 0, this.predicted.x, this.predicted.z);
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
    // 命中标记只属于「打中了」：空枪不弹 hitmarker（DOM 反馈由 ui-hud 驱动）
    if (isSelf) { this.shake(0.09); if (event.hit) this.hitmarker(); }
  }

  /* ---------------- 相机 / 渲染 ---------------- */
  shake(amount = 0.2) { this.shakeAmount = Math.min(1.4, this.shakeAmount + amount); }
  hitmarker() { this.hitmarkerTime = 0.12; }

  /** 空降镜头倍率：舱内最远、伞降逐渐收回、落地回到 1。
   *  倍率不宜过大：实测 2.6× 时地面建筑只剩色块，玩家反而看不清落点。
   *  1.7× 能同时看到航线、城镇轮廓与自己的位置。 */
  deployZoom() {
    const me = this.state?.me;
    const stage = me && me.deployStage;
    if (!stage || stage === 'ground') return 1;
    if (stage === 'plane') return 1.7;
    if (stage === 'freefall') return 1.45;
    return 1.2; // chute：接近正常视野，方便选落脚点
  }

  camBasis(px, pz, out) {
    const pitch = this.camPitch;
    // 空降时把镜头拉远抬高：俯视角下要能看清落区周围的地形与敌人，
    // 否则「选落点」这件事全靠小地图，跳伞就成了盲跳。
    const dist = this.camDist * this.deployZoom();
    out.x = px + Math.sin(this.camYaw) * Math.cos(pitch) * dist;
    out.y = Math.sin(pitch) * dist;
    out.z = pz + Math.cos(this.camYaw) * Math.cos(pitch) * dist;
    return out;
  }

  updateCamera(dt, elapsed) {
    const state = this.state;
    if (this.home) {      this.orbit += dt * 0.055;
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
      // 空降高度只在 UI（状态条的高度数字）与模型抬升里体现；
      // 相机注视点保持在地面 —— 抬高它会连同 camBasis 的固定相机高度一起错位
      // （实测把 lookTarget.y 抬到 82m 后，相机被拉到地面以下，画面只剩天空）。
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
    this.tickDynamics(step, elapsed);
    this.fx.update(step);
    this.updateLamps(px, pz, elapsed);
    if (this.hitmarkerTime > 0) this.hitmarkerTime -= step;
    // 两趟绘制：
    //  1) 地面层（LAYER_GROUND）—— 只有地面雾层。它 depthTest:false，永远铺满画面，
    //     作为「背景薄雾」先画；不写深度，所以不会挡住后面任何东西。
    //  2) 主层（LAYER_MAIN）—— 其余全部物体，按正常深度绘制并覆盖雾。
    // 这里必须用 autoClear=false 手动清屏一次，否则第二趟会把第一趟擦掉。
    const cam = this.camera;
    const renderer = this.renderer;
    renderer.autoClear = false;
    cam.layers.set(LAYER_GROUND);
    renderer.clear();
    renderer.render(this.scene, cam);
    cam.layers.set(LAYER_MAIN);
    renderer.render(this.scene, cam);
    renderer.autoClear = true;
  }

  tickCars(dt, elapsed) {
    let visible = 0;
    const cx = this.follow.x, cz = this.follow.z;
    for (const entry of this.cars.values()) {
      const car = entry.source;
      if (!car) { entry.group.visible = false; continue; }
      if ((car.hp ?? 1) <= 0 || dist2sq(car.x || 0, car.z || 0, cx, cz) > (this.viewDistance + 14) * (this.viewDistance + 14)) { entry.group.visible = false; continue; }
      visible++;
      entry.group.visible = true;
      this.updateCar(entry, car, dt);
    }
    this.visibleCars = visible;
  }

  tickLoot(elapsed) {
    if (!this.lootMeshes) return;
    let glow = 0;
    for (const [type, entry] of this.lootMeshes) {
      const { mesh, items } = entry;
      if (!items.length) continue;
      const lift = type === 'weapon' ? 0.3 : 0.34;
      const spin = type === 'weapon' ? 0.7 : 1.05;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const bob = Math.sin(elapsed * 1.9 + (item.x || 0) * 0.7) * 0.05;
        _e.set(0, elapsed * spin + (item.z || 0) * 0.2, 0); _q.setFromEuler(_e);
        _m.compose(_v.set(item.x || 0, lift + bob + (item.y || 0), item.z || 0), _q, _s.setScalar(type === 'weapon' ? 1.1 : 0.92));
        mesh.setMatrixAt(i, _m);
        const h = item.rarity === 'legendary' ? 2.4 : item.rarity === 'epic' ? 1.9 : item.rarity === 'rare' ? 1.5 : 1.15;
        _m.compose(_v.set(item.x || 0, h * 0.5, item.z || 0), _q.identity(), _s.set(0.14 + Math.sin(elapsed * 2.4 + i) * 0.02, h, 0.14 + Math.sin(elapsed * 2.4 + i) * 0.02));
        this.lootGlow.setMatrixAt(glow++, _m);
      }
      // 只上传实际用到的前 items.length 个矩阵。
      // 不设 updateRanges 时 three 会把整个 640×16 缓冲（40,960 B）全量 bufferSubData ——
      // 一局通常只有几十件物资，等于每帧给 GPU 传 17 倍的无用数据。
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.addUpdateRange(0, items.length * 16);
    }
    this.lootGlow.count = glow;
    if (glow > 0) {
      this.lootGlow.instanceMatrix.needsUpdate = true;
      this.lootGlow.instanceMatrix.addUpdateRange(0, glow * 16);
    }
  }

  /**
   * 屋顶遮挡系统：玩家（自己/队友）进入建筑后屋顶淡出。
   * 淡出用 opacity 渐变（指数插值到 0.05），而不是瞬间切换；
   * 实例屋顶无法改 opacity（InstancedMesh 材质共享），所以：
   *   淡出中 → 实例缩到 0、用独立半透明 mesh（overlay 池）按 roof.opacity 显示；
   *   回来时 → overlay 继续渐隐到 1 后，把实例恢复、overlay 隐藏。
   * 恢复延迟由 opacity > 0.985 才切回，避免闪烁。
   */
  tickRoofs(dt) {
    if (!this.roofs.length || !this.state) return;
    // 复用模块级容器：candidates/occupied 每帧重建会产生稳态 GC 压力
    const candidates = _roofCandidates;
    candidates.length = 0;
    const players = this.state.players;
    if (players) {
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.id === this.selfId || p.team === this.selfTeamCache) candidates.push(p);
      }
    }
    const lerpFade = clamp(1 - Math.exp(-11 * dt), 0, 1);
    const lerpBack = clamp(1 - Math.exp(-7 * dt), 0, 1);
    const overlay = this.currentWorld?.roofOverlay || [];
    const occupied = _occupiedSlots;
    occupied.length = 0;
    for (const roof of this.roofs) {
      const b = roof.building;
      const halfW = (b.w || 10) / 2 + 1.4;
      const halfD = (b.d || 9) / 2 + 1.4;
      let inside = false;
      for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i];
        if (Math.abs((p.x || 0) - (b.x || 0)) < halfW && Math.abs((p.z || 0) - (b.z || 0)) < halfD) { inside = true; break; }
      }
      const target = inside ? 0.05 : 1;
      const lerp = target < roof.opacity ? lerpFade : lerpBack;
      roof.opacity += (target - roof.opacity) * lerp;
      roof.mesh = null;
      const faded = roof.opacity < 0.995;
      if (faded && overlay.length) {
        // 淡出：把该实例矩阵缩到 0 真正隐藏，再由独立的半透明 overlay 承担渐变
        if (!roof.instanceFaded && roof.instance) {
          roof.instanceFaded = true;
          _m.makeScale(0, 0, 0);
          roof.instance.mesh.setMatrixAt(roof.instance.index, _m);
          roof.instance.mesh.instanceMatrix.needsUpdate = true;
        }
        let slot = roof.overlaySlot;
        if (!slot || slot.building !== b) {
          slot = overlay.find((o) => !o.building || o.building === b) || overlay[occupied.length % overlay.length];
          if (slot) { roof.overlaySlot = slot; slot.building = b; }
        }
        if (slot) {
          occupied.push(slot);
          slot.mesh.visible = true;
          slot.mesh.position.set(b.x || 0, (typeof b.baseY === 'number' ? b.baseY : 0) + (b.h || 3.4) + 0.78, b.z || 0);
          // overlay 与实例化屋顶同位置同尺寸 → 两个共面盒子必然 z-fighting（白条纹）。
          // 让 overlay 每个方向上大 0.06m，用几何偏移代替深度偏移（移动端 depth bias 不可靠）。
          slot.mesh.scale.set((b.w || 10) + 0.96, 0.5, (b.d || 9) + 0.96);
          slot.mesh.material.color.set(b.roofColor ?? this.theme.roof?.[0] ?? 0xae6855);
          slot.mesh.material.opacity = roof.opacity;
          slot.mesh.material.depthWrite = roof.opacity > 0.85;
          slot.opacity = roof.opacity;
        }
      } else if (roof.instanceFaded) {
        roof.instanceFaded = false;
        if (roof.instance) {
          // 恢复：实例矩阵只做平移（尺寸已烘焙进顶点，缩放必须保持 1）
          _m.makeTranslation(roof.instance.item.x, roof.instance.item.y, roof.instance.item.z);
          roof.instance.mesh.setMatrixAt(roof.instance.index, _m);
          roof.instance.mesh.instanceMatrix.needsUpdate = true;
        }
        if (roof.overlaySlot) {
          roof.overlaySlot.building = null;
          roof.overlaySlot.mesh.visible = false;
          roof.overlaySlot = null;
        }
      }
    }
    for (const slot of overlay) {
      if (slot.building && !occupied.includes(slot)) {
        // 淡回不透明（若玩家已在同一帧离开）
        slot.opacity += (1 - slot.opacity) * lerpBack;
        slot.mesh.material.opacity = slot.opacity;
        if (slot.opacity > 0.99) { slot.building = null; slot.mesh.visible = false; }
      }
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
    const len = Math.sqrt(mx * mx + mz * mz);
    const nx = len > 1 ? mx / len : mx, nz = len > 1 ? mz / len : mz;
    const dx = nx * speed * step, dz = nz * speed * step;
    // 复用环形池对象，避免每帧分配 {seq,dx,dz}
    const rec = _pendingPool[_pendingCursor];
    _pendingCursor = (_pendingCursor + 1) % _pendingPool.length;
    rec.seq = input.seq || 0; rec.dx = dx; rec.dz = dz;
    this.pendingInputs.push(rec);
    while (this.pendingInputs.length > _pendingPool.length) this.pendingInputs.shift();
    try {
      const moveBody = this.world?.moveBody || legacyExport('moveBody');
      if (typeof moveBody === 'function') moveBody.call(this.world, this.predicted, dx, dz, self.car ? 1.35 : 0.55);
      else { this.predicted.x += dx; this.predicted.z += dz; }
    } catch { this.predicted.x += dx; this.predicted.z += dz; }
    if (this.state.zone) {
      const dist = dist2(this.predicted.x, this.predicted.z, this.state.zone.x || 0, this.state.zone.z || 0);
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
    if (this.flightRig) {
      // 航线/飞机用的是本类自建的几何（不是共享 UNIT_BOX），必须自己释放。
      this.flightRig.path.geometry.dispose();
      this.flightRig.pathMat.dispose();
      this.flightRig.plane.traverse((node) => {
        if (node.material && !isSharedMaterial(node.material)) node.material.dispose();
      });
      this.scene.remove(this.flightRig.group);
      this.flightRig = null;
    }
    this.disposeLootTemplates();
    for (const cached of this.worlds.values()) this.disposeWorld(cached);
    this.worlds.clear();
    if (this._treeLowCache) { for (const geo of this._treeLowCache.values()) if (geo && !isSharedGeometry(geo)) geo.dispose(); this._treeLowCache.clear(); }
    this.fx.dispose?.();
    this.zoneRing.geometry.dispose(); this.zoneRing.material.dispose();
    this.stormWall.geometry.dispose(); this.stormWall.material.dispose();
    this.renderer.dispose();
  }
}

export default GameScene;




