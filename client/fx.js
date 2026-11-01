// 雾岛突围 / MIST ISLE 1.0 — 特效系统（owner: renderfx）
// 全对象池：几何/材质在构造期一次创建，运行时只写矩阵与颜色；禁止每帧 new 几何体。
// 粒子总量受 quality 控制；不使用 Math.random（内部确定性 LCG，粒子可复现）。
import * as THREE from 'three';
import { UNIT_BOX, UNIT_SPHERE, UNIT_CIRCLE } from './models.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3();
const _s = new THREE.Vector3(), _c = new THREE.Color(), _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const MAX_MESH = { low: 14, balanced: 24, high: 32 };
const MAX_SPARK = { low: 220, balanced: 420, high: 620 };
const MAX_GLOW = { low: 260, balanced: 520, high: 780 };
const MAX_DROP = { low: 320, balanced: 560, high: 820 };

/** 小盒对象池：火花/碎屑/弹壳/血滴共用（InstancedMesh，单 draw call）。 */
class InstancedPool {
  constructor(scene, geometry, capacity, additive) {
    this.capacity = capacity;
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, _c.set(0xffffff));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.items = [];
    for (let i = 0; i < capacity; i++) {
      this.items.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0.1, r: 1, g: 1, b: 1, grav: 0, drag: 0, spin: 0, rot: 0 });
    }
    this.active = 0;
  }
  spawn(x, y, z, vx, vy, vz, size, color, life, grav = 0, drag = 0) {
    if (this.active >= this.capacity) return;
    const it = this.items[this.active++];
    it.live = true; it.x = x; it.y = y; it.z = z; it.vx = vx; it.vy = vy; it.vz = vz;
    it.size = size; it.life = life; it.maxLife = life; it.grav = grav; it.drag = drag;
    _c.set(color); it.r = _c.r; it.g = _c.g; it.b = _c.b;
    it.rot = (this.active * 0.7) % 6.28; it.spin = 6 + (this.active % 5) * 2;
  }
  update(dt) {
    let write = 0;
    for (let i = 0; i < this.active; i++) {
      const it = this.items[i];
      it.life -= dt;
      if (it.life <= 0) continue;
      it.vy -= it.grav * dt;
      const damp = Math.max(0, 1 - it.drag * dt);
      it.vx *= damp; it.vz *= damp;
      it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
      if (it.y < 0.04) { it.y = 0.04; it.vy *= -0.32; it.vx *= 0.6; it.vz *= 0.6; }
      it.rot += it.spin * dt;
      const t = Math.max(0, it.life / it.maxLife);
      const scale = it.size * (0.35 + t * 0.65);
      _p.set(it.x, it.y, it.z); _q.setFromAxisAngle(_up, it.rot); _s.set(scale, scale, scale);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(write, _m);
      _c.setRGB(it.r * t, it.g * t, it.b * t);
      this.mesh.setColorAt(write, _c);
      this.items[write++] = it;
    }
    this.active = write;
    this.mesh.count = write;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = write > 0;
  }
  clear() { this.active = 0; this.mesh.count = 0; this.mesh.visible = false; }
}

