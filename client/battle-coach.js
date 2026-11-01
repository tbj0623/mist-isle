// 战术教练：纯函数，战场坐标以 +X=东、-Z=北；不依赖 DOM 或联网服务。
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v) => Math.max(0, Math.ceil(v));

export function compassDirection(dx, dz) {
  if (!finite(dx) || !finite(dz) || Math.hypot(dx, dz) < 0.1) return '当前位置';
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const sector = ((Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) % 8) + 8) % 8;
  return names[sector];
}

// 返回进入安全圈内的最近安全落点（预留 4 米，避免刚好踩在边缘）。
function safeEntry(circle, player, margin = 4) {
  if (!circle || !finite(circle.x) || !finite(circle.z) || !finite(circle.r) || circle.r <= 0
    || !player || !finite(player.x) || !finite(player.z)) return null;
  const dx = player.x - circle.x, dz = player.z - circle.z;
  const radial = Math.hypot(dx, dz);
  const inner = Math.max(0, circle.r - Math.min(margin, circle.r * 0.25));
  if (radial <= inner) return null;
  const k = radial > 0 ? inner / radial : 0;
  const goal = { x: circle.x + dx * k, z: circle.z + dz * k };
  return { goal, meters: round(radial - inner), direction: compassDirection(goal.x - player.x, goal.z - player.z) };
}

export function zoneGuidance(zone, player, phase = 'live', mode = '') {
  if (!zone || !player || player.alive === false || phase === 'deploying' || phase === 'ended'
    || mode === 'training' || mode === 'horde') return null;
  // 边界余量只用于选择目标点，不等于「已经在圈外」；避免靠圈边却误报扣血。
  const outside = finite(zone.x) && finite(zone.z) && finite(zone.r)
    && Math.hypot(player.x - zone.x, player.z - zone.z) > zone.r;
  const current = outside ? safeEntry(zone, player) : null;
  if (current) {
    const dps = finite(zone.damage) ? Math.max(0, Math.round(zone.damage)) : 0;
    return {
      kind: 'danger', ...current,
      text: `圈外！向${current.direction}移动 ${current.meters} 米${dps ? ` · -${dps}血/秒` : ''}`,
    };
  }
  if (zone.closing && zone.target) {
    const next = safeEntry(zone.target, player);
    if (next) return { kind: 'warn', ...next, text: `正在缩圈 · 向${next.direction}转移 ${next.meters} 米` };
  }
  return null;
}

export function nearestLootHint(loot, player, maxMeters = 90) {
  if (!Array.isArray(loot) || !player || !finite(player.x) || !finite(player.z)) return null;
  let best = null;
  for (const item of loot) {
    if (!item || item.taken || !finite(item.x) || !finite(item.z)) continue;
    const meters = Math.hypot(item.x - player.x, item.z - player.z);
    if (meters > maxMeters || (best && meters >= best.meters)) continue;
    best = { x: item.x, z: item.z, meters };
  }
  if (!best) return null;
  return {
    ...best, meters: round(best.meters),
    direction: compassDirection(best.x - player.x, best.z - player.z),
    text: best.meters <= 2 ? '物资就在脚边 · 按交互键拾取' : `附近物资 · 向${compassDirection(best.x - player.x, best.z - player.z)} ${round(best.meters)} 米`,
  };
}

// 击杀事件本身是服务端权威来源；不能从最后几帧的血量猜测死亡原因。
export function captureDeath(event, selfId, players = []) {
  if (!event || event.type !== 'kill' || !selfId || event.player !== selfId) return null;
  const killer = Array.isArray(players) ? players.find((p) => p?.id === event.by) : null;
  return {
    reason: String(event.reason || 'unknown').slice(0, 32),
    attackerName: event.attackerName || killer?.name || '',
    weapon: typeof event.weapon === 'string' ? event.weapon.slice(0, 40) : '',
    by: event.by || null,
  };
}

export function buildMatchDebrief(summary = {}, death = null) {
  const fired = Math.max(0, Number(summary.shotsFired) || 0);
  const hit = Math.max(0, Number(summary.shotsHit) || 0);
  const accuracy = fired ? Math.round(Math.min(100, hit / fired * 100)) : null;
  if (summary.won) {
    return {
      kind: 'win', title: '胜利复盘',
      cause: '你和队伍成功存活到最后。',
      tip: accuracy != null && accuracy < 20 && fired >= 10
        ? '胜利值得庆祝！下局尝试减少远距离无把握的开火，提高有效命中。'
        : '继续保持移动、掩体利用与安全区位置优势。',
    };
  }
  const reason = death?.reason;
  let cause = '暂未收到完整淘汰事件';
  let tip = '下一局先观察安全区与掩体位置，交战后及时补充护盾和弹药。';
  if (reason === 'zone') {
    cause = '安全区外持续失血';
    tip = '尽早查看右上方缩圈倒计时，沿小地图路线提前进圈；圈伤不会被护甲或护盾抵消。';
  } else if (reason === 'bleed' || reason === 'bleedout') {
    cause = '倒地后失血淘汰';
    tip = '组队时靠近队友、避免单独推进；倒地后优先寻找掩体等待救援。';
  } else if (reason === 'fire') {
    cause = '燃烧区域持续伤害';
    tip = '遇到燃烧区域立即侧移撤出，避免停留在火焰中强行对枪。';
  } else if (reason === 'grenade' || reason === 'explosion') {
    cause = '爆炸伤害';
    tip = '听到投掷声或爆炸预警时立即离开狭小掩体，拉开与爆点的距离。';
  } else if (reason === 'vehicle') {
    cause = '载具撞击';
    tip = '听到引擎声时远离开阔道路，使用树木与墙体切断撞击路线。';
  } else if (reason === 'shot') {
    const attacker = death.attackerName ? `「${String(death.attackerName).slice(0, 30)}」` : '敌方玩家';
    const weapon = death.weapon ? `使用 ${death.weapon} ` : '';
    cause = `被${attacker}${weapon}淘汰`;
    tip = fired >= 10 && accuracy !== null && accuracy < 18
      ? `本局命中率 ${accuracy}%。试着用短点射控制后坐力，优先从掩体后瞄准再开火。`
      : '不要在无遮蔽地形持续对枪；受到攻击时先横向移动到掩体，再选择反击或撤离。';
  } else if (summary.aliveAtEnd) {
    cause = '对局已结束，你仍然存活';
    tip = '复盘队伍最终站位与支援距离，下局可更早汇合并协同进圈。';
  }
  return { kind: 'loss', title: '战术复盘 · 下局更强', cause, tip };
}
