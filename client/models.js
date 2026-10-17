// 雾岛突围 / MIST ISLE 1.0 — 程序化模型工厂（owner: renderfx）
// 约束：实例共享缓存几何体/材质/纹理（Map 缓存），实例化时不新建 material；
// disposeModel 只释放非共享资源，避免动态模型反复进出导致几何/纹理泄漏。
import * as THREE from 'three';

/* ---------------- 共享资源缓存 ---------------- */
const GEO = new Map(), MAT = new Map(), SPRITE_MAT = new Map(), CHAR_GEO = new Map(), GUN_GEO = new Map();
const SHARED_GEO = new WeakSet(), SHARED_MAT = new WeakSet(), SHARED_TEX = new WeakSet();
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
export const UNIT_SPHERE = new THREE.SphereGeometry(1, 8, 6);
export const UNIT_CONE = new THREE.ConeGeometry(1, 1, 8);
export const UNIT_WHEEL = new THREE.CylinderGeometry(1, 1, 1, 12);
export const UNIT_CIRCLE = new THREE.CircleGeometry(1, 18);
[UNIT_BOX, UNIT_CYL, UNIT_SPHERE, UNIT_CONE, UNIT_WHEEL, UNIT_CIRCLE].forEach((g) => SHARED_GEO.add(g));
export const VC_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
SHARED_MAT.add(VC_MAT);
const ROPE_MAT = new THREE.LineBasicMaterial({ color: 0xeee8d2, transparent: true, opacity: 0.75 });
SHARED_MAT.add(ROPE_MAT);

function cached(store, key, make, pool) {
  let value = store.get(key);
  if (!value) { value = make(); store.set(key, value); pool.add(value); }
  return value;
}

/** 共享 Lambert 材质（按颜色/透明度/自发光缓存）。禁止在实例化路径直接 new material。 */
export function material(color, opts = {}) {
  const key = `m:${color}|${opts.opacity ?? ''}|${opts.emissive ?? ''}|${opts.flat ? 1 : 0}|${opts.side ?? 0}`;
  return cached(MAT, key, () => new THREE.MeshLambertMaterial({
    color,
    flatShading: !!opts.flat,
    transparent: opts.opacity !== undefined,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite !== false,
    side: opts.side ?? THREE.FrontSide,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  }), SHARED_MAT);
}

/** 共享自发光/叠加材质：光柱、曳光、光斑、枪口火光等。 */
export function glowMaterial(color, opacity = 0.85, additive = true) {
  const key = `g:${color}|${opacity}|${additive ? 1 : 0}`;
  return cached(MAT, key, () => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
  }), SHARED_MAT);
}

/* ---------------- 顶点色几何烘焙（多色部件合并为单 draw call） ---------------- */
const _euler = new THREE.Euler(), _quat = new THREE.Quaternion(), _pos = new THREE.Vector3();
const _scl = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _m3 = new THREE.Matrix3(), _color = new THREE.Color();
const BAKED = new WeakMap();
function bakedData(geometry) {
  let data = BAKED.get(geometry);
  if (!data) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    data = { pos: g.attributes.position.array, nor: g.attributes.normal.array };
    BAKED.set(geometry, data);
  }
  return data;
}

/** 新建一个合并列表。 */
export function createList() { return { pos: [], nor: [], col: [] }; }

