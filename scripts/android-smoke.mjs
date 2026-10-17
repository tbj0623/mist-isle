import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {PROTOCOL_VERSION} from '../shared/rules.mjs';

const serial=process.env.ANDROID_TEST_SERIAL;
if(!serial?.startsWith('emulator-'))throw new Error('Set ANDROID_TEST_SERIAL to the specifically owned emulator. This script never installs on physical phones.');
const adb=resolve(process.env.ANDROID_HOME||`${process.env.LOCALAPPDATA}/Android/Sdk`,'platform-tools/adb.exe');
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:30000}).trim();
function nativeScreenshot(path) {
  const remote='/sdcard/mist-isle-capture.png';
  shell('shell','screencap','-p',remote);shell('pull',remote,resolve(path));
}
const report={scope:'Owned Android emulator and three real WebSocket peers, not four physical phones',serial,version:'0.2.0',checks:{}};
await mkdir('artifacts',{recursive:true});
if(process.env.ANDROID_SKIP_INSTALL!=='1')shell('install','-r',resolve('artifacts/mist-isle-0.2.0-debug.apk'));
shell('shell','wm','size','720x1280');shell('shell','wm','density','240');
shell('shell','am','start','-n','com.mistisle.game/.MainActivity');
let pid;
for(let tries=0;tries<50;tries++){try{pid=shell('shell','pidof','com.mistisle.game');}catch{pid='';}if(pid)break;await new Promise(r=>setTimeout(r,300));}
assert.ok(pid);shell('forward','tcp:9225',`localabstract:webview_devtools_remote_${pid}`);
let browser;
for(let i=0;i<40;i++){
  try{browser=await chromium.connectOverCDP('http://127.0.0.1:9225',{noDefaults:true,timeout:6000});break;}catch(err){if(i===39)console.error(err.message);await new Promise(r=>setTimeout(r,400));}
}
assert.ok(browser,'WebView debugging endpoint must exist');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('appassets.androidplatform.net'));
assert.ok(page);page.setDefaultTimeout(45000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const peers=[];
try{
  await page.waitForFunction(()=>!!window.mistIsle,{},{timeout:30000});
  if(await page.locator('#result-dialog').isVisible())await page.locator('#return-home').click();
  else if(await page.locator('#hud').isVisible()){
    if(!await page.locator('#pause-dialog').isVisible())await page.locator('#game-menu').click();
    await page.locator('#result-dialog[open] #return-home, #pause-dialog[open] #exit-match').click();
  }
  report.android=shell('shell','getprop','ro.build.version.release');
  report.webview=await page.evaluate(()=>navigator.userAgent);
  await page.locator('#settings-open').click();await page.locator('#quality').selectOption('balanced');await page.locator('#settings-dialog [data-close]').click();
  nativeScreenshot('artifacts/android-lobby-0.2.0.png');
  await page.locator('#train').click();await page.waitForFunction(()=>window.mistIsle.getState()?.phase==='playing');
  report.checks.offline=await page.evaluate(()=>window.mistIsle.getStatus().offline&&window.mistIsle.getState().totalPlayers===64);
  const cdp=await page.context().newCDPSession(page),stick=await page.locator('#move-stick').boundingBox();
  const before=await page.evaluate(()=>{let s=window.mistIsle.getState(),id=window.mistIsle.getStatus().selfId;return s.players.find(p=>p.id===id).z;});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:stick.x+stick.width/2,y:stick.y+stick.height/2,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:stick.x+stick.width/2,y:stick.y+8,id:1}]});
  await page.waitForFunction(before=>{const s=window.mistIsle.getState();return s.players.find(p=>p.id===window.mistIsle.getStatus().selfId).z<before-1;},before);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});report.checks.touchMovement=true;
  nativeScreenshot('artifacts/android-battle-0.2.0.png');
  shell('shell','input','keyevent','KEYCODE_BACK');await page.locator('#pause-dialog').waitFor();report.checks.nativeBack=true;
  const time=await page.evaluate(()=>window.mistIsle.getState().time);await new Promise(r=>setTimeout(r,300));assert.equal(await page.evaluate(()=>window.mistIsle.getState().time),time);report.checks.offlinePause=true;
  await page.locator('#exit-match').click();
  await page.locator('#online-open').click();await page.locator('#server-address').fill('ws://10.0.2.2:8787');await page.locator('#nickname').fill('Android');await page.locator('#create-room').click();await page.locator('#room-dialog').waitFor();
  const code=await page.locator('#current-code').textContent();
  for(let i=0;i<3;i++){
    const ws=new WebSocket('ws://127.0.0.1:8787/ws');peers.push(ws);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Peer joining timed out')),6000);
      ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({type:'join',mode:'join',code,team:0,name:`Peer-${i}`,protocol:PROTOCOL_VERSION})));
      ws.on('message',data=>{const m=JSON.parse(data);if(m.type==='joined'){clearTimeout(timer);resolve();}if(m.type==='state'&&m.state.phase==='loading')ws.send(JSON.stringify({type:'ready'}));});
    });
  }
  await page.waitForFunction(()=>document.querySelectorAll('#room-players .room-player').length===4);
  nativeScreenshot('artifacts/android-four-player-room.png');
  await page.locator('#start-room').click();await page.waitForFunction(()=>window.mistIsle.getState()?.phase==='playing');
  report.checks.androidPlusThreeNetworkPeers=await page.evaluate(()=>window.mistIsle.getState().players.filter(p=>!p.bot&&p.team===0).length===4);
  report.status=await page.evaluate(()=>window.mistIsle.getStatus());
  nativeScreenshot('artifacts/android-network-battle.png');
  report.checks.noJavaScriptErrors=errors.length===0;report.errors=errors;
  if(!await page.locator('#result-dialog').isVisible())await page.locator('#game-menu').click();
  await page.locator('#result-dialog[open] #return-home, #pause-dialog[open] #exit-match').click();
  await page.locator('#menu').waitFor();report.checks.returnToLobby=true;
  assert.ok(Object.values(report.checks).every(Boolean));report.passed=true;
}catch(error){
  report.passed=false;report.failure=error.message;throw error;
}finally{
  peers.forEach(p=>p.terminate());report.testedAt=new Date().toISOString();await writeFile('artifacts/android-verification.json',JSON.stringify(report,null,2));
  await browser.close();shell('forward','--remove','tcp:9225');
}
console.log(JSON.stringify(report,null,2));
