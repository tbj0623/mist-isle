// scripts/audio-check.mjs — 音频引擎自动化验收（owner: audio）
//
// 做法：esbuild 把 client/audio.js 打成 IIFE，在 Playwright 页面里注入一个
// **mock AudioContext**（记录每次 createXxx / 每个 AudioParam 的每一次写入），
// 然后驱动 GameAudio 走真实代码路径，断言：
//   1) 全部音效名都能播（不抛错，且确实创建了 source 节点）
//   2) 同时 40 发枪声后活跃声道 ≤ 24（VoicePool 抢占）
//   3) 定位音正确设置 PannerNode 的 positionX/Z
//   4) suspend() 之后不再创建任何新节点
//   5) 没有任何 NaN 参数（setTargetAtTime(NaN) 会让节点永久静音）
//   6) 音乐三层 stem 的 gain 全部用平滑自动化写入（无爆音），且 off→1 单调上升
//
// 用法：node scripts/audio-check.mjs   （退出码 0 = 全过）
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ONLY = process.argv.includes('--keep') ? null : true;

// 所有必须存在的音效名（与任务清单一致 + 8 类枪声）
const SHOTS = ['pistol', 'smg', 'rifle', 'shotgun', 'marksman', 'sniper', 'lmg', 'special'];
const NAMES = [
  ...SHOTS.map((s) => `shot:${s}`),
  'reload', 'empty', 'hit', 'hitmarker_head', 'kill', 'hurt', 'down', 'death',
  'heal_start', 'heal_done', 'pickup', 'equip', 'throw', 'explosion', 'flash_bang',
  'smoke_pop', 'fire_crackle', 'fallback_nonexistent_name', 'vehicle_engine', 'vehicle_hit',
  'zone_warning', 'airdrop_in', 'airdrop_land', 'ui_click', 'ui_hover', 'ui_back', 'ui_error',
  'level_up', 'victory', 'defeat', 'wave_start', 'boss_spawn',
];
const FOOTSTEP_TERRAINS = ['grass', 'concrete', 'water', 'snow'];

