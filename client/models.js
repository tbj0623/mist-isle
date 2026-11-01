// 雾岛突围 / MIST ISLE 1.0 — 程序化模型工厂（owner: renderfx）
// 约束：实例共享缓存几何体/材质/纹理（Map 缓存），实例化时不新建 material；
// disposeModel 只释放非共享资源，避免动态模型反复进出导致几何/纹理泄漏。
import * as THREE from 'three';

const TAU = Math.PI * 2;

/* ---------------- 共享资源缓存 ---------------- */
const GEO = new Map(), MAT = new Map(), SPRITE_MAT = new Map(), CHAR_GEO = new Map(), GUN_GEO = new Map();
const SHARED_GEO = new WeakSet(), SHARED_MAT = new WeakSet(), SHARED_TEX = new WeakSet();
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
export const UNIT_SPHERE = new THREE.SphereGeometry(1, 8, 6);
export const UNIT_CONE = new THREE.ConeGeometry(1, 1, 8);
export const UNIT_WHEEL = new THREE.CylinderGeometry(1, 1, 1, 12);
// 接触阴影圆盘：18 段完全没必要（俯视角下 1.5m 的暗斑，6 段就够圆了）。
// 1548 个实例 × 18 tri = 27,864 tri，改成 6 段后只要 9,288 tri（-67%），且这些是
// 半透明圆盘，还参与 overdraw，减少顶点同时减少填充压力。
export const UNIT_CIRCLE = new THREE.CircleGeometry(1, 6);
// 岩石专用低模：IcosahedronGeometry(1, 0) 只有 20 tri，比 SphereGeometry(1,8,6) 的
// 80 tri 少 75%，且 20 面体本身就是低多边形岩石的经典形状（棱角分明，比光滑球体更像石头）。
// 实测：510 块岩石 × 3 个球体 = 122,400 tri，占全场景三角面的 47% —— 单这一项就能
// 把 259k 降到 147k，为角色/特效腾出预算。
export const UNIT_ROCK = new THREE.IcosahedronGeometry(1, 0);
[UNIT_BOX, UNIT_CYL, UNIT_SPHERE, UNIT_CONE, UNIT_WHEEL, UNIT_CIRCLE, UNIT_ROCK].forEach((g) => SHARED_GEO.add(g));
export const VC_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
SHARED_MAT.add(VC_MAT);
const ROPE_MAT = new THREE.LineBasicMaterial({ color: 0xeee8d2, transparent: true, opacity: 0.75 });
SHARED_MAT.add(ROPE_MAT);

function cached(store, key, make, pool) {
  let value = store.get(key);
  if (!value) { value = make(); store.set(key, value); pool.add(value); }
  return value;
}

/** 是否为模块级共享几何（scene.js 的 disposeWorld 用它避免误删共享资源）。 */
export function isSharedGeometry(geometry) { return SHARED_GEO.has(geometry); }
/** 是否为模块级共享材质。 */
export function isSharedMaterial(material) { return SHARED_MAT.has(material); }

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
    data = {
      pos: g.attributes.position.array,
      nor: g.attributes.normal.array,
      col: g.attributes.color ? g.attributes.color.array : null,
    };
    BAKED.set(geometry, data);
  }
  return data;
}

/** 新建一个合并列表。 */
export function createList() { return { pos: [], nor: [], col: [] }; }

/** 把任意几何体按 TRS 烘焙进列表；color 为 sRGB 十六进制。 */
export function bake(list, geometry, color, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0) {
  _m4.compose(_pos.set(x, y, z), _quat.setFromEuler(_euler.set(rx, ry, rz)), _scl.set(sx, sy, sz));
  return bakeMatrix(list, geometry, color, _m4);
}

/**
 * 按**现成矩阵**烘焙（等价于 bake 的 TRS，但允许调用方自行组合 T·R·S）。
 * 法线走 getNormalMatrix（= 逆转置），非等比缩放、镜像矩阵下方向都正确 ——
 * 这正是 InstancedMesh 做不到的（它只做 mat3(instanceMatrix)·n）。
 * color 为 null 时保留几何自带的顶点色（用于「模板本身已着色」的场景，
 * 例如按 kind 复用一个 createProp 模板烘焙出 N 个实例）。
 */