/** 把任意几何体按 TRS 烘焙进列表；color 为 sRGB 十六进制。 */
export function bake(list, geometry, color, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0) {
  const data = bakedData(geometry), count = data.pos.length / 3;
  _m4.compose(_pos.set(x, y, z), _quat.setFromEuler(_euler.set(rx, ry, rz)), _scl.set(sx, sy, sz));
  const e = _m4.elements, n = _m3.getNormalMatrix(_m4).elements;
  _color.set(color);
  for (let i = 0; i < count; i++) {
    const j = i * 3, px = data.pos[j], py = data.pos[j + 1], pz = data.pos[j + 2];
    list.pos.push(e[0] * px + e[4] * py + e[8] * pz + e[12], e[1] * px + e[5] * py + e[9] * pz + e[13], e[2] * px + e[6] * py + e[10] * pz + e[14]);
    let nx = n[0] * data.nor[j] + n[3] * data.nor[j + 1] + n[6] * data.nor[j + 2];
    let ny = n[1] * data.nor[j] + n[4] * data.nor[j + 1] + n[7] * data.nor[j + 2];
    let nz = n[2] * data.nor[j] + n[5] * data.nor[j + 1] + n[8] * data.nor[j + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    list.nor.push(nx / len, ny / len, nz / len);
    list.col.push(_color.r, _color.g, _color.b);
  }
  return list;
}

/** 收尾：生成带 position/normal/color 的 BufferGeometry。 */
export function finishList(list) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(list.pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(list.nor, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(list.col, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------- 阵营 / 武器类别 ---------------- */
export const DEFAULT_SKIN = Object.freeze({ primary: 0xf3b655, secondary: 0x2b4a4f, accent: 0xffdc8c });
export const TEAM_COLORS = Object.freeze([0x6fc2a1, 0xef8a6a, 0x8ab6f0, 0xe6c866, 0xc48bf0, 0x7ed3a5, 0xf5b445, 0x9fadb0]);
export function teamColorOf(team = 0) { return TEAM_COLORS[Math.abs(team | 0) % TEAM_COLORS.length]; }

export const GUN_LEN = Object.freeze({ pistol: 0.5, smg: 0.76, rifle: 1.04, shotgun: 0.94, marksman: 1.22, sniper: 1.52, lmg: 1.14, special: 0.88 });
/** 由武器 id 推断类别（兼容 1.0 新 id 与 0.2.0 旧类别串）。 */
export function weaponClassOf(id = '') {
  const s = String(id).toLowerCase();
  if (/sniper|awp|awm|bolt|railgun/.test(s)) return 'sniper';
  if (/marks|dmr|sks|scout/.test(s)) return 'marksman';
  if (/lmg|saw|minigun|^mg/.test(s)) return 'lmg';
  if (/shot|pump|sg$/.test(s)) return 'shotgun';
  if (/smg|p90|uzi|mp[0-9]|v9|vector/.test(s)) return 'smg';
  if (/pistol|p9|g17|deagle|revolver|m9/.test(s)) return 'pistol';
  if (/special|launcher|bow|cross/.test(s)) return 'special';
  return 'rifle';
}

/* ---------------- 角色几何（按调色板缓存，全角色共享） ---------------- */
const POSES = {
  normal: { lift: 0, tilt: 0, legL: 0, legR: 0, armL: -1.18, armR: -1.3, gun: 0 },
  sprint: { lift: 0, tilt: 0.16, legL: 0, legR: 0, armL: -1.0, armR: -1.05, gun: 0.45 },
  crouch: { lift: -0.3, tilt: 0.12, legL: 1.0, legR: 1.05, armL: -1.05, armR: -1.22, gun: 0 },
  downed: { lift: 0.42, tilt: -1.3, legL: 0.25, legR: 0.35, armL: -1.6, armR: -1.7, gun: 0.3 },
};

function charGeometries(pal, isSelf) {
  const key = `${pal.primary}|${pal.secondary}|${pal.accent}|${isSelf ? 1 : 0}`;
  return cached(CHAR_GEO, `char:${key}`, () => {
    const P = pal.primary, S = pal.secondary, A = pal.accent, D = 0x222b2f, M = 0x8d9a9e, K = 0xc39a76, G = 0x2c3d3a;
    const torso = createList(), head = createList(), backpack = createList(), arm = createList(), leg = createList(), band = createList();
    for (const b of [
      [S, 0, 0.98, 0, 0.46, 0.3, 0.3], [S, 0, 1.28, 0, 0.54, 0.44, 0.34], [A, 0, 1.33, 0.185, 0.38, 0.3, 0.07],
      [D, 0, 1.07, 0, 0.52, 0.1, 0.37], [D, 0, 1.2, 0.2, 0.16, 0.18, 0.06], [M, 0, 1.5, 0, 0.24, 0.08, 0.2],
      [P, -0.3, 1.47, 0, 0.18, 0.14, 0.28], [P, 0.3, 1.47, 0, 0.18, 0.14, 0.28], [G, 0, 1.12, -0.2, 0.3, 0.16, 0.08],
      [D, 0.16, 1.42, 0.12, 0.1, 0.14, 0.14], [D, -0.2, 1.2, 0.19, 0.1, 0.12, 0.05],
    ]) bake(torso, UNIT_BOX, ...b);
    if (isSelf) bake(torso, UNIT_BOX, 0xfff2c2, 0, 1.36, 0.222, 0.06, 0.22, 0.02);
    for (const b of [
      [K, 0, 0.02, 0, 0.14, 0.1, 0.14], [K, 0, 0.19, 0.01, 0.24, 0.22, 0.24], [S, 0, 0.3, -0.01, 0.32, 0.14, 0.32],
      [A, 0, 0.32, 0.02, 0.1, 0.05, 0.3], [D, 0, 0.12, 0.135, 0.2, 0.09, 0.05], [D, 0, 0.18, 0.13, 0.22, 0.07, 0.04],
      [M, 0.14, 0.2, 0, 0.04, 0.08, 0.04],
    ]) bake(head, UNIT_BOX, ...b);
    for (const b of [
      [S, 0, 1.3, -0.24, 0.4, 0.46, 0.2], [D, 0, 1.52, -0.24, 0.34, 0.1, 0.18], [A, 0, 1.36, -0.35, 0.28, 0.06, 0.03],
      [D, 0, 1.1, -0.22, 0.28, 0.1, 0.12], [M, 0.1, 1.62, -0.24, 0.03, 0.24, 0.03],
    ]) { bake(torso, UNIT_BOX, ...b); bake(backpack, UNIT_BOX, ...b); }
    for (const b of [
      [S, 0, -0.17, 0, 0.15, 0.34, 0.16], [A, 0, -0.36, 0, 0.17, 0.11, 0.17], [S, 0, -0.51, 0, 0.13, 0.28, 0.14],
      [D, 0, -0.68, 0, 0.13, 0.14, 0.15], [M, 0, -0.17, 0.085, 0.1, 0.08, 0.02],
    ]) bake(arm, UNIT_BOX, ...b);
    for (const b of [
      [S, 0, -0.17, 0, 0.17, 0.34, 0.2], [A, 0, -0.37, 0.02, 0.18, 0.11, 0.21], [S, 0, -0.53, 0, 0.15, 0.28, 0.17],
      [D, 0, -0.72, 0.03, 0.18, 0.13, 0.28], [D, 0, -0.4, 0.11, 0.1, 0.06, 0.05],
    ]) bake(leg, UNIT_BOX, ...b);
    for (const b of [
      [P, 0, 1.42, 0.212, 0.36, 0.08, 0.02], [P, -0.3, 1.53, 0, 0.19, 0.04, 0.22],
      [P, 0.3, 1.53, 0, 0.19, 0.04, 0.22], [P, 0, 1.07, 0.195, 0.14, 0.06, 0.02],
    ]) bake(torso, UNIT_BOX, ...b);
    // 阵营色带（几何共享；材质按队伍色缓存，支持 setTeamColor 热切换）
    for (const b of [
      [0xffffff, 0, 1.42, 0.214, 0.36, 0.08, 0.02], [0xffffff, -0.3, 1.53, 0, 0.19, 0.04, 0.22],
      [0xffffff, 0.3, 1.53, 0, 0.19, 0.04, 0.22], [0xffffff, 0, 1.07, 0.197, 0.14, 0.06, 0.02],
    ]) bake(band, UNIT_BOX, ...b);
    // 远景 LOD：把四肢按站姿烘焙成单一合并几何（1 draw call）
    const low = createList();
    appendList(low, torso); appendList(low, head, 0, 1.62, 0); appendList(low, backpack);
    appendList(low, arm, -0.33, 1.52, 0, -1.18, 0, 0.2); appendList(low, arm, 0.33, 1.52, 0, -1.3, 0, -0.14);
    appendList(low, leg, -0.16, 0.92, 0); appendList(low, leg, 0.16, 0.92, 0);
    return { torso: finishList(torso), head: finishList(head), backpack: finishList(backpack), arm: finishList(arm), leg: finishList(leg), band: finishList(band), low: finishList(low) };
  }, SHARED_GEO);
}

/** 把 list 的内容变换后并入 target（LOD 烘焙用）。 */
function appendList(target, src, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  _m4.compose(_pos.set(x, y, z), _quat.setFromEuler(_euler.set(rx, ry, rz)), _scl.set(1, 1, 1));
  const e = _m4.elements, n = _m3.getNormalMatrix(_m4).elements, count = src.pos.length / 3;
  for (let i = 0; i < count; i++) {
    const j = i * 3, px = src.pos[j], py = src.pos[j + 1], pz = src.pos[j + 2];
    target.pos.push(e[0] * px + e[4] * py + e[8] * pz + e[12], e[1] * px + e[5] * py + e[9] * pz + e[13], e[2] * px + e[6] * py + e[10] * pz + e[14]);
    let nx = n[0] * src.nor[j] + n[3] * src.nor[j + 1] + n[6] * src.nor[j + 2];
    let ny = n[1] * src.nor[j] + n[4] * src.nor[j + 1] + n[7] * src.nor[j + 2];
    let nz = n[2] * src.nor[j] + n[5] * src.nor[j + 1] + n[8] * src.nor[j + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    target.nor.push(nx / len, ny / len, nz / len);
    target.col.push(src.col[j], src.col[j + 1], src.col[j + 2]);
  }
  return target;
}
/* ---------------- 枪械几何（按类别缓存，全角色共享） ---------------- */
function gunGeometries(cls) {
  return cached(GUN_GEO, `gun:${cls}`, () => {
    const L = GUN_LEN[cls] || 1, list = createList();
    const bodyC = 0x39454a, dark = 0x1e262a, metal = 0x76858a, wood = 0x7a5b3c, accent = 0x9fd3c4;
    for (const b of [
      [bodyC, 0, 0.02, L * 0.28, 0.1, 0.14, L * 0.42], [dark, 0, -0.1, L * 0.18, 0.09, 0.17, 0.12],
      [metal, 0, 0.02, L * 0.64, 0.06, 0.07, L * 0.34], [bodyC, 0, 0.02, L * 0.02, 0.09, 0.11, L * 0.16],
      [accent, 0, 0.1, L * 0.28, 0.06, 0.03, 0.16], [dark, 0, -0.09, L * 0.33, 0.07, 0.16, 0.1],
    ]) bake(list, UNIT_BOX, ...b);
    bake(list, UNIT_CYL, dark, 0, 0.02, L * 0.92, 0.035, L * 0.16, 0.035, Math.PI / 2);
    if (cls === 'sniper' || cls === 'marksman') {
      bake(list, UNIT_CYL, dark, 0, 0.14, L * 0.44, 0.045, L * 0.28, 0.045, Math.PI / 2);
      bake(list, UNIT_BOX, dark, 0, 0.1, L * 0.44, 0.05, 0.07, 0.05);
      if (cls === 'sniper') { bake(list, UNIT_BOX, dark, 0, -0.1, L * 0.8, 0.03, 0.14, 0.03); bake(list, UNIT_BOX, dark, 0, -0.17, L * 0.8, 0.22, 0.03, 0.03); }
    }
    if (cls === 'lmg') { bake(list, UNIT_BOX, dark, 0, -0.15, L * 0.32, 0.16, 0.16, 0.16); bake(list, UNIT_BOX, metal, 0, 0.02, L * 0.72, 0.075, 0.075, L * 0.24); }
    if (cls === 'shotgun') { bake(list, UNIT_CYL, dark, 0, -0.06, L * 0.64, 0.05, L * 0.28, 0.05, Math.PI / 2); bake(list, UNIT_BOX, wood, 0, -0.02, L * 0.46, 0.07, 0.07, 0.14); }
    if (cls === 'smg') bake(list, UNIT_BOX, dark, 0, -0.14, L * 0.3, 0.06, 0.22, 0.08);
    if (cls === 'pistol') bake(list, UNIT_BOX, metal, 0, 0.08, L * 0.34, 0.085, 0.05, L * 0.48);
    if (cls === 'special') bake(list, UNIT_CYL, dark, 0, 0.02, L * 0.8, 0.09, L * 0.3, 0.09, Math.PI / 2);
    return finishList(list);
  }, SHARED_GEO);
}

/* ---------------- 角色 ---------------- */
export function createCharacter({ colors = DEFAULT_SKIN, team = 0, isSelf = false } = {}) {
  const pal = { primary: colors?.primary ?? DEFAULT_SKIN.primary, secondary: colors?.secondary ?? DEFAULT_SKIN.secondary, accent: colors?.accent ?? DEFAULT_SKIN.accent };
  const geo = charGeometries(pal, isSelf);
  const group = new THREE.Group();
  const body = new THREE.Group(); group.add(body);
  const shadow = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0x0e211c, 0.22, false));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; shadow.scale.setScalar(isSelf ? 0.6 : 0.52); group.add(shadow);
  if (isSelf) {
    const ring = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0xffe2a0, 0.2));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.scale.setScalar(0.8); group.add(ring);
  }
  const torso = new THREE.Mesh(geo.torso, VC_MAT); body.add(torso);
  const backpack = new THREE.Mesh(geo.backpack, VC_MAT); body.add(backpack);
  const band = new THREE.Mesh(geo.band, material(teamColorOf(team))); body.add(band);
  const head = new THREE.Mesh(geo.head, VC_MAT); head.position.y = 1.62; body.add(head);
  const armL = new THREE.Group(); armL.position.set(-0.33, 1.52, 0); armL.add(new THREE.Mesh(geo.arm, VC_MAT)); body.add(armL);
  const armR = new THREE.Group(); armR.position.set(0.33, 1.52, 0); armR.add(new THREE.Mesh(geo.arm, VC_MAT)); body.add(armR);
  const legL = new THREE.Group(); legL.position.set(-0.16, 0.92, 0); legL.add(new THREE.Mesh(geo.leg, VC_MAT)); body.add(legL);
  const legR = new THREE.Group(); legR.position.set(0.16, 0.92, 0); legR.add(new THREE.Mesh(geo.leg, VC_MAT)); body.add(legR);
  const gun = new THREE.Group(); gun.position.set(0.17, 1.36, 0.16); body.add(gun);
  const gunMesh = new THREE.Mesh(gunGeometries('rifle'), VC_MAT); gun.add(gunMesh);
  const muzzle = new THREE.Mesh(UNIT_CONE, glowMaterial(0xffd58a, 0.95));
  muzzle.rotation.x = Math.PI / 2; muzzle.scale.set(0.12, 0.26, 0.12); muzzle.visible = false; gun.add(muzzle);
  const chute = new THREE.Group(); chute.visible = false; body.add(chute);
  const canopy = new THREE.Mesh(UNIT_CONE, material(0xe8dcc0, { flat: true }));
  canopy.scale.set(2.3, 1.1, 2.3); canopy.position.y = 4.2; chute.add(canopy);
  const ropeGeo = cached(GEO, 'chute:ropes', () => new THREE.BufferGeometry().setFromPoints(
    [[-2, 4.2, -2], [0, 2.4, 0], [2, 4.2, -2], [0, 2.4, 0], [2, 4.2, 2], [0, 2.4, 0], [-2, 4.2, 2], [0, 2.4, 0]]
      .map(([x, y, z]) => new THREE.Vector3(x, y, z))), SHARED_GEO);
  chute.add(new THREE.LineSegments(ropeGeo, ROPE_MAT));
  const flash = new THREE.Mesh(UNIT_BOX, glowMaterial(0xff4438, 0.5));
  flash.scale.set(0.62, 0.7, 0.42); flash.position.y = 1.28; flash.visible = false; body.add(flash);
  const labelAnchor = new THREE.Object3D(); labelAnchor.position.y = 2.55; group.add(labelAnchor);
  const gunBase = gun.position.clone();
  let time = 0, recoil = 0, flashTime = 0;
  const api = {
    group, pose: 'normal', weapon: 'rifle',
    parts: { body, head, torso, armL, armR, legL, legR, gun, muzzle, chute, shadow, backpack, labelAnchor },
    setWeapon(weaponId, cls) {
      const klass = cls || weaponClassOf(weaponId);
      api.weapon = klass; gunMesh.geometry = gunGeometries(klass);
      muzzle.position.set(0, 0.04, (GUN_LEN[klass] || 1) + 0.06);
    },
    playRecoil() { recoil = 1; },
    setPose(state = 'normal') { api.pose = POSES[state] ? state : 'normal'; },
    setTeamColor(color) { band.material = material(color); },
    hitFlash(seconds = 0.16) { flashTime = Math.max(flashTime, seconds); flash.visible = true; },
    update(dt = 0, info = {}) {
      time += dt;
      recoil = Math.max(0, recoil - dt * 6.5);
      if (flashTime > 0) { flashTime -= dt; if (flashTime <= 0) flash.visible = false; }
      const p = POSES[api.pose] || POSES.normal;
      const swing = api.pose === 'downed' || api.pose === 'crouch' ? 0.22 : Math.min(1, Math.max(0, info.speed || 0) / 8);
      const k = Math.sin(time * 11) * 0.5 * swing;
      body.rotation.x = p.tilt; body.position.y = p.lift;
      legL.rotation.x = p.legL + k; legR.rotation.x = p.legR - k;
      armL.rotation.set(p.armL - k * 0.25, 0, 0.2);
      armR.rotation.set(p.armR + k * 0.2 - recoil * 0.12, 0, -0.14);
      gun.rotation.x = p.gun + recoil * 0.22;
      gun.position.set(gunBase.x, gunBase.y + recoil * 0.02, gunBase.z - recoil * 0.12);
      head.rotation.y = (info.lookYaw || 0) * 0.3;
      chute.rotation.z = Math.sin(time * 1.7) * 0.06;
    },
  };
  api.setWeapon('rifle');
  api.setPose('normal');
  group.userData = { kind: 'character', isSelf };
  return api;
}

/* ---------------- 资源释放 ---------------- */
/** 释放动态模型：共享缓存资源跳过，只释放本实例专属几何/材质/纹理。 */
export function disposeModel(root) {
  if (!root) return;
  root.traverse?.((node) => {
    if (node.geometry && !SHARED_GEO.has(node.geometry)) node.geometry.dispose();
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const m of mats) {
      if (SHARED_MAT.has(m)) continue;
      for (const key of ['map', 'emissiveMap', 'alphaMap']) { const t = m[key]; if (t && !SHARED_TEX.has(t)) t.dispose(); }
      m.dispose();
    }
  });
  root.parent?.remove(root);
  root.clear?.();
}