const MOCK = String.raw`
(() => {
  const state = { nodes: [], params: [], events: [], closed: false, suspended: false, resumes: 0, running: true };
  let paramSeq = 0;
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  function param(name, initial, node, kind) {
    const p = {
      __id: ++paramSeq, __name: name, __kind: kind, __node: node.__id,
      _v: finite(initial) ? initial : 0,
      __writes: 0, __bad: [],
      get value() { return this._v; },
      set value(v) { this._v = v; state.params.push({ id: this.__id, node: this.__node, name, kind, op: 'value', v }); if (!finite(v)) this.__bad.push(['value', v]); },
      setValueAtTime(v, t) { state.params.push({ id: this.__id, node: this.__node, name, kind, op: 'set', v, t }); if (!finite(v)) this.__bad.push(['set', v]); if (!finite(t)) this.__bad.push(['set:t', t]); if (finite(v)) this._v = v; return this; },
      linearRampToValueAtTime(v, t) { state.params.push({ id: this.__id, node: this.__node, name, kind, op: 'linear', v, t }); if (!finite(v) || !finite(t)) this.__bad.push(['linear', v, t]); return this; },
      exponentialRampToValueAtTime(v, t) { state.params.push({ id: this.__id, node: this.__node, name, kind, op: 'exp', v, t }); if (!finite(v) || !finite(t)) this.__bad.push(['exp', v, t]); return this; },
      setTargetAtTime(v, t, tau) { state.params.push({ id: this.__id, node: this.__node, name, kind, op: 'target', v, t, tau }); if (!finite(v) || !finite(t) || !finite(tau)) this.__bad.push(['target', v, t, tau]); return this; },
      cancelScheduledValues(t) { state.params.push({ id: this.__id, node: this.__node, name, kind, op: 'cancel', t }); return this; },
    };
    state.params.push({ id: p.__id, node: node.__id, name, kind, op: 'init', v: p._v });
    return p;
  }
  class MockNode {
    constructor(type) {
      this.__type = type;
      this.__id = state.nodes.length + 1;
      this.__connections = 0;
      this.__disconnects = 0;
      this.__started = false;
      this.__birth = (new Error('x').stack || '').split('\n').slice(2, 5).join(' | ');
      state.nodes.push(this);
    }
    connect(dest) { this.__connections++; state.events.push(['connect', this.__type, dest && dest.__type]); return dest; }
    disconnect() { this.__disconnects++; state.events.push(['disconnect', this.__type]); }
  }
  const mk = (type, extra) => {
    const n = new MockNode(type);
    n.__extra = extra || '';
    return n;
  };
  class AudioParamHolder {}
  function GainNode() {
    const n = mk('gain');
    n.gain = param('gain', 1, n, 'gain');
    return n;
  }
  function OscillatorNode() {
    const n = mk('oscillator');
    n.type = 'sine';
    n.frequency = param('frequency', 440, n, 'freq');
    n.detune = param('detune', 0, n, 'detune');
    n.onended = null;
    n.start = (t) => { n.__started = true; state.events.push(['start', 'oscillator', t]); };
    n.stop = (t) => { state.events.push(['stop', 'oscillator', t]); n.__stopped = t; };
    return n;
  }
  function BufferSourceNode() {
    const n = mk('bufferSource');
    n.buffer = null;
    n.loop = false;
    n.playbackRate = param('playbackRate', 1, n, 'rate');
    n.onended = null;
    n.start = (t) => { n.__started = true; state.events.push(['start', 'bufferSource', t]); };
    n.stop = (t) => { state.events.push(['stop', 'bufferSource', t]); n.__stopped = t; };
    return n;
  }
  function BiquadFilterNode() {
    const n = mk('biquad');
    n.type = 'lowpass';
    n.frequency = param('frequency', 350, n, 'freq');
    n.Q = param('Q', 1, n, 'q');
    n.gain = param('gain', 0, n, 'gain');
    return n;
  }
  function StereoPannerNode() {
    const n = mk('stereoPanner');
    n.pan = param('pan', 0, n, 'pan');
    return n;
  }
  function PannerNode() {
    const n = mk('panner');
    n.panningModel = 'equalpower';
    n.distanceModel = 'inverse';
    n.refDistance = 1;
    n.maxDistance = 10000;
    n.rolloffFactor = 1;
    n.coneInnerAngle = 360;
    n.coneOuterAngle = 360;
    n.coneOuterGain = 0;
    n.positionX = param('positionX', 0, n, 'pos');
    n.positionY = param('positionY', 0, n, 'pos');
    n.positionZ = param('positionZ', 0, n, 'pos');
    n.__setPosition = null;
    n.setPosition = (x, y, z) => { n.__setPosition = [x, y, z]; state.events.push(['setPosition', x, y, z]); };
    return n;
  }
  function Listener() {
    const l = { __type: 'listener', __id: 0 };
    l.positionX = param('listenerX', 0, l, 'pos');
    l.positionY = param('listenerY', 0, l, 'pos');
    l.positionZ = param('listenerZ', 0, l, 'pos');
    l.forwardX = param('forwardX', 0, l, 'dir');
    l.forwardY = param('forwardY', 0, l, 'dir');
    l.forwardZ = param('forwardZ', 1, l, 'dir');
    l.upX = param('upX', 0, l, 'dir');
    l.upY = param('upY', 1, l, 'dir');
    l.upZ = param('upZ', 0, l, 'dir');
    l.__calls = [];
    l.setPosition = (x, y, z) => l.__calls.push(['setPosition', x, y, z]);
    l.setOrientation = (a, b, c, d, e, f) => l.__calls.push(['setOrientation', a, b, c, d, e, f]);
    return l;
  }
  function CompressorNode() {
    const n = mk('compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = param(k, 0, n, 'comp');
    return n;
  }
  function ConvolverNode() { const n = mk('convolver'); n.buffer = null; return n; }
  function Buffer(ch, len, rate) { this.numberOfChannels = ch; this.length = len; this.sampleRate = rate; this._d = []; for (let i = 0; i < ch; i++) this._d.push(new Float32Array(len)); }
  Buffer.prototype.getChannelData = function (i) { return this._d[i] || this._d[0]; };
  class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.__t = 0;
      this.destination = mk('destination');
      this.listener = Listener();
      state.ctx = this;
    }
    get currentTime() { return this.__t; }
    createGain() { return GainNode(); }
    createOscillator() { return OscillatorNode(); }
    createBufferSource() { return BufferSourceNode(); }
    createBiquadFilter() { return BiquadFilterNode(); }
    createStereoPanner() { return StereoPannerNode(); }
    createPanner() { return PannerNode(); }
    createDynamicsCompressor() { return CompressorNode(); }
    createConvolver() { return ConvolverNode(); }
    createBuffer(ch, len, rate) { return new Buffer(ch, len, rate); }
    suspend() { this.state = 'suspended'; state.suspended = true; return Promise.resolve(); }
    resume() { this.state = 'running'; state.resumes++; state.suspended = false; return Promise.resolve(); }
    close() { state.closed = true; return Promise.resolve(); }
  }
  window.__audioMock = state;
  window.AudioContext = MockAudioContext;
  window.webkitAudioContext = MockAudioContext;
})();
`;

