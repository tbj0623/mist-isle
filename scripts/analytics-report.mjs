// 雾岛突围 / MIST ISLE 1.1 — 内部分析报告（命令行）
// 读 data/telemetry/*.jsonl（流式逐行扫描）+ data/matches.jsonl，彩色表格输出到终端
// 并写 artifacts/analytics-YYYY-MM-DD.md。用法：
//   node scripts/analytics-report.mjs [--funnel] [--weapons] [--days 7]
// 纯 Node 实现；ANSI 颜色在非 TTY / NO_COLOR 下自动关闭。
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { analyzeMatches, FUNNEL_STEPS, percentile } from '../shared/telemetry.mjs';
import { timeToKill, WEAPONS } from '../shared/data/weapons.mjs';

const ROOT = new URL('../', import.meta.url);
const DATA_DIR = new URL('data/telemetry/', ROOT);
const MATCH_LOG = new URL('data/matches.jsonl', ROOT);
const ARTIFACTS = new URL('artifacts/', ROOT);
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const intArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const DAYS = Math.max(0, Math.min(365, intArg('days', 0)));
const ONLY_FUNNEL = has('funnel');
const ONLY_WEAPONS = has('weapons');
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const bold = paint('1'), dim = paint('2'), cyan = paint('36'), green = paint('32');
const yellow = paint('33'), red = paint('31'), grey = paint('90');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtPct = (r) => `${(r * 100).toFixed(1)}%`;
const perGame = (total, n) => (total / Math.max(1, n)).toFixed(2);

async function pickFiles() {
  let names = [];
  try { names = await readdir(DATA_DIR); } catch { return []; }
  const days = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort();
  if (!DAYS) return days;
  const cutoff = new Date(Date.now() - (DAYS - 1) * 86400000).toISOString().slice(0, 10);
  return days.filter((d) => d >= cutoff);
}

async function scanTelemetry() {
  const files = await pickFiles();
  const b = {
    sessions: new Set(), funnel: new Map(FUNNEL_STEPS.map((s) => [s, { count: 0, ok: 0, sessions: new Set() }])),
    screens: new Map(), weapons: new Map(), deaths: new Map(),
    matches: 0, wins: 0, ends: 0, sessionMs: 0, kills: 0, damage: 0,
  };
  let events = 0, seedLines = 0, badLines = 0;
  const at = (map, key, make) => { if (!map.has(key)) map.set(key, make()); return map.get(key); };
  for (const day of files) {
    const input = createReadStream(new URL(`${day}.jsonl`, DATA_DIR), { encoding: 'utf8', highWaterMark: 65536 });
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { badLines++; continue; }
        if (!ev || typeof ev.name !== 'string') { badLines++; continue; }
        events++;
        if (ev.seed) seedLines++;
        if (ev.sid) b.sessions.add(String(ev.sid));
        const p = ev.props || {};
        if (ev.name === 'funnel') {
          const row = b.funnel.get(p.step);
          if (row) { row.count++; if (p.ok === true) row.ok++; if (ev.sid) row.sessions.add(String(ev.sid)); }
        } else if (ev.name === 'screen_open' || ev.name === 'screen_leave') {
          const row = at(b.screens, String(p.screen || 'unknown'), () => ({ opens: 0, ms: 0, durations: [] }));
          if (ev.name === 'screen_open') row.opens++;
          else { const ms = Math.max(0, num(p.durationMs)); if (ms > 0) { row.ms += ms; row.durations.push(ms); } }
        } else if (ev.name === 'match_start') b.matches++;
        else if (ev.name === 'match_end') {
          if (p.won === true) b.wins++;
          b.kills += num(p.kills);
          b.damage += num(p.damage);
        } else if (ev.name === 'weapon_fire' || ev.name === 'weapon_kill') {
          const w = at(b.weapons, String(p.weaponId || 'unknown'), () => ({ fires: 0, kills: 0, dist: 0, n: 0 }));
          if (ev.name === 'weapon_fire') w.fires++; else w.kills++;
          const d = num(p.distance);
          if (d > 0) { w.dist += d; w.n++; }
        } else if (ev.name === 'death') at(b.deaths, String(p.killerWeapon || 'unknown'), () => ({ count: 0 })).count++;
        else if (ev.name === 'session_end') { b.ends++; b.sessionMs += Math.max(0, num(p.durationMs)); }
      }
    } finally { rl.close(); input.destroy(); }
  }
  return { files, events, seedLines, badLines, b };
}

async function readMatches() {
  const rows = [];
  let input;
  try { input = createReadStream(MATCH_LOG, { encoding: 'utf8' }); } catch { return rows; }
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && typeof m === 'object') rows.push(m); } catch { /* 坏行跳过 */ }
    }
  } finally { rl.close(); input.destroy(); }
  return rows;
}

