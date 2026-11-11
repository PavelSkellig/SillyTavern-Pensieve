import {openWorkspace} from './ui-navigation.mjs';
/** Disposable real ST only. node tests/compact-ui.mjs <playwright/index.mjs> [chromium|webkit] [URL] */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const pw=await import(pathToFileURL(path.resolve(process.argv[2])).href),engine=process.argv[3]??'chromium';
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
await fs.mkdir('work/screenshots',{recursive:true});
try {
 const context=await browser.newContext(pw.devices['iPhone 13']),page=await context.newPage(),errors=[];let modelRequests=0;
 page.on('pageerror',e=>errors.push(e.message));
 if(process.argv[5]==='legacy-template')await page.route('**/SillyTavern-Pensieve/panel.html',async route=>{const response=await route.fetch(),body=(await response.text()).replace('class="pv-caption"','').replace('class="pv-brand"','').replace(/<div class="pv-brand-mark"[^>]*>[\s\S]*?<\/div>\s*/,'').replace('<h2 id="pensieve-title">','<h2 id="pensieve-title"><i class="fa-solid fa-book-open" aria-hidden="true"></i> ');await route.fulfill({response,body});});
 if(engine==='webkit')await page.route('**/api/settings/get',async route=>{const response=await route.fetch(),data=await response.json(),s=JSON.parse(data.settings);s.extension_settings.disabledExtensions=[...new Set([...(s.extension_settings.disabledExtensions??[]),'tts'])];data.settings=JSON.stringify(s);await route.fulfill({response,json:data});});
 await page.route('**/api/backends/chat-completions/generate',async route=>{modelRequests++;await route.fulfill({json:{choices:[{message:{role:'assistant',content:'UNEXPECTED MODEL REQUEST'},finish_reason:'stop'}]}});});
 await page.goto(process.argv[4]??'http://127.0.0.1:18273');await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));await page.waitForTimeout(800);
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').tap();}
 const fixture=await page.evaluate(async()=>{
  const c=SillyTavern.getContext(),core=await import('/script.js'),root='/scripts/extensions/third-party/SillyTavern-Pensieve';
  const response=await fetch('/api/characters/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({ch_name:`Compact QA ${Date.now()}`,first_mes:'Test greeting'})});if(!response.ok)throw Error('Fixture create failed');const avatar=await response.text();await c.getCharacters();const live=SillyTavern.getContext();await live.selectCharacterById(String(live.characters.findIndex(x=>x.avatar===avatar)));
  const state=SillyTavern.getContext();state.chat.splice(0,state.chat.length,...Array.from({length:50},(_,i)=>{const mes=`Event ${i+1}\n${'Длинный текст сообщения. '.repeat(100)}\n<img src=x> TAIL_${i+1}`;return {name:'Библиотекарь',mes,is_user:!!(i%2),is_system:false,extra:{pensieve:{id:`compact-message-${i}`}},...(!(i%2)?{swipe_id:0,swipes:[mes]}:{})};}));
  const {emptyArchive,captureRange,sourceRecord}=await import(`${root}/src/core.js`),archive=emptyArchive('compact-qa');
  const make=(id,title,source,active)=>({id,type:'summary',title,text:`SAVED_${id}`,order:source,active,createdAt:'2026-11-09T12:00:00.000Z',updatedAt:'2026-11-09T12:00:00.000Z',version:1,history:[],sources:captureRange(state.chat,source,source+1).map(sourceRecord),summaryIds:[],needsReview:false});
  archive.entries=[make('first','Сводка №3',0,false),make('second','Сводка №1',42,false),make('last','Сводка №2',44,true),{...make('arc','Арка №1',0,true),type:'arc',sources:[],summaryIds:['first','second']}];
  // Mirror native Hide after saved active memory; archived-only sources remain visible.
  for(const i of [0,1,42,43,44,45])state.chat[i].is_system=true;
  state.chatMetadata.pensieve=archive;Object.assign(state.extensionSettings.pensieve,{enabled:true,inject:true,tokenLimit:6000,theme:'dark'});for(const type of ['summary','arc']){const g=state.extensionSettings.pensieve.prompts[type];g.presets.find(p=>p.id===g.selected).text=`QA ${type} {{char}}`;}
  core.changeMainAPI('openai');Object.assign(state.chatCompletionSettings,{chat_completion_source:'custom',custom_url:'http://127.0.0.1:1/v1',custom_model:'qa-test',openai_max_context:32000,openai_max_tokens:2000,stream_openai:false});core.setOnlineStatus('Valid');
  await core.redisplayChat({startIndex:0,fade:false});state.swipe.refresh();await state.saveChat();state.saveSettingsDebounced();await state.eventSource.emit(state.eventTypes.CHAT_CHANGED,state.chatId);
  return {avatar,chatId:state.chatId,archive:JSON.stringify(archive),prompts:JSON.stringify(state.extensionSettings.pensieve.prompts)};
 });
 const panel=page.locator('#pensieve-panel');await openWorkspace(page,'home');await panel.locator('[name="rangeStart"]').waitFor();
 await panel.locator('[name="rangeStart"]').fill('1');await panel.locator('[name="rangeEnd"]').fill('42');
 await page.screenshot({path:`work/screenshots/compact-home-${engine}.png`});
 assert.equal(await panel.locator('.pv-version').count(),1,'the loaded UI must show its own version');assert.equal(await panel.locator('.pv-version').innerText(),'v1.6.4');
 const preview=panel.locator('.pv-range-preview'),details=preview.locator('details');assert.ok((await preview.innerText()).includes('Сообщения 1–42 · 42 сообщения'));assert.ok(!(await preview.innerText()).includes('TAIL_1'));
 assert.ok((await preview.innerText()).includes('Уже сохранено в эпизоде №3'));assert.equal(await details.getAttribute('open'),null);assert.equal(await preview.locator('.pv-full-preview > *').count(),0,'full DOM is lazy');assert.ok((await preview.locator('.pv-range-snippet').allTextContents()).every(text=>text.length<120));
 await details.getByText('Показать подробнее',{exact:true}).tap();await preview.locator('.pv-full-preview > *').nth(41).waitFor();assert.ok((await preview.innerText()).includes('TAIL_42'));assert.equal(await preview.locator('img').count(),0,'message text remains literal');
 await details.locator('summary').tap();assert.ok(!(await preview.innerText()).includes('TAIL_42'));
 await panel.locator('[name="rangeEnd"]').fill('1');assert.ok((await preview.innerText()).includes('1 сообщение'));await preview.locator('summary').tap();await preview.locator('.pv-full-preview > *').first().waitFor();assert.equal(await preview.locator('.pv-full-preview > *').count(),1);assert.ok(!(await preview.innerText()).includes('TAIL_42'),'old range must not remain');
 await panel.locator('[name="rangeStart"]').fill('42');await panel.locator('[name="rangeEnd"]').fill('1');assert.ok((await preview.innerText()).includes('Укажите начало и конец'));await panel.locator('[name="rangeStart"]').fill('1');await panel.locator('[name="rangeEnd"]').fill('42');
 await panel.locator('[name="rangeEnd"]').fill('46');assert.ok((await preview.locator('.pv-overlap-note').innerText()).includes('ещё 2'),'multiple overlaps use a compact count');assert.equal(await panel.locator('[aria-label="Повторная обработка"] [data-replace]').count(),3);await panel.locator('[name="rangeEnd"]').fill('42');
 await panel.getByRole('button',{name:'Создать эпизод',exact:true}).last().tap();await panel.locator('.pv-notice').filter({hasText:'пересекается'}).waitFor();assert.equal(modelRequests,0,'overlap protection still prevents a request');
 await panel.locator('[data-tab="home"]').tap();
 for(const width of [320,390,430,1280]){
  await page.setViewportSize({width,height:844});const sizes=await panel.evaluate(n=>{const actions=[...n.querySelectorAll('.pv-home-actions button')].map(x=>x.getBoundingClientRect()),s=n.querySelector('.pv-home-stats').getBoundingClientRect(),p=n.querySelector('.pv-range-preview').getBoundingClientRect();return {actions:actions.map(r=>({y:r.y,h:r.height})),stats:s.height,preview:p.height,scroll:n.scrollWidth,client:n.clientWidth};});
  assert.equal(sizes.actions.length,3);assert.equal(sizes.actions[0].y,sizes.actions[1].y);assert.ok(sizes.actions.every(r=>r.h<=44&&r.h>=36));assert.ok(sizes.stats<=40);assert.ok(sizes.preview<=150,`compact preview at ${width}px: ${sizes.preview}`);assert.ok(sizes.scroll<=sizes.client+1);
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`work/screenshots/compact-home-${engine}.png`});await panel.locator('[data-action="close"]').tap();await openWorkspace(page,'home');assert.equal(await panel.locator('[name="rangeEnd"]').inputValue(),'42');
 await panel.locator('[data-tab="archive"]').tap();await panel.locator('.pv-record').first().waitFor();assert.equal(await panel.locator('.pv-record').count(),3);assert.equal(await panel.locator('.pv-record.pv-card').count(),0);
 const card=panel.locator('[data-entry-id="last"]');const geometry=await card.evaluate(n=>({h:n.getBoundingClientRect().height,scroll:n.scrollWidth,width:n.clientWidth}));assert.ok(geometry.h<=170,`archive row must be compact: ${geometry.h}`);assert.ok(geometry.scroll<=geometry.width+1);assert.ok(!(await card.innerText()).includes('SAVED_last'));
 await card.locator('summary').tap();await card.getByRole('button',{name:'Открыть',exact:true}).tap();const editor=page.locator('.pv-editor[open]').last();assert.equal(await editor.getByLabel('Текст записи').inputValue(),'SAVED_last');await editor.getByRole('button',{name:'Закрыть',exact:true}).tap();
 await card.getByRole('button',{name:'Перегенерировать',exact:true}).waitFor();await card.getByRole('button',{name:'Восстановить исходные сообщения',exact:true}).waitFor();await card.locator('summary').tap();
 await page.setViewportSize({width:1280,height:844});await page.screenshot({path:`work/screenshots/compact-archive-desktop-${engine}.png`});await page.setViewportSize({width:390,height:844});
 await panel.getByLabel('Поиск воспоминаний').fill('SAVED_second');await page.waitForTimeout(250);assert.equal(await panel.locator('[data-entry-id]').count(),1);await panel.getByLabel('Поиск воспоминаний').fill('');await page.waitForTimeout(250);
 await page.screenshot({path:`work/screenshots/compact-archive-${engine}.png`});
 await panel.locator('[data-entry-id="first"]').getByRole('checkbox').check();assert.equal(await panel.locator('[data-selected-id="first"]').count(),1);
 for(const viewport of [{width:320,height:640},{width:390,height:420}]){await page.setViewportSize(viewport);assert.ok(await panel.locator('[data-action="close"]').isVisible());const bounds=await panel.evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,bottom:n.querySelector('.pv-content').getBoundingClientRect().bottom,root:n.getBoundingClientRect().bottom}));assert.ok(bounds.scroll<=bounds.client+1&&bounds.bottom<=bounds.root+1);}
 assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.pensieve)),fixture.archive);assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().extensionSettings.pensieve.prompts)),fixture.prompts);await panel.locator('[data-action="close"]').tap();assert.equal(await page.locator('#pensieve-panel:modal').count(),0);assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}: loaded UI version, compact home/stats, lazy full range and short snippets, changed/single/invalid range, overlap blocked, list rows/actions/search/selection, mobile layout/close, unchanged archive/prompts and no page errors`);
 await context.close();
}finally{await browser.close();}