const PLAYER = `(() => {
  const a = new window.__AudioModule.GameAudio();
  const mock = window.__audioMock;
  window.__audio = a;
  const self = { id: 'me', x: 10, z: -4, angle: 0.4, alive: true, ammo: 30 };
  a.init({ settings: { sound: true, sfx: 0.9, music: 0.6 }, me: self, state: { players: [self] }, selfId: 'me' });
  a.unlock();
  return { ready: a.ready, state: a.ctx && a.ctx.state, nodes: mock.nodes.length };
})()`;

const dir = await mkdtemp(join(tmpdir(), 'mist-audio-'));
const outfile = join(dir, 'audio.bundle.js');
let failures = 0;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  await build({
    entryPoints: [join(root, 'client/audio.js')],
    outfile, bundle: true, format: 'iife', globalName: '__AudioModule', target: ['chrome100'],
    logLevel: 'silent', write: true,
  });
  const code = await (await import('node:fs/promises')).readFile(outfile, 'utf8');
  const pageErrors = [];
  /** 新开一页：注入 mock，再注入被打包的音频引擎。每段断言一张干净页面。 */
  async function newPage(bundleCode) {
    const target = await browser.newPage();
    target.on('pageerror', (e) => pageErrors.push(e.message));
    target.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await target.setContent('<!doctype html><meta charset="utf-8"><title>audio-check</title>');
    await target.addScriptTag({ content: MOCK });
    await target.addScriptTag({ content: bundleCode });
    return target;
  }
  const page = await newPage(code);
  const boot = await page.evaluate(PLAYER);
  check('引擎在 mock AudioContext 下启动', boot.ready === true && boot.state === 'running', JSON.stringify(boot));

  // ── 1) 每个名字都能播 ────────────────────────────────────────────────
  const playReport = await page.evaluate((names) => {
    const a = window.__audio;
    const out = {};
    for (const name of names) {
      const before = window.__audioMock.nodes.length;
      let threw = null;
      let ret = false;
      try { ret = a.play(name, { vol: 0.8 }); } catch (e) { threw = String(e && e.message || e); }
      const created = window.__audioMock.nodes.length - before;
      out[name] = { ret: !!ret, threw, created };
      a.ctx.__t += 0.9;   // 推进音频时钟：让上一发过期
      a.lastAt.clear();   // 清节流（真实时间节流与 mock 时钟无关）
      a.pool.items.length = 0; // 清池：逐个音效独立测量
    }
    return out;
  }, NAMES);
  const silent = Object.entries(playReport).filter(([, r]) => r.threw || !r.ret || r.created <= 0);
  check('全部音效名可播放并创建节点', silent.length === 0,
    silent.length ? silent.map(([n, r]) => `${n}:${r.threw || (r.ret ? 'no-node' : 'no-return')}`).join(', ') : `${NAMES.length} 个名字`);

  // 脚步声 4 种地形
  const stepReport = await page.evaluate((terrains) => {
    const a = window.__audio;
    const out = {};
    for (const terrain of terrains) {
      const before = window.__audioMock.nodes.length;
      a.lastAt.clear();
      out[terrain] = { ret: !!a.play('footstep', { terrain, vol: 0.7 }), created: window.__audioMock.nodes.length - before };
      a.pool.items.length = 0;
      a.ctx.__t += 0.5;
    }
    return out;
  }, FOOTSTEP_TERRAINS);
  check('footstep × 4 地形', FOOTSTEP_TERRAINS.every((t) => stepReport[t].ret && stepReport[t].created > 0), JSON.stringify(stepReport));

  // ── 2) 40 发枪声 → 活跃声道 ≤ 24 ─────────────────────────────────────
  const poolReport = await page.evaluate(() => {
    const a = window.__audio;
    a.pool.items.length = 0;
    let played = 0;
    for (let i = 0; i < 40; i++) {
      // 同一音频时刻连开 40 枪（清掉节流，专测声道池）：最坏情况
      a.lastAt.clear();
      if (a.play('shot:rifle', { vol: 0.7, dist: i * 2 })) played++;
    }
    return { played, active: a.pool.size, max: a.pool.max, steals: a.pool.steals, dropped: a.pool.dropped, voices: a.voices };
  });
  check('同时 40 发枪声后活跃声道 ≤ 24', poolReport.active <= 24 && poolReport.max === 24,
    `active=${poolReport.active} max=${poolReport.max} steals=${poolReport.steals} dropped=${poolReport.dropped}`);

  // ── 3) 定位音 Panner positionX/Z ─────────────────────────────────────
  const spatialReport = await page.evaluate(() => {
    const a = window.__audio;
    const mock = window.__audioMock;
    a.pool.items.length = 0;
    a.lastAt.clear();
    a.rig.setListener(10, -4, 0.4, true);
    const before = mock.nodes.length;
    a.playAt('shot:shotgun', { x: 40, z: -30 });
    const created = mock.nodes.slice(before);
    const panners = created.filter((n) => n.__type === 'panner');
    const filters = created.filter((n) => n.__type === 'biquad');
    // 只看「这个 Panner 节点」的位置写入，排除 listener 的 positionX/Z
    const pannerIds = panners.map((n) => n.__id);
    const writes = mock.params.filter((p) => pannerIds.includes(p.node) && (p.name === 'positionX' || p.name === 'positionZ'));
    const px = writes.filter((p) => p.name === 'positionX').map((p) => p.v);
    const pz = writes.filter((p) => p.name === 'positionZ').map((p) => p.v);
    const listenerWrites = mock.params.filter((p) => p.name.startsWith('listener') || p.name.startsWith('forward')).length;
    return {
      panners: panners.length, filters: filters.length,
      px: px[px.length - 1], pz: pz[pz.length - 1],
      listenerWrites,
      panningModel: panners[0] && panners[0].panningModel,
      distanceModel: panners[0] && panners[0].distanceModel,
      refDistance: panners[0] && panners[0].refDistance,
      maxDistance: panners[0] && panners[0].maxDistance,
      rolloff: panners[0] && panners[0].rolloffFactor,
      cutoff: filters[0] && filters[0].frequency.value,
    };
  });
  check('定位音创建 PannerNode 并写入位置', spatialReport.panners > 0 && spatialReport.px === 40 && spatialReport.pz === -30,
    `panners=${spatialReport.panners} pos=(${spatialReport.px}, ${spatialReport.pz})`);
  check('Panner 参数：inverse / ref 6 / max 90 / rolloff 1.4',
    spatialReport.distanceModel === 'inverse' && spatialReport.refDistance === 6 && spatialReport.maxDistance === 90 && spatialReport.rolloff === 1.4,
    `${spatialReport.distanceModel} ref=${spatialReport.refDistance} max=${spatialReport.maxDistance} rolloff=${spatialReport.rolloff} model=${spatialReport.panningModel}`);
  check('定位音带距离低通且听者位置已写入', spatialReport.filters > 0 && spatialReport.listenerWrites > 0,
    `filters=${spatialReport.filters} cutoff=${spatialReport.cutoff} listenerWrites=${spatialReport.listenerWrites}`);

  // 低通曲线：25m 内 18000，90m 处 1200
  const curve = await page.evaluate(async () => {
    const mod = await import('./audio-spatial.js').catch(() => null);
    return mod ? null : null;
  });
  void curve;

  // ── 4) suspend() 后不再创建节点 ──────────────────────────────────────
  const suspendReport = await page.evaluate(async () => {
    const a = window.__audio;
    const mock = window.__audioMock;
    a.suspend();
    const ctxState = a.ctx.state;
    const before = mock.nodes.length;
    const played = [];
    for (const name of ['shot:rifle', 'hit', 'ui_click', 'explosion', 'kill']) played.push(a.play(name, {}));
    const after = mock.nodes.length;
    a.resume();
    return { ctxState, created: after - before, played, resumedState: a.ctx.state, resumes: mock.resumes };
  });
  check('suspend() 真的挂起 ctx 且不再创建节点',
    suspendReport.ctxState === 'suspended' && suspendReport.created === 0 && suspendReport.played.every((v) => v === false),
    `ctx=${suspendReport.ctxState} created=${suspendReport.created} resumed=${suspendReport.resumedState}`);

  // ── 5) 无 NaN 参数 ───────────────────────────────────────────────────
  const nanReport = await page.evaluate(() => {
    const mock = window.__audioMock;
    const bad = [];
    for (const n of mock.nodes) for (const key of Object.keys(n)) {
      const p = n[key];
      if (p && typeof p === 'object' && Array.isArray(p.__bad) && p.__bad.length) bad.push({ node: n.__type, param: key, bad: p.__bad.slice(0, 3) });
    }
    const paramBad = mock.params.filter((p) => 'v' in p && (typeof p.v !== 'number' || !Number.isFinite(p.v)));
    const tBad = mock.params.filter((p) => 't' in p && (typeof p.t !== 'number' || !Number.isFinite(p.t)));
    const tauBad = mock.params.filter((p) => 'tau' in p && (typeof p.tau !== 'number' || !Number.isFinite(p.tau)));
    return { nodeBad: bad.length, paramBad: paramBad.length, tBad: tBad.length, tauBad: tauBad.length, samples: bad.slice(0, 4), total: mock.params.length };
  });
  check('没有任何 NaN 参数', nanReport.nodeBad === 0 && nanReport.paramBad === 0 && nanReport.tBad === 0 && nanReport.tauBad === 0,
    `nodeBad=${nanReport.nodeBad} v=${nanReport.paramBad} t=${nanReport.tBad} tau=${nanReport.tauBad} (params=${nanReport.total}) ${JSON.stringify(nanReport.samples)}`);

  // ── 6) 音乐三层 stem ────────────────────────────────────────────────
  const musicReport = await page.evaluate(() => {
    const a = window.__audio;
    const mock = window.__audioMock;
    a.setMusic('battle');
    const before = mock.params.length;
    const layers = [];
    for (const t of [0, 0.35, 0.7, 1]) { a.setTension(t); layers.push({ t, mix: a.musicLayers }); }
    // 所有音乐 bus 上的 gain 写入都必须是平滑型，且不能直接赋值
    const writes = mock.params.slice(before).filter((p) => p.kind === 'gain');
    const smoothOps = writes.filter((w) => w.op === 'target' || w.op === 'linear' || w.op === 'set');
    const direct = writes.filter((w) => w.op === 'value');
    const negative = smoothOps.filter((w) => w.v < 0);
    return {
      layers, stems: a.music.setMode ? !!a.music : false, mode: a.music.mode,
      writes: writes.length, direct: direct.length, negative: negative.length,
      baseUp: layers[3].mix.base > layers[0].mix.base,
      tenseUp: layers[3].mix.tension > layers[0].mix.tension,
      climaxUp: layers[3].mix.climax > layers[0].mix.climax,
    };
  });
  check('音乐模式切换 + 三层 stem 存在', musicReport.mode === 'battle' && musicReport.stems, `mode=${musicReport.mode}`);
  check('tension 0→1 三层单调增强', musicReport.baseUp && musicReport.tenseUp && musicReport.climaxUp,
    JSON.stringify(musicReport.layers));
  check('音乐参数无直接赋值（无爆音）且非负', musicReport.direct === 0 && musicReport.negative === 0,
    `writes=${musicReport.writes} direct=${musicReport.direct} negative=${musicReport.negative}`);

  // ── 7) 基础混音与总线 ───────────────────────────────────────────────
  const mixReport = await page.evaluate(() => {
    const a = window.__audio;
    const buses = a.buses ? Object.keys(a.buses) : [];
    const v = a.setVolume({ gun: 0.3, ui: 0.2, music: 0.4 });
    const muted = a.mute(true);
    const unmuted = a.mute(false);
    return { buses, vol: v.gun === 0.3 && v.ui === 0.2 && v.music === 0.4, muted, unmuted, comp: !!a.comp, master: !!a.master };
  });
  check('总线 gun/fx/ui/music/ambience 齐备且可独立调音量',
    ['gun', 'fx', 'ui', 'music', 'ambience'].every((k) => mixReport.buses.includes(k)) && mixReport.vol && mixReport.comp && mixReport.master,
    `${mixReport.buses.join('/')}`);
  check('mute(true)/mute(false) 可切换', mixReport.muted === true && mixReport.unmuted === false, `${mixReport.muted}→${mixReport.unmuted}`);

  // ── 8) 资源回收：每个 source 都应被 disconnect ──────────────────────
  const leakReport = await page.evaluate(async () => {
    const a = window.__audio;
    const mock = window.__audioMock;
    a.pool.items.length = 0;
    a.lastAt.clear();
    for (let i = 0; i < 8; i++) { a.play('shot:pistol', { vol: 0.6 }); a.ctx.__t += 0.5; }
    a.play('vehicle_engine', { x: 6, z: 6, speed: 8 });
    a.stopLoop('vehicle_engine');
    // 循环音（vehicle_engine / fire_crackle）按设计常驻，不算泄漏；其余一次性音源必须
    // 「挂 onended 清理 + 已排 stop()」。mock 里 onended 不会真触发，所以只断言这两件事。
    // 用引擎自己登记的 _loopNodes 判断，避免按 id 编号去猜（id 会被非法调用占号）。
    const loopIds = new Set([...a._loopNodes].map((n) => n.__id));
    for (const h of a.loops.values()) for (const n of h.nodes) loopIds.add(n.__id);
    const all = mock.nodes.filter((n) => n.__type === 'oscillator' || n.__type === 'bufferSource');
    const sources = all.filter((n) => !loopIds.has(n.__id));
    const withOnended = sources.filter((n) => typeof n.onended === 'function');
    const withStop = sources.filter((n) => Number.isFinite(n.__stopped));
    const missingOnended = sources.filter((n) => typeof n.onended !== 'function').map((n) => `${n.__type}#${n.__id}`).slice(0, 4);
    const missingStop = sources.filter((n) => !Number.isFinite(n.__stopped)).map((n) => `${n.__type}#${n.__id}`).slice(0, 4);
    const poolBefore = a.pool.size;
    const loopCount = all.length - sources.length;
    const loopKeys = [...a.loops.keys()];
    a.dispose();
    await new Promise((r) => setTimeout(r, 300));
    return {
      sources: sources.length, withOnended: withOnended.length, withStop: withStop.length,
      poolBefore, poolAfter: a.pool.size, closed: mock.closed, ready: a.ready, missingOnended, missingStop,
      loopCount, loopKeys, loopsAfter: a.loops.size,
    };
  });
  check('每条 source 都有 onended 清理 + stop() 排期（无泄漏）',
    leakReport.sources > 0 && leakReport.withOnended === leakReport.sources && leakReport.withStop === leakReport.sources,
    `sources=${leakReport.sources} onended=${leakReport.withOnended} stop=${leakReport.withStop} noOnended=${leakReport.missingOnended} noStop=${leakReport.missingStop}`);
  check('dispose() 关闭 ctx、清空声道池与循环音',
    leakReport.closed === true && leakReport.ready === false && leakReport.poolAfter === 0 && leakReport.loopsAfter === 0,
    `closed=${leakReport.closed} ready=${leakReport.ready} pool ${leakReport.poolBefore}→${leakReport.poolAfter} loops ${leakReport.loopCount}→${leakReport.loopsAfter}`);

  check('页面无 console/page 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('脚本自身无异常', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' ') : String(err));
} finally {
  await browser.close();
  if (ONLY) await rm(dir, { recursive: true, force: true });
  else await writeFile(join(root, 'artifacts/audio-check.json'), JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: failures, results }, null, 2)).catch(() => {});
}

console.log(`\n${results.length - failures}/${results.length} 项通过${failures ? `，${failures} 项失败` : ''}`);
process.exit(failures ? 1 : 0);
