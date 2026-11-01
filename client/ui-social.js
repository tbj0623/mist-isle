// 雾岛突围 / MIST ISLE 1.1 — 社交 UI（owner: social · client/ui-social.js）
// 最小版：好友面板（列表 + 邀请 + 删除）与 app.social 接线。样式 .social- 前缀，本文件注入。
const el = (tag, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '' && text != null) n.textContent = String(text);
  return n;
};
const STATUS = { online: '在线', 'in-room': '在房间', offline: '离线' };
const CSS = [
  '.social-fab{position:fixed;left:12px;bottom:12px;z-index:41;min-width:44px;min-height:44px;border-radius:999px;border:1px solid rgba(120,220,220,.35);background:rgba(8,26,30,.82);color:#bfeef0;font:600 13px system-ui;cursor:pointer}#hud:not(.hidden)~.social-fab{display:none}@media (orientation:portrait){.social-fab{display:none}}',
  '.social-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(2,10,12,.6);padding:16px}.social-modal[hidden]{display:none}',
  '.social-card{width:min(420px,94vw);max-height:80vh;overflow:auto;border-radius:16px;padding:14px;border:1px solid rgba(120,220,220,.3);background:#0b1d21;color:#dff6f7;font:13px/1.5 system-ui}',
  '.social-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.social-title{font-weight:700;letter-spacing:.04em}.social-close{background:none;border:0;color:#9fd6d8;font-size:18px;cursor:pointer;min-width:44px;min-height:44px}',
  '.social-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(120,220,220,.12)}.social-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.social-dot{width:8px;height:8px;border-radius:50%;background:#5a6b6e;flex:none}.social-dot.online{background:#5ee6a8}.social-dot.in-room{background:#6cc8ff}',
  '.social-btn{min-height:44px;min-width:44px;padding:0 10px;border-radius:8px;border:1px solid rgba(120,220,220,.35);background:rgba(20,54,60,.9);color:#d8f4f5;font:600 12px system-ui;cursor:pointer}.social-btn.danger{border-color:rgba(255,120,120,.45);color:#ffc9c9}',
  '.social-add{display:flex;gap:6px;margin:8px 0}.social-input{flex:1;min-width:0;min-height:44px;border-radius:8px;padding:0 10px;font:13px system-ui;border:1px solid rgba(120,220,220,.25);background:rgba(4,18,22,.9);color:#e6fbfc}',
  '.social-modal:focus{outline:none}',
  '.social-empty{padding:10px 0;color:#8fb2b4}.social-invite{border:1px dashed rgba(120,220,220,.3);border-radius:10px;padding:8px;margin:6px 0}',
].join('\n');
function injectStyle() {
  if (document.getElementById('social-style')) return;
  const s = el('style');
  s.id = 'social-style';
  s.textContent = CSS;
  document.head.append(s);
}

