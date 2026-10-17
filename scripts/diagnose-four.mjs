import { chromium } from '@playwright/test';
const browser=await chromium.launch({headless:true,args:process.platform==='win32'&&process.env.WEBGL_SOFTWARE!=='1'?['--use-angle=d3d11']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const contexts=[], pages=[], errors=[];
try {
  for(let i=0;i<4;i++){
    const context=await browser.newContext({viewport:{width:800,height:450}});contexts.push(context);
    const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push({i,error:e.message}));
    await page.addInitScript(()=>{
      localStorage.setItem('mist-isle-settings',JSON.stringify({quality:'low',sound:false}));
      const W=window.WebSocket;window.inputs=[];window.WebSocket=class extends W {send(data){const m=JSON.parse(data);if(m.type==='input'){window.inputs.push(m.input);if(window.inputs.length>50)window.inputs.shift();}super.send(data);}};
    });
    await page.goto('http://127.0.0.1:8787');await page.waitForFunction(()=>!!window.mistIsle);
  }
  const host=pages[0];await host.locator('#online-open').click();await host.locator('#create-room').click();await host.locator('#room-dialog').waitFor();
  const code=await host.locator('#current-code').textContent();
  for(const p of pages.slice(1)){await p.locator('#online-open').click();await p.locator('#room-code').fill(code);await p.locator('#join-room').click();await p.locator('#room-dialog').waitFor();}
  await host.locator('#start-room').click();for(const p of pages)await p.waitForFunction(()=>window.mistIsle.getState()?.phase==='playing');
  const inspect=()=>host.evaluate(()=>({hidden:document.hidden,focus:document.hasFocus(),active:document.activeElement?.tagName,activeId:document.activeElement?.id,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),status:window.mistIsle.getStatus(),self:window.mistIsle.getState().players.find(p=>p.id===window.mistIsle.getStatus().selfId),inputs:window.inputs.slice(-4)}));
  console.log('BEFORE',JSON.stringify(await inspect()));
  await host.keyboard.down('KeyW');await host.waitForTimeout(1000);console.log('BEFORE FOCUS MOVEMENT',JSON.stringify(await inspect()));await host.keyboard.up('KeyW');
  await host.bringToFront();await host.locator('#world').focus();await host.keyboard.down('KeyW');await host.waitForTimeout(1000);console.log('AFTER FOCUS MOVEMENT',JSON.stringify(await inspect()));await host.keyboard.up('KeyW');
  console.log('ERRORS',JSON.stringify(errors));
} finally {await browser.close();}
