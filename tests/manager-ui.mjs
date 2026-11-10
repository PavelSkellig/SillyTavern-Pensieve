/** Disposable real ST only. node tests/manager-ui.mjs <playwright/index.mjs> [chromium|webkit] [URL] */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const pw=await import(pathToFileURL(path.resolve(process.argv[2])).href),engine=process.argv[3]??'chromium';
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
await fs.mkdir('work/screenshots',{recursive:true});
try {
 const context=await browser.newContext(pw.devices['iPhone 13']),page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 if(engine==='webkit')await page.route('**/api/settings/get',async route=>{const response=await route.fetch(),data=await response.json(),s=JSON.parse(data.settings);s.extension_settings.disabledExtensions=[...new Set([...(s.extension_settings.disabledExtensions??[]),'tts'])];data.settings=JSON.stringify(s);await route.fulfill({response,json:data});});
 await page.route('**/api/backends/chat-completions/generate',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{choices:[{message:{role:'assistant',content:'ARC_PREVIEW'},finish_reason:'stop'}]}});});
 await page.goto(process.argv[4]??'http://127.0.0.1:18273');await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));await page.waitForTimeout(800);
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').tap();}
 const fixture=await page.evaluate(async()=>{
  const c=SillyTavern.getContext(),core=await import('/script.js'),root='/scripts/extensions/third-party/SillyTavern-Pensieve';
  const response=await fetch('/api/characters/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({ch_name:`Manager QA ${Date.now()}`,first_mes:'Test greeting'})});if(!response.ok)throw Error('Fixture create failed');const avatar=await response.text();await c.getCharacters();const live=SillyTavern.getContext();await live.selectCharacterById(String(live.characters.findIndex(x=>x.avatar===avatar)));
  const state=SillyTavern.getContext();state.chat.splice(0,state.chat.length,...Array.from({length:8},(_,i)=>({name:'Test',mes:`Event ${i+1}`,is_user:!!(i%2),is_system:false,extra:{pensieve:{id:`manager-message-${i}`}},...(!(i%2)?{swipe_id:0,swipes:[`Event ${i+1}`]}:{})})));
  const {emptyArchive,captureRange,sourceRecord}=await import(`${root}/src/core.js`),archive=emptyArchive('manager-qa');
  const make=(id,title,text,order,source,active=false)=>({id,type:'summary',title,text,order,active,createdAt:'2026-11-09T12:00:00.000Z',updatedAt:'2026-11-09T12:00:00.000Z',version:1,history:[],sources:captureRange(state.chat,source,source+1).map(sourceRecord),summaryIds:[],needsReview:false});
  archive.entries=[make('last','Сводка №7 — Последняя','LAST_SECRET',0,6,true),make('first','Сводка №3 — Первая','FIRST_SECRET',1,0),make('second','Сводка №1 — Вторая','SECOND_SECRET',2,2),make('third','Сводка №2 — Третья','THIRD_SECRET',3,4),{...make('arc','Арка №9 — Ранее','ARC_FIRST_SECOND',4,0,true),type:'arc',sources:[],summaryIds:['first','second']}];
  state.chatMetadata.pensieve=archive;Object.assign(state.extensionSettings.pensieve,{enabled:true,inject:true,tokenLimit:6000,theme:'dark'});
  for(const type of ['summary','arc']){const group=state.extensionSettings.pensieve.prompts[type];group.presets.find(p=>p.id===group.selected).text=`QA ${type}: {{char}} — literal user prompt`;}
  core.changeMainAPI('openai');Object.assign(state.chatCompletionSettings,{chat_completion_source:'custom',custom_url:'http://127.0.0.1:1/v1',custom_model:'qa-test',openai_max_context:32000,openai_max_tokens:2000,stream_openai:false});core.setOnlineStatus('Valid');
  await core.redisplayChat({startIndex:0,fade:false});state.swipe.refresh();await state.saveChat();state.saveSettingsDebounced();await state.eventSource.emit(state.eventTypes.CHAT_CHANGED,state.chatId);
  return {avatar,chatId:state.chatId,archive:JSON.stringify(archive),prompts:JSON.stringify(state.extensionSettings.pensieve.prompts)};
 });
 const panel=page.locator('#pensieve-panel');
 await page.waitForSelector('[mesid="1"] [data-pensieve-edge="start"]',{state:'attached'});
 const icons=await page.locator('[mesid="1"] [data-pensieve-edge]').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent.trim(),title:n.title,label:n.getAttribute('aria-label'),svg:!!n.querySelector('svg')})));
 assert.deepEqual(icons.map(n=>n.text),['',''],'message actions must be icon-only');assert.ok(icons.every(n=>n.svg&&n.title&&n.label));
 // Expose ST's native existing extra menu; its other actions must remain untouched.
 const geometry=await page.locator('[mesid="1"] .extraMesButtons').evaluate(menu=>{
  menu.style.display='flex';const size=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
  const pair=menu.querySelector('.pv-range-actions'),buttons=[...pair.querySelectorAll('button')],glyph=buttons[0].querySelector('svg').getBoundingClientRect();
  const before=[...menu.querySelectorAll('.mes_button:not(.pv-message-action)')].map(n=>[n.className,getComputedStyle(n).fontSize,getComputedStyle(n).padding]);pair.hidden=true;
  const after=[...menu.querySelectorAll('.mes_button:not(.pv-message-action)')].map(n=>[n.className,getComputedStyle(n).fontSize,getComputedStyle(n).padding]);pair.hidden=false;
  return {buttons:buttons.map(size),glyph:glyph.width,before,after,scroll:document.documentElement.scrollWidth,viewport:innerWidth};
 });
 assert.deepEqual(geometry.before,geometry.after);assert.ok(geometry.buttons.every(b=>b.w>=32&&b.w<=36&&b.h>=32&&b.h<=36));assert.equal(geometry.buttons[0].y,geometry.buttons[1].y);assert.ok(geometry.glyph>=16&&geometry.glyph<=20);assert.ok(geometry.scroll<=geometry.viewport+1);
 await page.screenshot({path:`work/screenshots/message-icons-${engine}.png`});
 await page.locator('[mesid="1"] [data-pensieve-edge="start"] svg').tap();assert.equal(await panel.evaluate(n=>n.open),false);assert.equal(await page.locator('[mesid="1"] [data-pensieve-edge="start"]').getAttribute('aria-pressed'),'true');
 await page.locator('[mesid="1"] [data-pensieve-edge="end"] svg').tap();assert.equal(await panel.evaluate(n=>n.open),false);
 await page.locator('#pensieve-open').evaluate(n=>n.click());await panel.getByLabel('Поиск воспоминаний').waitFor();
 await page.waitForFunction(()=>{const tabs=[...document.querySelectorAll('#pensieve-panel .pv-tabs button')];return getComputedStyle(tabs.find(n=>n.getAttribute('aria-current')==='page')).backgroundColor!==getComputedStyle(tabs.find(n=>n.getAttribute('aria-current')==='false')).backgroundColor;});
 const tabColors=await panel.locator('.pv-tabs button').evaluateAll(nodes=>nodes.map(n=>({current:n.getAttribute('aria-current'),background:getComputedStyle(n).backgroundColor})));
 assert.notEqual(tabColors.find(n=>n.current==='page').background,tabColors.find(n=>n.current==='false').background,'current tab must be visually distinct');
 const ids=()=>panel.locator('.pv-archive-results [data-entry-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.entryId));
 const card=id=>panel.locator(`[data-entry-id="${id}"]`),bar=panel.locator('.pv-arc-selection');
 assert.deepEqual(await ids(),['first','second','third','last']);assert.equal(await bar.count(),0,'no selection toolbar before a selection');
 assert.equal(await card('last').locator('h4').innerText(),'Эпизод №7');assert.equal(await card('last').locator('.pv-record-subtitle').innerText(),'Последняя');assert.ok(!(await card('first').innerText()).includes('FIRST_SECRET'));
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`work/screenshots/manager-archive-desktop-${engine}.png`});await page.setViewportSize({width:390,height:844});
 await panel.getByLabel('Поиск воспоминаний').fill('second_secret');await page.waitForTimeout(350);assert.deepEqual(await ids(),['second']);assert.equal(await panel.getByLabel('Поиск воспоминаний').evaluate(n=>n===document.activeElement),true);
 await panel.getByLabel('Поиск воспоминаний').fill('пОсЛеДнЯя');await page.waitForTimeout(350);assert.deepEqual(await ids(),['last']);
 await panel.getByLabel('Поиск воспоминаний').fill('');await page.waitForTimeout(350);
 await card('last').getByRole('checkbox').check();await card('third').getByRole('checkbox').check();
 const chosen=()=>bar.locator('[data-selected-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.selectedId));assert.deepEqual(await chosen(),['third','last']);
 await bar.locator('[data-selected-id="last"]').getByRole('button',{name:'Поднять'}).tap();assert.deepEqual(await chosen(),['last','third']);
 await card('first').getByRole('checkbox').check();assert.deepEqual(await chosen(),['last','third','first'],'manual order survives additional selection');await bar.getByText('Уже входят в главы:',{exact:false}).waitFor();
 await panel.locator('.pv-content').evaluate(n=>n.scrollTop=0);await page.screenshot({path:`work/screenshots/manager-selection-mobile-${engine}.png`});
 await panel.getByLabel('Фильтр архива').selectOption('active');assert.deepEqual(await ids(),['last']);assert.deepEqual(await chosen(),['last','third','first']);await panel.getByLabel('Фильтр архива').selectOption('all');
 await bar.getByRole('button',{name:'Создать главу',exact:true}).tap();const preview=page.locator('.pv-editor[open]').last();await preview.getByLabel('Текст воспоминания').waitFor();
 assert.equal(requests.length,1,'exactly one explicit model request');const input=requests[0].messages[1].content;assert.ok(input.indexOf('LAST_SECRET')<input.indexOf('THIRD_SECRET')&&input.indexOf('THIRD_SECRET')<input.indexOf('FIRST_SECRET'));const expectedPrompt=JSON.parse(fixture.prompts).arc;assert.equal(requests[0].messages[0].content,expectedPrompt.presets.find(p=>p.id===expectedPrompt.selected).text);
 await preview.getByRole('button',{name:'Отмена',exact:true}).tap();await bar.getByRole('button',{name:'По исходным сообщениям'}).tap();assert.deepEqual(await chosen(),['first','third','last']);await bar.getByRole('button',{name:'Снять выбор'}).tap();assert.equal(await bar.count(),0);
 assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.pensieve)),fixture.archive,'search, selection, order and preview must not rewrite archive');
 await panel.locator('[data-tab="memory"]').tap();await panel.locator('[data-memory-section="current"] [data-entry-id="arc"]').waitFor();assert.deepEqual(await panel.locator('[data-memory-section="current"] [data-entry-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.entryId)),['arc','last']);
 const injected=await page.evaluate(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value);assert.ok(injected.indexOf('ARC_FIRST_SECOND')<injected.indexOf('LAST_SECRET'));assert.ok(!injected.includes('FIRST_SECRET')&&!injected.includes('SECOND_SECRET'));
 for(const viewport of [{width:320,height:640},{width:390,height:420},{width:430,height:900}]){await page.setViewportSize(viewport);const r=await panel.evaluate(n=>{const b=n.getBoundingClientRect(),x=n.querySelector('[data-action="close"]').getBoundingClientRect(),m=n.querySelector('.pv-content');return {w:b.width,h:b.height,scroll:n.scrollWidth,client:n.clientWidth,close:x.bottom,main:m.getBoundingClientRect().bottom,bottom:b.bottom};});assert.equal(Math.round(r.w),viewport.width);assert.ok(r.h<=viewport.height&&r.scroll<=r.client+1&&r.close<=viewport.height&&r.main<=r.bottom+1);await panel.locator('.pv-content').evaluate(n=>n.scrollTop=n.scrollHeight);}
 await page.screenshot({path:`work/screenshots/manager-${engine}.png`});await panel.locator('[data-action="close"]').tap();assert.equal(await page.locator('#pensieve-panel:modal').count(),0);
 await page.waitForTimeout(1200);await page.reload();await page.waitForFunction(avatar=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle')&&SillyTavern.getContext().characters.some(c=>c.avatar===avatar),fixture.avatar);await page.evaluate(async f=>{const c=SillyTavern.getContext();await c.selectCharacterById(String(c.characters.findIndex(x=>x.avatar===f.avatar)));if(SillyTavern.getContext().chatId!==f.chatId)await SillyTavern.getContext().openCharacterChat(f.chatId);},fixture);
 assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.pensieve)),fixture.archive);assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().extensionSettings.pensieve.prompts)),fixture.prompts);assert.equal(requests.length,1,'navigation, ordering and reload must not request generation');assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}: icon-only touch actions, source order, search/filter, conditional selection toolbar, manual arc request order, no duplicate injection, mobile fullscreen/close, preserved archive and prompts after reload`);
 await context.close();
}finally{await browser.close();}
