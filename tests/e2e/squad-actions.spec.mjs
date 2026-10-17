import {test,expect} from '@playwright/test';
import {WebSocket} from 'ws';
import {createGameServer} from '../../server/index.mjs';
import {PROTOCOL_VERSION} from '../../shared/rules.mjs';

test('mobile long-press rescues a teammate and passenger shoots from a shared car',async({browser})=>{
  test.setTimeout(90000);
  const server=createGameServer({port:0,host:'127.0.0.1'}),address=await server.listen();
  const context=await browser.newContext({viewport:{width:844,height:390},isMobile:true,hasTouch:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let socket;
  try{
    await page.addInitScript(()=>localStorage.setItem('mist-isle-settings',JSON.stringify({quality:'low',sound:false})));
    await page.goto(`http://127.0.0.1:${address.port}`);await page.waitForFunction(()=>!!window.mistIsle);
    await page.locator('#online-open').tap();await page.locator('#nickname').fill('Medic');await page.locator('#create-room').tap();await page.locator('#room-dialog').waitFor();
    const code=await page.locator('#current-code').textContent();
    socket=new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const joined=await new Promise((resolve,reject)=>{
      socket.once('error',reject);
      socket.on('open',()=>socket.send(JSON.stringify({type:'join',mode:'join',code,team:0,name:'Wingman',protocol:PROTOCOL_VERSION})));
      socket.on('message',data=>{const msg=JSON.parse(data);if(msg.type==='joined')resolve(msg);if(msg.type==='state'&&msg.state.phase==='loading')socket.send(JSON.stringify({type:'ready'}));});
    });
    await page.locator('#start-room').tap();await page.waitForFunction(()=>window.mistIsle.getState()?.phase==='playing');
    const room=server.rooms.get(code),match=room.match;
    const id=await page.evaluate(()=>window.mistIsle.getStatus().selfId),medic=match.players.find(p=>p.id===id),friend=match.players.find(p=>p.id===joined.id),enemy=match.players.find(p=>p.team===1);
    // Deterministic server-only fixture: a wounded friend, one inert opponent, no random combat.
    match.players=[medic,friend,enemy];enemy.bot=false;enemy.x=150;enemy.z=0;
    medic.x=0;medic.z=0;friend.x=1;friend.z=0;match.down(friend,enemy,'shot');
    await expect(page.locator('#interact-label')).toHaveText('救援');
    const box=await page.locator('#interact-action').boundingBox(),cdp=await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,id:7}]});
    await expect.poll(()=>friend.reviveProgress).toBeGreaterThan(1);
    await page.screenshot({path:'artifacts/mobile-revive.png'});
    await expect.poll(()=>friend.downed,{timeout:12000}).toBe(false);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    expect(friend.hp).toBe(38);
    const car=match.cars[0];medic.x=car.x;medic.z=car.z;friend.x=car.x;friend.z=car.z;
    match.vehicle(friend);match.vehicle(medic);expect(car.driver).toBe(friend.id);
    await expect(page.locator('#player-state')).toContainText('可以射击');
    const aim=await page.locator('#aim-stick').boundingBox(),ammo=medic.ammo;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:aim.x+aim.width/2,y:aim.y+aim.height/2,id:8}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:aim.x+aim.width/2,y:aim.y+8,id:8}]});
    await expect.poll(()=>medic.ammo).toBeLessThan(ammo);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.screenshot({path:'artifacts/mobile-passenger.png'});
    await page.locator('#interact-action').tap();await expect.poll(()=>medic.car).toBe(null);
    match.addLoot('sniper',medic.x,medic.z,5);await expect.poll(()=>medic.weapon).toBe('sniper');
    await page.locator('#swap-action').tap();await expect.poll(()=>medic.weapon).toBe('pistol');
    await page.locator('#grenade-action').tap();await expect.poll(()=>medic.grenades).toBe(1);
    await page.locator('#smoke-action').tap();await expect.poll(()=>medic.smokes).toBe(0);
    await page.locator('#ping-action').tap();await expect.poll(()=>match.pings.length).toBe(1);
    await page.locator('#game-menu').tap();match.kill(medic,enemy,'shot');
    await expect(page.locator('#result-dialog')).toBeVisible();await expect(page.locator('#pause-dialog')).not.toBeVisible();
    await page.locator('#return-home').tap();await expect(page.locator('#menu')).toBeVisible();
    expect(errors).toEqual([]);
  }finally{socket?.terminate();await context.close();await server.close();}
});