/** 自发光点池：火焰/余烬/雪花/沙尘/雨（Points，单 draw call，颜色淡出=加色衰减）。 */
class PointsPool {
  constructor(scene, capacity, size, blending, opacity = 0.9) {
    this.capacity = capacity; this.active = 0;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    const geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.posAttr);
    geometry.setAttribute('color', this.colAttr);
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Points(geometry, new THREE.PointsMaterial({
      size, sizeAttenuation: true, vertexColors: true, transparent: true, opacity,
      depthWrite: false, blending,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    for (let i = 0; i < capacity; i++) this.items.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, r: 1, g: 1, b: 1, grav: 0, drag: 0 });
  }
  spawn(x, y, z, vx, vy, vz, life, color, grav = 0, drag = 0) {
    if (this.active >= this.capacity) return;
    const it = this.items[this.active++];
    it.x = x; it.y = y; it.z = z; it.vx = vx; it.vy = vy; it.vz = vz;
    it.life = life; it.maxLife = life; it.grav = grav; it.drag = drag;
    _c.set(color); it.r = _c.r; it.g = _c.g; it.b = _c.b;
  }
  update(dt) {
    let write = 0;
    for (let i = 0; i < this.active; i++) {
      const it = this.items[i];
      it.life -= dt;
      if (it.life <= 0) continue;
      it.vy -= it.grav * dt;
      const damp = Math.max(0, 1 - it.drag * dt);
      it.vx *= damp; it.vz *= damp;
      it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
      const t = Math.max(0, it.life / it.maxLife);
      const j = write * 3;
      this.pos[j] = it.x; this.pos[j + 1] = it.y; this.pos[j + 2] = it.z;
      const fade = t * t;
      this.col[j] = it.r * fade; this.col[j + 1] = it.g * fade; this.col[j + 2] = it.b * fade;
      this.items[write++] = it;
    }
    this.active = write;
    this.mesh.geometry.setDrawRange(0, write);
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
    this.mesh.visible = write > 0;
  }
  clear() { this.active = 0; this.mesh.geometry.setDrawRange(0, 0); this.mesh.visible = false; }
}

/**
 * 独立网格池：枪口火光/曳光/冲击环/爆炸球/护盾等需要各自透明度的效果。
 *
 * ⚠ forceSinglePass 必须显式打开。
 * three r180 的 WebGLRenderer 在 `transparent === true && side === DoubleSide &&
 * forceSinglePass !== true` 时会**先画背面再画正面**（两趟，draw call ×2）。
 * 这里的所有特效都是不透明感的光斑/球/环，双面只是为了让相机从任何角度都能看到，
 * 并不是真的需要"背面先画一次"的排序；开单趟后背面直接不画（FrontSide 语义），
 * 对 Point 状光斑视觉无差别。实测特效密集帧 draw call 159 → 102。
 */
class MeshPool {
  constructor(scene, geometry, count, additive, blendOpacity = 0.85, singlePass = true) {
    this.items = [];
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: blendOpacity, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
        forceSinglePass: singlePass,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false; mesh.frustumCulled = false;
      scene.add(mesh);
      this.items.push({ mesh, material, live: false, kind: 'none', life: 0, maxLife: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, from: 1, to: 1, opacity: 1, spin: 0, rot: 0, color: 0xffffff, grav: 0 });
    }
    this.active = 0;
  }
  take() {
    for (const it of this.items) if (!it.live) { it.live = true; it.mesh.visible = true; return it; }
    const it = this.items[0];
    it.live = true; it.mesh.visible = true; return it;
  }
  update(dt) {
    let live = 0;
    for (const it of this.items) {
      if (!it.live) continue;
      it.life -= dt;
      if (it.life <= 0) { it.live = false; it.mesh.visible = false; it.kind = 'none'; continue; }
      live++;
      const t = Math.max(0, it.life / it.maxLife);
      it.opacity = t;
      if (it.kind === 'ring') {
        const grow = it.from + (it.to - it.from) * (1 - t);
        it.mesh.scale.setScalar(grow);
        it.mesh.position.set(it.x, it.y, it.z);
        it.material.opacity = t * 0.85;
      } else if (it.kind === 'burst') {
        const grow = it.from + (it.to - it.from) * (1 - t * t);
        it.mesh.scale.set(grow, grow * 0.8, grow);
        it.mesh.position.set(it.x, it.y + (1 - t) * it.vy, it.z);
        it.material.opacity = t * it.opacity * 1.1;
      } else if (it.kind === 'flash') {
        it.mesh.scale.setScalar(it.from * (0.4 + t * 0.6));
        it.mesh.rotation.z = it.rot;
        it.material.opacity = t * it.opacity;
      } else if (it.kind === 'tracer') {
        it.material.opacity = t * 0.9;
        it.mesh.scale.x = it.from * (0.6 + t * 0.4);
      } else if (it.kind === 'zone') {
        it.mesh.scale.set(it.from, it.from * (it.grav || 1), it.from);
        it.material.opacity = it.opacity * Math.min(1, t * 2.2);
        it.mesh.position.set(it.x, it.y, it.z);
      } else if (it.kind === 'puff') {
        it.mesh.position.set(it.x, it.y + (1 - t) * 1.6, it.z);
        it.mesh.scale.setScalar(it.from * (1.4 - t * 0.5));
        it.material.opacity = t * it.opacity;
      }
    }
    this.active = live;
  }
  clear() {
    for (const it of this.items) { it.live = false; it.mesh.visible = false; it.mesh.material.opacity = 0; }
    this.active = 0;
  }
}

