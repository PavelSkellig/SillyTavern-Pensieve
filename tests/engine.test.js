import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../src/engine.js';
import {KEY, defaults, clone, memoryEntries, fingerprint} from '../src/core.js';

function fixture() {
 let serial=0,disk=null,saves=0,failSaveAt=0,readFails=false,generateError=false,request=null,onGenerate=null;
 const c={chatId:'one',groupId:null,characterId:0,characters:[{avatar:'test.png'}],chatMetadata:{},extensionSettings:{[KEY]:defaults()},
 chat:Array.from({length:8},(_,i)=>({name:i%2?'Игрок':'Герой',mes:`Исходник ${i}`,is_user:!!(i%2),is_system:i===0,extra:{}}))};
 c.extensionSettings[KEY].prompts.summary.presets[0].text='Перескажи {{char}} дословно по правилам';
 c.extensionSettings[KEY].prompts.arc.presets[0].text='Объедини выбранное';
 const host={context:()=>c,uuid:()=>`id-${serial++}`,configuration:()=>c.chatId,count:async t=>Math.ceil(t.length/3),limits:()=>({context:32000,output:2000}),
 async generate(prompt,source){request={prompt,source}; if(onGenerate)await onGenerate();if(generateError)throw Error('Модель недоступна');return 'Результат'},
 async save(){saves++;if(saves===failSaveAt)return;disk=clone({metadata:c.chatMetadata,messages:c.chat});},
 async read(){if(readFails)throw Error('Проверка не удалась');return clone(disk??{metadata:{},messages:[]});},
 async hide(start,end,unhide){for(let i=start;i<=end;i++)c.chat[i].is_system=!unhide; await host.save();},
 lock(){return ()=>{}},refresh(){},notify(){},inject(text){host.injected=text}};
 const e=new module.Engine(host);
 return {c,host,e,get disk(){return disk},get saves(){return saves},get request(){return request},set failSaveAt(x){failSaveAt=x},set readFails(x){readFails=x},set generateError(x){generateError=x},set onGenerate(x){onGenerate=x}};
}
const saved = async(f,a=1,b=2)=>{const d=await f.e.generateSummary(a,b);return f.e.saveDraft(d,{title:'Сводка',text:d.text});};

