import {openWorkspace} from './ui-navigation.mjs';
/** Disposable ST only; real UI, local synthetic data. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const pw=await import(pathToFileURL(path.resolve(process.argv[2])).href),engine=process.argv[3]??'chromium';
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
await fs.mkdir('work/screenshots',{recursive:true});
try {
 const context=await browser.newContext(pw.devices['iPhone 13']),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 if(engine==='webkit')await page.route('**/api/settings/get',async route=>{const response=await route.fetch(),data=await response.json(),s=JSON.parse(data.settings);s.extension_settings.disabledExtensions=[...new Set([...(s.extension_settings.disabledExtensions??[]),'tts'])];data.settings=JSON.stringify(s);await route.fulfill({response,json:data});});
 await page.goto(process.argv[4]??'http://127.0.0.1:18274');await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-home'));await page.waitForTimeout(800);
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Reference QA');await page.locator('dialog[open] .popup-button-ok:visible').tap();}
 const panel=page.locator('#pensieve-panel'),dock=page.locator('#pensieve-restore-dock');
 await openWorkspace(page,'prompts');await panel.getByLabel('Промпт эпизода',{exact:true}).waitFor();
 const before=await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().extensionSettings.pensieve));
 const draft='НЕСОХРАНЁННЫЙ {{char}}\n# Длинный промпт';
 await panel.getByLabel('Промпт эпизода',{exact:true}).fill(draft);await panel.getByLabel('Промпт эпизода',{exact:true}).evaluate(n=>window.qaPromptNode=n);
 assert.equal(await panel.locator('[data-action="minimize"]').count(),1,'a dedicated minimize action is required');
 for(let i=0;i<3;i++) {
  await panel.locator('[data-action="minimize"]').tap();await page.waitForTimeout(80);
  assert.equal(await panel.evaluate(n=>n.open),false);assert.equal(await page.locator('#pensieve-panel:modal').count(),0);
  assert.equal(await dock.isVisible(),true);assert.equal(await dock.locator('button').count(),1);
  await page.locator('#send_textarea').fill('Чат доступен '+i);
  const bounds=await dock.evaluate(n=>({dock:n.getBoundingClientRect().bottom,input:document.querySelector('#send_form').getBoundingClientRect().top}));assert.ok(bounds.dock<=bounds.input+1,'restore must not overlay composer');
  await page.evaluate(async()=>{const c=SillyTavern.getContext();await c.eventSource.emit(c.eventTypes.MESSAGE_RECEIVED,0);});await page.waitForTimeout(200);
  await dock.getByRole('button',{name:/Омут памяти/}).tap();await page.waitForTimeout(80);
  assert.equal(await panel.locator('[data-tab="prompts"]').getAttribute('aria-current'),'page');assert.equal(await panel.getByLabel('Промпт эпизода',{exact:true}).inputValue(),draft);
  assert.equal(await panel.getByLabel('Промпт эпизода',{exact:true}).evaluate(n=>n===window.qaPromptNode),true);
  assert.equal(await dock.isVisible(),false);
 }
 await panel.locator('[data-action="minimize"]').tap();
 await page.evaluate(async()=>{const c=SillyTavern.getContext();await c.eventSource.emit(c.eventTypes.CHAT_CHANGED,c.chatId);document.querySelector('#pensieve-restore-dock button').click();});await page.waitForTimeout(250);
 assert.equal(await panel.getByLabel('Промпт эпизода',{exact:true}).inputValue(),draft,'a delayed chat refresh after rapid restore must preserve the prompt draft');
 assert.equal(await panel.getByLabel('Промпт эпизода',{exact:true}).evaluate(n=>n===window.qaPromptNode),true);
 assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().extensionSettings.pensieve)),before,'minimize/restore must not change settings or prompts');
 assert.equal(await panel.getByRole('button',{name:'Развернуть редактор',exact:true}).count(),1,'long prompts need the approved larger editor');
 await panel.getByRole('button',{name:'Развернуть редактор',exact:true}).tap();const expanded=page.locator('.pv-editor[open]').last();await expanded.getByLabel('Полный редактор промпта').fill(draft+'\nДополнение');await page.evaluate(async()=>{const c=SillyTavern.getContext();await c.eventSource.emit(c.eventTypes.CHAT_CHANGED,c.chatId);});await page.waitForTimeout(250);await expanded.getByRole('button',{name:'Вернуться к промпту',exact:true}).tap();await page.waitForFunction(expected=>document.querySelector('#pensieve-panel [aria-label="Промпт эпизода"]')?.value===expected,draft+'\nДополнение');assert.equal(await panel.getByLabel('Промпт эпизода',{exact:true}).inputValue(),draft+'\nДополнение');assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().extensionSettings.pensieve)),before,'expanded editor returns a draft without saving it automatically');
 for(const width of [320,390,736,1280]) {
  await page.setViewportSize({width,height:700});
  const nav=await panel.locator('.pv-tabs').evaluate(n=>[...n.children].map(b=>({top:b.getBoundingClientRect().top,height:b.getBoundingClientRect().height,scroll:b.scrollWidth,width:b.clientWidth,line:parseFloat(getComputedStyle(b).lineHeight)})));
  assert.ok(nav.every(b=>b.top===nav[0].top&&b.height<49&&b.scroll<=b.width+1),'compact navigation must remain one row at '+width+': '+JSON.stringify(nav));
  assert.equal(await panel.getByRole('button',{name:'Память',exact:true}).count(),1,'memory tab uses the reference label');
  assert.ok(await panel.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'no dialog overflow at '+width);
 }
 await page.setViewportSize({width:390,height:844});
 await panel.locator('[data-action="close"]').tap();await page.waitForTimeout(80);assert.equal(await dock.isVisible(),false);assert.equal(await panel.evaluate(n=>n.open),false);await page.locator('#send_textarea').fill('После закрытия');
 await openWorkspace(page,'prompts');await panel.getByLabel('Промпт эпизода',{exact:true}).waitFor();
 await panel.locator('[data-action="minimize"]').tap();await dock.getByRole('button').tap();await panel.locator('[data-action="close"]').tap();await page.waitForTimeout(80);assert.equal(await dock.isVisible(),false);
 // A nested progress dialog's X must use the same cancel path as Escape.
 await page.evaluate(async()=>{const {UI}=await import('/scripts/extensions/third-party/SillyTavern-Pensieve/src/ui.js');window.qaCanceled=0;window.qaProgressUI=new UI({settings:()=>({theme:'dark'}),cancel:()=>{window.qaCanceled++;window.qaReject(Error('Canceled'));}});window.qaPending=window.qaProgressUI.generating(()=>new Promise((resolve,reject)=>{window.qaReject=reject;})).catch(()=>{});});
 const progress=page.locator('.pv-editor[open]').last();await progress.getByRole('button',{name:'Закрыть окно',exact:true}).tap();assert.equal(await page.evaluate(()=>window.qaCanceled),1,'X on progress must cancel the pending operation');await page.evaluate(()=>window.qaPending);assert.equal(await page.locator('.pv-editor[open]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS '+engine+': minimize/restore retains the exact prompt DOM, unsaved text, tab, memory/settings, in-flow unique dock, usable composer, distinct Close and repeated cycles');
 await context.close();
} finally {await browser.close();}