/* ---------------- 文字精灵（canvas，缓存纹理与 SpriteMaterial） ---------------- */
export function createTextSprite(text, color = '#f2f6ea', size = 64, opts = {}) {
  const key = `${text}|${color}|${size}|${opts.plate ? 1 : 0}`;
  const spriteMat = cached(SPRITE_MAT, key, () => {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!canvas) return new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const pad = 22, font = `700 ${size}px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`;
    let ctx = canvas.getContext('2d');
    ctx.font = font;
    canvas.width = Math.max(64, Math.min(2048, Math.ceil(ctx.measureText(text).width) + pad * 2));
    canvas.height = size + pad * 2;
    ctx = canvas.getContext('2d');
    ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (opts.plate) { ctx.fillStyle = opts.plate; ctx.beginPath(); ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 12); ctx.fill(); }
    ctx.shadowColor = 'rgba(5,14,16,.9)'; ctx.shadowBlur = size * 0.22; ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.04);
    ctx.shadowBlur = 0; ctx.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.04);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    SHARED_TEX.add(texture);
    return new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: opts.depthTest !== false });
  }, SHARED_MAT);
  const sprite = new THREE.Sprite(spriteMat);
  sprite.userData.text = text;
  return sprite;
}

/* ---------------- 载具 ---------------- */
const wheelGeometry = () => cached(GEO, 'wheel', () => {
  const list = createList();
  bake(list, UNIT_CYL, 0x14191b, 0, 0, 0, 0.5, 0.3, 0.5, 0, 0, Math.PI / 2);
  bake(list, UNIT_CYL, 0x7c878a, 0, 0, 0, 0.28, 0.32, 0.28, 0, 0, Math.PI / 2);
  for (let i = 0; i < 5; i++) bake(list, UNIT_BOX, 0x5a6467, 0, 0, 0, 0.07, 0.34, 0.5, i * 1.256, 0, 0);
  return finishList(list);
}, SHARED_GEO);