export function bakeMatrix(list, geometry, color, matrix) {
  const data = bakedData(geometry), count = data.pos.length / 3;
  const e = matrix.elements, n = _m3.getNormalMatrix(matrix).elements;
  const keepColor = color == null && !!data.col;
  if (!keepColor) _color.set(color == null ? 0xffffff : color);
  for (let i = 0; i < count; i++) {
    const j = i * 3, px = data.pos[j], py = data.pos[j + 1], pz = data.pos[j + 2];
    list.pos.push(e[0] * px + e[4] * py + e[8] * pz + e[12], e[1] * px + e[5] * py + e[9] * pz + e[13], e[2] * px + e[6] * py + e[10] * pz + e[14]);
    let nx = n[0] * data.nor[j] + n[3] * data.nor[j + 1] + n[6] * data.nor[j + 2];
    let ny = n[1] * data.nor[j] + n[4] * data.nor[j + 1] + n[7] * data.nor[j + 2];
    let nz = n[2] * data.nor[j] + n[5] * data.nor[j + 1] + n[8] * data.nor[j + 2];
    // 不用 Math.hypot：它带溢出保护与参数归一化，无法内联，比 sqrt 慢 2–10×。
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    list.nor.push(nx / len, ny / len, nz / len);
    if (keepColor) list.col.push(data.col[j], data.col[j + 1], data.col[j + 2]);
    else list.col.push(_color.r, _color.g, _color.b);
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
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
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
/** 远景 LOD 阈值（米）：超过这个距离只画合并低模，隐藏 7 个分件 mesh。 */
export const CHARACTER_LOD_DISTANCE = 40;

/* ---------------- 头顶血条 ----------------
 * 原来是 bg / fill / armor 三个 mesh，各走一次 draw call（30 个可见玩家 = 90 call）。
 * 现在合并成 **1 个 mesh / 1 draw call**：
 *   - 槽底、血量条、护甲条三个四边形烘进同一份几何，用 float 属性 aPart 区分（0/1/2）；
 *   - 血量/护甲宽度不进几何（那会要求每个玩家一份顶点缓冲），而是放在顶点属性 vU
 *     （沿条长 0→1）与 uniform uHp/uArmor 的比较里 —— 每帧只改 uniform，零 CPU 顶点写。
 *   - 材质是 ShaderMaterial，无光照无雾；所有血条共用同一个 program（只有 uniform 不同），
 *     所以既不会多个 program，也不会多 draw call。
 */
const HP_BAR_GEOMETRY = (() => {
  // 三个四边形：[x0, x1] × [y0, y1]，z 依次抬高避免共面
  const quads = [
    { part: 0, x0: -0.525, x1: 0.525, y0: -0.06, y1: 0.06, z: 0 },        // 槽底/描边
    { part: 1, x0: -0.5, x1: 0.5, y0: -0.04, y1: 0.04, z: 0.002 },        // 血量
    { part: 2, x0: -0.5, x1: 0.5, y0: -0.1075, y1: -0.0725, z: 0.002 },   // 护甲
  ];
  const pos = [], part = [], u = [], idx = [];
  for (const q of quads) {
    const base = pos.length / 3;
    // 左下、右下、右上、左上
    pos.push(q.x0, q.y0, q.z, q.x1, q.y0, q.z, q.x1, q.y1, q.z, q.x0, q.y1, q.z);
    part.push(q.part, q.part, q.part, q.part);
    u.push(0, 1, 1, 0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geometry.setAttribute('aU', new THREE.Float32BufferAttribute(u, 1));
  geometry.setIndex(idx);
  geometry.computeBoundingSphere();
  SHARED_GEO.add(geometry);
  return geometry;
})();

/** 血条材质模板（每个血条 clone 一份以承载自己的 uHp/uArmor；program 仍只有一份）。 */
const HP_BAR_MATERIAL_TEMPLATE = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.FrontSide,
  uniforms: {
    uHp: { value: 1 }, uArmor: { value: 1 }, uArmorOn: { value: 1 },
    uHpColor: { value: new THREE.Color(0x77e08f) },
    uArmorColor: { value: new THREE.Color(0x76b8f0) },
    uSlotColor: { value: new THREE.Color(0x11201e) },
  },
  vertexShader: /* glsl */`
    attribute float aPart;
    attribute float aU;
    varying float vPart;
    varying float vU;
    void main() {
      vPart = aPart; vU = aU;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uHp, uArmor, uArmorOn;
    uniform vec3 uHpColor, uArmorColor, uSlotColor;
    varying float vPart;
    varying float vU;
    void main() {
      vec3 color;
      float alpha;
      if (vPart < 0.5) { color = uSlotColor; alpha = 0.62; }
      else if (vPart < 1.5) { color = uHpColor; alpha = step(vU, uHp) * 0.95; }
      else { color = uArmorColor; alpha = step(vU, uArmor) * uArmorOn * 0.9; }
      if (alpha <= 0.001) discard;
      gl_FragColor = vec4(color, alpha);
      #include <colorspace_fragment>
    }`,
});
const HP_BAR_COLORS = [new THREE.Color(0x77e08f), new THREE.Color(0xf0c85a), new THREE.Color(0xf06a54)];

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
  // 远景 LOD：charGeometries 早就合并好了 geo.low（1 个几何 = 全身），但一直没人用。
  // 近处 7 个分件 mesh 各自 1 draw call（躯干/背包/头/双臂/双腿）+ 枪 + 枪口 = 约 14 call/人；
  // 超过 CHARACTER_LOD_DISTANCE 后只保留 low + 阴影，分件整体隐藏。
  const low = new THREE.Mesh(geo.low, VC_MAT); low.visible = false; body.add(low);
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
  // 近景分件（LOD 高）与远景分件（LOD 低）分开管理，toggle 时整体切 visible
  const detailParts = [torso, backpack, band, head, armL, armR, legL, legR, gun, flash];
  let lodLevel = 0;
  const api = {
    group, pose: 'normal', weapon: 'rifle', lod: 0,
    parts: { body, head, torso, armL, armR, legL, legR, gun, muzzle, chute, shadow, backpack, labelAnchor, low },
    /** 0 = 近景分件（带肢体动画），1 = 远景合并低模（1 draw call）。 */
    setLod(level) {
      const next = level >= 1 ? 1 : 0;
      if (next === lodLevel) return;
      lodLevel = next; api.lod = next;
      for (const p of detailParts) p.visible = next === 0;
      if (next === 0) flash.visible = flashTime > 0;
      // 枪口火光属于近景细节：低模下即使开火也不再单独绘制。
      // 可见性只由本方法 + main/scene 的「开火时置 true」控制，两者互不覆盖。
      if (next === 1) muzzle.visible = false;
      low.visible = next === 1;
    },
    setWeapon(weaponId, cls) {
      const klass = cls || weaponClassOf(weaponId);
      api.weapon = klass; gunMesh.geometry = gunGeometries(klass);
      muzzle.position.set(0, 0.04, (GUN_LEN[klass] || 1) + 0.06);
    },
    playRecoil() { recoil = 1; },
    setPose(state = 'normal') { api.pose = POSES[state] ? state : 'normal'; },
    setTeamColor(color) { band.material = material(color); },
    hitFlash(seconds = 0.16) {
      flashTime = Math.max(flashTime, seconds);
      if (lodLevel === 0) flash.visible = true;   // 远景低模不做受击闪，保持 1 draw call
    },
    update(dt = 0, info = {}) {
      time += dt;
      recoil = Math.max(0, recoil - dt * 6.5);
      if (flashTime > 0) { flashTime -= dt; if (flashTime <= 0) flash.visible = false; }
      if (lodLevel === 1) { chute.rotation.z = Math.sin(time * 1.7) * 0.06; return; }
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

/**
 * 头顶血条：**1 mesh / 1 draw call**。返回 Group，`userData` 上：
 *   setHealth(hpRatio) / setArmor(armorRatio | 0 表示隐藏护甲条)
 * 血量/护甲颜色沿用旧规则（>0.55 绿、>0.25 黄、否则红）。
 */
export function createHealthBar() {
  const group = new THREE.Group();
  const material = HP_BAR_MATERIAL_TEMPLATE.clone();
  material.uniforms.uHpColor = { value: HP_BAR_COLORS[0].clone() };
  SHARED_MAT.add(material);
  const mesh = new THREE.Mesh(HP_BAR_GEOMETRY, material);
  mesh.frustumCulled = false;
  group.add(mesh);
  group.visible = false;
  group.userData = {
    mesh,
    setHealth(ratio) {
      const r = ratio > 1 ? 1 : ratio > 0 ? ratio : 0;
      material.uniforms.uHp.value = Math.max(0.02, r);
      material.uniforms.uHpColor.value.copy(r > 0.55 ? HP_BAR_COLORS[0] : r > 0.25 ? HP_BAR_COLORS[1] : HP_BAR_COLORS[2]);
    },
    setArmor(ratio) {
      const r = ratio > 1 ? 1 : ratio > 0 ? ratio : 0;
      material.uniforms.uArmor.value = Math.max(0.02, r);
      material.uniforms.uArmorOn.value = r > 0.02 ? 1 : 0;
    },
  };
  return group;
}
/** 车用血条：和角色共用几何/着色器，只是颜色偏黄/红。 */
export function setHealthBarColor(bar, hex) {
  const m = bar?.userData?.mesh?.material;
  if (m?.uniforms?.uHpColor) m.uniforms.uHpColor.value.set(hex);
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
      // ShaderMaterial 的 clone 是每血条一份：program 由 three 内部按 cacheKey 共享，
      // 释放时只清 uniform/引用，不会影响其它血条。
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
    // anisotropy 4 → 1：文字牌在俯视角下几乎正对相机，屏幕空间纹理拉伸极小，
    // 各向异性过滤看不到任何收益，却让移动端每个片元多采 4 次样。
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 1;
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

/**
 * 载具：buggy/jeep/bike/truck 四种明显不同轮廓；轮子可转、车身可倾斜。
 *
 * 车身几何按 `type|color` 缓存（SHARED_GEO）。车色由 shared/simulation.mjs 的
 * VEHICLES 表按 type 固定给出（buggy 0xd8a24a / jeep 0x6f8f6a / bike 0xb05a4a /
 * truck 0x7a8a94），一局 12 辆车最多 4 种几何；旧实现每辆车新建一份合并几何，
 * 反复进出对局会让 geometries 每局 +12，且这些几何每局内容完全一样。
 */
export function createVehicle(type = 'jeep', color = 0xe9b766) {
  const TYPE = String(type || 'jeep').toLowerCase();
  const variant = vehicleVariant(TYPE, color);
  const group = new THREE.Group(), body = new THREE.Group(); group.add(body);
  const wheels = variant.wheelSpecs.map(([x, z, r, steer]) => buildWheel(x, z, r, steer));
  const chassis = new THREE.Mesh(variant.geometry, VC_MAT); body.add(chassis);
  const wheelPivots = [];
  for (const w of wheels) { group.add(w.steerGroup); wheelPivots.push(w); }
  const shadow = new THREE.Mesh(UNIT_CIRCLE, glowMaterial(0x0c1a18, 0.26, false));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; shadow.scale.set(TYPE === 'bike' ? 0.7 : 1.5, 1, TYPE === 'truck' ? 2.6 : 1.7); group.add(shadow);
  const seats = variant.seatPositions.map(([x, y, z]) => { const o = new THREE.Object3D(); o.position.set(x, y, z); body.add(o); return o; });
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

/**
 * 车身变体（按 type|color 缓存）：合并几何 + 轮位 + 座位点。
 *
 * 旧实现把这段烘焙直接放在 createVehicle 里，因此**每辆车**都会新建一份合并几何
 * （一局 12 辆 = 12 个 geometry），反复进出对局时每局再 +12。车色由
 * shared/simulation.mjs 的 VEHICLES 表按 type 固定，所以 type|color 的组合只有 4 类，
 * 缓存后 geometry 数一次到位、不再随对局增长。
 */
function vehicleVariant(TYPE, color) {
  return cached(GEO, `veh:${TYPE}|${color}`, () => {
    const list = createList();
    const dark = 0x232c30, glass = 0x3d5f68, metal = 0x8b979b;
    const wheelSpecs = [], seatPositions = [];
    const add = (c, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0) => bake(list, UNIT_BOX, c, x, y, z, w, h, d, rx, ry, rz);
    if (TYPE === 'bike') {
      add(color, 0, 0.62, 0, 0.26, 0.3, 1.5); add(dark, 0, 0.42, -0.1, 0.22, 0.36, 0.5);
      add(color, 0, 0.82, 0.5, 0.3, 0.24, 0.42); add(dark, 0, 0.86, 0.02, 0.32, 0.12, 0.72);
      add(metal, 0, 0.98, 0.42, 0.7, 0.05, 0.05); add(metal, -0.2, 1.06, 0.36, 0.05, 0.2, 0.05); add(metal, 0.2, 1.06, 0.36, 0.05, 0.2, 0.05);
      add(dark, 0, 0.72, -0.66, 0.34, 0.2, 0.34); add(0xf2e6b6, 0, 0.9, 0.74, 0.09, 0.09, 0.03);
      wheelSpecs.push([0, 0.92, 0.42, true], [0, -0.86, 0.44, false]);
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
      wheelSpecs.push([-0.82, 0.82, 0.42, true], [0.82, 0.82, 0.42, true], [-0.84, -0.86, 0.44, false], [0.84, -0.86, 0.44, false]);
    } else if (TYPE === 'truck') {
      add(color, 0, 1.05, 1.65, 2.2, 1.1, 2.1); add(dark, 0, 0.6, 0, 2.1, 0.4, 6.2);
      add(glass, 0, 1.72, 0.96, 2.0, 0.62, 0.1); add(dark, 0, 1.62, 2.72, 2.1, 0.5, 0.14);
      add(0xc9cec4, 0, 1.5, -1.58, 2.3, 2.0, 4.2); add(metal, 0, 2.54, -1.58, 2.34, 0.12, 4.24);
      add(dark, 0, 2.28, 0.52, 2.28, 0.14, 0.14); add(color, 0, 2.2, 1.66, 2.3, 0.32, 0.3);
      for (const z of [-3.06, -2.46, -1.86]) bake(list, UNIT_BOX, 0xffffff, 0, 1.5, z, 2.12, 0.06, 0.06);
      seatPositions.push([-0.5, 1.5, 1.5], [0.5, 1.5, 1.5], [-0.6, 1.5, -0.4], [0.6, 1.5, -0.4], [-0.6, 1.5, -1.4], [0.6, 1.5, -1.4]);
      wheelSpecs.push([-1.06, 2.1, 0.56, true], [1.06, 2.1, 0.56, true],
        [-1.06, -1.6, 0.58, false], [1.06, -1.6, 0.58, false],
        [-1.06, -2.5, 0.58, false], [1.06, -2.5, 0.58, false]);
    } else {
      add(color, 0, 0.86, 0, 2.05, 0.62, 4.0); add(color, 0, 1.32, -0.62, 1.96, 0.54, 2.5);
      add(glass, 0, 1.44, 0.56, 1.86, 0.56, 0.08); add(dark, 0, 1.5, -0.62, 1.88, 0.5, 2.34);
      add(metal, 0, 1.72, -0.6, 2.0, 0.06, 2.4); add(dark, 0, 1.82, 0.62, 2.0, 0.08, 0.08);
      for (const x of [-0.86, -0.3, 0.3, 0.86]) bake(list, UNIT_BOX, metal, x, 1.82, -0.6, 0.06, 0.16, 2.2);
      add(dark, 0, 1.1, 2.02, 2.06, 0.3, 0.16); add(0xf2e6b6, -0.6, 1.12, 2.1, 0.3, 0.16, 0.06); add(0xf2e6b6, 0.6, 1.12, 2.1, 0.3, 0.16, 0.06);
      add(0xb9463a, 0, 1.2, -2.04, 1.9, 0.18, 0.08);
      for (const [x, z] of [[-0.48, 0.62], [0.48, 0.62], [-0.48, -0.1], [0.48, -0.1]]) { seatPositions.push([x, 1.24, z]); add(dark, x, 1.22, z, 0.36, 0.14, 0.34); }
      wheelSpecs.push([-0.98, 1.28, 0.5, true], [0.98, 1.28, 0.5, true], [-0.98, -1.28, 0.5, false], [0.98, -1.28, 0.5, false]);
    }
    return { geometry: finishList(list), wheelSpecs, seatPositions };
  }, SHARED_GEO);
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
    // 集装箱箱体不能是纯白：纯白顶点色在强平行光下会被 ACES 色调映射推到接近 220 的
    // 灰白（实测 218,219,213），在屋顶/墙面上看就是一条条白色斜条纹。
    // 这里用主题色派生一个偏冷的钢灰，并保留原有用白色当底、靠 vertexColors 叠色的意图。
    bake(list, UNIT_BOX, 0xcfd6d2, 0, h * 0.5, 0, w, h, d);
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
    // 用 20 面体而非球体：俯视角低多边形下棱角更明确，三角形从 240/块降到 60/块。
    bake(list, UNIT_ROCK, themePick(theme, 'rock'), 0, h * 0.42, 0, w * 0.62, h * 0.55, d * 0.62);
    bake(list, UNIT_ROCK, 0x6f7568, w * 0.3, h * 0.3, d * 0.2, w * 0.3, h * 0.3, d * 0.3);
    bake(list, UNIT_ROCK, 0x7d8479, -w * 0.22, h * 0.62, -d * 0.14, w * 0.26, h * 0.22, d * 0.26);
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
  } else if (kind === 'plank') {
    // 木栈道板条（码头/观景台）
    bake(list, UNIT_BOX, 0x9a7a52, 0, h * 0.5, 0, w, h, d);
    bake(list, UNIT_BOX, 0x7d6142, 0, h * 0.5, 0, w * 0.98, h * 0.4, d * 1.02);
    for (let i = -1; i <= 1; i++) bake(list, UNIT_BOX, 0x6d5334, i * w * 0.3, h * 0.62, 0, 0.1, h * 0.26, d * 1.04);
  } else if (kind === 'post') {
    bake(list, UNIT_CYL, 0x6d5334, 0, h * 0.5, 0, w * 0.5, h, d * 0.5);
    bake(list, UNIT_CYL, 0x54402a, 0, h * 0.86, 0, w * 0.56, h * 0.12, d * 0.56);
  } else if (kind === 'hull') {
    // 倒扣船壳
    bake(list, UNIT_SPHERE, 0x6d5a4a, 0, h * 0.1, 0, w * 0.5, h * 0.9, d * 0.5);
    bake(list, UNIT_BOX, 0x5a4a3c, 0, h * 0.02, 0, w * 0.92, h * 0.18, d * 0.72);
    bake(list, UNIT_BOX, 0x8a7355, 0, h * 0.34, 0, w * 0.5, h * 0.1, d * 0.1);
  } else if (kind === 'pool') {
    // 水面（上层水池/下层水潭）：极薄圆盘
    bake(list, UNIT_CYL, 0x6fa6ad, 0, h * 0.5, 0, w * 0.5, h, d * 0.5);
    bake(list, UNIT_CYL, 0x8fc4c8, 0, h * 0.5, 0, w * 0.42, h * 1.4, d * 0.42);
  } else if (kind === 'deck') {
    // 桥面
    bake(list, UNIT_BOX, 0x8b8f8a, 0, h * 0.5, 0, w, h, d);
    bake(list, UNIT_BOX, 0x9da19c, 0, h * 0.82, 0, w * 0.96, h * 0.1, d * 0.9);
  } else if (kind === 'beam') {
    bake(list, UNIT_BOX, 0x6f6a5a, 0, h * 0.5, 0, w, h, d);
    bake(list, UNIT_BOX, 0x54503f, 0, h * 0.5, 0, w * 0.98, h * 0.3, d * 0.5);
  } else if (kind === 'radome') {
    bake(list, UNIT_SPHERE, 0xeaf0e8, 0, h * 0.52, 0, w * 0.5, h * 0.55, d * 0.5);
    bake(list, UNIT_CYL, 0xc3cdc6, 0, h * 0.2, 0, w * 0.5, h * 0.4, d * 0.5);
  } else if (kind === 'crusher') {
    bake(list, UNIT_BOX, 0x8a7050, 0, h * 0.42, 0, w, h * 0.84, d);
    bake(list, UNIT_CONE, 0x6d5a3f, 0, h * 0.92, 0, w * 0.46, h * 0.3, d * 0.46, Math.PI);
    for (let i = -1; i <= 1; i++) bake(list, UNIT_CYL, 0x5b5b5b, i * w * 0.22, h * 0.2, d * 0.5, w * 0.08, h * 0.4, w * 0.08, Math.PI / 2);
  } else if (kind === 'towerbase') {
    bake(list, UNIT_CYL, 0x8d968a, 0, h * 0.14, 0, w * 0.5, h * 0.28, d * 0.5);
    bake(list, UNIT_CYL, 0x6f7873, 0, h * 0.5, 0, w * 0.34, h, d * 0.34);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      bake(list, UNIT_BOX, 0x59625d, Math.cos(a) * w * 0.4, h * 0.36, Math.sin(a) * d * 0.4, 0.4, h * 0.7, 0.4);
    }
  } else if (kind === 'pipe') {
    bake(list, UNIT_CYL, 0x9a8a6a, 0, h * 0.5, 0, w * 0.5, h, d * 0.5, 0, 0, Math.PI / 2);
    bake(list, UNIT_BOX, 0x6d6152, 0, h * 0.5, d * 0.4, w * 0.9, h * 0.5, d * 0.4);
  } else if (kind === 'crane') {
    bake(list, UNIT_BOX, 0x8b979b, 0, h * 0.5, 0, w * 0.2, h, d * 0.2);
    bake(list, UNIT_BOX, accent, 0, h * 0.94, 0, w, h * 0.1, d * 0.24);
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

/* ---------------- 地标（每图 4 个独特的视觉记忆点） ---------------- */
/**
 * 地标模型：`createLandmark(type)` 返回单个合并几何（1 draw call），
 * 由 scene.js 一次性摆到 world.landmarks 的坐标上。
 * type 与 shared/data/maps.mjs 的 landmark.kind 一一对应。
 */
export function createLandmark(type = 'signal_tower', theme = null) {
  const key = `lm:${type}|${theme?.accent ?? 0}|${theme?.tree?.[0] ?? 0}`;
  return cached(GEO, key, () => {
    const list = createList();
    const accent = theme?.accent ?? 0xefb657;
    const steel = 0x6f7873, darkSteel = 0x50585a, rust = 0x8a5b3f, sand = 0xc9ab7d;
    const concrete = 0xb9b6a8, glassy = 0x4a6a72, wood = 0x9a7a52;
    const glowParts = [];   // 单独发光的部件（灯/光柱）
    const g = (c, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0) => bake(list, UNIT_BOX, c, x, y, z, w, h, d, rx, ry, rz);
    const cy = (c, x, y, z, r, h, rx = 0, ry = 0, rz = 0) => bake(list, UNIT_CYL, c, x, y, z, r, h, r, rx, ry, rz);
    const sp = (c, x, y, z, r, h = r, d = r) => bake(list, UNIT_SPHERE, c, x, y, z, r, h, d);
    const co = (c, x, y, z, r, h, rx = 0, ry = 0, rz = 0) => bake(list, UNIT_CONE, c, x, y, z, r, h, r, rx, ry, rz);

    switch (type) {
      case 'signal_tower': {
        // 40m 桁架塔：四根外柱 + 交叉斜撑 + 三层平台 + 顶部天线
        const H = 40, base = 7.5, top = 2.6;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + Math.PI / 4;
          const bx = Math.cos(a) * base, bz = Math.sin(a) * base;
          const tx = Math.cos(a) * top, tz = Math.sin(a) * top;
          // 柱身分段（带收分）
          for (let s = 0; s < 8; s++) {
            const t0 = s / 8, t1 = (s + 1) / 8;
            const x0 = bx + (tx - bx) * t0, z0 = bz + (tz - bz) * t0;
            const x1 = bx + (tx - bx) * t1, z1 = bz + (tz - bz) * t1;
            const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, mh = H / 8;
            g(steel, mx, mh * (s + 0.5), mz, 1.0, mh, 1.0);
          }
        }
        // 交叉斜撑（每 10m 一层）
        for (let lvl = 0; lvl < 4; lvl++) {
          const y = lvl * 10 + 5;
          const rr = base + (top - base) * ((y) / H);
          for (let i = 0; i < 4; i++) {
            const a0 = (i / 4) * TAU + Math.PI / 4;
            const a1 = ((i + 1) / 4) * TAU + Math.PI / 4;
            const x0 = Math.cos(a0) * rr, z0 = Math.sin(a0) * rr;
            const x1 = Math.cos(a1) * rr, z1 = Math.sin(a1) * rr;
            const len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
            const ang = Math.atan2(x1 - x0, z1 - z0);
            g(darkSteel, (x0 + x1) / 2, y, (z0 + z1) / 2, 0.34, 0.34, len, 0, ang, 0);
          }
        }
        // 三层平台
        for (let f = 0; f < 3; f++) {
          const y = 10 + f * 10;
          const r = 5.4 - f * 0.9;
          bake(list, UNIT_CYL, f === 2 ? accent : concrete, 0, y, 0, r, 0.34, r);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * TAU;
            g(darkSteel, Math.cos(a) * r, y + 0.6, Math.sin(a) * r, 0.22, 1.0, 0.22);
          }
          bake(list, UNIT_CYL, 0x8d968a, 0, y + 0.72, 0, r, 0.1, r);
        }
        // 顶部机房 + 天线 + 警示灯
        g(concrete, 0, 32.4, 0, 5.2, 3.4, 5.2);
        g(darkSteel, 0, 34.3, 0, 5.6, 0.4, 5.6);
        cy(steel, 0, 37.5, 0, 0.34, 7.0);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + 0.4;
          g(steel, Math.cos(a) * 1.4, 36.0, Math.sin(a) * 1.4, 0.18, 4.2, 0.18);
        }
        sp(accent, 0, 41.2, 0, 0.55);
        glowParts.push({ color: accent, x: 0, y: 41.2, z: 0, r: 0.7 });
        // 基座
        bake(list, UNIT_CYL, concrete, 0, 0.8, 0, 9.0, 1.6, 9.0);
        break;
      }
      case 'dock': {
        // 废弃渔村码头：木栈道 + 桩 + 鱼市棚 + 倒扣船壳
        for (let k = -1; k <= 1; k++) {
          const ang = k * 0.36;
          const ox = Math.cos(ang + Math.PI / 2) * k * 7;
          const oz = Math.sin(ang + Math.PI / 2) * k * 7;
          const len = k === 0 ? 23 : 18;
          for (let i = 0; i < Math.round(len / 1.4); i++) {
            const t = (i + 0.5) / Math.round(len / 1.4) * len;
            g(wood, ox + Math.sin(ang) * t, 0.16, oz + Math.cos(ang) * t, 3.4, 0.3, 1.5, 0, ang, 0);
          }
          for (let i = 0; i < 6; i++) {
            const t = (i / 5) * len;
            for (const side of [-1, 1]) {
              const px = Math.cos(ang) * 1.6 * side, pz = -Math.sin(ang) * 1.6 * side;
              cy(0x6d5334, ox + Math.sin(ang) * t + px, 0.9, oz + Math.cos(ang) * t + pz, 0.16, 1.9);
            }
          }
        }
        // 鱼市棚（三间）
        for (let i = 0; i < 3; i++) {
          const x = (i - 1) * 8.4, z = -9.5;
          g(0xb8a98a, x, 1.8, z, 7.4, 3.6, 6.6);
          bake(list, UNIT_CONE, 0x8a5b3f, x, 4.4, z, 5.2, 1.8, 5.2);
          g(glassy, x, 2.0, z + 3.35, 2.6, 1.4, 0.2);
        }
        // 倒扣船壳
        for (const [x, z, s] of [[10, -4, 1], [-12, -3, 0.85], [5, 8, 0.7]]) {
          bake(list, UNIT_SPHERE, 0x6d5a4a, x, 0.7, z, 2.8 * s, 1.5 * s, 1.1 * s, 0, 0.4, 0);
        }
        // 灯塔式小浮标
        cy(accent, 13, 3.0, 12, 0.36, 4.0);
        sp(accent, 13, 5.4, 12, 0.5);
        glowParts.push({ color: accent, x: 13, y: 5.4, z: 12, r: 0.6 });
        break;
      }
      case 'radar_station': {
        // 雷达站：半球罩 + 抛物面天线 + 机房 + 天线阵
        const hillH = 9;
        bake(list, UNIT_CYL, concrete, 0, hillH - 0.4, 0, 17, 1.2, 17);
        g(0xdde4dc, 0, hillH + 2.6, 0, 10, 6.0, 10);
        // 半球罩（用半球）
        bake(list, UNIT_SPHERE, 0xeaf0e8, 0, hillH + 5.6, 0, 5.2, 4.4, 5.2);
        g(0xc3cdc6, 0, hillH + 5.6, 0, 10.5, 0.5, 10.5);
        // 抛物面天线（用圆锥近似碟形）+ 支架
        cy(steel, 8.5, hillH + 3.2, 5.5, 0.5, 6.4);
        bake(list, UNIT_CONE, 0xdfe6df, 8.5, hillH + 6.8, 5.5, 3.4, 1.1, 3.4, -1.0, 0.5, 0);
        // 天线阵（4 根细塔）
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + 0.4, rr = 12;
          cy(darkSteel, Math.cos(a) * rr, hillH + 6, Math.sin(a) * rr, 0.24, 12);
          sp(accent, Math.cos(a) * rr, hillH + 12.4, Math.sin(a) * rr, 0.3);
          glowParts.push({ color: accent, x: Math.cos(a) * rr, y: hillH + 12.4, z: Math.sin(a) * rr, r: 0.42 });
        }
        // 附属机房
        g(0xc9c4b4, -12, hillH + 1.8, 8, 8, 3.6, 6);
        g(glassy, -12, hillH + 2.2, 11.1, 3.0, 1.4, 0.2);
        break;
      }
      case 'waterfall': {
        // 断崖瀑布：崖壁 + 上层水池 + 两段水帘 + 下层水潭
        const cliffH = 11;
        for (let i = 0; i < 9; i++) {
          const u = (i / 8 - 0.5) * 34;
          g(0x7d8479, u, cliffH * 0.5, 0, 4.2, cliffH, 5.0, 0, 0.06 * i, 0);
          g(0x6d7468, u, cliffH * 0.5 + 1.2, -1.6, 3.6, cliffH * 0.8, 3.4);
        }
        // 上层水池
        bake(list, UNIT_CYL, 0x6fa6ad, 0, cliffH + 0.12, 7, 9.5, 0.24, 6.5);
        // 水帘（半透明竖向薄片，分两层制造落差）
        const fall1 = [];  // 交给 scene 做 UV 动画的材质，这里只烘焙几何
        fall1.push({ x: 0, y: cliffH * 0.62, z: 2.9, w: 9.5, h: cliffH * 0.78, d: 0.35 });
        for (const f of fall1) g(0xa8d8de, f.x, f.y, f.z, f.w, f.h, f.d);
        // 上层小块水帘（两级）
        g(0xc4e6ea, -3.0, cliffH * 0.86, 2.6, 3.6, cliffH * 0.3, 0.3);
        // 下层水潭
        bake(list, UNIT_CYL, 0x7fb8bd, 0, 0.1, 9, 10, 0.16, 7);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * TAU;
          sp(0x8d968a, Math.cos(a) * 8.6, 0.5, 9 + Math.sin(a) * 6.2, 1.2, 0.9, 1.0);
        }
        // 观景木栈道
        for (let i = 0; i < 7; i++) g(wood, -11 - i * 1.2, 0.5 + i * 0.12, 9 + i * 1.4, 2.4, 0.22, 1.2, 0, 0.4, 0);
        break;
      }
      case 'open_pit': {
        // 露天矿坑：geom 以「地表」为原点，向下生长；台阶剖面与 shared/map.mjs
        // 的 landmarkShape 保持一致（5 级台地 + 线性坡道），避免模型与地形错位。
        const depth = 20;
        const R = 34;
        const surfaceY = (t) => {
          // t = 0..1（中心→边缘），与地形 profile 相同的阶梯函数
          const steps = 5;
          const idx = t * steps;
          const tier = Math.floor(idx) / steps;
          const frac = idx - Math.floor(idx);
          const profile = tier + (frac * frac * (3 - 2 * frac)) / steps;
          return -depth * (1 - profile) * 0.92;
        };
        // 阶梯台地：每级是一圈环带平台 + 一圈立面（下沉感的来源）
        const steps = 5;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const r0 = R * t0, r1 = R * t1;
          const y0 = surfaceY(t0 + 0.001), y1 = surfaceY(t1 - 0.001);
          const n = 26 + s * 4;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU;
            // 台地平面（环带的一小段）
            g(s % 2 ? 0x9a6f4f : 0x8a6a4a, Math.cos(a) * (r0 + r1) * 0.5, y0 + 0.25, Math.sin(a) * (r0 + r1) * 0.5,
              (r1 - r0) * 0.62, 0.5, 2.4, 0, a, 0);
            // 立面：从本级台地到下一级
            if (s < steps - 1) {
              const drop = y1 - y0;
              if (Math.abs(drop) > 0.4) {
                g(0x6d5640, Math.cos(a) * r1, (y0 + y1) * 0.5, Math.sin(a) * r1,
                  2.6, Math.abs(drop), (r1 - r0) * 0.3, 0, a, 0);
              }
            }
          }
        }
        // 坑底：破碎机 + 机房 + 灯
        const bottom = surfaceY(0.02);
        g(0x8a7050, 0, bottom + 3.2, 0, 8.5, 6.4, 8.5);
        g(darkSteel, 0, bottom + 6.8, 0, 7.2, 1.0, 7.2);
        cy(steel, 0, bottom + 9.8, 0, 0.4, 6.0);
        sp(accent, 0, bottom + 13.0, 0, 0.5);
        glowParts.push({ color: accent, x: 0, y: bottom + 13.0, z: 0, r: 0.7 });
        // 螺旋矿车轨道（贴着阶梯面）
        for (let i = 0; i < 34; i++) {
          const a = (i / 34) * TAU * 1.1 + 2.2;
          const t = 0.12 + (i / 34) * 0.76;
          const rr = R * t;
          g(0x5b5b5b, Math.cos(a) * rr, surfaceY(t) + 0.4, Math.sin(a) * rr, 4.6, 0.28, 0.75, 0, a, 0);
        }
        // 坑口塔吊（地表高度）
        cy(steel, 30, 8, -22, 0.7, 16);
        g(steel, 30, 15.5, -22, 1.2, 1.0, 1.2);
        g(accent, 30, 16.2, -22, 14, 0.5, 0.5, 0, 0.6, 0);
        sp(accent, 30, 17.4, -22, 0.5);
        glowParts.push({ color: accent, x: 30, y: 17.4, z: -22, r: 0.5 });
        break;
      }
      case 'conveyor': {
        // 传送带塔：斜向长条 + 支腿 + 料斗 + 机头
        const len = 27, H = 18;
        for (let i = 0; i < 8; i++) {
          const t = (i / 7 - 0.5) * len;
          const h = 3 + (1 - Math.abs(i / 7 - 0.5) * 2) * H * 0.55;
          for (const side of [-1, 1]) {
            cy(darkSteel, t * 0.06, h * 0.5, side * 2.4, 0.3, h);
          }
          if (i % 2 === 0) g(steel, t * 0.06, h, 0, len / 7 + 0.6, 0.7, 2.4);
        }
        // 传送带本体（倾斜长条）
        for (let i = 0; i < 14; i++) {
          const t = i / 13;
          const px = (t - 0.5) * len;
          const py = 3.4 + Math.sin(t * Math.PI) * H * 0.55;
          g(i % 2 ? 0x8a7a5a : 0x6f6a5a, px * 0.06, py, 0, len / 13 + 0.3, 0.9, 2.0, 0, 0, 0);
        }
        // 机头料斗
        g(rust, len * 0.06 * 0.5 + 5, H * 0.62 + 2.4, 0, 6.2, 5.6, 6.2);
        bake(list, UNIT_CONE, 0x7a6a52, len * 0.06 * 0.5 + 5, H * 0.62 + 6.0, 0, 3.8, 3.0, 3.8, Math.PI);
        glowParts.push({ color: accent, x: len * 0.06 * 0.5 + 5, y: H * 0.62 + 7.6, z: 0, r: 0.5 });
        sp(accent, len * 0.06 * 0.5 + 5, H * 0.62 + 7.6, 0, 0.45);
        break;
      }
      case 'shipwreck': {
        // 沉船残骸：半埋船体 + 上层建筑 + 断桅 + 烟囱
        const L = 34, W = 11;
        for (let i = 0; i < 9; i++) {
          const t = (i / 8 - 0.5) * L;
          const taper = 1 - Math.abs(i / 8 - 0.5) * 0.55;
          g(0x5d6663, 0, 1.9 * taper + 0.8, t, W * taper, 4.2 * taper, 3.6);
          g(0x49514f, 0, 3.9 * taper + 0.9, t, W * taper * 0.94, 0.7, 3.4);
        }
        // 船首尖头
        bake(list, UNIT_CONE, 0x5d6663, 0, 2.1, L * 0.5 + 1.4, 5.4, 5.0, 3.4, Math.PI / 2, 0, 0);
        // 上层建筑
        g(0x6a7370, 0, 6.0, -5, 8.0, 6.4, 7.0);
        g(0x7d8580, 0, 9.4, -5, 7.4, 0.6, 6.4);
        g(glassy, 0, 6.4, -1.35, 6.0, 1.6, 0.3);
        // 烟囱（歪斜）
        cy(rust, 2.4, 10.6, -5, 1.3, 4.2, 0, 0, 0.18);
        // 断桅
        cy(0x8a7a5a, 0, 11.0, 7, 0.45, 14, 0.14, 0, 0);
        g(0x8a7a5a, 0, 14.6, 7.9, 0.4, 0.4, 8.0, 0.5, 0, 0);
        // 船体破洞（暗色块）
        g(0x2a3130, W * 0.5 + 0.1, 2.6, 3.0, 0.3, 2.0, 2.6);
        glowParts.push({ color: accent, x: 2.4, y: 12.9, z: -5, r: 0.5 });
        sp(accent, 2.4, 12.9, -5, 0.4);
        break;
      }
      case 'derrick': {
        // 钻井平台：四层钢架 + 甲板 + 储罐 + 管线 + 井架
        const H = 22;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + Math.PI / 4;
          cy(steel, Math.cos(a) * 6.4, H * 0.5, Math.sin(a) * 6.4, 0.5, H);
        }
        for (let f = 0; f < 4; f++) {
          const y = 5.5 + f * 5;
          const r = 6.0 - f * 0.55;
          bake(list, UNIT_CYL, f === 3 ? accent : concrete, 0, y, 0, r, 0.32, r);
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU;
            g(0x9a8a6a, Math.cos(a) * r * 0.86, y + 0.7, Math.sin(a) * r * 0.86, 0.24, 1.2, 0.24);
          }
        }
        // 井架（顶部锥形）
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + Math.PI / 4;
          g(darkSteel, Math.cos(a) * 1.5, H + 4, Math.sin(a) * 1.5, 0.4, 8.4, 0.4, Math.sin(a) * 0.16, 0, -Math.cos(a) * 0.16);
        }
        bake(list, UNIT_CONE, steel, 0, H + 9.2, 0, 2.6, 2.4, 2.6);
        glowParts.push({ color: accent, x: 0, y: H + 10.8, z: 0, r: 0.55 });
        sp(accent, 0, H + 10.8, 0, 0.45);
        // 储罐
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU + 0.7;
          cy(0xb7a58a, Math.cos(a) * 12, 2.8, Math.sin(a) * 12, 2.2, 5.6);
          cy(0x8c7d66, Math.cos(a) * 12, 5.7, Math.sin(a) * 12, 2.3, 0.4);
        }
        // 管线
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * TAU;
          g(0x9a8a6a, Math.cos(a) * 8, 0.5, Math.sin(a) * 8, 6.0, 0.42, 0.42, 0, a, 0);
        }
        break;
      }
      case 'container_maze': {
        // 集装箱迷宫：成排 1–3 层堆叠，留走廊
        const palette = [0xc4563f, 0x3f6d7a, 0xc99a45, 0x5f7a55, 0x8a8f95, 0x9a5b4a];
        const cell = 8.4;
        const cols = 5, rows = 5;
        let n = 0;
        for (let cx = 0; cx < cols; cx++) {
          for (let cz = 0; cz < rows; cz++) {
            if (cx % 2 === 1 || (cx * 7 + cz * 3) % 11 === 0) continue;
            const x = (cx - (cols - 1) / 2) * cell;
            const z = (cz - (rows - 1) / 2) * cell;
            const stack = (cx * 3 + cz * 5) % 3 === 0 ? 3 : (cx + cz) % 2 ? 2 : 1;
            const rotY = (cx + cz) % 2 ? Math.PI / 2 : 0;
            for (let s = 0; s < stack; s++) {
              const c = palette[(cx * 5 + cz * 3 + s) % palette.length];
              const long = (cx + cz + s) % 3 === 0;
              g(c, x, 1.35 + s * 2.74, z, long ? 12.2 : 6.1, 2.7, 2.55, 0, rotY, 0);
              // 波纹板
              for (let k = -3; k <= 3; k++) {
                const along = (long ? 12.2 : 6.1) * 0.15 * k;
                const dx = rotY ? 0 : along, dz = rotY ? along : 0;
                g(0x000000, x + dx, 1.35 + s * 2.74, z + dz, rotY ? 2.6 : 0.12, 2.3, rotY ? 0.12 : 2.6);
              }
              n++;
            }
          }
        }
        // 叉车 + 吊具
        g(0xd9a34a, -18, 1.4, 16, 2.6, 2.4, 4.2);
        cy(0x2f3335, -18, 0.7, 14.6, 0.7, 0.5, 0, 0, Math.PI / 2);
        cy(steel, 18, 6, -18, 0.4, 12);
        g(accent, 18, 11.8, -18, 9.0, 0.6, 0.6, 0, 0.5, 0);
        glowParts.push({ color: accent, x: 18, y: 12.6, z: -18, r: 0.45 });
        break;
      }
      case 'lighthouse': {
        // 灯塔：塔身（红白环带）+ 外廊 + 灯室 + 光束
        const H = 34;
        for (let i = 0; i < 10; i++) {
          const r = 2.6 - i * 0.11;
          cy(i % 2 ? 0xb8452f : 0xe8e4d8, 0, 1.6 + i * 3.2, 0, r, 3.2);
        }
        // 底座
        bake(list, UNIT_CYL, concrete, 0, 1.0, 0, 5.2, 2.0, 5.2);
        // 外廊
        bake(list, UNIT_CYL, 0xd8d4c4, 0, H - 1.2, 0, 3.6, 0.4, 3.6);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU;
          g(darkSteel, Math.cos(a) * 3.4, H - 0.4, Math.sin(a) * 3.4, 0.14, 1.4, 0.14);
        }
        bake(list, UNIT_CYL, 0xd8d4c4, 0, H + 0.4, 0, 3.5, 0.14, 3.5);
        // 灯室
        bake(list, UNIT_CYL, 0x3d5f68, 0, H + 1.6, 0, 2.4, 2.4, 2.4);
        bake(list, UNIT_CONE, 0xb8452f, 0, H + 3.4, 0, 2.9, 1.8, 2.9);
        glowParts.push({ color: accent, x: 0, y: H + 1.6, z: 0, r: 1.5 });
        sp(accent, 0, H + 1.6, 0, 1.1);
        // 附属房
        g(0xd2dcd8, 9, 1.9, -5, 7.4, 3.8, 5.6);
        bake(list, UNIT_CONE, 0x4c6c7e, 9, 4.4, -5, 4.6, 1.6, 4.0);
        break;
      }
      case 'bridge': {
        // 跨海大桥断段：两截桥面 + 断口 + 斜拉索塔
        const len = 46, W = 9;
        for (let i = 0; i < 13; i++) {
          const t = (i / 12 - 0.5) * len;
          const gap = Math.abs(i - 6) < 1.1;
          if (gap) continue;
          g(0x8b8f8a, 0, 6.4, t, W, 0.7, len / 12 + 0.4);
          // 护栏
          for (const side of [-1, 1]) g(0xb9bec2, side * W * 0.5, 7.3, t, 0.4, 1.1, len / 12 + 0.3);
          // 桥墩
          if (i % 3 === 1) {
            cy(0x9a9d98, 0, 3.0, t, 1.4, 6.2);
            g(0x9a9d98, 0, 5.9, t, W * 0.9, 0.6, 1.8);
          }
          // 斜拉索
          if (Math.abs(i - 6) < 5 && i % 2 === 0) {
            const h = 22;
            g(0xcfd4cf, 0, h * 0.5 + 7, t, 0.08, h, 0.08, 0.28 * Math.sign(t - 0), 0, 0);
          }
        }
        // 索塔
        for (const t of [-len * 0.22, len * 0.22]) {
          for (const side of [-1, 1]) {
            g(0xc3c8c3, side * W * 0.7, 15, t, 1.5, 30, 1.5);
          }
          g(0xc3c8c3, 0, 29, t, W * 1.5, 1.4, 1.6);
          glowParts.push({ color: accent, x: 0, y: 30.4, z: t, r: 0.5 });
          sp(accent, 0, 30.4, t, 0.4);
        }
        // 断口处的断梁
        for (let k = 0; k < 3; k++) {
          g(0x777b76, (k - 1) * 2.8, 6.0, 0.8, 2.2, 1.4, 2.6, 0.4 * (k - 1), 0, 0.2 * (k - 1));
          g(0x777b76, (k - 1) * 2.8, 6.0, -0.8, 2.2, 1.4, 2.6, -0.4 * (k - 1), 0, -0.2 * (k - 1));
        }
        break;
      }
      case 'warehouse': {
        // 大跨度仓库群：3 间厂房 + 天窗 + 装卸门 + 集装箱
        for (let i = 0; i < 3; i++) {
          const x = (i - 1) * 17;
          const z = i % 2 ? 10 : -9;
          const c = [0xc7cfcb, 0xb6c4c2, 0xd2dcd8][i];
          g(c, x, 4.4, z, 15, 8.8, 12);
          // 双坡屋顶
          g(0x4c6c7e, x, 9.2, z, 15.4, 0.5, 6.4, 0.36, 0, 0);
          g(0x4c6c7e, x, 9.2, z, 15.4, 0.5, 6.4, -0.36, 0, 0);
          // 天窗
          for (let k = 0; k < 3; k++) g(0x8fd6e8, x - 5 + k * 5, 9.7, z, 2.4, 0.2, 2.0);
          // 装卸门
          g(0x3a464a, x, 2.6, z + 6.1, 5.6, 5.2, 0.25);
          g(0x2c3639, x, 5.3, z + 6.3, 6.0, 0.35, 0.5);
          // 雨棚
          g(0x8a8f95, x, 6.0, z + 7.4, 7.4, 0.3, 2.6);
        }
        // 装卸平台
        for (let i = 0; i < 3; i++) g(0xa8a39a, (i - 1) * 17, 0.7, 6, 10, 1.4, 3.0);
        // 集装箱 + 叉车
        for (const [x, z, c] of [[-22, -14, 0xc4563f], [22, -15, 0x3f6d7a], [-23, 15, 0xc99a45]]) {
          g(c, x, 1.4, z, 12.2, 2.7, 2.55);
        }
        g(0xd9a34a, 0, 1.3, 16, 2.4, 2.2, 4.0);
        glowParts.push({ color: accent, x: 0, y: 11.4, z: 10, r: 0.5 });
        sp(accent, 0, 11.4, 10, 0.45);
        break;
      }
      default: {
        // 未知类型：给一个通用的纪念碑，避免运行时空几何
        bake(list, UNIT_CYL, concrete, 0, 3, 0, 1.6, 6, 1.6);
        glowParts.push({ color: accent, x: 0, y: 6.8, z: 0, r: 0.6 });
        break;
      }
    }
    return { geometry: finishList(list), glowParts };
  }, SHARED_GEO);
}

/** 单材质地标 mesh（scene 直接 add 到 worldGroup）。 */
export function landmarkMesh(type, theme = null) {
  const data = createLandmark(type, theme);
  const mesh = new THREE.Mesh(data.geometry, VC_MAT);
  mesh.userData.glowParts = data.glowParts;
  return mesh;
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