/** 好友面板：列表 + 邀请 + 删除。refresh() 读 app.social 的本地缓存重绘。 */
export function buildFriendsPanel(app) {
  injectStyle();
  const panel = el('div', 'social-panel');
  const social = () => app?.social || null;
  const notify = (t) => { try { app?.toast?.(t); } catch { /* ignore */ } };
  const head = el('div', 'social-head');
  const title = el('div', 'social-title', '好友');
  title.id = 'social-modal-title';
  const closeBtn = el('button', 'social-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭好友面板');
  // 关闭按钮必须绑定事件。历史上这里只创建了按钮、没绑 click（只有点遮罩才关），
  // 用户点 × 毫无反应，是最容易被当成「面板卡死」的体验缺陷。
  // close() 定义在下方同一作用域内，点击时一定已就绪。
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try { close(); } catch { /* 忽略 */ }
  });
  const addRow = el('div', 'social-add'), input = el('input', 'social-input');
  input.id = 'social-add-input';
  input.placeholder = '玩家 ID 或昵称';
  input.maxLength = 20;
  const addBtn = el('button', 'social-btn', '添加');
  addBtn.type = 'button';
  const invites = el('div', 'social-invites'), list = el('div', 'social-list');
  head.append(title, closeBtn);
  addRow.append(input, addBtn);
  panel.append(head, addRow, invites, list);
  const guard = async (fn, okText) => {
    try { await fn(); if (okText) notify(okText); } catch (err) { notify(err?.message || '操作失败'); }
    panel.refresh();
  };
  addBtn.addEventListener('click', () => {
    const target = input.value.trim();
    if (!target) { notify('请输入玩家 ID 或昵称'); return; }
    guard(async () => { await social()?.addFriend(target); input.value = ''; }, '好友已添加');
  });
  const renderInvites = (rows) => {
    invites.replaceChildren();
    for (const inv of rows) {
      const box = el('div', 'social-invite');
      box.append(el('div', 'social-name', `${inv.fromName || '队友'} 邀请你 · ${inv.roomCode || '组队'}`));
      const row = el('div', 'social-row');
      const take = el('button', 'social-btn', '接受'), drop = el('button', 'social-btn danger', '拒绝');
      take.type = 'button'; drop.type = 'button';
      take.addEventListener('click', () => guard(() => social()?.respond(inv.id, true), '已接受邀请'));
      drop.addEventListener('click', () => guard(() => social()?.respond(inv.id, false)));
      row.append(take, drop);
      box.append(row);
      invites.append(box);
    }
  };
  const renderFriends = (rows) => {
    list.replaceChildren();
    if (!rows.length) { list.append(el('div', 'social-empty', '还没有好友，输入 ID 添加队友。')); return; }
    for (const f of rows) {
      const row = el('div', 'social-row');
      const dot = el('span', `social-dot ${f.status || 'offline'}`);
      dot.title = STATUS[f.status] || '离线';
      const inviteBtn = el('button', 'social-btn', '邀请'), delBtn = el('button', 'social-btn danger', '删除');
      inviteBtn.type = 'button'; delBtn.type = 'button';
      inviteBtn.addEventListener('click', () => guard(async () => {
        await social()?.invite(f.id, app?.socketInfo?.code || '');
      }, `已邀请 ${f.name || f.id}`));
      delBtn.addEventListener('click', () => guard(() => social()?.removeFriend(f.id), '已删除好友'));
      row.append(dot, el('span', 'social-name', `${f.name || f.id} · ${STATUS[f.status] || '离线'}`), inviteBtn, delBtn);
      list.append(row);
    }
  };
  panel.refresh = () => {
    const s = social(), friends = s?.friends || [];
    title.textContent = `好友 ${friends.length}/50`;
    renderInvites(s?.invites || []);
    renderFriends(friends);
  };
  panel.refresh();
  return panel;
}
/** 把 app.social 接到 UI：浮动好友按钮 + 弹窗 + 事件订阅。 */
export function registerSocialHooks(app) {
  if (!app) return null;
  injectStyle();
  const panel = buildFriendsPanel(app);
  const modal = el('div', 'social-modal');
  modal.id = 'social-modal';
  modal.hidden = true;
  // 无障碍语义：历史实现只是一个普通 div，读屏完全不知道它是个对话框，
  // Esc 不关闭，Tab 会跑到背后的主菜单上。
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'social-modal-title');
  const card = el('div', 'social-card');
  card.append(panel);
  modal.append(card);
  const fab = el('button', 'social-fab', '好友');
  fab.type = 'button';
  fab.id = 'social-fab';
  fab.setAttribute('aria-label', '打开好友面板');
  fab.setAttribute('aria-haspopup', 'dialog');
  fab.setAttribute('aria-expanded', 'false');
  let lastFocus = null;
  const open = () => {
    lastFocus = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-expanded', 'true');
    panel.refresh?.();
    // 焦点进弹窗：优先落到添加好友输入框，否则落到关闭按钮
    requestAnimationFrame(() => {
      const target = modal.querySelector('#social-add-input') || modal.querySelector('.social-close');
      try { target?.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    });
  };
  const close = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-expanded', 'false');
    const back = lastFocus && document.contains(lastFocus) ? lastFocus : fab;
    lastFocus = null;
    try { back.focus?.({ preventScroll: true }); } catch { /* 忽略 */ }
  };
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
    + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const trap = (event) => {
    const list = [...modal.querySelectorAll(FOCUSABLE)].filter(node => node.offsetParent !== null || node.getClientRects().length > 0);
    if (!list.length) { event.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!modal.contains(active)) { event.preventDefault(); first.focus(); return; }
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  const onKeyDown = (event) => {
    if (modal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab' || event.code === 'Tab') { trap(event); }
  };
  fab.addEventListener('click', open);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  window.addEventListener('keydown', onKeyDown);
  document.body.append(fab, modal);
  const social = app.social;
  for (const ev of ['friends', 'invites', 'clan']) social?.on?.(ev, () => panel.refresh?.());
  social?.on?.('invite', (inv) => { try { app.toast?.(`${inv?.fromName || '队友'} 邀请你组队`); } catch { /* ignore */ } });
  app.socialUI = { panel, modal, fab, open, close, refresh: () => panel.refresh?.() };
  return app.socialUI;
}
export default { buildFriendsPanel, registerSocialHooks };