function buildWheel(x, z, radius, steer) {
  const pivot = new THREE.Group(); pivot.position.set(x, radius, z);
  const mesh = new THREE.Mesh(wheelGeometry(), VC_MAT); mesh.scale.setScalar(radius / 0.5); pivot.add(mesh);
  const steerGroup = new THREE.Group(); steerGroup.position.set(x, 0, z); steerGroup.rotation.y = steer ? 0 : 0;
  pivot.position.set(0, radius, 0); steerGroup.add(pivot);
  return { steerGroup, pivot, radius, steer: !!steer };
}

/** 载具：buggy/jeep/bike/truck 四种明显不同轮廓；轮子可转、车身可倾斜。 */
export function createVehicle(type = 'jeep', color = 0xe9b766) {
  const TYPE = String(type || 'jeep').toLowerCase();
  const group = new THREE.Group(), body = new THREE.Group(); group.add(body);
  const list = createList();
  const dark = 0x232c30, glass = 0x3d5f68, metal = 0x8b979b, tyre = 0x191d1f;
  const wheels = [], seatPositions = [];
  const add = (c, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0) => bake(list, UNIT_BOX, c, x, y, z, w, h, d, rx, ry, rz);
  if (TYPE === 'bike') {
    add(color, 0, 0.62, 0, 0.26, 0.3, 1.5); add(dark, 0, 0.42, -0.1, 0.22, 0.36, 0.5);
    add(color, 0, 0.82, 0.5, 0.3, 0.24, 0.42); add(dark, 0, 0.86, 0.02, 0.32, 0.12, 0.72);
    add(metal, 0, 0.98, 0.42, 0.7, 0.05, 0.05); add(metal, -0.2, 1.06, 0.36, 0.05, 0.2, 0.05); add(metal, 0.2, 1.06, 0.36, 0.05, 0.2, 0.05);
    add(dark, 0, 0.72, -0.66, 0.34, 0.2, 0.34); add(0xf2e6b6, 0, 0.9, 0.74, 0.09, 0.09, 0.03);
    wheels.push(buildWheel(0, 0.92, 0.42, true), buildWheel(0, -0.86, 0.44, false));
    seatPositions.push([0, 0.95, -0.22], [0, 0.95, -0.5]);
  } else if (TYPE === 'buggy') {
    add(color, 0, 0.5, 0, 1.4, 0.3, 2.4); add(dark, 0, 0.72, -0.8, 1.2, 0.34, 0.6);
    add(dark, 0, 0.86, -1.32, 0.5, 0.34, 0.3); add(metal, 0, 1.24, -1.36, 0.06, 0.06, 0.6);
    add(color, 0, 0.8, 0.92, 1.3, 0.24, 0.4); add(dark, 0, 0.68, 1.06, 1.3, 0.2, 0.16);
    for (const x of [-0.68, 0.68]) for (const z of [-0.7, 0.72]) { bake(list, UNIT_CYL, metal, x, 1.16, z, 0.045, 1.05, 0.045, x > 0 ? 0.16 : -0.16, 0, 0); }
    bake(list, UNIT_CYL, metal, 0, 1.72, -0.98, 0.045, 1.75, 0.045, Math.PI / 2);
    bake(list, UNIT_CYL, metal, 0, 1.72, 0.86, 0.045, 1.75, 0.045, Math.PI / 2);
    for (const x of [-0.62, 0.62]) bake(list, UNIT_CYL, metal, x, 1.72, -0.06, 0.04, 1.72, 0.04, Math.PI / 2);
    for (const [x, z] of [[-0.42, 0.24], [0.42, 0.24], [-0.42, -0.32], [0.42, -0.32]]) { seatPositions.push([x, 0.9, z]); add(dark, x, 0.86, z, 0.36, 0.16, 0.34); }
    add(dark, 0, 0.98, 0.6, 0.62, 0.3, 0.4); add(0x2f3a3d, 0, 0.9, 1.18, 1.2, 0.3, 0.08);
    wheels.push(buildWheel(-0.82, 0.82, 0.42, true), buildWheel(0.82, 0.82, 0.42, true), buildWheel(-0.84, -0.86, 0.44, false), buildWheel(0.84, -0.86, 0.44, false));
  } else if (TYPE === 'truck') {
    add(color, 0, 1.05, 1.65, 2.2, 1.1, 2.1); add(dark, 0, 0.6, 0, 2.1, 0.4, 6.2);
    add(glass, 0, 1.72, 0.96, 2.0, 0.62, 0.1); add(dark, 0, 1.62, 2.72, 2.1, 0.5, 0.14);
    add(0xc9cec4, 0, 1.5, -1.58, 2.3, 2.0, 4.2); add(metal, 0, 2.54, -1.58, 2.34, 0.12, 4.24);
    add(dark, 0, 2.28, 0.52, 2.28, 0.14, 0.14); add(color, 0, 2.2, 1.66, 2.3, 0.32, 0.3);
    for (const z of [-3.06, -2.46, -1.86]) bake(list, UNIT_BOX, 0xffffff, 0, 1.5, z, 2.12, 0.06, 0.06);
    seatPositions.push([-0.5, 1.5, 1.5], [0.5, 1.5, 1.5], [-0.6, 1.5, -0.4], [0.6, 1.5, -0.4], [-0.6, 1.5, -1.4], [0.6, 1.5, -1.4]);
    wheels.push(buildWheel(-1.06, 2.1, 0.56, true), buildWheel(1.06, 2.1, 0.56, true),
      buildWheel(-1.06, -1.6, 0.58, false), buildWheel(1.06, -1.6, 0.58, false),
      buildWheel(-1.06, -2.5, 0.58, false), buildWheel(1.06, -2.5, 0.58, false));
  } else {
    add(color, 0, 0.86, 0, 2.05, 0.62, 4.0); add(color, 0, 1.32, -0.62, 1.96, 0.54, 2.5);
    add(glass, 0, 1.44, 0.56, 1.86, 0.56, 0.08); add(dark, 0, 1.5, -0.62, 1.88, 0.5, 2.34);
    add(metal, 0, 1.72, -0.6, 2.0, 0.06, 2.4); add(dark, 0, 1.82, 0.62, 2.0, 0.08, 0.08);
    for (const x of [-0.86, -0.3, 0.3, 0.86]) bake(list, UNIT_BOX, metal, x, 1.82, -0.6, 0.06, 0.16, 2.2);
    add(dark, 0, 1.1, 2.02, 2.06, 0.3, 0.16); add(0xf2e6b6, -0.6, 1.12, 2.1, 0.3, 0.16, 0.06); add(0xf2e6b6, 0.6, 1.12, 2.1, 0.3, 0.16, 0.06);
    add(0xb9463a, 0, 1.2, -2.04, 1.9, 0.18, 0.08);
    for (const [x, z] of [[-0.48, 0.62], [0.48, 0.62], [-0.48, -0.1], [0.48, -0.1]]) { seatPositions.push([x, 1.24, z]); add(dark, x, 1.22, z, 0.36, 0.14, 0.34); }
    wheels.push(buildWheel(-0.98, 1.28, 0.5, true), buildWheel(0.98, 1.28, 0.5, true), buildWheel(-0.98, -1.28, 0.5, false), buildWheel(0.98, -1.28, 0.5, false));
  }
  const chassis = new THREE.Mesh(finishList(list), VC_MAT); body.add(chassis);
  const wheelPivots = [];
  for (const w of wheels) { group.add(w.steerGroup); wheelPivots.push(w); }
  const shadow = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0x0c1a18, 0.26, false));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; shadow.scale.set(TYPE === 'bike' ? 0.7 : 1.5, 1, TYPE === 'truck' ? 2.6 : 1.7); group.add(shadow);
  const seats = seatPositions.map(([x, y, z]) => { const o = new THREE.Object3D(); o.position.set(x, y, z); body.add(o); return o; });
  const api = {
    group, body, wheels: wheelPivots.map((w) => w.steerGroup), type: TYPE, seats,
    parts: { chassis, body, shadow },
    setColor(next) { chassis.material = material(next); },
    update(dt = 0, speed = 0, steer = 0, tilt = 0) {
      const spin = (speed * dt) / 0.45;
      for (const w of wheelPivots) { w.pivot.rotation.x -= spin; if (w.steer) w.steerGroup.rotation.y = steer * 0.5; }
      body.rotation.z = tilt;
      body.position.y = Math.min(0.08, Math.abs(speed) * 0.002);
    },
  };
  return api;
}