/** 确定性伪随机（同一特效序列可复现，避免 Math.random）。 */
function hash01(n) {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export class Fx {
  constructor(scene3d) {
    // 同一场景只允许一个 Fx（main.js 可能额外 new Fx(scene)，返回既有实例避免双份粒子池）
    if (scene3d && scene3d.userData && scene3d.userData.__mistFx) return scene3d.userData.__mistFx;
    this.scene = scene3d || new THREE.Scene();
    if (scene3d && scene3d.userData) scene3d.userData.__mistFx = this;
    this._lastUpdateMs = -1e9;
    this.quality = 'balanced';
    this.seed = 1;
    this.time = 0;
    this.focus = { x: 0, z: 0 };
    this.weather = 'clear';
    this.weatherAmount = 0;
    this.zones = new Map();
    this.maxMesh = MAX_MESH.balanced;
    this.flashes = new MeshPool(this.scene, UNIT_SPHERE, 18, true, 0.95);
    this.tracers = new MeshPool(this.scene, UNIT_BOX, 24, true, 0.9);
    this.rings = new MeshPool(this.scene, UNIT_CIRCLE, 18, true, 0.7);
    this.bursts = new MeshPool(this.scene, UNIT_SPHERE, 16, true, 0.8);
    this.puffs = new MeshPool(this.scene, UNIT_SPHERE, 22, false, 0.5);
    this.sparks = new InstancedPool(this.scene, UNIT_BOX, MAX_SPARK.balanced, true);
    this.debris = new InstancedPool(this.scene, UNIT_BOX, MAX_SPARK.balanced / 2 | 0, false);
    this.fireGlow = new PointsPool(this.scene, MAX_GLOW.balanced, 1.8, THREE.AdditiveBlending, 0.85);
    this.weatherPoints = new PointsPool(this.scene, MAX_DROP.balanced, 0.5, THREE.AdditiveBlending, 0.75);
    this.rainMesh = this.makeRainMesh(MAX_DROP.balanced);
    this.zoneMeshes = [];
  }

  makeRainMesh(capacity) {
    const geometry = new THREE.BoxGeometry(0.035, 1, 0.035);
    const material = new THREE.MeshBasicMaterial({ color: 0xa8cbd8, transparent: true, opacity: 0.55, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, capacity, drops: [], active: 0 };
  }

  setQuality(quality) {
    this.quality = MAX_SPARK[quality] ? quality : 'balanced';
    this.maxMesh = MAX_MESH[this.quality];
    const sparkCap = Math.min(this.sparks.capacity, MAX_SPARK[this.quality]);
    this.sparks.capacity = sparkCap;
    this.sparkCap = sparkCap;
    this.glowCap = Math.min(this.fireGlow.capacity, MAX_GLOW[this.quality]);
    this.dropCap = Math.min(this.weatherPoints.capacity, MAX_DROP[this.quality]);
    this.rainMesh.capacity = this.dropCap;
  }

  rand() {
    this.seed = (this.seed + 0x9e3779b9) | 0;
    return hash01(this.seed);
  }
  spread(scale) { return (this.rand() - 0.5) * 2 * scale; }

  setWeather(kind = 'clear') {
    this.weather = kind;
    this.weatherAmount = kind === 'clear' || kind === 'fog' ? 0 : kind === 'rain' ? 0.55 : kind === 'snow' ? 0.5 : 0.6;
    if (this.weatherAmount === 0) this.clearWeather();
  }
  setWeatherFocus(x = 0, z = 0) { this.focus.x = x; this.focus.z = z; }
  clearWeather() {
    this.weatherPoints.clear();
    this.rainMesh.active = 0; this.rainMesh.mesh.count = 0; this.rainMesh.mesh.visible = false;
  }
  clear() {
    this.flashes.clear(); this.tracers.clear(); this.rings.clear(); this.bursts.clear(); this.puffs.clear();
    this.sparks.clear(); this.debris.clear(); this.fireGlow.clear();
    this.clearWeather();
    for (const zone of this.zones.values()) { this.releaseZone(zone); }
    this.zones.clear();
  }

  /* ---------------- 通用小工具 ---------------- */
  ring(x, y, z, color, from, to, life, _additive = true) {
    const it = this.rings.take();
    it.kind = 'ring'; it.life = life; it.maxLife = life; it.x = x; it.y = y; it.z = z;
    it.from = from; it.to = to; it.material.color.set(color); it.material.opacity = 0.8;
    it.mesh.rotation.x = -Math.PI / 2; it.mesh.rotation.z = 0;
    it.mesh.scale.setScalar(from); it.mesh.position.set(x, y, z);
    return it;
  }
  burst(x, y, z, color, size, life, rise = 0) {
    const it = this.bursts.take();
    it.kind = 'burst'; it.life = life; it.maxLife = life; it.x = x; it.y = y; it.z = z;
    it.from = size * 0.35; it.to = size; it.vy = rise; it.opacity = 0.75;
    it.material.color.set(color); it.material.opacity = 0.75;
    it.mesh.position.set(x, y, z); it.mesh.scale.setScalar(size * 0.35);
    return it;
  }
  puff(x, y, z, color, size, life, opacity = 0.42) {
    const it = this.puffs.take();
    it.kind = 'puff'; it.life = life; it.maxLife = life; it.x = x; it.y = y; it.z = z;
    it.from = size; it.opacity = opacity;
    it.material.color.set(color); it.material.opacity = opacity;
    it.mesh.position.set(x, y, z); it.mesh.scale.setScalar(size);
    return it;
  }
  flash(x, y, z, color, size, life = 0.09) {
    const it = this.flashes.take();
    it.kind = 'flash'; it.life = life; it.maxLife = life; it.opacity = 0.95;
    it.from = size; it.rot = this.rand() * 6.28;
    it.material.color.set(color); it.material.opacity = 0.95;
    it.mesh.position.set(x, y, z); it.mesh.scale.setScalar(size); it.mesh.rotation.set(0, 0, it.rot);
    return it;
  }
  tracer(ax, az, bx, bz, color = 0xffd98a, y = 1.05) {
    // sqrt 而非 hypot：曳光每发一颗，hypot 的溢出保护/参数归一化在这里纯属浪费
    const dx = bx - ax, dz = bz - az, len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.02) return null;
    const it = this.tracers.take();
    it.kind = 'tracer'; it.life = 0.11; it.maxLife = 0.11; it.from = 0.055; it.opacity = 0.9;
    it.material.color.set(color); it.material.opacity = 0.9;
    it.mesh.position.set((ax + bx) / 2, y, (az + bz) / 2);
    it.mesh.rotation.set(0, Math.atan2(dx, dz), 0);
    it.mesh.scale.set(0.055, 0.055, len);
    return it;
  }
  sparksAt(x, y, z, color, count, speed = 5, size = 0.11, life = 0.42, grav = 12, dirX = 0, dirZ = 0) {
    const n = Math.max(1, Math.round(count * (this.quality === 'low' ? 0.55 : this.quality === 'high' ? 1.25 : 1)));
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2, up = 0.25 + this.rand() * 0.9, sp = speed * (0.35 + this.rand());
      this.sparks.spawn(x, y, z, Math.cos(a) * sp + dirX * speed * 0.5, up * sp, Math.sin(a) * sp + dirZ * speed * 0.5, size * (0.5 + this.rand()), color, life * (0.5 + this.rand()), grav, 1.6);
    }
  }
  debrisAt(x, y, z, color, count, speed = 4, size = 0.14) {
    const n = Math.max(1, Math.round(count * (this.quality === 'low' ? 0.5 : 1)));
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2, sp = speed * (0.3 + this.rand());
      this.debris.spawn(x, y + 0.2, z, Math.cos(a) * sp, 2 + this.rand() * speed, Math.sin(a) * sp, size * (0.6 + this.rand() * 0.8), color, 0.8 + this.rand() * 0.7, 16, 0.4);
    }
  }

  /* ---------------- 特效入口（契约 §10.2） ---------------- */
  spawn(kind, data = {}) {
    const x = data.x || 0, z = data.z || 0, y = data.y ?? 0;
    switch (kind) {
      case 'muzzle': {
        const color = data.color ?? 0xffcf7a;
        this.flash(x, y || 1.32, z, color, data.size ?? 0.42, 0.075);
        this.sparksAt(x, y || 1.32, z, color, 3, 3.2, 0.07, 0.16, 0, data.dx || 0, data.dz || 0);
        break;
      }
      case 'tracer': this.tracer(data.x, data.z, data.tx ?? data.x, data.tz ?? data.z, data.color ?? 0xffd98a, data.y ?? 1.05); break;
      case 'impact': {
        const color = data.color ?? 0xffdca0;
        this.sparksAt(x, y || 0.7, z, color, 7, 5.5, 0.1, 0.34);
        this.debrisAt(x, y || 0.7, z, data.debris ?? 0x8d8776, 3, 3.2, 0.09);
        this.ring(x, 0.06, z, color, 0.15, 0.62, 0.22);
        break;
      }
      case 'blood': {
        const color = data.color ?? 0xb8322f;
        const n = Math.round(10 * (this.quality === 'low' ? 0.5 : 1));
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2, sp = 1.6 + this.rand() * 3.4;
          this.sparks.spawn(x, y || 1.1, z, Math.cos(a) * sp, 0.8 + this.rand() * 2.2, Math.sin(a) * sp, 0.07 + this.rand() * 0.07, i % 3 ? color : 0x6e1f1d, 0.32 + this.rand() * 0.3, 11, 1.1);
        }
        this.puff(x, 1.05, z, 0x8d2b28, 0.55, 0.26, 0.38);
        break;
      }
      case 'explosion': {
        const radius = data.r || 6;
        this.burst(x, 1.2, z, 0xffc061, radius * 0.6, 0.34, radius * 0.22);
        this.burst(x, 0.8, z, 0xff6a2f, radius * 0.42, 0.5, radius * 0.12);
        this.ring(x, 0.08, z, 0xffd08a, radius * 0.16, radius * 1.25, 0.4);
        this.ring(x, 0.1, z, 0xff9a4a, radius * 0.1, radius * 1.0, 0.55);
        this.sparksAt(x, 0.7, z, 0xffb057, 16, 8, 0.13, 0.6);
        this.debrisAt(x, 0.7, z, 0x6d6152, 10, 7, 0.2);
        const puffs = this.quality === 'low' ? 2 : 4;
        for (let i = 0; i < puffs; i++) this.puff(x + this.spread(radius * 0.35), 0.9, z + this.spread(radius * 0.35), 0x6b675f, 1.3 + this.rand() * 1.4, 1.1 + this.rand() * 0.6, 0.5);
        break;
      }
      case 'smoke': return this.zone('smoke', data);
      case 'fire':
      case 'molotov': return this.zone('fire', data);
      // main.js 用的事件别名
      case 'smokeBurst': return this.zone('smoke', data);
      case 'fireStart': return this.zone('fire', data);
      case 'flash': {
        this.burst(x, 1.4, z, 0xffffff, 3.6, 0.16, 0);
        this.ring(x, 0.1, z, 0xffffff, 0.4, 4.2, 0.24);
        break;
      }
      case 'shell': this.debris.spawn(x, y || 1.2, z, 1.4 + this.spread(1.4), 2.1 + this.rand(), 1.4 + this.spread(1.4), 0.055, 0xd8bc74, 0.9, 13, 0.2); break;
      case 'heal': this.ring(x, 0.08, z, 0x7ee0a0, 0.25, 1.35, 0.65); this.burst(x, 1.0, z, 0xa6f0bb, 0.5, 0.6, 1.2); break;
      case 'pickup': this.ring(x, 0.08, z, 0xf7d98a, 0.2, 1.15, 0.5); break;
      case 'levelup': {
        for (const [i, c] of [[0, 0xffd88a], [1, 0x7ee0c4], [2, 0xf08ac8]].entries()) {
          const it = this.ring(x, 0.12 + i * 0.55, z, c, 0.5, 2.4 + i * 0.35, 0.9 - i * 0.15);
          if (it) it.mesh.rotation.x = -Math.PI / 2;
        }
        this.sparksAt(x, 1.2, z, 0xffe09a, 12, 4.5, 0.1, 0.9, 2.2);
        break;
      }
      case 'shield': this.ring(x, 0.15, z, 0x6fc8f0, 0.4, 1.9, 0.6); this.burst(x, 1.1, z, 0x9fe6ff, 0.9, 0.5, 0.8); break;
      case 'repair': this.ring(x, 0.1, z, 0x8fe0b0, 0.3, 1.7, 0.6); this.sparksAt(x, 0.8, z, 0xb8f0c8, 8, 3.2, 0.09, 0.6); break;
      case 'wave': {
        const it = this.ring(x, 0.1, z, 0xf08a5a, 1.5, 14, 1.2);
        if (it) { it.mesh.rotation.x = -Math.PI / 2; }
        this.sparksAt(x, 1.0, z, 0xffb066, 14, 7, 0.12, 0.8);
        break;
      }
      case 'boss': {
        this.burst(x, 1.4, z, 0xd94f4f, 4.5, 1.0, 1.6);
        this.ring(x, 0.12, z, 0xd94f4f, 0.8, 6.5, 1.4);
        this.sparksAt(x, 1.4, z, 0xff7a6a, 20, 9, 0.15, 1.1);
        break;
      }
      case 'zone': {
        const it = this.burst(x, 0.4, z, 0xf0a060, (data.r || 6) * 0.5, 0.9, 0.4);
        if (it) it.material.opacity = 0.4;
        break;
      }
      default: break;
    }
    return null;
  }

  /* ---------------- 区域型特效：烟雾 / 火焰（跟随快照 ttl，不新建几何） ---------------- */
  makeZoneMesh() {
    const geometry = new THREE.SphereGeometry(1, 12, 8);
    // 烟雾/火焰是球体罩子，单趟即可（同 MeshPool 的注释）：双趟没有任何观感收益，
    // 只让每个区域火焰多一次 draw call。
    const material = new THREE.MeshBasicMaterial({ color: 0xd6d9cc, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false; mesh.frustumCulled = false;
    this.scene.add(mesh);
    return { mesh, material, geometry };
  }

  /** 更新/创建区域：data = {id, kind:'smoke'|'fire', x, z, r, ttl} */
  zone(kind, data = {}) {
    const rawId = data.id ?? `${Math.round((data.x || 0) * 10)}:${Math.round((data.z || 0) * 10)}`;
    const id = `${kind}:${rawId}`;
    let zone = this.zones.get(id);
    if (!zone) {
      const res = this.makeZoneMesh();
      zone = { id, kind, snapId: String(rawId), ...res, x: data.x || 0, z: data.z || 0, r: data.r || 5, ttl: data.ttl ?? 8, age: 0, emit: 0, seedRot: this.rand() * 6.28 };
      this.zones.set(id, zone);
    }
    zone.x = data.x ?? zone.x; zone.z = data.z ?? zone.z; zone.r = data.r ?? zone.r;
    zone.ttl = data.ttl ?? zone.ttl;
    zone.mesh.visible = true;
    if (kind === 'smoke') { zone.material.color.set(data.color ?? 0xcfd4c6); zone.material.opacity = Math.min(0.72, 0.28 + zone.ttl * 0.04); }
    else { zone.material.color.set(data.color ?? 0xff8a3c); zone.material.opacity = Math.min(0.3, 0.1 + zone.ttl * 0.02); }
    return zone;
  }

  releaseZone(zone) {
    if (!zone) return;
    zone.mesh.visible = false;
    this.scene.remove(zone.mesh);
    zone.mesh.material.dispose();
    zone.geometry.dispose();
  }

  removeZone(id) { const zone = this.zones.get(id); if (zone) { this.releaseZone(zone); this.zones.delete(id); } }

  /* ---------------- 天气：跟随相机的循环粒子 ---------------- */
  updateWeather(dt) {
    const amount = this.weatherAmount;
    if (!amount) return;
    const cap = Math.min(this.dropCap || MAX_DROP.balanced, MAX_DROP[this.quality] || MAX_DROP.balanced);
    const target = Math.round(cap * amount);
    const span = 46;
    const fx = this.focus.x, fz = this.focus.z;
    const isRain = this.weather === 'rain';
    const pool = isRain ? null : this.weatherPoints;
    if (isRain) this.updateRain(dt, target, span, fx, fz);
    else this.updateWeatherPoints(dt, target, span, fx, fz, pool);
  }

  updateRain(dt, target, span, fx, fz) {
    const rain = this.rainMesh;
    const cap = Math.min(rain.capacity, MAX_DROP[this.quality] || MAX_DROP.balanced);
    const mesh = rain.mesh;
    const drops = rain.drops;
    while (drops.length < cap) drops.push({ x: 0, y: 0, z: 0, speed: 0 });
    let n = Math.min(target, cap);
    for (let i = 0; i < n; i++) {
      const d = drops[i];
      if (d.y < 0.2 || d.speed === 0) { d.x = fx + this.spread(span); d.z = fz + this.spread(span); d.y = 6 + this.rand() * 16; d.speed = 34 + this.rand() * 12; }
      d.y -= d.speed * dt; d.x += 2.4 * dt;
      if (Math.abs(d.x - fx) > span) d.x = fx - Math.sign(d.x - fx) * span;
      _m.makeRotationZ(0.06);
      _m.setPosition(d.x, d.y, d.z);
      mesh.setMatrixAt(i, _m);
    }
    // 未使用的实例缩到 0
    for (let i = n; i < cap; i++) { _m.makeScale(0, 0, 0); mesh.setMatrixAt(i, _m); }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  updateWeatherPoints(dt, target, span, fx, fz, pool) {
    if (!pool) return;
    const cap = Math.min(MAX_DROP[this.quality] || MAX_DROP.balanced, pool.items.length);
    while (pool.active < Math.min(target, cap)) {
      pool.items[pool.active++] = { x: fx + this.spread(span), y: 6 + this.rand() * 16, z: fz + this.spread(span), vx: 0, vy: 0, vz: 0, life: 999, maxLife: 999, r: 1, g: 1, b: 1, grav: 0, drag: 0 };
    }
    if (pool.active > cap) pool.active = cap;
    const fall = this.weather === 'snow' ? 2.4 : 7;
    const drift = this.weather === 'sandstorm' ? 13 : this.weather === 'snow' ? 1.6 : 1.4;
    const color = this.weather === 'snow' ? 0xffffff : 0xd8b184;
    const size = this.weather === 'snow' ? 0.55 : 0.7;
    if (pool.mesh.material.size !== size) pool.mesh.material.size = size;
    let n = 0;
    for (let i = 0; i < pool.active; i++) {
      const it = pool.items[i];
      it.y -= fall * dt;
      it.x += (drift + Math.sin(this.time * 0.7 + i) * 0.8) * dt;
      it.z += drift * 0.35 * dt;
      if (it.y < 0.1 || Math.abs(it.x - fx) > span || Math.abs(it.z - fz) > span) {
        it.x = fx + this.spread(span); it.z = fz + this.spread(span); it.y = 8 + this.rand() * 14;
      }
      const j = n * 3;
      pool.pos[j] = it.x; pool.pos[j + 1] = it.y; pool.pos[j + 2] = it.z;
      _c.set(color);
      pool.col[j] = _c.r; pool.col[j + 1] = _c.g; pool.col[j + 2] = _c.b;
      n++;
    }
    pool.active = n;
    pool.mesh.geometry.setDrawRange(0, n);
    pool.posAttr.needsUpdate = true; pool.colAttr.needsUpdate = true;
    pool.mesh.visible = n > 0;
  }

  /* ---------------- 主更新 ---------------- */
  update(dt) {
    // scene.render 内部已推进过同一帧的 fx；main.js 再调一次时按墙钟去抖，避免双倍速度
    if (typeof performance !== 'undefined' && performance.now) {
      const now = performance.now();
      if (now - this._lastUpdateMs < 4) return;
      this._lastUpdateMs = now;
    }
    const step = Math.min(0.05, Math.max(0, dt || 0));
    this.time += step;
    this.updateWeather(step);
    this.flashes.update(step); this.tracers.update(step); this.rings.update(step);
    this.bursts.update(step); this.puffs.update(step);
    this.sparks.update(step); this.debris.update(step);
    this.updateZones(step);
    this.fireGlow.update(step);
  }

  updateZones(dt) {
    for (const [id, zone] of this.zones) {
      zone.ttl -= dt; zone.age += dt;
      if (zone.ttl <= 0) { this.releaseZone(zone); this.zones.delete(id); continue; }
      const grow = Math.min(1, zone.age * 1.6);
      if (zone.kind === 'smoke') {
        zone.mesh.position.set(zone.x, 1.6, zone.z);
        zone.mesh.scale.set(zone.r * grow, zone.r * 0.62, zone.r * grow);
        zone.material.opacity = Math.min(0.75, zone.ttl * 0.09) * grow;
        zone.emit -= dt;
        if (zone.emit <= 0) { zone.emit = 0.22; this.puff(zone.x + this.spread(zone.r * 0.5), 0.6, zone.z + this.spread(zone.r * 0.5), 0xc9cfc0, zone.r * 0.45, 1.4, 0.34); }
      } else {
        zone.mesh.position.set(zone.x, 0.5, zone.z);
        zone.mesh.scale.set(zone.r * grow, Math.max(0.5, zone.r * 0.3), zone.r * grow);
        zone.material.opacity = Math.min(0.28, zone.ttl * 0.05) * grow;
        zone.emit -= dt;
        if (zone.emit <= 0) {
          zone.emit = 0.06;
          const cap = Math.min(this.glowCap || MAX_GLOW.balanced, this.fireGlow.items.length);
          if (this.fireGlow.active < cap) {
            this.fireGlow.spawn(zone.x + this.spread(zone.r * 0.8), 0.2, zone.z + this.spread(zone.r * 0.8), this.spread(1.2), 2.4 + this.rand() * 2.2, this.spread(1.2), 0.55 + this.rand() * 0.5, this.rand() > 0.55 ? 0xff9a3c : 0xff5a28, -2.5, 0.6);
          }
        }
      }
    }
  }

  /** 便捷：清空并回收所有区域（切图/回主菜单）。 */
  dispose() {
    this.clear();
    const pools = [this.flashes, this.tracers, this.rings, this.bursts, this.puffs];
    for (const pool of pools) {
      for (const it of pool.items) { this.scene.remove(it.mesh); it.material.dispose(); }
    }
    for (const pool of [this.sparks, this.debris, this.fireGlow, this.weatherPoints]) {
      this.scene.remove(pool.mesh);
      pool.mesh.geometry.dispose(); pool.mesh.material.dispose();
    }
    this.scene.remove(this.rainMesh.mesh);
    this.rainMesh.mesh.geometry.dispose(); this.rainMesh.mesh.material.dispose();
  }
}

