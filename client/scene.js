import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP, WORLD_RADIUS, randomGenerator, moveBody } from '../shared/map.mjs';
import { MAX_LOOT, WEAPONS } from '../shared/rules.mjs';

const colors = { grass: 0x7c9e68, sand: 0xd5c193, water: 0x78aeb1, pine: [0x285e53, 0x3a7560, 0x548469], walls: [0xe6d6b5, 0xaebcb2, 0xd1c6ac, 0xc8b59d], roof: [0xae6855, 0x557986, 0x66715c, 0xb78560] };
const lootColors = { pistol: 0xcbd0b9, rifle: 0xf5bb52, smg: 0x78cbc7, shotgun: 0xfa9257, marksman: 0xbe91ed, sniper: 0xe992bf, lmg: 0xe6d562, ammo: 0xe1dca0, med: 0x9bd8c6, armor: 0x88bfe2, grenade: 0xeb7761, smoke: 0xb5ced2 };
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const mergedMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
const groundShadowMaterial = new THREE.MeshBasicMaterial({color:0x203e30,transparent:true,opacity:.13,depthWrite:false});
const materialCache = new Map();
const material = color => { if (!materialCache.has(color)) materialCache.set(color, new THREE.MeshLambertMaterial({ color })); return materialCache.get(color); };
const object = new THREE.Object3D();
function box(parent, x, y, z, w, h, d, color) {
  const mesh = new THREE.Mesh(boxGeometry, material(color));
  mesh.position.set(x, y, z); mesh.scale.set(w, h, d); parent.add(mesh); return mesh;
}
function instances(parent, geometry, color, transforms) {
  const mesh = new THREE.InstancedMesh(geometry, material(color), transforms.length);
  transforms.forEach((t, i) => {
    object.position.set(t.x, t.y || 0, t.z); object.rotation.set(t.rx || 0, t.ry || 0, t.rz || 0);
    object.scale.set(t.sx || 1, t.sy || 1, t.sz || 1); object.updateMatrix(); mesh.setMatrixAt(i, object.matrix);
  });
  parent.add(mesh); return mesh;
}

function mergeBoxes(group, exclude = []) {
  const meshes = group.children.filter(child => child.isMesh && child.geometry === boxGeometry && !exclude.includes(child));
  if (!meshes.length) return;
  const pieces = meshes.map(mesh => {
    mesh.updateMatrix();
    const geometry = boxGeometry.clone().applyMatrix4(mesh.matrix);
    const color = mesh.material.color, vertexColors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < vertexColors.length; i += 3) { vertexColors[i] = color.r; vertexColors[i + 1] = color.g; vertexColors[i + 2] = color.b; }
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
    return geometry;
  });
  const geometry = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  for (const mesh of meshes) group.remove(mesh);
  group.add(new THREE.Mesh(geometry, mergedMaterial));
}