/* ---------------- 物资 ---------------- */
const RARITY_HEX = { common: 0xc9d2cb, uncommon: 0x7ed3a5, rare: 0x6fb7f0, epic: 0xc48bf0, legendary: 0xf5b445 };
const LOOT_TYPE = { weapon: 0, ammo: 1, armor: 2, consumable: 3, throwable: 4, attachment: 5, backpack: 6 };
const LOOT_RARITY_RGB = { common: [0.79, 0.82, 0.8], uncommon: [0.49, 0.83, 0.65], rare: [0.44, 0.72, 0.94], epic: [0.77, 0.55, 0.94], legendary: [0.96, 0.71, 0.27] };
/** 稀有度颜色（sRGB 十六进制），供 InstancedMesh 着色复用。 */
export function rarityColor(rarity) { return RARITY_HEX[rarity] ?? RARITY_HEX.common; }
export function rarityRgb(rarity) { return LOOT_RARITY_RGB[rarity] ?? LOOT_RARITY_RGB.common; }
/** 类别编号，供 InstancedMesh 选几何体。 */
export function lootTypeIndex(type) { return LOOT_TYPE[type] ?? 1; }

/** 地面物资模型：六类外形 + 稀有度光柱（发光圆柱 + 环形光斑）。 */
export function createLootModel(type = 'weapon', itemId = '', rarity = 'common') {
  const group = new THREE.Group();
  const list = createList(), kind = lootTypeIndex(type), col = itemId && weaponClassOf(itemId) && type === 'weapon' ? 0x4a565b : 0xb9b09a;
  if (kind === 0) {
    const cls = weaponClassOf(itemId || 'rifle'), len = GUN_LEN[cls] || 1;
    bake(list, UNIT_BOX, col, 0, 0, 0, 0.1, 0.16, len * 0.62);
    bake(list, UNIT_BOX, 0x2a3336, 0, -0.06, -len * 0.26, 0.09, 0.2, 0.16);
    bake(list, UNIT_CYL, 0x7d8a8d, 0, 0.02, len * 0.4, 0.035, len * 0.34, 0.035, Math.PI / 2);
    if (cls === 'sniper' || cls === 'marksman') bake(list, UNIT_CYL, 0x2a3336, 0, 0.13, 0.1, 0.04, 0.2, 0.04, Math.PI / 2);
    if (cls === 'lmg') bake(list, UNIT_BOX, 0x2a3336, 0, -0.14, 0.1, 0.14, 0.14, 0.14);
  } else if (kind === 1) {
    bake(list, UNIT_BOX, 0xb39a5e, 0, 0, 0, 0.46, 0.28, 0.34);
    bake(list, UNIT_BOX, 0x6f5f38, 0, 0.15, 0, 0.48, 0.04, 0.36);
    bake(list, UNIT_BOX, 0xe8dba4, 0, 0.02, 0.175, 0.2, 0.1, 0.02);
  } else if (kind === 2) {
    bake(list, UNIT_BOX, 0x8fb8cc, 0, 0.05, 0, 0.5, 0.42, 0.28);
    bake(list, UNIT_BOX, 0x5b7f92, 0, 0.05, 0.145, 0.34, 0.3, 0.03);
    bake(list, UNIT_BOX, 0xd5e6ef, 0, 0.28, 0, 0.2, 0.06, 0.2);
  } else if (kind === 3) {
    bake(list, UNIT_CYL, 0xdedbd0, 0, 0, 0, 0.2, 0.34, 0.2);
    bake(list, UNIT_BOX, 0xc4463c, 0, 0.02, 0.18, 0.14, 0.14, 0.03);
    bake(list, UNIT_CYL, 0x9b968a, 0, 0.24, 0, 0.11, 0.1, 0.11);
  } else if (kind === 4) {
    bake(list, UNIT_SPHERE, 0x5e6d5a, 0, 0, 0, 0.19, 0.22, 0.19);
    bake(list, UNIT_CYL, 0x3f4a3c, 0, 0.2, 0, 0.07, 0.12, 0.07);
    bake(list, UNIT_CYL, 0x9c8b5c, 0, 0.28, 0, 0.02, 0.1, 0.02);
    bake(list, UNIT_BOX, 0x3a4538, 0, 0.05, 0, 0.4, 0.04, 0.04);
  } else if (kind === 5) {
    bake(list, UNIT_CYL, 0x4d5b60, 0, 0.04, 0, 0.12, 0.34, 0.12, 0, 0, Math.PI / 2);
    bake(list, UNIT_BOX, 0x2d3639, 0.02, -0.13, 0, 0.2, 0.06, 0.14);
    bake(list, UNIT_CYL, 0x9be3c8, 0, 0.13, 0.15, 0.07, 0.03, 0.07, Math.PI / 2);
  } else {
    bake(list, UNIT_BOX, 0x7e7a5f, 0, 0.02, 0, 0.44, 0.5, 0.28);
    bake(list, UNIT_BOX, 0x64614c, 0, 0.3, 0, 0.3, 0.1, 0.2);
    bake(list, UNIT_BOX, 0x9a9678, 0, -0.02, 0.15, 0.36, 0.3, 0.04);
  }
  const mesh = new THREE.Mesh(finishList(list), VC_MAT);
  if (kind === 0) mesh.position.y = 0.34; group.add(mesh);
  const hex = rarityColor(rarity);
  const pillar = new THREE.Mesh(UNIT_CYL, glowMaterial(hex, 0.22));
  pillar.scale.set(0.22, 1.8, 0.22); pillar.position.y = 0.9; group.add(pillar);
  const ring = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(hex, 0.4));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; ring.scale.setScalar(0.42); group.add(ring);
  const spark = new THREE.Mesh(UNIT_SPHERE, glowMaterial(hex, 0.5));
  spark.scale.setScalar(0.1); spark.position.y = 1.9; group.add(spark);
  group.userData = { kind: 'loot', type, rarity };
  return { group, glow: pillar, ring, spark, parts: { mesh, pillar, ring } };
}

