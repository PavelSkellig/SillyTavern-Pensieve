import {openWorkspace} from './ui-navigation.mjs';
/** Disposable ST only. node tests/ui-memory.mjs <playwright/index.mjs> [chromium|webkit] [ST URL] */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const pw=await import(pathToFileURL(path.resolve(process.argv[2])).href),engine=process.argv[3]??'chromium';
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
await fs.mkdir('work/screenshots',{recursive:true});
try{
 const context=await browser.newContext(pw.devices['iPhone 13']),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 if(engine==='webkit')await page.route('**/api/settings/get',async route=>{const response=await route.fetch(),data=await response.json(),s=JSON.parse(data.settings);s.extension_settings.disabledExtensions=[...new Set([...(s.extension_settings.disabledExtensions??[]),'tts'])];data.settings=JSON.stringify(s);await route.fulfill({response,json:data});});
 await page.goto(process.argv[4]??'http://127.0.0.1:18273');await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));await page.waitForTimeout(800);
 const scoped=await page.evaluate(()=>{
  const box=document.createElement('div'),normal=document.createElement('div');box.append(normal);document.body.append(box);
  const values=n=>{const s=getComputedStyle(n);return [s.paddingTop,s.paddingLeft,s.marginTop,s.minHeight,s.backgroundColor,s.borderTopWidth].join('|');},baseline=values(normal);
  const matches=['pv-card','pv-content','pv-header','pv-row','pv-tabs'].every(name=>{const n=document.createElement('div');n.className=name;box.append(n);return values(n)===baseline;});box.remove();return matches;
 });assert.equal(scoped,true,'Pensieve CSS must not style unrelated elements');
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').tap();}
 const fixture=await page.evaluate(async()=>{
  const c=SillyTavern.getContext(),core=await import('/script.js'),root='/scripts/extensions/third-party/SillyTavern-Pensieve';
  const r=await fetch('/api/characters/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({ch_name:`UI memory QA ${Date.now()}`,first_mes:'Test greeting'})});if(!r.ok)throw Error('fixture create failed');const avatar=await r.text();await c.getCharacters();const live=SillyTavern.getContext();await live.selectCharacterById(String(live.characters.findIndex(x=>x.avatar===avatar)));
  const state=SillyTavern.getContext();state.chat.splice(0,state.chat.length,...Array.from({length:6},(_,i)=>({name:'Test',mes:`Событие ${i+1}`,is_user:!!(i%2),is_system:false,extra:{pensieve:{id:`qa-message-${i}`}},...(!(i%2)?{swipe_id:0,swipes:[`Событие ${i+1}`]}:{})})));
  core.changeMainAPI('openai');Object.assign(state.chatCompletionSettings,{openai_max_context:32000,openai_max_tokens:2000,stream_openai:false});
  const {emptyArchive,captureRange,sourceRecord}=await import(`${root}/src/core.js`),archive=emptyArchive('qa');
  const make=(id,title,text,order,active)=>({id,type:'summary',title,text,order,active,createdAt:'2026-11-09T12:00:00.000Z',updatedAt:'2026-11-09T12:00:00.000Z',version:1,history:[],sources:captureRange(state.chat,order,order+1).map(sourceRecord),summaryIds:[],needsReview:false});
  archive.entries=[make('qa-a','Сводка №1','ALPHA',0,false),make('qa-b','Сводка №2','BETA',2,false),make('qa-c','Сводка №3','GAMMA',4,true),{...make('qa-arc','Арка №1','ARC_AB',0,true),type:'arc',sources:[],summaryIds:['qa-a','qa-b']}];
  state.chatMetadata.pensieve=archive;Object.assign(state.extensionSettings.pensieve,{enabled:true,inject:true,tokenLimit:6000,theme:'dark'});await core.redisplayChat({startIndex:0,fade:false});state.swipe.refresh();await state.saveChat();await state.eventSource.emit(state.eventTypes.CHAT_CHANGED,state.chatId);
  return {avatar,chatId:state.chatId,texts:archive.entries.map(e=>[e.id,e.text]),prompts:JSON.stringify(state.extensionSettings.pensieve.prompts)};
 });
 const panel=page.locator('#pensieve-panel');
 await page.waitForSelector('[mesid="1"] [data-pensieve-edge="start"]',{state:'attached'});
 await page.locator('[mesid="1"] [data-pensieve-edge="start"]').evaluate(n=>n.click());
 assert.equal(await panel.evaluate(n=>n.open),false,'marking start must not open the dialog');
 await page.locator('[mesid="3"] [data-pensieve-edge="end"]').evaluate(n=>n.click());assert.equal(await panel.evaluate(n=>n.open),false);
 assert.equal(await page.locator('[mesid="1"]').evaluate(n=>n.classList.contains('pensieve-start')),true);
 await openWorkspace(page,'home');await panel.locator('[name="rangeStart"]').waitFor();assert.equal(await panel.locator('[name="rangeStart"]').inputValue(),'2');assert.equal(await panel.locator('[name="rangeEnd"]').inputValue(),'4');
 await panel.locator('[data-action="close"]').tap();await openWorkspace(page,'home');assert.equal(await panel.locator('[name="rangeEnd"]').inputValue(),'4');
 console.log(`PASS ${engine}: boundary selection stays in chat; close/reopen retains range`);
 await panel.locator('[data-tab="archive"]').tap();
 const card=id=>panel.locator(`[data-entry-id="${id}"]`),status=id=>card(id).locator('.pv-entry-title > .pv-memory-status');
 await status('qa-a').waitFor();assert.equal(await status('qa-a').innerText(),'В архиве');assert.equal(await status('qa-c').innerText(),'Активна');
 await card('qa-c').getByRole('checkbox').check();await card('qa-c').getByText('Выбран для главы',{exact:true}).waitFor();assert.equal(await status('qa-c').innerText(),'Активна');
 await panel.getByLabel('Фильтр архива').selectOption('active');assert.equal(await panel.locator('[data-entry-id]').count(),1);assert.equal(await status('qa-c').innerText(),'Активна');
 await panel.getByLabel('Фильтр архива').selectOption('inactive');assert.equal(await panel.locator('[data-entry-id]').count(),2);
 await panel.locator('[data-tab="memory"]').tap();await panel.locator('[data-memory-section="current"] [data-entry-id="qa-arc"]').waitFor();
 assert.equal(await panel.locator('[data-memory-section="current"] [data-entry-id]').count(),2);assert.equal(await panel.locator('[data-memory-section="archive"] [data-entry-id]').count(),2);
 await card('qa-c').getByRole('button',{name:'Убрать из памяти',exact:true}).tap();await page.waitForFunction(()=>!SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value.includes('GAMMA'));
 await status('qa-c').filter({hasText:'В архиве'}).waitFor();await card('qa-c').getByRole('button',{name:'Добавить в память',exact:true}).tap();await page.waitForFunction(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value.includes('GAMMA'));
 await status('qa-c').filter({hasText:'Активна'}).waitFor();
 const actual=await page.evaluate(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value);assert.ok(actual.includes('ARC_AB')&&actual.includes('GAMMA')&&!actual.includes('ALPHA')&&!actual.includes('BETA'));
 console.log(`PASS ${engine}: effective statuses, independent arc selection, filters, immediate activation, arc deduplication`);
 await panel.locator('[data-tab="settings"]').tap();await panel.getByLabel('Внедрять активную память',{exact:true}).uncheck();await panel.locator('[data-tab="memory"]').tap();await panel.getByText('Внедрение памяти глобально отключено.',{exact:false}).waitFor();assert.equal(await panel.locator('[data-memory-section="current"] [data-entry-id]').count(),0);assert.equal(await panel.locator('.pv-memory-status').filter({hasText:'Активна'}).count(),0);
 await panel.locator('[data-tab="settings"]').tap();await panel.getByLabel('Внедрять активную память',{exact:true}).check();await panel.locator('[data-tab="memory"]').tap();
 await panel.getByLabel('Лимит памяти, токенов').fill('1');await panel.getByLabel('Лимит памяти, токенов').dispatchEvent('change');await page.waitForFunction(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value==='');
 await panel.getByText('Не помещается в лимит',{exact:true}).first().waitFor();assert.equal(await panel.locator('[data-memory-section="current"] [data-entry-id]').count(),0);
 await panel.getByLabel('Лимит памяти, токенов').fill('6000');await panel.getByLabel('Лимит памяти, токенов').dispatchEvent('change');await page.waitForFunction(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value.includes('GAMMA'));
 await status('qa-c').filter({hasText:'Активна'}).waitFor();assert.equal(await panel.locator('.pv-notice').isVisible(),false,'resolved token overflow must not leave a stale warning');
 await card('qa-c').getByRole('button',{name:'Убрать из памяти',exact:true}).tap();await status('qa-c').filter({hasText:'В архиве'}).waitFor();
 await page.screenshot({path:`work/screenshots/memory-sections-${engine}.png`});
 await page.waitForTimeout(1300);await page.reload();await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-home'));await page.waitForTimeout(500);
 await page.evaluate(async f=>{const c=SillyTavern.getContext();await c.selectCharacterById(String(c.characters.findIndex(x=>x.avatar===f.avatar)));if(SillyTavern.getContext().chatId!==f.chatId)await SillyTavern.getContext().openCharacterChat(f.chatId);},fixture);
 assert.equal(await panel.evaluate(n=>n.open),false);await openWorkspace(page,'home');await panel.locator('[name="rangeStart"]').waitFor();assert.equal(await panel.locator('[name="rangeStart"]').inputValue(),'2');assert.equal(await panel.locator('[name="rangeEnd"]').inputValue(),'4');
 await panel.locator('[data-tab="memory"]').tap();await status('qa-c').waitFor();assert.equal(await status('qa-c').innerText(),'В архиве');
 const preserved=await page.evaluate(()=>{const c=SillyTavern.getContext();return {texts:c.chatMetadata.pensieve.entries.map(e=>[e.id,e.text]),prompts:JSON.stringify(c.extensionSettings.pensieve.prompts)};});assert.deepEqual(preserved,{texts:fixture.texts,prompts:fixture.prompts});
 for(const viewport of [{width:320,height:640},{width:390,height:420},{width:430,height:900}]){await page.setViewportSize(viewport);const b=await panel.evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,bottom:n.getBoundingClientRect().bottom,main:n.querySelector('.pv-content').getBoundingClientRect().bottom}));assert.ok(b.scroll<=b.client+1&&b.main<=b.bottom);await panel.locator('.pv-content').evaluate(n=>n.scrollTop=n.scrollHeight);}
 await panel.locator('[data-action="close"]').tap();assert.equal(await page.locator('#pensieve-panel:modal').count(),0);assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}: global disable, whole-block token gate, reload/range persistence, original texts/prompts, mobile scrolling, startup and close`);
 await context.close();
}finally{await browser.close();}