export class GameScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.setClearColor(0x86b5b6);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x86b5b6, 210, 450);
    this.scene.add(new THREE.HemisphereLight(0xeaf5ea, 0x526455, 2.6));
    const light = new THREE.DirectionalLight(0xffe4c1, 2.1); light.position.set(-60, 120, 30); this.scene.add(light);
    this.camera = new THREE.OrthographicCamera(-80, 80, 60, -60, .1, 650);
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.players = new Map(); this.cars = new Map(); this.effects = [];
    this.lootMesh = new THREE.InstancedMesh(boxGeometry, material(0xffffff), MAX_LOOT);
    this.lootMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lootMesh.count = 0; this.lootMesh.frustumCulled = false; this.scene.add(this.lootMesh);
    this.roofs = []; this.follow = new THREE.Vector3(); this.target = new THREE.Vector3();
    this.worldEffects = new Map(); this.labels = [];
    this.raycaster = new THREE.Raycaster(); this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.lobby = true; this.eventId = 0; this.pendingInputs = []; this.predicted = null;
    this.buildMap();
    this.hero = this.makePlayer(0xf3b655); this.hero.group.scale.setScalar(10); this.hero.group.position.set(28, 2, 54); this.hero.group.rotation.y = -.6; this.scene.add(this.hero.group);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(quality) {
    const pixelRatio = quality === 'low' ? .7 : quality === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : Math.min(window.devicePixelRatio || 1, 1.35);
    this.renderer.setPixelRatio(pixelRatio);
  }

  resize() {
    this.width = window.innerWidth; this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height, false);
    const span = this.lobby ? 145 : (this.width / this.height < 1 ? 23 : 16);
    this.camera.left = -span * this.width / this.height; this.camera.right = span * this.width / this.height;
    this.camera.top = span; this.camera.bottom = -span; this.camera.updateProjectionMatrix();
  }

  buildMap() {
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100), material(colors.water)); sea.rotation.x = -Math.PI / 2; sea.position.y = -2.2; this.world.add(sea);
    const cylinder = (radius, height, color, y) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + 1, height, 64), material(color)); mesh.position.y = y; this.world.add(mesh); return mesh;
    };
    cylinder(WORLD_RADIUS + 8, .2, 0x91c0ba, -1.85); cylinder(WORLD_RADIUS + 4, 1.9, colors.sand, -.8); cylinder(WORLD_RADIUS - 1, .35, colors.grass, .01);
    const road = new THREE.Group(); box(road, 0, .22, 0, 8, .1, WORLD_RADIUS * 2 - 3, 0x77847b); box(road, 0, .23, 0, WORLD_RADIUS * 2 - 3, .1, 8, 0x77847b); this.world.add(road);
    const lines = [];
    for (let i = -WORLD_RADIUS + 9; i <= WORLD_RADIUS - 9; i += 10) { if (Math.abs(i) < 7) continue; lines.push({ x: 0, y: .31, z: i, sx: .18, sy: .03, sz: 3 }, { x: i, y: .32, z: 0, sx: 3, sy: .03, sz: .18 }); }
    instances(this.world, boxGeometry, 0xc5c7a8, lines);
    for (let col = 0; col < 4; col++) {
      const floors = MAP.buildings.filter(b => b.color === col).map(b => ({ x: b.x, y: .32, z: b.z, sx: b.w, sy: .15, sz: b.d }));
      instances(this.world, boxGeometry, 0xe0cba4, floors);
      const walls = [];
      for (const b of MAP.buildings.filter(b => b.color === col)) {
        for (const o of MAP.obstacles.filter(o => o.kind === 'wall' && Math.abs(o.x - b.x) < b.w && Math.abs(o.z - b.z) < b.d)) walls.push({ x: o.x, y: 1.8, z: o.z, sx: o.w, sy: 3.1, sz: o.d });
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4), new THREE.MeshLambertMaterial({ color: colors.roof[col], transparent: true }));
        roof.position.set(b.x, 4.65, b.z); roof.rotation.y = Math.PI / 4; roof.scale.set((b.w + 1.2) / Math.SQRT2, 3.5, (b.d + 1.2) / Math.SQRT2);
        this.world.add(roof); this.roofs.push({ mesh: roof, building: b });
        box(this.world, b.x + 2, 5, b.z - 1.5, 1.05, 3, 1.05, 0xc5c7bb);
        box(this.world, b.x, .4, b.z + b.d / 2 + 1, 3.2, .35, 2, 0xb8baa2);
      }
      instances(this.world, boxGeometry, colors.walls[col], walls);
    }
    const windows=[], roofRidges=[], steps=[], shutters=[];
    for(const b of MAP.buildings) {
      for(const x of [-1,1]) {
        windows.push({x:b.x+x*b.w*.3,y:1.9,z:b.z+b.d/2+.27,sx:1.3,sy:1.15,sz:.05});
        shutters.push({x:b.x+x*b.w*.3,y:2.53,z:b.z+b.d/2+.31,sx:1.55,sy:.16,sz:.3});
      }
      steps.push({x:b.x,y:.37,z:b.z+b.d/2+1.55,sx:3.35,sy:.25,sz:2.5});
      roofRidges.push({x:b.x,y:.25,z:b.z,sx:b.w+1,sy:.06,sz:b.d+1});
    }
    instances(this.world,boxGeometry,0x456c70,windows); instances(this.world,boxGeometry,0xe7d5ac,shutters);
    instances(this.world,boxGeometry,0xb5b499,steps); instances(this.world,boxGeometry,0x748769,roofRidges);
    const crateDetails=[], crates=[];
    for(const p of MAP.props) {
      crates.push({x:p.x,y:p.h/2+.3,z:p.z,sx:p.w,sy:p.h,sz:p.d});
      for(const dx of [-.48,.48]) crateDetails.push({x:p.x+dx,y:p.h+.34,z:p.z,sx:.14,sy:.1,sz:p.d+.04});
    }
    instances(this.world,boxGeometry,0x937153,crates); instances(this.world,boxGeometry,0xd7b37a,crateDetails);
    const shadows=[...MAP.trees.map(t=>({x:t.x+1.5,y:.27,z:t.z+1.3,sx:2.2*t.scale,sy:.9,sz:4.2*t.scale,ry:-.7})),...MAP.buildings.map(b=>({x:b.x+1,y:.25,z:b.z+1.2,sx:b.w*.8,sy:.9,sz:b.d*.72}))];
    const shadowMesh=instances(this.world,new THREE.CylinderGeometry(1,1,.012,8),0x203e30,shadows); shadowMesh.material=groundShadowMaterial;
    instances(this.world, boxGeometry, 0x6d6952, MAP.trees.map(t => ({ x: t.x, y: 1.3 * t.scale, z: t.z, sx: .65, sy: 2.6 * t.scale, sz: .65 })));
    for (let c = 0; c < 3; c++) {
      const crowns = [];
      for (const t of MAP.trees.filter(t => t.color === c)) {
        crowns.push({ x: t.x, y: 3.1 * t.scale, z: t.z, sx: 2.2 * t.scale, sy: 4 * t.scale, sz: 2.2 * t.scale });
        crowns.push({ x: t.x, y: 4.8 * t.scale, z: t.z, sx: 1.65 * t.scale, sy: 3.5 * t.scale, sz: 1.65 * t.scale });
      }
      instances(this.world, new THREE.ConeGeometry(1, 1, 5), colors.pine[c], crowns);
    }
    const rng = randomGenerator(95), stones = [], grass = [];
    for (let i = 0; i < 180; i++) {
      const a = rng() * Math.PI * 2, r = WORLD_RADIUS - 10 + rng() * 10;
      stones.push({ x: Math.cos(a) * r, y: .7, z: Math.sin(a) * r, sx: 1 + rng() * 2, sy: 1 + rng() * 1.5, sz: 1 + rng() * 2, ry: rng() * 5 });
      const rad = 12 + rng() * (WORLD_RADIUS - 22);
      grass.push({ x: Math.cos(a) * rad, y: .24, z: Math.sin(a) * rad, sx: 3 + rng() * 4, sy: .04, sz: 3 + rng() * 4, ry: rng() * 5 });
    }
    instances(this.world, new THREE.DodecahedronGeometry(1, 0), 0x9ba794, stones);
    instances(this.world, new THREE.CylinderGeometry(1, 1, 1, 6), 0x88a772, grass);
    const dock = new THREE.Group();
    for (let i = 0; i < 12; i++) box(dock, i * 1.8, -.1, 0, 1.65, .5, 6, 0x987f61);
    dock.position.set(WORLD_RADIUS - 4, 0, 0); this.world.add(dock);
    const container = new THREE.Group(); box(container, 0, 2, 0, 8, 3.6, 4, 0xcfa157); box(container, 0, 3.9, 0, 8.1, .2, 4.1, 0xb88a49);
    container.position.set(12, 0, -62); this.world.add(container);
    box(this.world, -10, 4, 62, .3, 8, .3, 0x5a6965); box(this.world, -7.8, 7, 62, 4.3, 1.7, .15, 0xefb657);
    for (const region of MAP.regions) {
      const sign = this.makeText(region.name, '#e8edce'); sign.scale.set(12, 3, 1); sign.position.set(region.x, 7, region.z - 30); this.world.add(sign);
      this.labels.push(sign);
      box(this.world, region.x, .25, region.z, 4, .15, 54, 0xadab88);
    }
    const farmRows = [];
    for (let n = 0; n < 20; n++) farmRows.push({ x: -30 + n * 1.5, y: .27, z: 65, sx: .65, sy: .3, sz: 20 });
    instances(this.world, boxGeometry, 0x9b9561, farmRows);
    const ringPoints = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos(i / 128 * Math.PI * 2), .7, Math.sin(i / 128 * Math.PI * 2)));
    this.ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints), new THREE.LineBasicMaterial({ color: 0x78e6de }));
    this.ring.scale.set(WORLD_RADIUS, 1, WORLD_RADIUS); this.scene.add(this.ring); this.ring.visible = false;
    this.storm = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 22, 96, 1, true), new THREE.MeshBasicMaterial({ color: 0x6ad4ce, transparent: true, opacity: .13, side: THREE.DoubleSide, depthWrite: false }));
    this.storm.position.y = 10; this.scene.add(this.storm); this.storm.visible = false;
    this.pointer = new THREE.Mesh(new THREE.RingGeometry(.65, .77, 24), new THREE.MeshBasicMaterial({ color: 0xf6c76e, transparent: true, opacity: .7, depthWrite: false }));
    this.pointer.rotation.x = -Math.PI / 2; this.scene.add(this.pointer); this.pointer.visible = false;
  }

  makeText(text, color) {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.font = '600 28px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#142b2b'; ctx.shadowBlur = 5; ctx.fillStyle = color; ctx.fillText(text, 160, 32, 310);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  }

  makePlayer(color) {
    const group = new THREE.Group(), body = new THREE.Group(); group.add(body);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(.9, 12), new THREE.MeshBasicMaterial({ color: 0x253e37, transparent: true, opacity: .18, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = .26; group.add(shadow);
    box(body, 0, 1.1, 0, .75, .85, .5, 0x283d43);
    box(body, -.44, 1.12, .06, .25, .68, .28, color); box(body, .44, 1.14, .13, .25, .66, .3, color);
    box(body, 0, 1.83, 0, .78, .72, .7, color);
    box(body, 0, 1.79, .371, .58, .22, .04, 0x203740);
    box(body, -.17, 1.81, .4, .18, .055, .025, 0xb8e2d1);
    box(body, 0, 1.06, -.36, .55, .62, .28, 0x7e8c6b);
    box(body, 0, 1.08, .28, .4, .34, .1, 0x536664);
    const left = box(body, -.23, .5, 0, .28, .62, .35, 0x30494b), right = box(body, .23, .5, 0, .28, .62, .35, 0x30494b);
    const gun=new THREE.Group(); gun.position.set(.38,1.14,.3); body.add(gun);
    box(gun,0,0,.4,.19,.22,.85,0x273438);box(gun,0,.11,.3,.24,.14,.48,0x5a6866);
    box(gun,0,-.16,.25,.12,.28,.18,0x2b3837);mergeBoxes(gun);
    const muzzle=new THREE.Mesh(new THREE.ConeGeometry(.22,.55,5),new THREE.MeshBasicMaterial({color:0xffd16c}));
    muzzle.rotation.x=Math.PI/2;muzzle.position.set(0,0,.96);muzzle.visible=false;gun.add(muzzle);
    mergeBoxes(body, [left, right]);
    const chute = new THREE.Group();
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(2.5, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), material(0xf2c272)); canopy.position.y = 5; chute.add(canopy);
    const ropeMat = new THREE.LineBasicMaterial({ color: 0xe4e9d4 });
    for (const x of [-1.7, 1.7]) for (const z of [-1.7, 1.7]) chute.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 1.8, 0), new THREE.Vector3(x, 5, z)]), ropeMat));
    body.add(chute); chute.visible = false;
    return { group, body, left, right, chute, shadow, gun, muzzle, shotAt:-10, previous: new THREE.Vector2() };
  }

  makeCar(color = 0xe9b766) {
    const group = new THREE.Group();
    box(group, 0, .9, 0, 1.85, .65, 3.1, color);
    box(group, 0, 1.52, -.1, 1.65, .72, 1.5, 0x365b61);
    box(group, 0, 1.94, -.1, 1.85, .16, 1.65, color);
    box(group, -.6, .95, 1.61, .4, .2, .1, 0xf8eec9); box(group, .6, .95, 1.61, .4, .2, .1, 0xf8eec9);
    for (const x of [-1, 1]) for (const z of [-.95, .95]) box(group, x, .53, z, .36, .67, .67, 0x304349);
    mergeBoxes(group);
    this.scene.add(group); return group;
  }

  showLobby() {
    this.lobby = true; this.hero.group.visible = true; this.ring.visible = false; this.storm.visible = false; this.pointer.visible = false;
    for (const p of this.players.values()) { this.scene.remove(p.group); this.disposeModel(p.group); }
    this.players.clear();
    this.lootMesh.count = 0;
    for (const car of this.cars.values()) { this.scene.remove(car); this.disposeModel(car); }
    this.cars.clear();
    for (const roof of this.roofs) { roof.mesh.material.opacity = 1; roof.mesh.material.depthWrite = true; }
    for (const effect of this.effects) { this.scene.remove(effect.mesh); effect.mesh.geometry.dispose(); effect.mesh.material.dispose(); }
    this.effects.length = 0;
    this.state = null;
    this.pendingInputs.length = 0; this.predicted = null;
    for (const mesh of this.worldEffects.values()) { this.scene.remove(mesh); this.disposeModel(mesh); }
    this.worldEffects.clear();
    this.eventId = 0;
    this.resize();
  }

  disposeModel(group) {
    const geometries = new Set(), materials = new Set();
    group.traverse(mesh => {
      if (mesh.geometry && mesh.geometry !== boxGeometry) geometries.add(mesh.geometry);
      if (mesh.material && mesh.material !== mergedMaterial && ![...materialCache.values()].includes(mesh.material)) materials.add(mesh.material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const mat of materials) { mat.map?.dispose(); mat.dispose(); }
  }

  setState(state, selfId) {
    if (this.lobby) { this.lobby = false; this.hero.group.visible = false; this.resize(); const p = state.players.find(p => p.id === selfId); if (p) this.follow.set(p.x, 0, p.z); }
    this.state = state; this.selfId = selfId;
    const self = state.players.find(p => p.id === selfId);
    if (self) {
      this.pendingInputs = this.pendingInputs.filter(i => i.seq > self.seq).slice(-30);
      this.predicted = { x: self.x, z: self.z };
      const car = state.cars.find(c => c.id === self.car);
      const speed = self.car ? car?.driver === self.id ? 22 : 0 : self.downed ? 2.2 : self.healTime || self.reviveTarget ? 0 : 7;
      if (self.alive && state.phase === 'playing') for (const input of this.pendingInputs) moveBody(this.predicted, input.mx * speed * input.dt, input.mz * speed * input.dt, self.car ? 1.35 : .55);
    }
    for (const p of state.players) {
      if (!this.players.has(p.id)) {
        const selfTeam = state.players.find(player => player.id === selfId)?.team;
        const model = this.makePlayer(p.id === selfId ? 0xf2bc60 : p.team === selfTeam ? 0x6fc2a1 : [0xb68169, 0x9cae8b, 0x668c9d, 0xa8a19f][state.players.indexOf(p) % 4]);
        model.group.position.set(p.x, 0, p.z); this.players.set(p.id, model); this.scene.add(model.group);
        if (p.team === selfTeam) {
          model.label = this.makeText(p.id === selfId ? '▼ 你' : p.name, p.id === selfId ? '#ffdc8c' : '#a2eed0');
          model.label.scale.set(4, .8, 1); model.label.position.y = 3; model.group.add(model.label);
        }
      }
    }
    this.lootMesh.count = Math.min(state.loot.length,MAX_LOOT);
    state.loot.slice(0,MAX_LOOT).forEach((item, i) => this.lootMesh.setColorAt(i, new THREE.Color(lootColors[item.type])));
    if (this.lootMesh.instanceColor) this.lootMesh.instanceColor.needsUpdate = true;
    for (const car of state.cars) if (!this.cars.has(car.id)) this.cars.set(car.id, this.makeCar());
    for (const event of state.events) {
      if (event.id <= this.eventId) continue;
      if (event.type === 'shot' && state.time - event.time < .6) {
        const model=this.players.get(event.player); if(model)model.shotAt=performance.now()/1000;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(event.x, 1.1, event.z), new THREE.Vector3(event.tx, 1.1, event.tz)]), new THREE.LineBasicMaterial({ color: event.player === selfId ? 0xffdc8c : 0xffa477, transparent: true }));
        this.scene.add(line); this.effects.push({ mesh: line, life: .14 });
      }
      if (event.type === 'explosion' && state.time - event.time < .5) {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffb468, transparent: true, opacity: .6, depthWrite: false }));
        mesh.position.set(event.x, 1, event.z); mesh.scale.set(5, 2, 5); this.scene.add(mesh); this.effects.push({ mesh, life: .45, explosion: true });
      }
      this.eventId = Math.max(this.eventId, event.id);
    }
    this.ring.visible = true; this.ring.scale.set(state.zone.radius, 1, state.zone.radius);
    this.storm.visible = state.zone.radius < WORLD_RADIUS - 1; this.storm.scale.set(state.zone.radius, 1, state.zone.radius);
    this.updateWorldEffects(state);
  }

  updateWorldEffects(state) {
    const entities = [
      ...(state.grenades || []).map(g => ({ ...g, kind: 'grenade' })),
      ...(state.smokes || []).map(g => ({ ...g, kind: 'smoke' })),
      ...(state.drops || []).filter(d => !d.opened).map(d => ({ ...d, kind: 'drop' })),
      ...(state.pings || []).map(p => ({ ...p, id: `ping-${p.id}`, kind: 'ping' })),
    ];
    const ids = new Set(entities.map(e => e.id));
    for (const [id, mesh] of this.worldEffects) if (!ids.has(id)) { this.scene.remove(mesh); this.disposeModel(mesh); this.worldEffects.delete(id); }
    for (const e of entities) {
      let mesh = this.worldEffects.get(e.id);
      if (!mesh) {
        if (e.kind === 'smoke') mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd4d6c8, transparent: true, opacity: .86, depthWrite: false }));
        else if (e.kind === 'ping') { mesh = this.makeText('◈ 集合', '#ffc764'); mesh.scale.set(5, 1, 1); }
        else { mesh = new THREE.Group(); box(mesh, 0, 0, 0, e.kind === 'drop' ? 2 : .35, e.kind === 'drop' ? 1.4 : .4, e.kind === 'drop' ? 2 : .35, e.kind === 'drop' ? 0xb95343 : e.smoke ? 0x9fbabe : 0xcc9949); if (e.kind === 'drop') box(mesh, 0, .8, 0, 2.1, .2, 2.1, 0x5c849a); }
        this.scene.add(mesh); this.worldEffects.set(e.id, mesh);
      }
      mesh.position.set(e.x, e.kind === 'drop' ? .9 + e.landsIn * 1.4 : e.kind === 'smoke' ? 2 : e.kind === 'ping' ? 3 : e.height || .5, e.z);
      if (e.kind === 'smoke') { mesh.scale.set(e.radius, 4.5, e.radius); mesh.material.opacity = Math.min(.88, e.ttl / 2); }
    }
  }

  aimAt(screenX, screenY, player) {
    this.raycaster.setFromCamera(new THREE.Vector2(screenX / this.width * 2 - 1, 1 - screenY / this.height * 2), this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.plane, hit)) {
      this.pointer.visible = true; this.pointer.position.set(hit.x, .4, hit.z);
      return Math.atan2(hit.x - player.x, hit.z - player.z);
    }
    return player.angle;
  }

  predictInput(input, dt) {
    const self = this.state?.players.find(p => p.id === this.selfId);
    if (!this.predicted || !self?.alive || this.state.phase !== 'playing') return;
    const car = this.state.cars.find(c => c.id === self.car);
    const speed = self.car ? car?.driver === self.id ? 22 : 0 : self.downed ? 2.2 : self.healTime || self.reviveTarget ? 0 : 7;
    const step = Math.min(.08, Math.max(0, dt));
    this.pendingInputs.push({ ...input, dt: step }); if (this.pendingInputs.length > 30) this.pendingInputs.shift();
    moveBody(this.predicted, input.mx * speed * step, input.mz * speed * step, self.car ? 1.35 : .55);
  }

  render(dt, elapsed) {
    if (this.lobby) {
      this.target.set(-35, 0, 6);
      this.camera.position.set(135 + Math.sin(elapsed * .07) * 4, 220, 246); this.camera.lookAt(this.target);
      this.hero.body.position.y = Math.sin(elapsed * 1.6) * .03;
    } else if (this.state) {
      let self = this.state.players.find(p => p.id === this.selfId);
      const followed = self?.alive ? self : this.state.players.find(p => p.alive && p.team === self?.team) || this.state.players.find(p => p.alive) || self;
      if (followed) {
        const point = followed === self && this.predicted ? this.predicted : followed;
        this.follow.lerp(new THREE.Vector3(point.x, 0, point.z), 1 - Math.exp(-9 * dt));
        this.camera.position.copy(this.follow).add(new THREE.Vector3(0, 52, 38)); this.camera.lookAt(this.follow);
      }
      for (const model of this.players.values()) model.group.visible = false;
      for (const p of this.state.players) {
        const model = this.players.get(p.id), pos = model.group.position;
        const target = p.id === this.selfId && this.predicted ? this.predicted : p;
        const movement = Math.hypot(pos.x - target.x, pos.z - target.z);
        pos.lerp(new THREE.Vector3(target.x, 0, target.z), 1 - Math.exp(-18 * dt));
        const angleDelta = Math.atan2(Math.sin(p.angle - model.body.rotation.y), Math.cos(p.angle - model.body.rotation.y));
        model.body.rotation.y += angleDelta * (1 - Math.exp(-20 * dt));
        model.body.position.y = p.air * 12;
        model.chute.visible = p.air > .03;
        model.group.visible = p.alive && !p.car;
        model.body.rotation.x = p.downed ? -1.1 : 0;
        model.body.position.y = p.downed ? .35 : p.air * 12;
        model.shadow.material.opacity = p.downed ? .3 : .18;
        const gunLength={pistol:.48,smg:.65,rifle:1,shotgun:.85,marksman:1.12,sniper:1.45,lmg:1.18}[p.weapon]||1;
        const recoil=Math.max(0,1-(elapsed-model.shotAt)/.12);model.gun.position.z=.3-recoil*.15;model.gun.scale.set(p.weapon==='lmg'?1.4:1,1,gunLength);
        model.muzzle.visible=!p.downed && elapsed-model.shotAt<.075;
        model.left.rotation.x = p.air ? -.2 : Math.sin(elapsed * 17) * Math.min(.7, movement);
        model.right.rotation.x = -model.left.rotation.x;
      }
      for (const car of this.state.cars) {
        const mesh = this.cars.get(car.id); mesh.position.lerp(new THREE.Vector3(car.x, 0, car.z), 1 - Math.exp(-18 * dt)); mesh.rotation.y = car.angle;
        mesh.visible = car.hp > 0;
      }
      for (const { mesh, building: b } of this.roofs) {
        const close = followed && Math.abs(followed.x - b.x) < b.w / 2 + 3 && Math.abs(followed.z - b.z) < b.d / 2 + 3;
        mesh.material.opacity = THREE.MathUtils.lerp(mesh.material.opacity, close ? .07 : 1, 1 - Math.exp(-8 * dt));
        mesh.material.depthWrite = !close;
      }
      this.state.loot.forEach((item, i) => {
        object.position.set(item.x, .7 + Math.sin(elapsed * 2 + item.x) * .1, item.z);
        object.rotation.set(0, elapsed * .7, 0);
        object.scale.set(WEAPONS[item.type] ? 1.25 : .7, .35, .7);
        object.updateMatrix(); this.lootMesh.setMatrixAt(i, object.matrix);
      });
      this.lootMesh.instanceMatrix.needsUpdate = true;
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]; effect.life -= dt;
      if (effect.life <= 0) { this.scene.remove(effect.mesh); effect.mesh.geometry.dispose(); effect.mesh.material.dispose(); this.effects.splice(i, 1); }
      else effect.mesh.material.opacity = effect.life / (effect.explosion ? .6 : .14);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