/* ---------------- 建筑 / 树 / 道具 / 空投 / 命名 ---------------- */
const THEME_FALLBACK = Object.freeze({
  roof: [0xae6855, 0x557986, 0x66715c, 0xb78560], wall: [0xe6d6b5, 0xaebcb2, 0xd1c6ac, 0xc8b59d],
  tree: [0x285e53, 0x3a7560, 0x548469], accent: 0xefb657, sand: 0xd5c193, rock: 0x8d968a, grass: 0x7c9e68, road: 0x77847b,
});
function themePick(theme, key, index = 0) {
  const list = theme?.[key] ?? THEME_FALLBACK[key];
  if (Array.isArray(list)) return list[Math.abs(index | 0) % list.length];
  return list ?? THEME_FALLBACK[key];
}

/** 建筑：墙/门洞/独立可淡出屋顶/窗/台阶/招牌。 */
export function createBuilding(building = {}, theme = null) {
  const { x = 0, z = 0, w = 10, d = 9, h = 3.6, rot = 0, roofColor, floorColor, regionId = 0 } = building;
  const group = new THREE.Group(); group.position.set(x, 0, z); group.rotation.y = rot;
  const seed = Math.abs((x * 13.7 + z * 7.3) | 0);
  const wallColor = themePick(theme, 'wall', seed), roof = roofColor ?? themePick(theme, 'roof', seed);
  const wallList = createList(), trimList = createList(), glassList = createList();
  const halfW = w / 2, halfD = d / 2, door = Math.min(2.8, w * 0.32), thickness = 0.34;
  const doorX = (seed % 2 ? 1 : -1) * Math.min(2.2, (w - door) * 0.25);
  const wall = (cx, cz, cw, cd) => bake(wallList, UNIT_BOX, wallColor, cx, h / 2, cz, cw, h, cd);
  wall(0, -halfD + thickness / 2, w, thickness);
  wall(-halfW + thickness / 2, 0, thickness, d);
  wall(halfW - thickness / 2, 0, thickness, d);
  const leftEdge = doorX - door / 2, rightEdge = doorX + door / 2;
  const leftW = leftEdge - -halfW, rightW = halfW - rightEdge;
  if (leftW > 0.02) bake(wallList, UNIT_BOX, wallColor, -halfW + leftW / 2, h / 2, halfD - thickness / 2, leftW, h, thickness);
  if (rightW > 0.02) bake(wallList, UNIT_BOX, wallColor, halfW - rightW / 2, h / 2, halfD - thickness / 2, rightW, h, thickness);
  bake(wallList, UNIT_BOX, wallColor, doorX, h - 0.42, halfD - thickness / 2, door, 0.84, thickness);
  bake(trimList, UNIT_BOX, 0xf0e6cc, 0, h + 0.02, 0, w + 0.3, 0.16, d + 0.3);
  for (const side of [-1, 1]) {
    for (const t of [-0.28, 0.28]) {
      bake(glassList, UNIT_BOX, 0x4a6a72, side * halfW * t * 2, h * 0.58, halfD + 0.03, 1.25, 1.0, 0.06);
      bake(trimList, UNIT_BOX, 0xefe3c4, side * halfW * t * 2, h * 0.58 + 0.62, halfD + 0.07, 1.45, 0.14, 0.16);
      bake(glassList, UNIT_BOX, 0x4a6a72, side * halfW + 0.03, h * 0.58, -halfD * 0.5, 0.06, 1.0, 1.25);
    }
  }
  bake(trimList, UNIT_BOX, 0xd9cbaa, doorX, 0.16, halfD + 0.85, door + 0.8, 0.3, 1.5);
  bake(trimList, UNIT_BOX, 0xcbbd9c, doorX, 0.06, halfD + 1.55, door + 1.4, 0.18, 0.7);
  const walls = new THREE.Mesh(finishList(wallList), VC_MAT); group.add(walls);
  const trims = new THREE.Mesh(finishList(trimList), VC_MAT); group.add(trims);
  const glass = new THREE.Mesh(finishList(glassList), VC_MAT); group.add(glass);
  const roofMesh = new THREE.Mesh(UNIT_BOX, material(roof, { opacity: 1, transparent: true }));
  roofMesh.scale.set(w + 0.9, 0.5, d + 0.9); roofMesh.position.y = h + 0.3; group.add(roofMesh);
  const ridge = new THREE.Mesh(UNIT_BOX, material(themePick(theme, 'wall', seed + 1)));
  ridge.scale.set(w + 1.0, 0.14, 0.5); ridge.position.y = h + 0.62; group.add(ridge);
  const sign = createTextSprite(building.label || building.name || '', '#f6eccb', 40, { plate: 'rgba(26,38,40,.72)' });
  sign.scale.set(3.6, 0.9, 1); sign.position.set(0, h + 1.5, halfD + 0.2); group.add(sign);
  group.userData = { kind: 'building', x, z, w, d, h, roof: roofMesh };
  return { group, roof: roofMesh, walls, parts: { walls, trims, glass, roof: roofMesh, ridge, sign } };
}