test('preview/cancel never persists or hides source messages',async()=>{
 const f=fixture(),d=await f.e.generateSummary(1,3); assert.equal(d.text,'Результат');assert.equal(f.saves,0);assert.equal(f.c.chat[1].is_system,false);assert.equal(f.c.chat.length,8);
 assert.equal(f.request.prompt,'Перескажи {{char}} дословно по правилам');assert.ok(f.request.source.indexOf('Исходник 1')<f.request.source.indexOf('Исходник 3'));
});
test('confirmed summary is verified on disk before hiding and survives reload',async()=>{
 const f=fixture(); const entry=await saved(f);
 assert.ok(f.disk.metadata[KEY].entries.some(e=>e.id===entry.id));assert.equal(f.disk.messages[1].is_system,true);
 assert.equal(f.c.chat.length,8);assert.equal(f.c.chat[1].mes,'Исходник 1');assert.equal(f.disk.metadata[KEY].pending,null);
 f.c.chatMetadata=clone(f.disk.metadata);f.c.chat=clone(f.disk.messages);
 assert.equal(f.e.archive().entries[0].text,'Результат');
});
test('silent ST save failure is detected before messages are hidden',async()=>{
 const f=fixture();f.failSaveAt=1;await assert.rejects(()=>saved(f),/сохран|сервер/i);assert.equal(f.c.chat[1].is_system,false);
});
test('readback failure never hides sources',async()=>{
 const f=fixture();f.readFails=true;await assert.rejects(()=>saved(f));assert.equal(f.c.chat[1].is_system,false);
});
test('pre-hidden messages remain hidden after restore; ordinary messages return',async()=>{
 const f=fixture(),entry=await saved(f,0,2);await f.e.restore(entry.id);
 assert.equal(f.c.chat[0].is_system,true);assert.equal(f.c.chat[1].is_system,false);assert.equal(f.c.chat[2].is_system,false);
});
test('overlap requires explicit permission and shared ownership is reference counted',async()=>{
 const f=fixture(),a=await saved(f,1,3);
 await assert.rejects(()=>f.e.generateSummary(2,4),/пересек|обработ/i);
 const d=await f.e.generateSummary(2,4,{allowOverlap:true});const b=await f.e.saveDraft(d,{title:'Версия',text:d.text});
 await f.e.restore(a.id);assert.equal(f.c.chat[1].is_system,false);assert.equal(f.c.chat[2].is_system,true);
 await f.e.restore(b.id);assert.equal(f.c.chat[2].is_system,false);
});
test('editing a source or choosing another swipe after preview rejects commit',async()=>{
 const f=fixture(),d=await f.e.generateSummary(1,2);f.c.chat[1].mes='Другой ответ';await assert.rejects(()=>f.e.saveDraft(d,{title:'S',text:d.text}),/измен/i);assert.equal(f.saves,0);
});
test('switching chat during generation discards result and cannot mix memories',async()=>{
 const f=fixture();f.onGenerate=()=>{f.c.chatId='two';f.c.chatMetadata={};f.c.chat=clone(f.c.chat)};
 await assert.rejects(()=>f.e.generateSummary(1,2),/чат/i);assert.equal(f.saves,0);
});
test('model error and empty result leave history untouched',async()=>{
 const f=fixture();f.generateError=true;await assert.rejects(()=>f.e.generateSummary(1,2));assert.equal(f.saves,0);
 f.generateError=false;f.host.generate=async()=>'';await assert.rejects(()=>f.e.generateSummary(1,2),/пуст/i);
});
test('source mutations after saved summary are reported and never blindly restored',async()=>{
 const f=fixture(),entry=await saved(f);f.c.chat[1].mes='Изменён';const result=await f.e.restore(entry.id);
 assert.equal(result.issues.length,1);assert.equal(f.c.chat[1].is_system,true);assert.equal(f.c.chat[2].is_system,false);
});
test('arc request includes only selected summaries in user order and replaces active sources',async()=>{
 const f=fixture(),a=await saved(f,1,2),b=await saved(f,3,4),c=await saved(f,5,6);
 await f.e.edit(a.id,{title:'Первый',text:'ALPHA'});await f.e.edit(b.id,{title:'Второй',text:'BETA'});
 const d=await f.e.generateArc([b.id,a.id]);assert.ok(f.request.source.indexOf('BETA')<f.request.source.indexOf('ALPHA'));assert.ok(!f.request.source.includes('Исходник'));assert.equal(f.request.prompt,'Объедини выбранное');
 const arc=await f.e.saveDraft(d,{title:'Арка',text:d.text});assert.equal(f.e.archive().entries.length,4);
 assert.deepEqual(memoryEntries(f.e.archive().entries).map(e=>e.id),[arc.id,c.id]);
 await f.e.deleteEntry(arc.id,true);assert.equal(f.e.archive().entries.find(e=>e.id===a.id).active,true);
});
test('pending journal after interrupted hide can complete without duplicate entry',async()=>{
 const f=fixture();const native=f.host.hide;let interrupted=true;
 f.host.hide=async(...args)=>{await native(...args);if(interrupted)throw Error('Закрытие страницы')};
 await assert.rejects(()=>saved(f));assert.equal(f.disk.metadata[KEY].pending.type,'hide');
 f.c.chatMetadata=clone(f.disk.metadata);f.c.chat=clone(f.disk.messages);interrupted=false;
 await f.e.recover('complete');assert.equal(f.e.archive().entries.length,1);assert.equal(f.e.archive().pending,null);assert.equal(f.c.chat[1].is_system,true);
});
test('pending hide can be rolled back to readable original prompt while keeping summary archive',async()=>{
 const f=fixture();f.host.hide=async()=>{throw Error('Стоп')};await assert.rejects(()=>saved(f));
 f.host.hide=async(a,b,u)=>{for(let i=a;i<=b;i++)f.c.chat[i].is_system=!u;await f.host.save()};
 await f.e.recover('restore');assert.equal(f.c.chat[1].is_system,false);assert.equal(f.e.archive().entries.length,1);
});
test('memory overflow and overlapping arcs block generation with full text available',async()=>{
 const f=fixture();await saved(f);f.c.extensionSettings[KEY].tokenLimit=1;
 const memory=await f.e.memory();assert.equal(memory.blocked,true);assert.ok(memory.text.includes('Результат'));
});
test('disabled extension clears prompt without deleting archive',async()=>{
 const f=fixture();await saved(f);f.c.extensionSettings[KEY].enabled=false;const m=await f.e.refreshMemory();
 assert.equal(f.host.injected,'');assert.equal(m.enabled,false);assert.equal(f.e.archive().entries.length,1);
});
test('generation input exceeding configured context is refused without truncation or model call',async()=>{
 const f=fixture();f.host.limits=()=>({context:20,output:10});await assert.rejects(()=>f.e.generateSummary(1,7),/контекст/i);assert.equal(f.request,null);
});
test('two simultaneous actions cannot race to save or generate',async()=>{
 const f=fixture();let release;f.onGenerate=()=>new Promise(r=>release=r);
 const first=f.e.generateSummary(1,2);await new Promise(r=>setTimeout(r,0));await assert.rejects(()=>f.e.generateSummary(3,4),/выполня/i);release();await first;
});
test('recovery verifies staged archive before its first hide, even if first save failed silently',async()=>{
 const f=fixture();f.failSaveAt=1;await assert.rejects(()=>saved(f));
 f.readFails=true;let hides=0;const native=f.host.hide;f.host.hide=async(...args)=>{hides++;return native(...args)};
 await assert.rejects(()=>f.e.recover('complete'));assert.equal(hides,0);assert.equal(f.c.chat[1].is_system,false);
});
test('source indices are resolved again after each awaited hide',async()=>{
 const f=fixture();let once=true;const native=f.host.hide;
 f.host.hide=async(...args)=>{await native(...args);if(once){once=false;f.c.chat.splice(0,1);}};
 await saved(f,1,2);
 assert.equal(f.c.chat.find(m=>m.mes==='Исходник 3').is_system,false);
 assert.equal(f.c.chat.find(m=>m.mes==='Исходник 2').is_system,true);
});
test('pending save blocks ordinary generation until recovery',async()=>{
 const f=fixture();f.failSaveAt=1;await assert.rejects(()=>saved(f));const m=await f.e.memory();assert.equal(m.blocked,true);
});
test('reordering selected sources after preview cannot save a summary with reversed chronology',async()=>{
 const f=fixture(),draft=await f.e.generateSummary(1,2);[f.c.chat[1],f.c.chat[2]]=[f.c.chat[2],f.c.chat[1]];
 await assert.rejects(()=>f.e.saveDraft(draft,{title:'S',text:draft.text}),/измен|поряд|диапазон/i);
});
test('cancelling during token counting never sends a model request',async()=>{
 const f=fixture();let release;f.host.count=()=>new Promise(r=>release=r);
 const request=f.e.generateSummary(1,2);await new Promise(r=>setTimeout(r,0));f.e.cancel();release(20);
 await assert.rejects(()=>request,/отмен/i);assert.equal(f.request,null);
});
test('an old refresh cannot overwrite a newer active-memory choice',async()=>{
 const f=fixture();await saved(f);let release;const count=f.host.count;let first=true;
 f.host.count=t=>{if(first){first=false;return new Promise(r=>release=r);}return count(t);};
 const old=f.e.refreshMemory();await new Promise(r=>setTimeout(r,0));
 f.e.archive().entries[0].active=false;await f.e.refreshMemory();release(20);await old;assert.equal(f.host.injected,'');
});
test('generation awaiting an obsolete refresh also waits for the latest injection',async()=>{
 const f=fixture();await saved(f);const releases=[];f.host.count=()=>new Promise(r=>releases.push(r));
 let oldFinished=false;const old=f.e.refreshMemory().then(()=>oldFinished=true);await new Promise(r=>setTimeout(r,0));
 f.e.archive().entries[0].text='LATEST';const latest=f.e.refreshMemory();await new Promise(r=>setTimeout(r,0));
 releases[0](20);await new Promise(r=>setTimeout(r,0));assert.equal(oldFinished,false);releases[1](20);await Promise.all([old,latest]);assert.ok(f.host.injected.includes('LATEST'));
});
test('unconfirmed arc persistence leaves a recoverable commit journal and blocks generation',async()=>{
 const f=fixture(),a=await saved(f,1,2),b=await saved(f,3,4),d=await f.e.generateArc([a.id,b.id]);
 f.failSaveAt=f.saves+1;await assert.rejects(()=>f.e.saveDraft(d,{title:'Arc',text:'ARC'}));
 assert.equal(f.e.archive().pending.type,'commit');assert.equal((await f.e.memory()).blocked,true);
 await f.e.recover('complete');assert.equal(f.e.archive().pending,null);assert.equal(f.e.archive().entries.length,3);
});
test('memory larger than actual model context is blocked even when user limit is higher',async()=>{
 const f=fixture();await saved(f);f.host.limits=()=>({context:500,output:400});f.c.extensionSettings[KEY].tokenLimit=100000;
 assert.equal((await f.e.memory()).blocked,true);
});
test('large archive export preserves complete text and does not truncate active memory',async()=>{
 const f=fixture();await saved(f);const entry=f.e.archive().entries[0];entry.text='Длинная история\n'.repeat(40000);const m=await f.e.memory();assert.ok(m.blocked);assert.ok(m.text.includes(entry.text));
});
test('long contiguous source restoration uses one native range save',async()=>{
 const f=fixture(),entry=await saved(f,1,6);let calls=0;const native=f.host.hide;f.host.hide=async(...args)=>{calls++;await native(...args);};await f.e.restore(entry.id);
 assert.equal(calls,1);assert.equal(f.c.chat[6].is_system,false);
});
test('actual memory order follows moved source messages instead of stale saved order',async()=>{
 const f=fixture(),late=await saved(f,3,4),early=await saved(f,1,2);
 await f.e.edit(late.id,{title:'Поздняя по старому порядку',text:'LATE_SOURCE'});await f.e.edit(early.id,{title:'Ранняя по старому порядку',text:'EARLY_SOURCE'});
 f.c.chat.push(...f.c.chat.splice(0,3));const m=await f.e.memory();assert.ok(m.text.indexOf('LATE_SOURCE')<m.text.indexOf('EARLY_SOURCE'));
});

