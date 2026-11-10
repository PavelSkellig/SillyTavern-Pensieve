import {openWorkspace} from './ui-navigation.mjs';
/** Real ST 1.19.0 browser integration. Requires a disposable ST server and Playwright.
 * Usage: node tests/integration.mjs <path-to-playwright/index.mjs> [ST-url]
 * Creates synthetic QA characters/chats. Never point this at a personal ST instance.
 * The model HTTP response is mocked; ST frontend, saves, tokenizers and prompt builder are real.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const url=process.argv[3]??'http://127.0.0.1:18272';
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[],requests=[];let failModel=false;
await fs.mkdir('work/screenshots',{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/backends/chat-completions/generate',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   if(failModel){await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic model failure'}})});return;}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{role:'assistant',content:`Проверенное воспоминание ${requests.length} {{char}}`},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})});
 });
 await page.goto(url);await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-home'));
 await page.waitForTimeout(1500);
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').click();}
 const qaAvatar=await page.evaluate(async()=>{
   const c=SillyTavern.getContext(),core=await import('/script.js');
   const response=await fetch('/api/characters/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({ch_name:`Pensieve QA ${Date.now()}`,description:'Synthetic integration fixture',first_mes:'Начало тестовой истории',scenario:'A test library',personality:''})});
   if(!response.ok)throw Error('Character creation failed');const avatar=await response.text();await c.getCharacters();
   const current=SillyTavern.getContext(),id=current.characters.findIndex(x=>x.avatar===avatar);await current.selectCharacterById(String(id));
   const state=SillyTavern.getContext();state.chat.splice(0,state.chat.length,...Array.from({length:200},(_,i)=>{const mes=i===0?'Служебный пролог без макросов':`Тестовое событие ${i+1}. Сюжетная дата: 3 мая 1899 года. {{char}}`;return {name:i%2?'Игрок':'Библиотекарь',is_user:!!(i%2),is_system:i===0,mes,send_date:`2026-real-${i}`,extra:{},...(! (i%2)?{swipe_id:0,swipes:[mes]}:{})};}));
   await core.redisplayChat({startIndex:0,fade:false});state.swipe.refresh();await state.saveChat();
   core.changeMainAPI('openai');const live=SillyTavern.getContext();
   Object.assign(live.chatCompletionSettings,{chat_completion_source:'custom',custom_url:'http://127.0.0.1:1/v1',custom_model:'qa-test',openai_max_context:32000,openai_max_tokens:2000,stream_openai:false});core.setOnlineStatus('Valid');
   const root='/scripts/extensions/third-party/SillyTavern-Pensieve';
   const {Engine}=await import(`${root}/src/engine.js`),{createHost}=await import(`${root}/src/host.js`),chats=await import('/scripts/chats.js');
   window.qaEngine=new Engine(createHost(()=>SillyTavern.getContext(),core,chats));window.qaChat=live.chatId;
   Object.assign(live.extensionSettings.pensieve,{enabled:true,inject:true,exclude:true,previewEpisodes:true,tokenLimit:6000,collapse:false,theme:'dark'});
   live.extensionSettings.pensieve.prompts.summary.presets[0].text='Промпт сводки: {{char}}. Сохрани события.';
   live.extensionSettings.pensieve.prompts.arc.presets[0].text='Промпт арки: {{user}}. Объедини выбранное.';
   for(const type of ['summary','arc'])live.extensionSettings.pensieve.prompts[type].selected=live.extensionSettings.pensieve.prompts[type].presets[0].id;
   await live.eventSource.emit(live.eventTypes.CHAT_CHANGED,live.chatId);return avatar;
 });
 await openWorkspace(page,'home');await page.waitForSelector('#pensieve-panel[open]');
 const panel=page.locator('#pensieve-panel');
 await panel.locator('[name="rangeStart"]').fill('1');await panel.locator('[name="rangeEnd"]').fill('50');
 await panel.getByRole('button',{name:'Создать эпизод',exact:true}).last().click();
 const preview=page.locator('.pv-editor[open]').last();await preview.getByLabel('Текст воспоминания').waitFor();
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().chat[1].is_system),false);
 await preview.getByLabel('Название воспоминания').fill('Разговор в библиотеке');await preview.getByLabel('Текст воспоминания').fill('ALPHA — 3 мая 1899 года. Проверено вручную.');
 await preview.getByRole('button',{name:'Сохранить',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.pv-editor[open]'),{},{timeout:15000}).catch(async error=>{console.log('SAVE DIAGNOSTIC',await preview.innerText(),errors);await page.screenshot({path:'work/screenshots/failure.png'});throw error;});
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().chat.length),200);
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().chat[49].is_system),true);
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().chat[50].is_system),false);
 assert.equal(requests[0].messages[0].content,'Промпт сводки: {{char}}. Сохрани события.');
 assert.ok(requests[0].messages[1].content.includes('Сюжетная дата: 3 мая 1899 года. {{char}}'));assert.ok(!requests[0].messages[1].content.includes('2026-real-'));
 console.log('PASS actual ST: range → raw request → edited preview → verified archive → native hide');
 await page.evaluate(async()=>{const d=await qaEngine.generateSummary(50,99);await qaEngine.saveDraft(d,{title:'Возвращение',text:'BETA — новые события'});const entries=qaEngine.archive().entries;window.qaSummaryIds=entries.map(e=>e.id);const arc=await qaEngine.generateArc(window.qaSummaryIds);await qaEngine.saveDraft(arc,{title:'Арка библиотеки',text:'ARC — единая история'});});
 assert.equal(await page.evaluate(()=>qaEngine.archive().entries.length),3);
 assert.ok(requests[2].messages[1].content.includes('ALPHA'));assert.ok(requests[2].messages[1].content.includes('BETA'));assert.ok(!requests[2].messages[1].content.includes('Тестовое событие'));
 await panel.locator('[data-tab="memory"]').click();await panel.getByText('ARC — единая история',{exact:false}).first().waitFor({state:'attached'});
 await page.evaluate(async()=>{
    const core=await import('/script.js'),c=SillyTavern.getContext();
    c.setExtensionPrompt('qa_world_info','WORLD_INFO_CONTROL',1,1,false,0);
    c.setExtensionPrompt('1_memory','SUMMARIZE_CONTROL',0,0,false,0);
    await core.Generate('normal');
 });
 const normal=requests.at(-1).messages.map(m=>m.content).join('\n');
 assert.ok(normal.includes('ARC — единая история'));assert.ok(!normal.includes('ALPHA'));assert.ok(!normal.includes('BETA'));assert.ok(!normal.includes('Тестовое событие 2.'));assert.ok(normal.includes('Тестовое событие 200.'));
 assert.ok(normal.includes('WORLD_INFO_CONTROL'));assert.ok(normal.includes('SUMMARIZE_CONTROL'));
 console.log('PASS actual ST: arc + normal character generation + no source duplicates + separate WI/Summarize injections');
 await panel.locator('[data-tab="archive"]').click();await page.screenshot({path:'work/screenshots/archive-desktop.png'});
 await page.evaluate(async()=>{const c=SillyTavern.getContext();c.extensionSettings.pensieve.tokenLimit=1;await qaEngine.refreshMemory();});
 const before=requests.length;await page.evaluate(async()=>{const core=await import('/script.js');await core.Generate('normal');});assert.equal(requests.length,before);
 await page.evaluate(async()=>{SillyTavern.getContext().extensionSettings.pensieve.tokenLimit=6000;await qaEngine.refreshMemory();await SillyTavern.getContext().saveSettingsDebounced();});
 console.log('PASS actual ST: token overflow blocks normal generation without silently truncating');
 await panel.locator('[data-tab="prompts"]').click();
 const chooser=page.waitForEvent('filechooser');await panel.getByRole('button',{name:'Импорт из .txt'}).click();await (await chooser).setFiles({name:'prompt.txt',mimeType:'text/plain',buffer:Buffer.from('Импортированный промпт {{user}}')});
 await page.waitForTimeout(200);assert.equal(await panel.getByLabel('Промпт эпизода',{exact:true}).inputValue(),'Импортированный промпт {{user}}');await panel.getByRole('button',{name:'Сохранить промпт',exact:true}).click();
 await page.waitForTimeout(1200);await page.reload();await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-home'));
 await page.evaluate(async avatar=>{const c=SillyTavern.getContext();const id=c.characters.findIndex(x=>x.avatar===avatar);await c.selectCharacterById(String(id));},qaAvatar);
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().chatMetadata.pensieve.entries.length),3);
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().extensionSettings.pensieve.prompts.summary.presets[0].text),'Импортированный промпт {{user}}');
 await openWorkspace(page,'archive');
 for(const [width,height,theme]of [[390,844,'dark'],[390,844,'light'],[1280,900,'light']]){
    await page.setViewportSize({width,height});await panel.locator('[data-tab="settings"]').click();await panel.getByLabel('Тема панели').selectOption(theme);await panel.locator('[data-tab="home"]').click();
    const bounds=await panel.evaluate(n=>({width:n.getBoundingClientRect().width,scroll:n.scrollWidth,client:n.clientWidth}));assert.ok(bounds.width<=width);assert.ok(bounds.scroll<=bounds.client+1);
    await page.screenshot({path:`work/screenshots/home-${width}-${theme}.png`});
 }
 console.log('PASS actual ST: prompt file import, reload persistence, desktop/mobile dark/light layout');
 await panel.locator('[data-action="close"]').click();
 const sourceAction=page.locator('#chat .mes[mesid="180"] [data-pensieve-edge="start"]');assert.equal(await sourceAction.count(),1);await sourceAction.evaluate(n=>n.click());
 assert.equal(await panel.evaluate(n=>n.open),false);
 await page.locator('#chat .mes[mesid="190"] [data-pensieve-edge="end"]').evaluate(n=>n.click());assert.equal(await panel.evaluate(n=>n.open),false);
 await openWorkspace(page,'home');assert.equal(await panel.locator('[name="rangeStart"]').inputValue(),'181');assert.equal(await panel.locator('[name="rangeEnd"]').inputValue(),'191');
 console.log('PASS actual ST: message menu selects both inclusive boundaries');
 const root='/scripts/extensions/third-party/SillyTavern-Pensieve';
 await page.evaluate(async root=>{
   const c=SillyTavern.getContext(),core=await import('/script.js');const original=c.chatId,branch=`Pensieve QA branch ${Date.now()}`;
   await core.saveChat({chatName:branch});await c.openCharacterChat(branch);
   const {Engine}=await import(`${root}/src/engine.js`),{createHost}=await import(`${root}/src/host.js`),chats=await import('/scripts/chats.js');
   const e=new Engine(createHost(()=>SillyTavern.getContext(),core,chats));const first=e.archive().entries[0];await e.edit(first.id,{title:'Only branch title',text:first.text});
   await SillyTavern.getContext().openCharacterChat(original);
   if(SillyTavern.getContext().chatMetadata.pensieve.entries[0].title==='Only branch title')throw Error('Branch memory leaked');
   await SillyTavern.getContext().openCharacterChat(`Pensieve QA empty ${Date.now()}`);
   if(SillyTavern.getContext().chatMetadata.pensieve)throw Error('Archive leaked into another chat');
   await e.refreshMemory();if(SillyTavern.getContext().extensionPrompts.pensieve_active_memory_v1.value)throw Error('Prompt leaked');
   await SillyTavern.getContext().openCharacterChat(original);
 },root);
 console.log('PASS actual ST: independent chats and copied branch archives');
 const restored=await page.evaluate(async root=>{
   const core=await import('/script.js'),{Engine}=await import(`${root}/src/engine.js`),{createHost}=await import(`${root}/src/host.js`),chats=await import('/scripts/chats.js');
   const e=new Engine(createHost(()=>SillyTavern.getContext(),core,chats));let issues=0;for(const x of [...e.archive().entries])if(x.type==='summary'){const r=await e.restore(x.id);issues+=r.issues.length;}return {issues,preHidden:SillyTavern.getContext().chat[0].is_system,restored:SillyTavern.getContext().chat[1].is_system};
 },root);
 assert.equal(restored.issues,0);assert.equal(restored.preHidden,true);assert.equal(restored.restored,false);
 const groupId=await page.evaluate(async({root,avatar})=>{
   const c=SillyTavern.getContext(),core=await import('/script.js'),groups=await import('/scripts/group-chats.js');
   const response=await fetch('/api/groups/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({name:`Pensieve QA group ${Date.now()}`,members:[avatar]})});
   if(!response.ok)throw Error('Group creation failed');const group=await response.json();c.groups.push(group);await groups.openGroupById(group.id);
   const state=SillyTavern.getContext();state.chat.splice(0,state.chat.length,...Array.from({length:6},(_,i)=>({name:'Group member',is_user:false,is_system:false,mes:`Group scene ${i}`,swipes:[`Group scene ${i}`],swipe_id:0,extra:{}})));
   await core.redisplayChat({startIndex:0,fade:false});await state.saveChat();
   const {Engine}=await import(`${root}/src/engine.js`),{createHost}=await import(`${root}/src/host.js`),chats=await import('/scripts/chats.js');const e=new Engine(createHost(()=>SillyTavern.getContext(),core,chats));
   if(e.archive().entries.length)throw Error('Group inherited character archive');
   const d=await e.generateSummary(1,3);const entry=await e.saveDraft(d,{title:'Group memory',text:'GROUP MEMORY'});const disk=await e.host.read();
   if(disk.metadata.pensieve.entries.length!==1||!disk.messages[1].is_system)throw Error('Group persistence failed');await e.restore(entry.id);if(state.chat[1].is_system)throw Error('Group restoration failed');window.qaEngine=e;return group.id;
 },{root,avatar:qaAvatar});
 console.log('PASS actual ST: group archive, native hide, readback and restoration');
 failModel=true;
 const modelFailure=await page.evaluate(async()=>{const before=JSON.stringify(SillyTavern.getContext().chat),count=qaEngine.archive().entries.length;try{await qaEngine.generateSummary(4,5);return false;}catch{return before===JSON.stringify(SillyTavern.getContext().chat)&&count===qaEngine.archive().entries.length;}});
 failModel=false;assert.equal(modelFailure,true);
 await page.evaluate(async()=>{
   const e=qaEngine,native=e.host.hide;let interrupted=false;e.host.hide=async(...args)=>{await native(...args);if(!interrupted){interrupted=true;throw Error('Synthetic browser interruption');}};
   const d=await e.generateSummary(1,3,{allowOverlap:true});try{await e.saveDraft(d,{title:'Interrupted memory',text:'RECOVERY'});}catch{}
   if(e.archive().pending?.type!=='hide')throw Error('No durable recovery journal');
 });
 await page.reload();await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-home'));await page.waitForTimeout(1000);
 await page.evaluate(async({root,groupId})=>{
   const groups=await import('/scripts/group-chats.js');await groups.openGroupById(groupId);
   const core=await import('/script.js'),{Engine}=await import(`${root}/src/engine.js`),{createHost}=await import(`${root}/src/host.js`),chats=await import('/scripts/chats.js');const e=new Engine(createHost(()=>SillyTavern.getContext(),core,chats));
   if(!e.archive().pending)throw Error('Journal did not survive reload');await e.recover('restore');if(SillyTavern.getContext().chat[1].is_system)throw Error('Recovery did not restore source');
   const {exportArchive,parseArchive}=await import(`${root}/src/core.js`),backup=JSON.stringify(exportArchive(e.archive())),count=e.archive().entries.length,visible=JSON.stringify(SillyTavern.getContext().chat.map(m=>m.is_system));
   await e.importArchive(parseArchive(backup),'merge');if(e.archive().entries.length!==count*2)throw Error('JSON merge failed');if(visible!==JSON.stringify(SillyTavern.getContext().chat.map(m=>m.is_system)))throw Error('Import changed exclusions');
 },{root,groupId});
 console.log('PASS actual ST: model failure, interrupted save across reload, recovery, JSON merge without hiding');
 assert.deepEqual(errors,[]);console.log('PASS actual ST: original hide ownership restored; no page errors');
}finally{await browser.close();}