/** 树：kind 0 松树（尖塔）、1 阔叶（球冠）、2 枯木/灌木（沙地）。 */
export function createTree(tree = {}, theme = null) {
  const { scale = 1, kind = 0 } = tree;
  const group = new THREE.Group();
  const seed = Math.abs(((tree.x || 0) * 5.1 + (tree.z || 0) * 3.3) | 0);
  const green = themePick(theme, 'tree', seed + (kind | 0));
  const list = createList();
  bake(list, UNIT_CYL, 0x5c4a35, 0, 0.8 * scale, 0, 0.16 * scale, 1.6 * scale, 0.16 * scale);
  if (kind === 1) {
    bake(list, UNIT_SPHERE, green, 0, 2.5 * scale, 0, 1.5 * scale, 1.4 * scale, 1.5 * scale);
    bake(list, UNIT_SPHERE, green, 0.6 * scale, 2.1 * scale, 0.3 * scale, 0.9 * scale, 0.8 * scale, 0.9 * scale);
    bake(list, UNIT_SPHERE, green, -0.55 * scale, 2.2 * scale, -0.35 * scale, 0.85 * scale, 0.75 * scale, 0.85 * scale);
  } else if (kind === 2) {
    bake(list, UNIT_CYL, green, 0, 1.5 * scale, 0, 0.85 * scale, 0.9 * scale, 0.85 * scale);
    bake(list, UNIT_SPHERE, 0x6f7150, 0.3 * scale, 0.9 * scale, 0.2 * scale, 0.5 * scale, 0.4 * scale, 0.5 * scale);
    for (const [dx, dz] of [[0.5, 0.3], [-0.4, 0.45], [0.1, -0.5]]) bake(list, UNIT_BOX, 0x5b5138, dx * scale, 0.25 * scale, dz * scale, 0.3 * scale, 0.5 * scale, 0.3 * scale, dx * 0.4, 0, dz * 0.4);
  } else {
    for (const [y, r] of [[1.7, 1.3], [2.6, 1.0], [3.3, 0.66]]) bake(list, UNIT_CONE, green, 0, y * scale, 0, r * scale, 1.4 * scale, r * scale, 0, seed * 0.3);
  }
  const mesh = new THREE.Mesh(finishList(list), VC_MAT); group.add(mesh);
  const shadow = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0x14251f, 0.16, false));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; shadow.scale.setScalar(1.5 * scale); group.add(shadow);
  group.userData = { kind: 'tree' };
  return { group, parts: { mesh, shadow } };
}

/** 道具/障碍：按 kind 生成外形（crate/barrel/wall/rock/container/barrier/sign/...）。
 *  默认按「单位尺寸」烘焙（w=d=h=1），实例化时用 scale 精确匹配碰撞盒。 */
export function createProp(prop = {}, theme = null) {
  const { kind = 'crate', w = 1, d = 1, h = 1 } = prop;
  const group = new THREE.Group();
  const list = createList();
  const accent = theme?.accent ?? THEME_FALLBACK.accent;
  if (kind === 'barrel' || kind === 'oil') {
    bake(list, UNIT_CYL, accent, 0, h * 0.5, 0, w * 0.5, h, w * 0.5);
    bake(list, UNIT_CYL, 0x3b4448, 0, h * 0.22, 0, w * 0.53, h * 0.1, w * 0.53);
    bake(list, UNIT_CYL, 0x3b4448, 0, h * 0.78, 0, w * 0.53, h * 0.1, w * 0.53);
  } else if (kind === 'container') {
    bake(list, UNIT_BOX, 0xffffff, 0, h * 0.5, 0, w, h, d);
    for (let i = -3; i <= 3; i++) bake(list, UNIT_BOX, 0x8f8f8f, i * w * 0.13, h * 0.5, d * 0.5 + 0.02, 0.1, h * 0.86, 0.05);
    bake(list, UNIT_BOX, 0x5b5b5b, 0, h * 0.94, 0, w * 1.02, 0.12, d * 1.02);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bake(list, UNIT_BOX, 0x6a6a6a, sx * (w * 0.5 - 0.12), h * 0.5, sz * (d * 0.5 - 0.12), 0.2, h, 0.2);
  } else if (kind === 'barrier') {
    bake(list, UNIT_BOX, 0xc7c2b4, 0, h * 0.62, 0, w, h * 0.36, d * 1.1);
    for (let i = -2; i <= 2; i++) bake(list, UNIT_BOX, accent, i * w * 0.2, h * 0.62, 0, w * 0.1, h * 0.37, d * 1.16);
    bake(list, UNIT_BOX, 0x5a5f5c, -w * 0.4, h * 0.24, 0, 0.16, h * 0.5, 0.16);
    bake(list, UNIT_BOX, 0x5a5f5c, w * 0.4, h * 0.24, 0, 0.16, h * 0.5, 0.16);
  } else if (kind === 'wall') {
    bake(list, UNIT_BOX, themePick(theme, 'wall'), 0, h * 0.5, 0, w, h, d);
    bake(list, UNIT_BOX, 0xe8dfc4, 0, h - 0.08, 0, w * 1.02, 0.14, d * 1.02);
  } else if (kind === 'rock') {
    bake(list, UNIT_SPHERE, themePick(theme, 'rock'), 0, h * 0.42, 0, w * 0.62, h * 0.55, d * 0.62);
    bake(list, UNIT_SPHERE, 0x6f7568, w * 0.3, h * 0.3, d * 0.2, w * 0.3, h * 0.3, d * 0.3);
    bake(list, UNIT_SPHERE, 0x7d8479, -w * 0.22, h * 0.62, -d * 0.14, w * 0.26, h * 0.22, d * 0.26);
  } else if (kind === 'vehicle' || kind === 'wreck') {
    bake(list, UNIT_BOX, 0x6d6a5c, 0, h * 0.45, 0, w, h * 0.7, d);
    bake(list, UNIT_BOX, 0x4c5150, 0, h * 0.9, -d * 0.1, w * 0.8, h * 0.4, d * 0.5);
    bake(list, UNIT_CYL, 0x2b3032, -w * 0.3, h * 0.24, d * 0.42, h * 0.3, h * 0.24, h * 0.3, 0, 0, Math.PI / 2);
    bake(list, UNIT_CYL, 0x2b3032, w * 0.3, h * 0.24, d * 0.42, h * 0.3, h * 0.24, h * 0.3, 0, 0, Math.PI / 2);
  } else if (kind === 'hay') {
    bake(list, UNIT_CYL, 0xc9b06a, 0, h * 0.5, 0, w * 0.5, h, d * 0.5, 0, 0, Math.PI / 2);
    bake(list, UNIT_CYL, 0xb59d59, 0, h * 0.5, 0, w * 0.52, h * 0.12, d * 0.52, 0, 0.6, Math.PI / 2);
    bake(list, UNIT_CYL, 0xb59d59, 0, h * 0.5, 0, w * 0.52, h * 0.12, d * 0.52, 0, -0.6, Math.PI / 2);
  } else if (kind === 'dune') {
    bake(list, UNIT_SPHERE, themePick(theme, 'sand'), 0, h * 0.12, 0, w * 0.6, h * 0.5, d * 0.6);
    bake(list, UNIT_SPHERE, themePick(theme, 'sand') + 6, w * 0.2, h * 0.2, d * 0.1, w * 0.3, h * 0.32, d * 0.3);
  } else if (kind === 'tank') {
    bake(list, UNIT_CYL, 0xb7a58a, 0, h * 0.5, 0, w * 0.45, h, w * 0.45);
    bake(list, UNIT_CYL, 0x8c7d66, 0, h * 0.93, 0, w * 0.47, h * 0.08, w * 0.47);
    bake(list, UNIT_BOX, 0x5b5f5c, 0, h * 0.1, 0, w * 0.32, h * 0.2, w * 0.32);
  } else if (kind === 'wagon') {
    bake(list, UNIT_BOX, 0x6d5a4a, 0, h * 0.55, 0, w, h * 0.7, d);
    bake(list, UNIT_BOX, 0x4e4238, 0, h * 0.96, 0, w * 1.02, h * 0.12, d * 1.02);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bake(list, UNIT_CYL, 0x2f3335, sx * w * 0.36, h * 0.2, sz * d * 0.42, h * 0.2, h * 0.1, h * 0.2, 0, 0, Math.PI / 2);
  } else if (kind === 'rail') {
    bake(list, UNIT_BOX, 0x5b5b5b, 0, 0.12, 0, w, 0.16, 0.28);
    for (let i = -3; i <= 3; i++) bake(list, UNIT_BOX, 0x6d5a4a, i * w * 0.14, 0.07, 0, 0.4, 0.12, d * 0.9);
  } else if (kind === 'sign' || kind === 'board') {
    bake(list, UNIT_CYL, 0x5c5142, 0, h * 0.5, 0, 0.09, h, 0.09);
    bake(list, UNIT_BOX, accent, 0, h * 0.86, 0, w, h * 0.38, 0.1);
  } else {
    bake(list, UNIT_BOX, 0x8d7448, 0, h * 0.5, 0, w, h, d);
    bake(list, UNIT_BOX, 0x6d5935, 0, h * 0.98, 0, w * 1.04, h * 0.1, d * 1.04);
    bake(list, UNIT_BOX, 0xc8a86a, -w * 0.32, h * 0.5, d * 0.5 + 0.01, w * 0.16, h * 0.9, 0.03);
    bake(list, UNIT_BOX, 0xc8a86a, w * 0.32, h * 0.5, d * 0.5 + 0.01, w * 0.16, h * 0.9, 0.03);
  }
  const mesh = new THREE.Mesh(finishList(list), VC_MAT); group.add(mesh);
  group.userData = { kind: 'prop' };
  return { group, parts: { mesh } };
}

