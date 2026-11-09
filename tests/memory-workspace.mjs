/** Disposable ST only. node tests/memory-workspace.mjs <playwright/index.mjs> [chromium|webkit] [URL] */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const pw=await import(pathToFileURL(path.resolve(process.argv[2])).href),engine=process.argv[3]??'chromium';
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
await fs.mkdir('work/screenshots',{recursive:true});
try{
 const context=await browser.newContext(pw.devices['iPhone 13']),page=await context.newPage(),errors=[];let calls=0;
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/backends/**/generate',async route=>{calls++;await route.abort();});
 if(engine==='webkit')await page.route('**/api/settings/get',async route=>{const response=await route.fetch(),data=await response.json(),s=JSON.parse(data.settings);s.extension_settings.disabledExtensions=[...new Set([...(s.extension_settings.disabledExtensions??[]),'tts'])];data.settings=JSON.stringify(s);await route.fulfill({response,json:data});});
 await page.goto(process.argv[4]??'http://127.0.0.1:18273');await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));await page.waitForTimeout(800);
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').tap();}
 const panel=page.locator('#pensieve-panel');
 // A fresh ST screen has no selected chat; settings/prompts must not require an archive.
 const noChat=await page.evaluate(()=>!SillyTavern.getContext().chatId);assert.equal(noChat,true,'disposable initial screen must have no chat');
 await page.locator('#pensieve-menu-open').waitFor({state:'attached'});assert.equal(await page.locator('#pensieve-menu-open').count(),1);await page.locator('#pensieve-menu-open').evaluate(n=>n.click());assert.equal(await panel.locator('[data-tab="memory"]').getAttribute('aria-current'),'page');await panel.locator('[data-action="close"]').tap();
 await page.locator('#pensieve-settings-prompts').evaluate(n=>n.click());
 assert.equal(await panel.getByLabel('Промпт сводки',{exact:true}).count(),1,'global prompts must be accessible without a chat');
 await panel.getByRole('button',{name:'Новый пресет',exact:true}).tap();const ask=page.locator('.pv-editor[open]').last();await ask.getByLabel('Название нового пресета').fill('Workspace QA');await ask.getByRole('button',{name:'Сохранить',exact:true}).tap();
 await panel.getByLabel('Промпт сводки',{exact:true}).fill('Workspace literal {{char}}');await panel.getByRole('button',{name:'Сохранить промпт',exact:true}).tap();
 await panel.locator('[data-tab="settings"]').tap();await panel.getByLabel('Внедрять активную память',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'Экспорт архива JSON',exact:true}).count(),0);assert.equal(await panel.getByRole('button',{name:'Экспорт промптов JSON',exact:true}).count(),1);
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().chatMetadata.pensieve??null),null,'global UI must not create a chat archive');
 await panel.locator('[data-action="close"]').tap();
 const fixture=await page.evaluate(async()=>{
  const c=SillyTavern.getContext(),core=await import('/script.js'),root='/scripts/extensions/third-party/SillyTavern-Pensieve';
  const r=await fetch('/api/characters/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({ch_name:'Workspace QA '+Date.now(),first_mes:'Test greeting'})});if(!r.ok)throw Error('Fixture creation failed');const avatar=await r.text();await c.getCharacters();const live=SillyTavern.getContext();await live.selectCharacterById(String(live.characters.findIndex(x=>x.avatar===avatar)));
  const state=SillyTavern.getContext();state.chat.splice(0,state.chat.length,...Array.from({length:8},(_,i)=>({name:'Test',mes:'Событие '+(i+1),is_user:!!(i%2),is_system:false,extra:{pensieve:{id:'workspace-message-'+i}},...(!(i%2)?{swipe_id:0,swipes:['Событие '+(i+1)]}:{})})));
  core.changeMainAPI('openai');Object.assign(state.chatCompletionSettings,{openai_max_context:32000,openai_max_tokens:2000,stream_openai:false});
  const {emptyArchive,captureRange,sourceRecord}=await import(root+'/src/core.js'),archive=emptyArchive('workspace');
  const make=(id,title,text,source,active)=>({id,type:'summary',title,text,order:source,active,createdAt:'2026-11-09T12:00:00.000Z',updatedAt:'2026-11-09T12:00:00.000Z',version:1,history:[],sources:captureRange(state.chat,source,source+1).map(sourceRecord),summaryIds:[],needsReview:false});
  archive.entries=[make('a','Сводка №1 — Первый разговор','ALPHA',0,false),make('b','Сводка №2 — Поиск ответов','BETA',2,false),make('c','Сводка №3 — Возвращение','GAMMA',4,true),make('d','Сводка №4 — В архиве','DELTA',6,false),{...make('arc','Арка №1 — От знакомства до решения','ARC_AB',0,true),type:'arc',sources:[],summaryIds:['a','b']}];
  state.chatMetadata.pensieve=archive;Object.assign(state.extensionSettings.pensieve,{enabled:true,inject:true,tokenLimit:6000,theme:'dark'});await core.redisplayChat({startIndex:0,fade:false});state.swipe.refresh();await state.saveChat();state.saveSettingsDebounced();await state.eventSource.emit(state.eventTypes.CHAT_CHANGED,state.chatId);
  return {avatar,chatId:state.chatId,archive:JSON.stringify(archive),prompts:JSON.stringify(state.extensionSettings.pensieve.prompts)};
 });
 await page.locator('#pensieve-settings-memory').evaluate(n=>n.click());await panel.locator('.pv-memory-overview').waitFor();
 assert.equal(await panel.locator('.pv-version').innerText(),'v1.3.0');
 const current=panel.locator('[data-memory-section="current"]'),archived=panel.locator('[data-memory-section="archive"]'),card=id=>panel.locator('[data-entry-id="'+id+'"]');
 assert.equal(await current.getByRole('heading',{name:'Сейчас в памяти модели',exact:true}).count(),1);assert.equal(await archived.getByRole('heading',{name:'Только в архиве',exact:true}).count(),1);
 assert.equal(await current.locator('[data-entry-id]').count(),2);assert.equal(await archived.locator('[data-entry-id]').count(),3);assert.equal(await current.locator('.pv-memory-active').count(),2);assert.equal(await card('a').getByRole('button',{name:'Добавить в память',exact:true}).isDisabled(),true);
 assert.equal(await current.locator('.pv-record-mark').count(),2);await panel.getByRole('button',{name:'Посмотреть память',exact:true}).tap();let dialog=page.locator('.pv-editor[open]').last();const actual=await page.evaluate(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value);assert.equal(await dialog.getByLabel('Итоговый блок памяти').inputValue(),actual);assert.ok(actual.includes('ARC_AB')&&actual.includes('GAMMA')&&!actual.includes('ALPHA'));await dialog.getByRole('button',{name:'Закрыть',exact:true}).tap();
 await page.evaluate(()=>{window.qaCopied='';navigator.clipboard.writeText=async text=>{window.qaCopied=text;};});await panel.getByRole('button',{name:'Скопировать память',exact:true}).tap();assert.equal(await page.evaluate(()=>qaCopied),actual);
 await panel.getByRole('button',{name:'Отключить всю память',exact:true}).tap();await page.waitForFunction(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value==='');await panel.getByRole('button',{name:'Включить память',exact:true}).waitFor();assert.equal(await current.locator('[data-entry-id]').count(),0);assert.equal(await panel.locator('.pv-memory-active').count(),0);
 assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.pensieve)),fixture.archive,'global switch must preserve every record flag/text/link');
 assert.equal(await panel.locator('.pv-memory-meter > span').evaluate(n=>n.style.width),'0%');
 await panel.getByRole('button',{name:'Включить память',exact:true}).tap();await current.locator('[data-entry-id="arc"]').waitFor();assert.equal(await page.evaluate(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value),actual);
 await panel.getByRole('button',{name:'Обновить',exact:true}).tap();await current.locator('[data-entry-id="c"]').waitFor();
 await card('d').getByRole('button',{name:'Добавить в память',exact:true}).tap();await current.locator('[data-entry-id="d"]').waitFor();await card('d').getByRole('button',{name:'Убрать из памяти',exact:true}).tap();await archived.locator('[data-entry-id="d"]').waitFor();
 await panel.getByLabel('Лимит памяти, токенов').fill('1');await panel.getByLabel('Лимит памяти, токенов').dispatchEvent('change');await panel.getByText('Не помещается в лимит',{exact:true}).first().waitFor();assert.equal(await current.locator('[data-entry-id]').count(),0);assert.equal(await panel.locator('.pv-memory-active').count(),0);assert.equal(await panel.locator('.pv-memory-meter > span').evaluate(n=>n.style.width),'0%');
 await panel.getByLabel('Лимит памяти, токенов').fill('6000');await panel.getByLabel('Лимит памяти, токенов').dispatchEvent('change');await current.locator('[data-entry-id="arc"]').waitFor();
 for(const viewport of [{width:320,height:640},{width:390,height:420},{width:430,height:900},{width:1280,height:900}]){await page.setViewportSize(viewport);const sizes=await panel.evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,bottom:n.getBoundingClientRect().bottom,main:n.querySelector('.pv-content').getBoundingClientRect().bottom,close:n.querySelector('[data-action="close"]').getBoundingClientRect().bottom}));assert.ok(sizes.scroll<=sizes.client+1&&sizes.main<=sizes.bottom+1&&sizes.close<=viewport.height);await panel.locator('.pv-content').evaluate(n=>n.scrollTop=n.scrollHeight);}
 await page.setViewportSize({width:390,height:844});await panel.locator('.pv-content').evaluate(n=>n.scrollTop=0);await page.screenshot({path:'work/screenshots/workspace-mobile-'+engine+'.png'});await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'work/screenshots/workspace-desktop-'+engine+'.png'});
 const savedArchive=await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.pensieve));await panel.getByRole('button',{name:'Отключить всю память',exact:true}).tap();await panel.getByRole('button',{name:'Включить память',exact:true}).waitFor();await page.waitForTimeout(1300);await page.reload();
 await page.waitForFunction(avatar=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle')&&SillyTavern.getContext().characters.some(c=>c.avatar===avatar),fixture.avatar);await page.evaluate(async f=>{const c=SillyTavern.getContext();await c.selectCharacterById(String(c.characters.findIndex(x=>x.avatar===f.avatar)));if(SillyTavern.getContext().chatId!==f.chatId)await SillyTavern.getContext().openCharacterChat(f.chatId);},fixture);
 assert.equal(await panel.evaluate(n=>n.open),false);await page.locator('#pensieve-settings-memory').evaluate(n=>n.click());await panel.getByRole('button',{name:'Включить память',exact:true}).waitFor();assert.equal(await current.locator('[data-entry-id]').count(),0);assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.pensieve)),savedArchive);
 await panel.getByRole('button',{name:'Включить память',exact:true}).tap();await current.locator('[data-entry-id="arc"]').waitFor();assert.equal(await page.evaluate(()=>SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value),actual);
 assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().extensionSettings.pensieve.prompts)),fixture.prompts);await panel.locator('[data-action="close"]').tap();assert.equal(await page.locator('#pensieve-panel:modal').count(),0);assert.equal(calls,0);assert.deepEqual(errors,[]);
 console.log('PASS '+engine+': global prompts/settings without chat, exact memory view/copy, reversible global disable preserving archive, actual statuses and limits, arc deduplication, mobile cards/navigation/close, no model calls or page errors');
 await context.close();
}finally{await browser.close();}