async function chapters(f) {
 const ids=[];for(const [a,b]of [[0,1],[2,3],[4,5],[6,7]])ids.push((await saved(f,a,b)).id);
 const result=[];for(let i=0;i<2;i++){const d=await f.e.generateArc(ids.slice(i*2,i*2+2));result.push(await f.e.saveDraft(d,{title:'Глава '+i,text:i?'CHAPTER_B':'CHAPTER_A'}));}return result;
}
test('legacy prompt upgrade only adds a volume group once without touching existing presets or archive',()=>{
 const f=fixture();delete f.c.extensionSettings[KEY].prompts.volume;const old=JSON.stringify(f.c.extensionSettings[KEY].prompts),metadata=JSON.stringify(f.c.chatMetadata);let saves=0;f.c.saveSettingsDebounced=()=>saves++;
 const settings=f.e.settings();assert.ok(settings.prompts.volume.presets[0].text.includes('глав'));assert.equal(JSON.stringify({summary:settings.prompts.summary,arc:settings.prompts.arc}),old);assert.equal(JSON.stringify(f.c.chatMetadata),metadata);f.e.settings();assert.equal(saves,1);
 settings.prompts.volume.presets[0].text='';f.e.settings();assert.equal(settings.prompts.volume.presets[0].text,'');
});
test('volume preview uses its literal prompt and selected chapter order without persisting or hiding',async()=>{
 const f=fixture(),[a,b]=await chapters(f);f.e.settings().prompts.volume.presets[0].text='TOM {{char}} literal';const before=JSON.stringify(f.c.chatMetadata),messages=JSON.stringify(f.c.chat),saves=f.saves;
 const draft=await f.e.generateVolume([b.id,a.id]);assert.equal(draft.type,'volume');assert.deepEqual(draft.chapterIds,[b.id,a.id]);assert.equal(f.request.prompt,'TOM {{char}} literal');assert.equal(f.request.source,'Глава 1\nCHAPTER_B\n\nГлава 0\nCHAPTER_A');assert.equal(f.saves,saves);assert.equal(JSON.stringify(f.c.chatMetadata),before);assert.equal(JSON.stringify(f.c.chat),messages);
});
test('saved volume preserves all descendants, injects once with later episodes, and never resurrects children on disable',async()=>{
 const f=fixture(),pair=await chapters(f),draft=await f.e.generateVolume(pair.map(e=>e.id)),messages=JSON.stringify(f.c.chat);const v=await f.e.saveDraft(draft,{title:'Том №1',text:'VOLUME_ONLY'});
 assert.equal(f.e.archive().entries.length,7);assert.deepEqual(v.chapterIds,pair.map(e=>e.id));assert.equal(JSON.stringify(f.c.chat),messages);assert.ok(f.e.archive().entries.filter(e=>e.id!==v.id).every(e=>e.active===false));assert.ok(f.host.injected.includes('VOLUME_ONLY')&&!f.host.injected.includes('CHAPTER_A'));
 f.c.chat.push({name:'Игрок',mes:'Продолжение',extra:{},is_system:false});const later=await saved(f,8,8);await f.e.edit(later.id,{title:'Эпизод №5',text:'NEW_EPISODE'});assert.deepEqual((await f.e.memory()).entries.map(e=>e.id),[v.id,later.id]);
 await f.e.toggle(v.id,false);assert.deepEqual((await f.e.memory()).entries.map(e=>e.id),[later.id]);await f.e.toggle(pair[0].id,true);assert.ok((await f.e.memory()).entries.some(e=>e.id===pair[0].id));await f.e.toggle(v.id,true);await f.e.toggle(v.id,false);assert.equal(f.e.archive().entries.find(e=>e.id===pair[0].id).active,false);
});
test('volume source edits and chat switches reject stale or unrelated results',async()=>{
 const f=fixture(),pair=await chapters(f),draft=await f.e.generateVolume(pair.map(e=>e.id));await f.e.edit(pair[0].id,{title:pair[0].title,text:'CHANGED'});await assert.rejects(()=>f.e.saveDraft(draft,{title:'V',text:draft.text}),/измен/i);
 f.onGenerate=()=>{f.c.chatId='other';f.c.chatMetadata={};};await assert.rejects(()=>f.e.generateVolume(pair.map(e=>e.id)),/чат/i);
});
test('volume generation refuses empty/duplicate/wrong source levels and missing prompt without model calls',async()=>{
 const f=fixture(),pair=await chapters(f);for(const ids of [[],[pair[0].id],[pair[0].id,pair[0].id],[f.e.archive().entries[0].id,pair[0].id]])await assert.rejects(()=>f.e.generateVolume(ids));
 f.e.settings().prompts.volume.presets[0].text='';await assert.rejects(()=>f.e.generateVolume(pair.map(e=>e.id)),/промпт/i);
});
test('volume pending-save recovery reuses the durability journal and never hides messages',async()=>{
 const f=fixture(),pair=await chapters(f),draft=await f.e.generateVolume(pair.map(e=>e.id));f.failSaveAt=f.saves+1;const messages=JSON.stringify(f.c.chat);
 await assert.rejects(()=>f.e.saveDraft(draft,{title:'V',text:'VOLUME'}));assert.equal(f.e.archive().pending.type,'commit');assert.equal((await f.e.memory()).blocked,true);await f.e.recover('complete');assert.equal(f.e.archive().pending,null);assert.equal(f.e.archive().entries.length,7);assert.equal(JSON.stringify(f.c.chat),messages);
});
test('linked children cannot be deleted silently, while deleting a volume retains every child',async()=>{
 const f=fixture(),pair=await chapters(f),draft=await f.e.generateVolume(pair.map(e=>e.id)),v=await f.e.saveDraft(draft,{title:'V',text:'VOLUME'});
 await assert.rejects(()=>f.e.deleteEntry(pair[0].id),/связан|входит/i);const before=f.e.archive().entries.filter(e=>e.id!==v.id).map(e=>[e.id,e.text]);await f.e.deleteEntry(v.id);assert.deepEqual(f.e.archive().entries.map(e=>[e.id,e.text]),before);assert.ok(f.e.archive().entries.every(e=>!e.active));
});
