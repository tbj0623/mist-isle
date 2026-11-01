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
  ground: { sandRing: 0xd5c193, shore: 0xb9c7ae, detail: 0.5, roughness: 0.86 },
  haze: 0xffffff,
  stars: 0,
  // 地面雾（低空浓雾带，用半透明平面模拟）+ 远景雾（FogExp2 / Fog）
  groundMist: { color: 0xffffff, opacity: 0.16, height: 2.4, scale: 1.0 },
  fogMode: 'linear',
  fogDensity: 0.0042,
  // 动态元素
  motion: { flags: 0.0, water: 0.0, leaves: 0.0, drip: 0.0, windowGlow: 0 },
};

/** 主题 = maps.mjs theme + 视觉增强参数。三张图必须一眼可辨：
 *  青岚＝湿润青绿 + 灰蓝雾；赤砂＝橙红沙尘 + 暖黄光；白夜＝冷蓝夜 + 月光 + 窗光。 */
export const THEMES = {
  qinglan: {
    ...BASE,
    id: 'qinglan',
    name: '青岚岛',
    fogColor: 0x9dbcbb,
    fogNear: 92, fogFar: 300,
    ambient: { sky: 0xd4ece2, ground: 0x445b4a, intensity: 1.42 },
    sun: { color: 0xfff4dc, intensity: 2.42, position: [86, 165, 62] },
    exposure: 1.06,
    water: { color: 0x5f9aa4, opacity: 0.94, animated: true, foam: 0xd7ece6, roughness: 0.16 },
    ground: { sandRing: 0xd8c69c, shore: 0x9dbc9a, detail: 0.62, grass: 0x6f9660, grassAlt: 0x86a86c, roughness: 0.78 },
    rain: { color: 0xbcd6de, opacity: 0.5 },
    haze: 0xc2dcd8,
    birds: true,
    landmarkAccent: 0xefb657,
    groundMist: { color: 0xd6e8e4, opacity: 0.2, height: 2.2, scale: 1.05 },
    fogMode: 'linear',
    motion: { flags: 0.85, water: 1.0, leaves: 0.7, drip: 0.8, windowGlow: 0.15 },
    // 青岚：湿润 = 低粗糙度高反射（水洼感），整体偏青绿
    wetness: 0.45,
    puddle: 0.4,
    paletteBias: { saturation: 1.04, temperature: -0.06 },
  },
  chisha: {
    ...BASE,
    id: 'chisha',
    name: '赤砂矿区',
    fogColor: 0xdb9a63,
    fogNear: 58, fogFar: 214,
    ambient: { sky: 0xffcf9c, ground: 0x6a4a2c, intensity: 1.26 },
    sun: { color: 0xffb469, intensity: 3.05, position: [-120, 58, 45] },
    exposure: 1.2,
    water: { color: 0xa8763f, opacity: 0.8, animated: false, roughness: 0.9 },
    ground: { sandRing: 0xd6a468, shore: 0xbe9358, detail: 0.82, grass: 0xb08f58, grassAlt: 0xc4a066, roughness: 0.98 },
    dust: { color: 0xe0b184, opacity: 0.6 },
    haze: 0xf3cf9c,
    birds: false,
    landmarkAccent: 0xe0803f,
    groundMist: { color: 0xe8b884, opacity: 0.26, height: 2.8, scale: 1.2 },
    fogMode: 'linear',
    motion: { flags: 0.6, water: 0.0, leaves: 0.18, drip: 0.0, windowGlow: 0.0 },
    wetness: 0.05,
    puddle: 0.0,
    paletteBias: { saturation: 1.12, temperature: 0.14 },
  },
  baiye: {
    ...BASE,
    id: 'baiye',
    name: '白夜港',
    fogColor: 0x2b3f52,
    fogNear: 64, fogFar: 232,
    ambient: { sky: 0x4d7396, ground: 0x121c26, intensity: 0.82 },
    sun: { color: 0xa9c8ec, intensity: 1.32, position: [-90, 120, -70] },
    exposure: 1.28,
    water: { color: 0x28414f, opacity: 0.97, animated: true, ice: true, foam: 0xbcd6de, roughness: 0.22 },
    ground: { sandRing: 0xc8d5d3, shore: 0x8fa3a2, detail: 0.38, grass: 0x8fa3a0, grassAlt: 0xa3b6b2, roughness: 0.62 },
    snow: { color: 0xffffff, opacity: 0.9 },
    night: { ambient: 0x35547a, sun: 0x9cc2e8, intensity: 0.92, lamps: true, lampColor: 0xffc978 },
    haze: 0x22384a,
    stars: 0.75,
    birds: false,
    landmarkAccent: 0x8fd6e8,
    groundMist: { color: 0x6d8ea8, opacity: 0.18, height: 2.0, scale: 1.15 },
    fogMode: 'exp2',
    fogDensity: 0.0055,
    motion: { flags: 0.7, water: 0.45, leaves: 0.22, drip: 0.0, windowGlow: 1.0 },
    wetness: 0.3,
    puddle: 0.12,
    paletteBias: { saturation: 0.9, temperature: -0.2 },
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
    fogMode: theme.fogMode || 'linear',
    fogDensity: theme.fogDensity ?? 0.0042,
    ambient: { ...theme.ambient }, sun: { ...theme.sun },
    exposure: theme.exposure, clearColor: theme.fogColor, lamps: false, stars: theme.stars || 0,
    groundMist: { ...(theme.groundMist || { color: 0xffffff, opacity: 0.16, height: 2.4, scale: 1 }) },
    motion: { ...(theme.motion || { flags: 0, water: 0, leaves: 0 }) },
    keyLight: null,
  };
  if (timeOfDay === 'dusk' || theme.mapId === 'chisha') {
    out.fogColor = timeOfDay === 'dusk' ? 0xd88f5c : theme.fogColor;
    out.ambient.sky = 0xffc491; out.ambient.intensity *= 0.94;
    out.sun.color = 0xffab5e; out.sun.intensity *= 1.16;
    out.sun.position = [-120, 58, 45];
    out.exposure *= 1.05;
    out.groundMist.color = 0xe6b583; out.groundMist.opacity = Math.max(out.groundMist.opacity, 0.24);
  }
  if (timeOfDay === 'night' || theme.mapId === 'baiye') {
    const night = theme.night || { ambient: 0x35547a, sun: 0x9cc2e8, intensity: 0.92, lamps: true, lampColor: 0xffc978 };
    out.fogColor = theme.fogColor; out.ambient.sky = night.ambient; out.ambient.intensity = 0.95;
    out.sun.color = night.sun; out.sun.intensity = night.intensity; out.lamps = night.lamps;
    out.lampColor = night.lampColor; out.exposure = 1.3;
    // 月光方向光（冷色 + 高角度），与暖色路灯形成冷暖对比
    out.keyLight = { color: 0x9dc0ea, intensity: 0.85, position: [-70, 140, -90] };
    out.groundMist.color = 0x5f7f9c; out.groundMist.opacity = 0.2;
  }
  if (weather === 'fog') { out.fogNear *= 0.42; out.fogFar *= 0.62; out.fogDensity *= 1.5; }
  else if (weather === 'rain') {
    out.fogNear *= 0.66; out.fogFar *= 0.8; out.sun.intensity *= 0.72; out.ambient.intensity *= 0.9;
    out.groundMist.opacity += 0.05; out.fogDensity *= 1.15;
  } else if (weather === 'sandstorm') {
    out.fogNear *= 0.5; out.fogFar *= 0.72; out.fogColor = 0xcf9059; out.sun.intensity *= 0.86;
    out.groundMist.opacity = 0.34; out.groundMist.color = 0xdcab74; out.fogDensity *= 1.7;
  } else if (weather === 'snow') {
    out.fogNear *= 0.6; out.fogFar *= 0.82; out.sun.intensity *= 0.92; out.fogDensity *= 1.3;
  }
  if (out.clearColor === theme.fogColor && out.fogColor !== theme.fogColor) out.clearColor = out.fogColor;
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
