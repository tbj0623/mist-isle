// 雾岛突围 / MIST ISLE — 地图定义（冻结文件，禁止他人修改）
// 只描述「意图」；具体建筑/障碍/树木由 shared/map.mjs 的 makeWorld() 程序化生成。
// 坐标单位：米。地图以 (0,0) 为中心，radius 为可活动陆地半径，外圈为海/边界。

export const MAPS = {
  qinglan: {
    id: 'qinglan',
    name: '青岚岛',
    en: 'QINGLAN ISLE',
    subtitle: '海雾漫过松林与旧镇，信号风暴正在逼近。',
    seed: 74129,
    radius: 182,
    water: 'sea',
    timeOfDay: 'day',
    weather: 'rain',
    difficulty: 1,
    tier: 1,
    minPlayers: 24,
    duration: 420,
    theme: {
      sky: 0x86b5b6,
      fog: 0xa8c6c2,
      water: 0x6fa6ad,
      sand: 0xd5c193,
      grass: 0x7c9e68,
      grassAlt: 0x8fae74,
      dirt: 0x9c8a63,
      rock: 0x8d968a,
      road: 0x77847b,
      roof: [0xae6855, 0x557986, 0x66715c, 0xb78560],
      wall: [0xe6d6b5, 0xaebcb2, 0xd1c6ac, 0xc8b59d],
      tree: [0x285e53, 0x3a7560, 0x548469],
      accent: 0xefb657,
    },
    regions: [
      { id: 'qinglan_town', name: '青岚镇', x: -72, z: -70, tier: 3, kind: 'town', r: 46, note: '旧镇中心，多二层民宅与广场。' },
      { id: 'pine_camp', name: '松林营地', x: 66, z: -72, tier: 2, kind: 'wild', r: 40, note: '林地中的散兵营地与篝火。' },
      { id: 'south_bay', name: '南湾港', x: 92, z: 80, tier: 3, kind: 'port', r: 48, note: '栈桥、仓库与集装箱。' },
      { id: 'windmill_farm', name: '风车农场', x: -88, z: 78, tier: 2, kind: 'farm', r: 44, note: '大片农田与谷仓。' },
      { id: 'north_post', name: '北方哨站', x: 2, z: -136, tier: 2, kind: 'checkpoint', r: 38, note: '废弃检查站、路障与瞭望塔。' },
      { id: 'quarry', name: '旧采石场', x: 0, z: 130, tier: 3, kind: 'mine', r: 44, note: '矿坑、碎石堆与矿车轨道。' },
      { id: 'west_warehouse', name: '西岸仓库', x: -140, z: 4, tier: 3, kind: 'industrial', r: 40, note: '连片铁皮仓库与货运站台。' },
      { id: 'east_homes', name: '东部居民区', x: 138, z: 2, tier: 2, kind: 'village', r: 42, note: '整齐的联排住宅与小公园。' },
      { id: 'checkpoint', name: '中央检查站', x: 0, z: 0, tier: 3, kind: 'checkpoint', r: 40, note: '全岛最热闹的交火点。' },
    ],
    landmarks: [
      { kind: 'radio_tower', name: '广播塔', x: -20, z: -20, r: 8 },
      { kind: 'beacon', name: '灯塔', x: 118, z: 122, r: 6 },
      { kind: 'wreck', name: '搁浅货轮', x: -118, z: -118, r: 10 },
    ],
    roads: [
      { kind: 'highway', x: 0, z: 0, w: 9, d: 300, rot: 0 },
      { kind: 'highway', x: 0, z: 0, w: 9, d: 300, rot: Math.PI / 2 },
      { kind: 'dirt', x: -72, z: -40, w: 6, d: 70, rot: Math.PI / 2 },
      { kind: 'dirt', x: 60, z: 46, w: 6, d: 90, rot: 0 },
      { kind: 'dirt', x: -120, z: 10, w: 5, d: 80, rot: Math.PI / 2 },
    ],
    description: '经典战场。资源分布均衡，城镇与港口物资最好，中央检查站是必经的绞肉机。',
  },

  chisha: {
    id: 'chisha',
    name: '赤砂矿区',
    en: 'RED SAND BASIN',
    subtitle: '沙暴吞没了山谷，只有矿塔上的灯还亮着。',
    seed: 91117,
    radius: 172,
    water: 'dunes',
    timeOfDay: 'dusk',
    weather: 'sandstorm',
    difficulty: 2,
    tier: 2,
    minPlayers: 24,
    duration: 400,
    theme: {
      sky: 0xc98a63,
      fog: 0xd8a679,
      water: 0xb58a5e,
      sand: 0xcfa878,
      grass: 0xb59a68,
      grassAlt: 0xa88f5f,
      dirt: 0xb08557,
      rock: 0x9a6f4f,
      road: 0x8b7455,
      roof: [0xa8583f, 0x8a6440, 0x7d5f47, 0xc08b55],
      wall: [0xd8c09a, 0xc7a97f, 0xb99370, 0xd3b98d],
      tree: [0x8d8a4e, 0x77713f, 0xa19658],
      accent: 0xd97b3f,
    },
    regions: [
      { id: 'red_pit', name: '赤砂矿坑', x: -14, z: 8, tier: 3, kind: 'mine', r: 52, note: '巨坑、矿车道与破碎机。' },
      { id: 'container_yard', name: '集装箱堆场', x: 96, z: -58, tier: 3, kind: 'industrial', r: 46, note: '迷宫般的集装箱，短兵相接。' },
      { id: 'refinery', name: '炼油厂', x: -104, z: 52, tier: 3, kind: 'industrial', r: 44, note: '储油罐与管道，掩体密集。' },
      { id: 'wreck_yard', name: '废车场', x: 86, z: 94, tier: 2, kind: 'industrial', r: 40, note: '车壳山与废旧吊机。' },
      { id: 'dune_camp', name: '沙丘营地', x: -86, z: -92, tier: 1, kind: 'wild', r: 38, note: '帐篷与篝火，物资稀少视野好。' },
      { id: 'tunnel_post', name: '隧道哨卡', x: 6, z: -132, tier: 2, kind: 'checkpoint', r: 34, note: '山体隧道口，卡住南北通道。' },
      { id: 'oasis', name: '绿洲村', x: 122, z: 8, tier: 2, kind: 'village', r: 36, note: '几口水井与泥土房。' },
      { id: 'rail_station', name: '货运车站', x: -128, z: -48, tier: 3, kind: 'port', r: 40, note: '铁轨、站台与车厢。' },
    ],
    landmarks: [
      { kind: 'mine_head', name: '主矿塔', x: -14, z: -24, r: 10 },
      { kind: 'radio_tower', name: '中继塔', x: 52, z: 30, r: 8 },
      { kind: 'crane', name: '巨型吊机', x: 96, z: -40, r: 9 },
    ],
    roads: [
      { kind: 'highway', x: 0, z: 0, w: 10, d: 300, rot: 0.35 },
      { kind: 'dirt', x: 30, z: -40, w: 7, d: 120, rot: 1.1 },
      { kind: 'dirt', x: -60, z: 60, w: 6, d: 110, rot: 0.4 },
      { kind: 'rail', x: -110, z: -40, w: 4, d: 160, rot: 0.2 },
    ],
    description: '开阔、掩体集中在工业区，远程武器与载具价值极高；沙暴会压缩视野。',
  },

  baiye: {
    id: 'baiye',
    name: '白夜港',
    en: 'WHITE NIGHT HARBOR',
    subtitle: '长夜不落，冰面上的灯光像一串诱饵。',
    seed: 53021,
    radius: 176,
    water: 'ice',
    timeOfDay: 'night',
    weather: 'snow',
    difficulty: 3,
    tier: 3,
    minPlayers: 24,
    duration: 440,
    theme: {
      sky: 0x1b2b3a,
      fog: 0x35505f,
      water: 0x35505f,
      sand: 0xcdd8d5,
      grass: 0x9fb0ad,
      grassAlt: 0xb0c0bd,
      dirt: 0x8e9c99,
      rock: 0x6d7c80,
      road: 0x59686d,
      roof: [0x4c6c7e, 0x6a5d74, 0x3f5a63, 0x77808f],
      wall: [0xd2dcd8, 0xb6c4c2, 0xc7cfcb, 0x9fadb0],
      tree: [0x3c5a54, 0x4b6b62, 0x2f4a47],
      accent: 0x8fd6e8,
    },
    regions: [
      { id: 'harbor', name: '深水港', x: 96, z: -96, tier: 3, kind: 'port', r: 52, note: '集装箱、龙门吊与货轮。' },
      { id: 'warehouse_row', name: '仓库区', x: 20, z: -40, tier: 3, kind: 'industrial', r: 46, note: '连排冷库，物资最好也最危险。' },
      { id: 'lighthouse_point', name: '灯塔岬', x: 132, z: 44, tier: 2, kind: 'wild', r: 30, note: '灯塔与礁石，适合狙击。' },
      { id: 'shanty', name: '棚户区', x: -58, z: 92, tier: 2, kind: 'village', r: 40, note: '拥挤的临时住房与小巷。' },
      { id: 'frozen_lake', name: '冰湖', x: 48, z: 118, tier: 1, kind: 'wild', r: 38, note: '开阔冰面，滑行快但没有掩体。' },
      { id: 'shipyard', name: '造船厂', x: -112, z: -20, tier: 3, kind: 'industrial', r: 44, note: '船坞、钢架与焊接平台。' },
      { id: 'plaza', name: '白夜广场', x: 0, z: 0, tier: 3, kind: 'town', r: 42, note: '中央广场与商厦。' },
      { id: 'power_post', name: '变电站', x: -108, z: -124, tier: 2, kind: 'checkpoint', r: 36, note: '高压塔与变压器阵列。' },
      { id: 'old_church', name: '旧教堂', x: 120, z: -18, tier: 2, kind: 'town', r: 28, note: '钟楼制高点，视野极佳。' },
    ],
    landmarks: [
      { kind: 'lighthouse', name: '白夜灯塔', x: 148, z: 44, r: 10 },
      { kind: 'crane', name: '龙门吊', x: 84, z: -108, r: 10 },
      { kind: 'wreck', name: '冻住的货轮', x: 118, z: -124, r: 12 },
    ],
    roads: [
      { kind: 'highway', x: 0, z: 0, w: 9, d: 300, rot: 0.15 },
      { kind: 'highway', x: 0, z: 0, w: 8, d: 280, rot: Math.PI / 2 + 0.15 },
      { kind: 'dirt', x: 60, z: -70, w: 6, d: 100, rot: 0.7 },
      { kind: 'dirt', x: -70, z: 40, w: 6, d: 100, rot: 1.9 },
    ],
    description: '夜色与落雪中近距离信息战；仓库群富得流油，冰湖是高风险转移路线。',
  },
};

export const MAP_ORDER = ['qinglan', 'chisha', 'baiye'];

export function getMapDef(mapId) {
  return MAPS[mapId] || MAPS.qinglan;
}

export function mapRotation(seed = 1) {
  const list = [...MAP_ORDER];
  let state = seed >>> 0;
  for (let i = list.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
