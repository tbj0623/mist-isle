// 雾岛突围 / MIST ISLE 1.0 — 三图配色 / 光照 / 天气参数表（owner: renderfx）
// 只描述「怎么看起来更像那张图」，几何仍由 shared/map.mjs 生成。
import { MAPS } from '../shared/data/maps.mjs';

const BASE = {
  fogNear: 120,
  fogFar: 340,
  ambient: { sky: 0xdfe9e2, ground: 0x4a5a4a, intensity: 1.35 },
  sun: { color: 0xfff0d4, intensity: 2.35, position: [70, 150, 55] },
  exposure: 1.08,
  water: { color: 0x6fa6ad, opacity: 0.92, animated: true },
  ground: { sandRing: 0xd5c193, shore: 0xb9c7ae, detail: 0.5 },
  haze: 0xffffff,
  stars: 0,
};

/** 主题 = maps.mjs theme + 视觉增强参数。 */
export const THEMES = {
  qinglan: {
    ...BASE,
    id: 'qinglan',
    name: '青岚岛',
    fogColor: 0xa8c6c2,
    fogNear: 132, fogFar: 365,
    ambient: { sky: 0xdceee6, ground: 0x53664f, intensity: 1.4 },
    sun: { color: 0xfff2d8, intensity: 2.5, position: [86, 165, 62] },
    exposure: 1.1,
    water: { color: 0x6ea3ab, opacity: 0.94, animated: true, foam: 0xd7ece6 },
    ground: { sandRing: 0xd8c69c, shore: 0xa9c0a0, detail: 0.6, grass: 0x7c9e68, grassAlt: 0x8fae74 },
    rain: { color: 0xbcd6de, opacity: 0.5 },
    haze: 0xcfe4e0,
    birds: true,
    landmarkAccent: 0xefb657,
  },
  chisha: {
    ...BASE,
    id: 'chisha',
    name: '赤砂矿区',
    fogColor: 0xd8a679,
    fogNear: 96, fogFar: 300,
    ambient: { sky: 0xf0c79a, ground: 0x6d5334, intensity: 1.18 },
    sun: { color: 0xffb877, intensity: 2.75, position: [-120, 70, 45] },
    exposure: 1.16,
    water: { color: 0xb58a5e, opacity: 0.85, animated: false },
    ground: { sandRing: 0xcfa878, shore: 0xb99c6c, detail: 0.75, grass: 0xb59a68, grassAlt: 0xa88f5f },
    dust: { color: 0xd9b184, opacity: 0.55 },
    haze: 0xf0d0a8,
    birds: false,
    landmarkAccent: 0xd97b3f,
  },
  baiye: {
    ...BASE,
    id: 'baiye',
    name: '白夜港',
    fogColor: 0x35505f,
    fogNear: 78, fogFar: 280,
    ambient: { sky: 0x5b7c96, ground: 0x1a2730, intensity: 0.95 },
    sun: { color: 0x9fc4e8, intensity: 1.15, position: [-90, 120, -70] },
    exposure: 1.22,
    water: { color: 0x35505f, opacity: 0.96, animated: false, ice: true, foam: 0xbcd6de },
    ground: { sandRing: 0xcdd8d5, shore: 0x9fb0ad, detail: 0.4, grass: 0x9fb0ad, grassAlt: 0xb0c0bd },
    snow: { color: 0xffffff, opacity: 0.85 },
    night: { ambient: 0x3f5f80, sun: 0x8fb8e0, intensity: 0.8, lamps: true, lampColor: 0xffc978 },
    haze: 0x2c4152,
    stars: 0.6,
    birds: false,
    landmarkAccent: 0x8fd6e8,
  },
};

