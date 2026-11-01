// 训练场局内教学的纯逻辑：不依赖 DOM，可由 Node 与浏览器共同测试。
export const COMBAT_TASKS = Object.freeze([
  { id: 'move', title: '移动 5 米', desktop: '按 WASD 移动，Shift 可冲刺', touch: '推动左侧摇杆移动' },
  { id: 'fire', title: '开火一次', desktop: '鼠标瞄准，按住左键射击', touch: '用右侧摇杆瞄准并开火' },
  { id: 'hit', title: '击中一名敌人', desktop: '跟随准星，寻找 AI 目标', touch: '调整右摇杆方向，确认命中反馈' },
  { id: 'reload', title: '完成一次换弹', desktop: '射击后按 R 换弹', touch: '射击后点击换弹按钮' },
  { id: 'pickup', title: '拾取一件物资', desktop: '靠近物资，按 E 交互', touch: '靠近物资，点击交互按钮' },
]);

export function createCombatGuide() {
  return { completed: new Set(), distance: 0, lastPosition: null };
}

export function observeCombatMovement(guide, player) {
  if (!guide || player?.alive === false) return false;
  const x = Number(player?.x), z = Number(player?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const prev = guide.lastPosition;
  guide.lastPosition = { x, z };
  if (!prev || guide.completed.has('move')) return false;
  const step = Math.hypot(x - prev.x, z - prev.z);
  // 跨帧传送/重连快照不算作玩家步行。
  if (step > 4) return false;
  guide.distance += step;
  if (guide.distance < 5) return false;
  guide.completed.add('move');
  return true;
}

export function observeCombatEvent(guide, event, selfId) {
  if (!guide || !event || !selfId) return false;
  const owner = event.player === selfId || event.attacker === selfId;
  if (!owner) return false;
  const before = guide.completed.size;
  switch (event.type) {
    case 'shot':
      guide.completed.add('fire');
      if (event.hit === true || typeof event.hit === 'string' || Number(event.hits) > 0) guide.completed.add('hit');
      break;
    case 'hit':
      guide.completed.add('hit');
      break;
    case 'reloaded':
      // reload 是按键开始，reloaded 才表示弹匣装填完成。
      guide.completed.add('reload');
      break;
    case 'pickup':
      guide.completed.add('pickup');
      break;
    default:
      break;
  }
  return guide.completed.size !== before;
}

export function combatGuideStatus(guide) {
  const completed = guide?.completed || new Set();
  return {
    count: COMBAT_TASKS.filter((task) => completed.has(task.id)).length,
    total: COMBAT_TASKS.length,
    next: COMBAT_TASKS.find((task) => !completed.has(task.id)) || null,
  };
}
