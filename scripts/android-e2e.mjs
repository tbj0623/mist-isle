// 安卓模拟器端到端验证：**只在我们的 Activity 确实在前台时**才截图。
//
// 教训：这台模拟器被多个项目共用，别的 App 会不断抢前台。之前无条件 screencap
// 拿到的可能是别人的画面（实测被 com.dilao.abysssquad 污染过一次，看到的
// "对战画面"其实是另一个游戏）。所以每次截图前必须校验 topResumedActivity。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const ADB = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const DEVICE = process.argv[2] || 'emulator-5554';
const PKG = 'com.mistisle.game';
const OUT = 'artifacts/android';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, binary = false) => execFileSync(ADB, ['-s', DEVICE, ...args], {
  encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const sh = (cmd) => run(['shell', cmd]);
const top = () => {
  const out = sh('dumpsys activity activities');
  const m = out.match(/topResumedActivity=ActivityRecord\{\S+ \S+ ([\w.]+)\//);
  return m ? m[1] : null;
};

mkdirSync(OUT, { recursive: true });
const steps = [];
function rec(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

/** 把我们的 App 拉到前台，最多重试 n 次（别的项目会抢）。 */
async function grabForeground(n = 6) {
  for (let i = 0; i < n; i++) {
    sh(`pm unsuspend ${PKG}`);
    sh(`am force-stop ${PKG}`);
    sh(`am start -n ${PKG}/.MainActivity`);
    await sleep(2500);
    if (top() === PKG) return true;
    await sleep(1000);
  }
  return false;
}

/** 校验前台是我们的包后再截图，否则抛错（绝不产出污染截图）。 */
async function shot(name) {
  const t = top();
  if (t !== PKG) throw new Error(`拒绝截图：前台是 ${t}，不是 ${PKG}`);
  const buf = run(['exec-out', 'screencap', '-p'], true);
  const path = `${OUT}/${name}`;
  writeFileSync(path, buf);
  rec(`截图 ${name}`, true, `${(buf.length / 1024).toFixed(0)}KB`);
  return path;
}

console.log(`device: ${DEVICE}`);
const fg = await grabForeground();
rec('App 前台', fg, `top=${top()}`);
if (!fg) { console.error('无法独占前台，中止（不产出可疑截图）'); process.exit(3); }

await sleep(6000);
await shot('01-home.png');

// 出击 → 训练场 → 开始
sh('input tap 175 228'); await sleep(2200);
await shot('02-play.png');
sh('input tap 945 300'); await sleep(700);   // 训练场
sh('input tap 325 660'); await sleep(11000); // 开始
await shot('03-battle.png');

// 摇杆推动 + 开火，验证真实触控链路
sh('input swipe 75 580 75 470 900'); await sleep(1200);
await shot('04-battle-moved.png');
sh('input swipe 90 580 160 540 700'); await sleep(500);
sh('input tap 1232 535'); await sleep(1200);
await shot('05-battle-fire.png');

writeFileSync(`${OUT}/e2e-summary.json`, JSON.stringify({
  device: DEVICE, testedAt: new Date().toISOString(), steps,
  note: '每张截图都在校验 topResumedActivity === com.mistisle.game 之后才拍摄',
}, null, 2));
console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} 步通过`);