/** 空投箱：降落伞 + 发光箱体 + 信标。 */
export function createAirdrop() {
  const group = new THREE.Group();
  const list = createList();
  bake(list, UNIT_BOX, 0xb8543f, 0, 0.55, 0, 1.7, 1.0, 1.7);
  bake(list, UNIT_BOX, 0xdad2b8, 0, 1.08, 0, 1.74, 0.14, 1.74);
  bake(list, UNIT_BOX, 0x8c3f2e, 0, 0.55, 0.87, 1.5, 0.12, 0.03);
  bake(list, UNIT_CYL, 0x4b5152, 0, 0.6, 0, 0.1, 0.05, 0.1);
  const crate = new THREE.Mesh(finishList(list), VC_MAT); group.add(crate);
  const beacon = new THREE.Mesh(UNIT_CYL, glowMaterial(0x64d8dc, 0.24));
  beacon.scale.set(0.5, 9, 0.5); beacon.position.y = 4.6; group.add(beacon);
  const ring = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0x64d8dc, 0.36));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; ring.scale.setScalar(1.6); group.add(ring);
  const chute = new THREE.Group(); chute.position.y = 2.2; group.add(chute);
  const canopy = new THREE.Mesh(UNIT_CONE, material(0xdfd6c0, { flat: true }));
  canopy.scale.set(2.4, 1.2, 2.4); canopy.position.y = 4.4; chute.add(canopy);
  group.userData = { kind: 'airdrop' };
  return { group, parts: { crate, beacon, ring, chute } };
}

/** 补给箱/普通箱子（rarity 决定光带颜色）。 */
export function createCrate(rarity = 'common') {
  const group = new THREE.Group();
  const list = createList();
  bake(list, UNIT_BOX, 0x8c7a52, 0, 0.4, 0, 1.1, 0.8, 0.9);
  bake(list, UNIT_BOX, 0x6c5c3c, 0, 0.82, 0, 1.14, 0.08, 0.94);
  bake(list, UNIT_BOX, 0xb7a175, 0, 0.4, 0.46, 0.16, 0.7, 0.04);
  const mesh = new THREE.Mesh(finishList(list), VC_MAT); group.add(mesh);
  const strip = new THREE.Mesh(UNIT_BOX, glowMaterial(rarityColor(rarity), 0.55));
  strip.scale.set(1.16, 0.06, 0.96); strip.position.y = 0.66; group.add(strip);
  group.userData = { kind: 'crate' };
  return { group, glow: strip, parts: { mesh, strip } };
}

/** 标记/信标（ping）：敌人 / 物资 / 移动 / 救命的锥形地标。 */
export function createPingMarker(kind = 'move') {
  const color = kind === 'enemy' ? 0xf05a4c : kind === 'loot' ? 0xf5c453 : kind === 'help' ? 0xf08a5a : 0x7ee0c4;
  const group = new THREE.Group();
  const cone = new THREE.Mesh(UNIT_CONE, glowMaterial(color, 0.9));
  cone.scale.set(0.3, 0.9, 0.3); cone.rotation.x = Math.PI; cone.position.y = 3.4; group.add(cone);
  const ring = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(color, 0.5));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; ring.scale.setScalar(1.1); group.add(ring);
  const pole = new THREE.Mesh(UNIT_CYL, glowMaterial(color, 0.25));
  pole.scale.set(0.08, 3.2, 0.08); pole.position.y = 1.6; group.add(pole);
  group.userData = { kind: 'ping', ping: kind, color };
  return { group, parts: { cone, ring, pole }, color };
}

/** 自动炮塔（horde 模式基地升级）。 */
export function createTurret(color = 0x6fc2a1) {
  const group = new THREE.Group();
  const list = createList();
  bake(list, UNIT_CYL, 0x3a464a, 0, 0.28, 0, 0.6, 0.56, 0.6);
  bake(list, UNIT_BOX, 0x2c3639, 0, 0.78, 0, 0.42, 0.42, 0.42);
  bake(list, UNIT_BOX, color, 0, 0.8, 0.42, 0.16, 0.16, 0.72);
  bake(list, UNIT_CYL, 0x8b979b, 0, 1.0, 0, 0.06, 0.16, 0.06);
  const base = new THREE.Mesh(finishList(list), VC_MAT); group.add(base);
  const head = new THREE.Group(); head.position.y = 1.0; group.add(head);
  const headList = createList();
  bake(headList, UNIT_BOX, 0x39474b, 0, 0, 0, 0.46, 0.3, 0.5);
  bake(headList, UNIT_CYL, 0xa2b0b2, 0, 0.02, 0.55, 0.06, 0.8, 0.06, Math.PI / 2);
  bake(headList, UNIT_BOX, color, 0, 0.2, 0, 0.2, 0.06, 0.24);
  const barrel = new THREE.Mesh(finishList(headList), VC_MAT); head.add(barrel);
  const light = new THREE.Mesh(UNIT_SPHERE, glowMaterial(color, 0.85));
  light.scale.setScalar(0.09); light.position.set(0.18, 0.06, 0.2); head.add(light);
  group.userData = { kind: 'turret' };
  return { group, parts: { base, head, barrel, light }, head };
}