export function themeFor(mapId) {
  const id = mapId in THEMES ? mapId : 'qinglan';
  const def = MAPS[id] || MAPS.qinglan;
  const theme = THEMES[id];
  const palette = def.theme || {};
  return {
    ...theme,
    mapId: id,
    def,
    name: theme.name,
    accent: palette.accent ?? theme.landmarkAccent,
    palette,
    ground: {
      ...theme.ground,
      sandRing: palette.sand ?? theme.ground.sandRing,
      grass: palette.grass ?? theme.ground.grass,
      grassAlt: palette.grassAlt ?? theme.ground.grassAlt,
      road: palette.road ?? 0x77847b,
      rock: palette.rock ?? 0x8d968a,
    },
    water: { ...theme.water, color: palette.water ?? theme.water.color },
    fogColor: palette.fog ?? theme.fogColor,
    sky: palette.sky ?? theme.fogColor,
    tree: palette.tree || [0x285e53, 0x3a7560, 0x548469],
    roof: palette.roof || [0xae6855, 0x557986, 0x66715c, 0xb78560],
    wall: palette.wall || [0xe6d6b5, 0xaebcb2, 0xd1c6ac, 0xc8b59d],
  };
}

/** 昼夜/天气对光照与雾的修正（返回可直接赋给 three 的参数）。 */
export function lightingFor(theme, timeOfDay = 'day', weather = 'clear') {
  const out = {
    fogColor: theme.fogColor, fogNear: theme.fogNear, fogFar: theme.fogFar,
    ambient: { ...theme.ambient }, sun: { ...theme.sun },
    exposure: theme.exposure, clearColor: theme.fogColor, lamps: false, stars: theme.stars || 0,
  };  if (timeOfDay === 'dusk' || theme.mapId === 'chisha') {
    out.fogColor = timeOfDay === 'dusk' ? 0xd49670 : theme.fogColor;
    out.ambient.sky = 0xefb98a; out.ambient.intensity *= 0.86;
    out.sun.color = 0xffb173; out.sun.intensity *= 1.12;
    out.exposure *= 1.03;
  }
  if (timeOfDay === 'night' || theme.mapId === 'baiye') {
    const night = theme.night || { ambient: 0x3f5f80, sun: 0x8fb8e0, intensity: 0.8, lamps: true, lampColor: 0xffc978 };
    out.fogColor = theme.fogColor; out.ambient.sky = night.ambient; out.ambient.intensity = 1.0;
    out.sun.color = night.sun; out.sun.intensity = night.intensity; out.lamps = night.lamps;
    out.lampColor = night.lampColor; out.exposure = 1.26;
  }
  if (weather === 'fog') { out.fogNear *= 0.42; out.fogFar *= 0.62; }
  else if (weather === 'rain') { out.fogNear *= 0.66; out.fogFar *= 0.8; out.sun.intensity *= 0.72; out.ambient.intensity *= 0.88; }
  else if (weather === 'sandstorm') { out.fogNear *= 0.5; out.fogFar *= 0.72; out.fogColor = 0xc99a6a; out.sun.intensity *= 0.8; }
  else if (weather === 'snow') { out.fogNear *= 0.6; out.fogFar *= 0.82; out.sun.intensity *= 0.9; }
  return out;
}

/** 相机参数（俯视 55-62°，按 quality 调距离）。 */
export const CAMERA = {
  fov: 46,
  pitch: 58 * Math.PI / 180,
  minPitch: 48 * Math.PI / 180,
  maxPitch: 66 * Math.PI / 180,
  distance: { low: 34, balanced: 30, high: 27 },
  lobbyDistance: 120,
  lookAhead: { low: 3.4, balanced: 4.6, high: 5.2 },
  follow: { low: 7, balanced: 9, high: 11 },
  zoomMin: 18, zoomMax: 48,
};

/** 天气粒子参数（配合 fx.setWeather）。 */
export const WEATHER_FX = {
  clear: { kind: 'none', amount: 0 },
  rain: { kind: 'rain', amount: 0.85, color: 0xbcd6de },
  fog: { kind: 'none', amount: 0, haze: 1.5 },
  sandstorm: { kind: 'sandstorm', amount: 0.9, color: 0xd9b184 },
  snow: { kind: 'snow', amount: 0.8, color: 0xffffff },
};