const strw = (s) => [...String(s)].reduce((a, ch) => a + (/[\u1100-\uffff]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - strw(s)))}`;
const bars = (ratio, width = 22) => {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};
function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(strw(h), ...rows.map((r) => strw(r[i] ?? ''))));
  const out = [bold(headers.map((c, i) => pad(c, widths[i])).join('  ')),
    grey(widths.map((w) => '─'.repeat(w)).join('  '))];
  for (const r of rows) out.push(r.map((c, i) => pad(c ?? '', widths[i])).join('  '));
  return out.join('\n');
}
function funnelRows(b) {
  const base = b.funnel.get(FUNNEL_STEPS[0]);
  const baseCount = base.sessions.size || base.count || 1;
  let prev = baseCount;
  return FUNNEL_STEPS.map((step) => {
    const row = b.funnel.get(step);
    const count = row.sessions.size || row.count;
    const rate = count / baseCount;
    const tone = rate >= 0.7 ? green : rate >= 0.4 ? yellow : red;
    const out = [step, String(count), fmtPct(rate), fmtPct(prev ? count / prev : 0), tone(bars(rate))];
    if (count) prev = count;
    return out;
  });
}

function derive(scan) {
  const { b } = scan;
  const fires = [...b.weapons.values()].reduce((a, w) => a + w.fires, 0);
  const kills = [...b.weapons.values()].reduce((a, w) => a + w.kills, 0);
  const ttkTheory = percentile(Object.keys(WEAPONS).map((id) => timeToKill(WEAPONS[id])).filter((t) => t > 0), 50);
  return {
    sessions: b.sessions.size,
    matches: b.matches,
    winRate: b.matches ? b.wins / b.matches : 0,
    avgSessionMin: b.ends ? b.sessionMs / 1000 / 60 / b.ends : 0,
    screens: [...b.screens.entries()].map(([screen, s]) => ({
      screen, opens: s.opens, avg: s.durations.length ? Math.round(s.ms / s.durations.length) : 0, total: s.ms,
    })).sort((x, y) => y.total - x.total),
    weapons: [...b.weapons.entries()].map(([id, w]) => ({
      id, fires: w.fires, kills: w.kills, share: fires ? w.fires / fires : 0,
      killShare: kills ? w.kills / kills : 0, kpm: w.fires ? w.kills / w.fires : 0,
      dist: w.n ? Math.round(w.dist / w.n) : 0,
    })).sort((x, y) => y.fires - x.fires),
    deaths: [...b.deaths.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 5),
    ttkTheory,
  };
}

async function main() {
  const ran = Date.now();
  const scan = await scanTelemetry();
  const { files, events, seedLines, badLines, b } = scan;
  const d = derive(scan);
  const matchAnalysis = analyzeMatches(await readMatches());
  const ttk = matchAnalysis.ttkP50 > 0 ? matchAnalysis.ttkP50 : d.ttkTheory;
  const ttkNote = matchAnalysis.ttkP50 > 0 ? '对局粗估' : '武器表理论值';

  const say = (s = '') => console.log(s);
  const title = ONLY_FUNNEL ? '漏斗分析' : ONLY_WEAPONS ? '武器平衡' : '玩家行为与平衡总报告';
  say('');
  say(bold(cyan(`  MIST ISLE · ${title}`)));
  say(grey(`  窗口 ${DAYS ? `最近 ${DAYS} 天` : '全部'} · ${files.length} 个文件 · ${events.toLocaleString()} 条事件 · ${d.sessions.toLocaleString()} 会话`));
  if (seedLines) say(yellow(`  ⚠ 其中 ${seedLines.toLocaleString()} 条为 seed 假数据（node scripts/analytics-seed.mjs --clean 清理）`));
  if (badLines) say(grey(`  跳过 ${badLines} 行无法解析的数据`));

  if (!ONLY_WEAPONS) {
    say('');
    say(bold('  一、新手漏斗（按独立会话去重）'));
    say(table(['步骤', '会话数', '总转化', '环比', '留存'], funnelRows(b)));
  }

  if (!ONLY_FUNNEL && !ONLY_WEAPONS) {
    say('');
    say(bold('  二、界面停留（谁最耗玩家时间）'));
    say(table(['界面', '打开次数', '平均停留', '累计时长'],
      d.screens.slice(0, 8).map((s) => [s.screen, String(s.opens), fmtMs(s.avg), fmtMs(s.total)])));
    say('');
    say(bold('  三、会话与对局概览'));
    say(dim(`  会话 ${d.sessions}  ·  对局 ${d.matches}  ·  胜率 ${fmtPct(d.winRate)}  ·  平均会话 ${d.avgSessionMin.toFixed(1)} 分钟`));
    say(dim(`  场均击杀 ${perGame(b.kills, d.matches)}  ·  场均伤害 ${Math.round(b.damage / Math.max(1, d.matches))}`));
    if (matchAnalysis.matches) {
      say('');
      say(bold('  四、服务端对局落盘（data/matches.jsonl）'));
      say(table(['指标', '数值'], [
        ['对局数', String(matchAnalysis.matches)], ['真人玩家', String(matchAnalysis.players)],
        ['平均排名', matchAnalysis.avgPlacement.toFixed(2)], ['平均时长', `${matchAnalysis.avgDurationSec}s`],
        ['场均击杀', matchAnalysis.avgKills.toFixed(2)], [`TTK P50（${ttkNote}）`, `${ttk.toFixed(2)}s`],
      ]));
    }
  }

  if (!ONLY_FUNNEL) {
    say('');
    say(bold(`${ONLY_WEAPONS ? '一' : '五'}、武器平衡（使用率 / 击杀贡献 / 交战距离）`));
    say(table(['武器', '开火数', '使用率', '击杀', '击杀占比', '每百发击杀', '平均距离'],
      d.weapons.slice(0, 12).map((w) => [w.id, String(w.fires), fmtPct(w.share), String(w.kills),
        fmtPct(w.killShare), (w.kpm * 100).toFixed(1), `${w.dist}m`])));
    const over = d.weapons.filter((w) => w.share > 0.35);
    const under = d.weapons.filter((w) => w.share < 0.02);
    say('');
    say(`  ${bold('结论')}  ${over.length ? red(`过度集中：${over.map((w) => w.id).join(', ')}`) : green('使用率分布健康')}`);
    if (under.length) say(`         ${yellow(`冷门武器：${under.map((w) => w.id).join(', ')}`)}（<2% 开火占比，考虑增强或调整投放）`);
    if (d.deaths.length) say(`         ${dim(`最致命武器：${d.deaths.map(([id, v]) => `${id}(${v.count})`).join('  ')}`)}`);
    say(`         ${dim(`TTK P50（${ttkNote}）${ttk.toFixed(2)}s  ·  武器表理论 TTK 中位数 ${d.ttkTheory.toFixed(2)}s`)}`);
  }

  // Markdown 产出
  const day = new Date().toISOString().slice(0, 10);
  const md = [`# MIST ISLE 分析报告 — ${day}`, '', `- 窗口：${DAYS ? `最近 ${DAYS} 天` : '全部'}`,
    `- 数据：${files.length} 个文件 / ${events.toLocaleString()} 条事件 / ${d.sessions.toLocaleString()} 会话`];
  if (seedLines) md.push(`- ⚠️ 含 ${seedLines.toLocaleString()} 条 seed 假数据（\`node scripts/analytics-seed.mjs --clean\` 清理）`);
  md.push('', '## 漏斗', '', '| 步骤 | 会话数 | 总转化 | 环比 |', '| --- | ---: | ---: | ---: |');
  const baseCount = b.funnel.get(FUNNEL_STEPS[0]).sessions.size || b.funnel.get(FUNNEL_STEPS[0]).count || 1;
  let prev = baseCount;
  for (const step of FUNNEL_STEPS) {
    const row = b.funnel.get(step);
    const count = row.sessions.size || row.count;
    md.push(`| ${step} | ${count} | ${fmtPct(count / baseCount)} | ${fmtPct(prev ? count / prev : 0)} |`);
    if (count) prev = count;
  }
  md.push('', '## 界面停留', '', '| 界面 | 打开次数 | 平均停留 | 累计 |', '| --- | ---: | ---: | ---: |');
  for (const s of d.screens.slice(0, 10)) md.push(`| ${s.screen} | ${s.opens} | ${fmtMs(s.avg)} | ${fmtMs(s.total)} |`);
  md.push('', '## 武器平衡', '', '| 武器 | 开火 | 使用率 | 击杀 | 击杀占比 | 每百发击杀 | 平均距离 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const w of d.weapons.slice(0, 12)) {
    md.push(`| ${w.id} | ${w.fires} | ${fmtPct(w.share)} | ${w.kills} | ${fmtPct(w.killShare)} | ${(w.kpm * 100).toFixed(1)} | ${w.dist}m |`);
  }
  md.push('', '## 概览', '',
    `- 对局 ${d.matches}，胜率 ${fmtPct(d.winRate)}，平均会话 ${d.avgSessionMin.toFixed(1)} 分钟`,
    `- 场均击杀 ${perGame(b.kills, d.matches)}，场均伤害 ${Math.round(b.damage / Math.max(1, d.matches))}`,
    `- 服务端 matches.jsonl：${matchAnalysis.matches} 场，平均排名 ${matchAnalysis.avgPlacement.toFixed(2)}，TTK P50 ${ttk.toFixed(2)}s（${ttkNote}）`,
    `- 注：胜率以客户端 match_end 口径为准；matches.jsonl 混有历史测试对局，排名/时长仅供结构参考。`,
    '', `> 生成耗时 ${Date.now() - ran}ms · \`node scripts/analytics-report.mjs ${args.join(' ')}\``.trim(), '');

  await mkdir(ARTIFACTS, { recursive: true });
  const outFile = `analytics-${day}.md`;
  await writeFile(new URL(outFile, ARTIFACTS), md.join('\n'), 'utf8');
  say('');
  say(grey(`  报告已写入 artifacts/${outFile}`));
}

main().catch((err) => { console.error('report 失败：', err); process.exit(1); });
