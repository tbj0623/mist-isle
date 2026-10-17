export const PROTOCOL_VERSION = 2;
export const MAX_PLAYERS = 64;
export const SQUAD_SIZE = 4;
export const MAX_SQUADS = MAX_PLAYERS / SQUAD_SIZE;
export const MAX_HUMANS_PER_ROOM = MAX_PLAYERS;
export const MAX_LOOT = 512;
export const REVIVE_TIME = 4;
export const BLEEDOUT_TIME = 30;
export const TICK_RATE = 30;
export const WEAPONS = {
  pistol: { name: 'P9 手枪', damage: 23, interval: .34, magazine: 12, range: 29, reload: 1.1, spread: .028 },
  smg: { name: 'V9 冲锋枪', damage: 14, interval: .09, magazine: 35, range: 31, reload: 1.4, spread: .065 },
  rifle: { name: 'AR 突击步枪', damage: 21, interval: .15, magazine: 30, range: 49, reload: 1.6, spread: .037 },
  shotgun: { name: 'S12 霰弹枪', damage: 16, interval: .83, magazine: 6, range: 18, reload: 1.9, spread: .19, pellets: 6 },
  marksman: { name: 'M14 精准步枪', damage: 43, interval: .58, magazine: 12, range: 69, reload: 2, spread: .018 },
  sniper: { name: 'SR 狙击步枪', damage: 85, interval: 1.4, magazine: 5, range: 87, reload: 2.5, spread: .009 },
  lmg: { name: 'M60 轻机枪', damage: 22, interval: .13, magazine: 60, range: 52, reload: 3.3, spread: .062 },
};
