import {importPreset} from '../src/prompt-presets.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../src/engine.js';
import {KEY, defaults, clone, memoryEntries, fingerprint} from '../src/core.js';
import {createBackup} from '../src/backup.js';

function fixture() {
 let serial=0,disk=null,saves=0,failSaveAt=0,readFails=false,generateError=false,request=null,onGenerate=null;
 const c={chatId:'one',groupId:null,characterId:0,characters:[{avatar:'test.png'}],chatMetadata:{},extensionSettings:{[KEY]:defaults()},
 chat:Array.from({length:8},(_,i)=>({name:i%2?'Игрок':'Герой',mes:`Исходник ${i}`,is_user:!!(i%2),is_system:i===0,extra:{}}))};
 c.extensionSettings[KEY].prompts.summary.presets[0].text='Перескажи {{char}} дословно по правилам';
 c.extensionSettings[KEY].prompts.arc.presets[0].text='Объедини выбранное';
 const host={context:()=>c,uuid:()=>`id-${serial++}`,configuration:()=>c.chatId,count:async t=>Math.ceil(t.length/3),limits:()=>({context:32000,output:2000}),
 async generate(prompt,source){request={prompt,source}; if(onGenerate)await onGenerate();if(generateError)throw Error('Модель недоступна');return 'Результат'},
 async save(){saves++;if(saves===failSaveAt)return;disk=clone({metadata:c.chatMetadata,messages:c.chat});},
 async saveSettings(){c.saveSettingsDebounced?.();},
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
 const result=[];for(let i=0;i<2;i++){const d=await f.e.generateArc(ids.slice(i*2,i*2+2));result.push(await f.e.saveDraft(d,{title:'Часть '+i,text:i?'CHAPTER_B':'CHAPTER_A'}));}return result;
}
test('legacy prompt upgrade only adds a volume group once without touching existing presets or archive',()=>{
 const f=fixture();delete f.c.extensionSettings[KEY].prompts.volume;const old=JSON.stringify(f.c.extensionSettings[KEY].prompts),metadata=JSON.stringify(f.c.chatMetadata);let saves=0;f.c.saveSettingsDebounced=()=>saves++;
 const settings=f.e.settings();assert.ok(settings.prompts.volume.presets[0].text.includes('частей'));assert.equal(JSON.stringify({summary:settings.prompts.summary,arc:settings.prompts.arc}),old);assert.equal(JSON.stringify(f.c.chatMetadata),metadata);f.e.settings();assert.equal(saves,1);
 settings.prompts.volume.presets[0].text='';f.e.settings();assert.equal(settings.prompts.volume.presets[0].text,'');
});
test('volume preview uses its literal prompt and selected chapter order without persisting or hiding',async()=>{
 const f=fixture(),[a,b]=await chapters(f);f.e.settings().prompts.volume.presets[0].text='TOM {{char}} literal';const before=JSON.stringify(f.c.chatMetadata),messages=JSON.stringify(f.c.chat),saves=f.saves;
 const draft=await f.e.generateVolume([b.id,a.id]);assert.equal(draft.type,'volume');assert.deepEqual(draft.chapterIds,[b.id,a.id]);assert.equal(f.request.prompt,'TOM {{char}} literal');assert.equal(f.request.source,'Часть 1\nCHAPTER_B\n\nЧасть 0\nCHAPTER_A');assert.equal(f.saves,saves);assert.equal(JSON.stringify(f.c.chatMetadata),before);assert.equal(JSON.stringify(f.c.chat),messages);
});
test('saved volume preserves all descendants, injects once with later episodes, and never resurrects children on disable',async()=>{
 const f=fixture(),pair=await chapters(f),draft=await f.e.generateVolume(pair.map(e=>e.id)),messages=JSON.stringify(f.c.chat);const v=await f.e.saveDraft(draft,{title:'Том №1',text:'VOLUME_ONLY'});
 assert.equal(f.e.archive().entries.length,7);assert.deepEqual(v.chapterIds,pair.map(e=>e.id));assert.equal(JSON.stringify(f.c.chat),messages);assert.ok(f.e.archive().entries.filter(e=>e.id!==v.id).every(e=>e.active===false));assert.ok(f.host.injected.includes('VOLUME_ONLY')&&!f.host.injected.includes('CHAPTER_A'));
 f.c.chat.push({name:'Игрок',mes:'Продолжение',extra:{},is_system:false});const later=await saved(f,8,8);await f.e.edit(later.id,{title:'Глава №5',text:'NEW_EPISODE'});assert.deepEqual((await f.e.memory()).entries.map(e=>e.id),[v.id,later.id]);
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
test('deleting an active volume cannot resurrect a regenerated chapter with a latent active flag',async()=>{
 const f=fixture(),pair=await chapters(f),d=await f.e.generateVolume(pair.map(e=>e.id)),v=await f.e.saveDraft(d,{title:'Том №1',text:'VOLUME'});
 const regen=await f.e.generateArc(pair[0].summaryIds,{replaceId:pair[0].id});await f.e.saveDraft(regen,{title:'Часть №1',text:'UPDATED'});assert.deepEqual((await f.e.memory()).entries.map(e=>e.id),[v.id]);
 await f.e.deleteEntry(v.id);assert.deepEqual((await f.e.memory()).entries,[]);assert.equal(f.e.archive().entries.length,6);
});
test('deleting an inactive volume preserves chapters explicitly activated by the user',async()=>{
 const f=fixture(),pair=await chapters(f),d=await f.e.generateVolume(pair.map(e=>e.id)),v=await f.e.saveDraft(d,{title:'Том №1',text:'VOLUME'});await f.e.toggle(v.id,false);await f.e.toggle(pair[0].id,true);await f.e.deleteEntry(v.id);assert.deepEqual((await f.e.memory()).entries.map(e=>e.id),[pair[0].id]);
});
test('confirmed child deletion can unlink a source from a three-child parent without losing parent text or other children',async()=>{
 const f=fixture();f.c.chat.push(...Array.from({length:4},(_,i)=>({name:'Test',mes:'Added '+i,is_user:true,is_system:false,extra:{}})));const pair=await chapters(f),x=await saved(f,8,9),y=await saved(f,10,11),draft=await f.e.generateArc([x.id,y.id]),third=await f.e.saveDraft(draft,{title:'Часть №3',text:'THIRD'}),vd=await f.e.generateVolume([...pair.map(e=>e.id),third.id]),v=await f.e.saveDraft(vd,{title:'Том №1',text:'UNCHANGED VOLUME'});
 await f.e.deleteEntry(pair[0].id,false,{unlink:true});const parent=f.e.archive().entries.find(e=>e.id===v.id);assert.equal(parent.text,'UNCHANGED VOLUME');assert.equal(parent.needsReview,true);assert.deepEqual(parent.chapterIds,[pair[1].id,third.id]);assert.equal(f.e.archive().entries.filter(e=>e.type==='summary').length,6);
});
test('new automatic volume numbers do not reuse an existing visible number after deletion',async()=>{
 const f=fixture(),pair=await chapters(f),d=await f.e.generateVolume(pair.map(e=>e.id)),v=await f.e.saveDraft(d,{title:'Том №2 — Сохранённый',text:'VOLUME'});await f.e.toggle(v.id,false);
 const next=await f.e.generateVolume(pair.map(e=>e.id));assert.equal(next.title,'Том №3');
});

const fullCopy=f=>createBackup(f.e.archive(),f.e.settings(),{key:f.e.key(),name:f.c.chatId});
test('preview setting upgrades once, defaults on, and preserves an explicit false',()=>{
 const f=fixture();delete f.e.settings().previewEpisodes;let saves=0;f.c.saveSettingsDebounced=()=>saves++;assert.equal(f.e.settings().previewEpisodes,true);f.e.settings().previewEpisodes=false;assert.equal(f.e.settings().previewEpisodes,false);assert.equal(saves,1);
});
test('full restore into a foreign chat is default-inactive, idempotent and cannot regenerate or restore matching foreign source UUIDs',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f);f.c.chatId='new';f.c.chatMetadata={};for(const m of f.c.chat){m.is_system=false;delete m.extra?.[KEY]?.exclusion;}const chat=JSON.stringify(f.c.chat),settings=JSON.stringify(f.e.settings());
 const plan=await f.e.restoreBackup(copy,{mode:'merge'});assert.equal(plan.added,1);const entry=f.e.archive().entries[0];assert.equal(entry.active,false);assert.equal(entry.detachedSources,true);assert.equal(entry.backupActive,true);assert.equal(f.host.injected,'');assert.equal(JSON.stringify(f.c.chat),chat);assert.equal(JSON.stringify(f.e.settings()),settings);
 assert.equal((await f.e.restoreBackup(copy,{mode:'merge'})).added,0);assert.equal(f.e.archive().entries.length,1);await assert.rejects(()=>f.e.restore(entry.id),/друг|источ|копи/i);await assert.rejects(()=>f.e.generateSummary(1,2,{replaceId:entry.id,allowOverlap:true}),/друг|источ|копи/i);assert.equal(JSON.stringify(f.c.chat),chat);
});
test('explicit backup activation and optional globals restore only the saved effective roots',async()=>{
 const f=fixture(),pair=await chapters(f),d=await f.e.generateVolume(pair.map(e=>e.id));await f.e.saveDraft(d,{title:'V',text:'ONLY_VOLUME'});const copy=fullCopy(f);copy.settings.tokenLimit=12000;copy.prompts.volume.presets[0].text='RESTORED RULE';f.c.chatId='new';f.c.chatMetadata={};f.c.chat=[];let settingsSaved=0;f.c.saveSettingsDebounced=()=>settingsSaved++;
 await f.e.restoreBackup(copy,{mode:'replace',activate:true,restorePrompts:true,restoreSettings:true});assert.equal(f.e.settings().tokenLimit,12000);assert.equal(f.e.prompt('volume').text,'RESTORED RULE');assert.ok(f.host.injected.includes('ONLY_VOLUME'));assert.equal(f.e.archive().entries.filter(e=>e.active).length,1);assert.equal(settingsSaved,1);
});
test('invalid backup configuration and activation overflow never partially change archive or global presets',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f),before=JSON.stringify([f.c.chatMetadata,f.e.settings()]),saves=f.saves;copy.prompts.arc.presets[0].history=[42];await assert.rejects(()=>f.e.restoreBackup(copy,{mode:'replace'}));assert.equal(JSON.stringify([f.c.chatMetadata,f.e.settings()]),before);assert.equal(f.saves,saves);
 const valid=fullCopy(f);valid.settings.tokenLimit=1;await assert.rejects(()=>f.e.restoreBackup(valid,{mode:'merge',activate:true,restoreSettings:true}),/лимит|токен|контекст/i);assert.equal(JSON.stringify([f.c.chatMetadata,f.e.settings()]),before);assert.equal(f.saves,saves);
});
test('unconfirmed backup save rolls back previous local archive and leaves globals unchanged',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f);copy.archive.entries[0].text='BACKUP TEXT';copy.prompts.summary.presets[0].text='BACKUP RULE';const before=JSON.stringify([f.c.chatMetadata,f.e.settings()]);f.failSaveAt=f.saves+1;
 await assert.rejects(()=>f.e.restoreBackup(copy,{mode:'replace',restorePrompts:true}));assert.equal(JSON.stringify([f.c.chatMetadata,f.e.settings()]),before);assert.equal(f.disk.metadata[KEY].entries[0].text,'Результат');
});
test('chat switch during backup preflight cannot commit or roll back into the next chat',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f),native=f.host.count;let once=true;f.host.count=async text=>{if(once){once=false;f.c.chatId='different';f.c.chatMetadata={};}return native(text);};await assert.rejects(()=>f.e.restoreBackup(copy,{mode:'merge',activate:true}),/чат/i);assert.deepEqual(f.c.chatMetadata,{});
});
test('overlapping episode versions block memory instead of injecting the same event twice',async()=>{
 const f=fixture();await saved(f,1,3);const d=await f.e.generateSummary(2,4,{allowOverlap:true});await f.e.saveDraft(d,{title:'Version',text:'SECOND'});assert.equal((await f.e.memory()).blocked,true);assert.equal(f.host.injected,'');
});
test('normal generation cannot inject a backup while the final archive readback is still pending',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f);f.c.chatId='new';f.c.chatMetadata={};f.c.chat=[];const native=f.host.read;let reads=0,release,reached;const gate=new Promise(r=>release=r),waiting=new Promise(r=>reached=r);f.host.read=async()=>{if(++reads===2){reached();await gate;}return native();};
 const task=f.e.restoreBackup(copy,{activate:true});await waiting;const interim=await f.e.refreshMemory(),injected=f.host.injected;release();await task;assert.equal(interim.blocked,true);assert.equal(injected,'');assert.ok(f.host.injected.includes('Результат'));
});
test('interrupted complete-backup commit remains recoverable without touching foreign source messages',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f);f.c.chatId='new';f.c.chatMetadata={};f.c.chat=[];const save=f.host.save;let attempts=0;f.host.save=async()=>{if(++attempts>1)throw Error('Offline');return save();};
 await assert.rejects(()=>f.e.restoreBackup(copy,{activate:true}));assert.equal(f.disk.metadata[KEY].pending.type,'backup');f.c.chatMetadata=clone(f.disk.metadata);f.host.save=save;await f.e.recover('complete');assert.equal(f.e.archive().pending,null);assert.equal(f.e.archive().entries.length,1);assert.ok(f.host.injected.includes('Результат'));assert.deepEqual(f.c.chat,[]);
});
test('restored active memory cannot duplicate unhidden source messages already present in the target chat',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f);f.c.chatId='new';f.c.chatMetadata={};for(const m of f.c.chat){m.is_system=false;delete m.extra?.[KEY]?.exclusion;}const before=JSON.stringify(f.c.chat);
 await assert.rejects(()=>f.e.restoreBackup(copy,{activate:true}),/сообщен|исход/i);assert.deepEqual(f.c.chatMetadata,{});await f.e.restoreBackup(copy);await f.e.toggle(f.e.archive().entries[0].id,true);assert.equal((await f.e.memory()).blocked,true);assert.equal(f.host.injected,'');assert.equal(JSON.stringify(f.c.chat),before);
});

for(const exclude of [false,true])test(`retry after final readback failure reuses the same draft commit, Hide=${exclude}`,async()=>{
 const f=fixture();f.e.settings().exclude=exclude;const d=await f.e.generateSummary(1,2),native=f.host.read;let reads=0;const final=exclude?4:3;f.host.read=async()=>{if(++reads===final)throw Error('Final read failed');return native();};
 await assert.rejects(()=>f.e.saveDraft(d,{title:'One',text:d.text}));assert.equal(f.e.archive().pending,null);const id=f.e.archive().entries[0].id;f.host.read=native;const entry=await f.e.saveDraft(d,{title:'One',text:d.text});assert.equal(f.e.archive().entries.length,1);assert.equal(entry.id,id);assert.equal(entry.version,1);assert.equal(f.e.archive().entries.filter(e=>e.active).length,1);
});
test('full restore rejects malformed nested record versions before any write',async()=>{
 for(const invalid of [{version:-2},{version:'oops'},{updatedAt:{}},{updatedAt:''}]){const f=fixture(),entry=await saved(f);const file=fullCopy(f);await f.e.restore(entry.id);file.archive.entries[0].history=[{version:1,title:'Before',text:'Before',updatedAt:'2026',...invalid}];const before=JSON.stringify([f.c.chatMetadata,f.e.settings()]),saves=f.saves;await assert.rejects(()=>f.e.restoreBackup(file,{mode:'replace',restorePrompts:true}));assert.equal(f.saves,saves);assert.equal(JSON.stringify([f.c.chatMetadata,f.e.settings()]),before);}
});
test('same-chat activation cannot duplicate restored visible native sources',async()=>{
 const f=fixture(),entry=await saved(f),copy=fullCopy(f);await f.e.restore(entry.id);const before=JSON.stringify(f.c.chatMetadata),saves=f.saves;await assert.rejects(()=>f.e.restoreBackup(copy,{activate:true}),/исход|сообщен/i);assert.equal(f.saves,saves);assert.equal(JSON.stringify(f.c.chatMetadata),before);
});
test('a raw transcript without Pensieve UUIDs still blocks duplicate restored memory without binding',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f);f.c.chatId='new';f.c.chatMetadata={};for(const m of f.c.chat){m.is_system=false;m.extra={};}const before=JSON.stringify(f.c.chat);await assert.rejects(()=>f.e.restoreBackup(copy,{activate:true}),/исход|сообщен/i);assert.equal(JSON.stringify(f.c.chat),before);assert.deepEqual(f.c.chatMetadata,{});
});
test('unknown provenance v1.5 imports cannot regenerate or restore current message UUIDs',async()=>{
 const f=fixture(),entry=await saved(f);entry.imported=true;const before=JSON.stringify(f.c.chat),saves=f.saves;await assert.rejects(()=>f.e.generateSummary(1,2,{allowOverlap:true,replaceId:entry.id}),/исход|копи|чат/i);await assert.rejects(()=>f.e.restore(entry.id),/исход|копи|чат/i);assert.equal(f.saves,saves);assert.equal(JSON.stringify(f.c.chat),before);
});
test('inactive backup recovery never activates a foreign record that reuses an old active ID',async()=>{
 const f=fixture();const entry=await saved(f),file=fullCopy(f);file.source.key='foreign';file.archive.entries[0].origin={chat:'foreign',id:entry.id};file.archive.entries[0].sourceChat='foreign';await f.e.restore(entry.id);await f.e.toggle(entry.id,true);const save=f.host.save;let attempts=0;f.host.save=async()=>{if(++attempts>1)throw Error('Offline');return save();};await assert.rejects(()=>f.e.restoreBackup(file,{mode:'replace'}));f.c.chatMetadata=clone(f.disk.metadata);f.host.save=save;await f.e.recover('restore');assert.equal(f.e.archive().entries[0].active,false);assert.equal(f.host.injected,'');
});
test('selected global backup sections require durable confirmation and survive journal recovery',async()=>{
 const f=fixture();await saved(f);const file=fullCopy(f);file.prompts.summary.presets[0].text='RECOVERED RULE';const previous=JSON.stringify([f.c.chatMetadata,f.e.settings()]),save=f.host.save;let writes=0;f.host.save=async()=>{if(++writes>1)throw Error('Chat rollback offline');return save();};f.host.saveSettings=async()=>{throw Error('Settings not saved');};await assert.rejects(()=>f.e.restoreBackup(file,{restorePrompts:true}));assert.equal(JSON.stringify([f.c.chatMetadata,f.e.settings()]),previous);assert.equal(f.disk.metadata[KEY].pending.globals.prompts.summary.presets.find(p=>p.id===f.disk.metadata[KEY].pending.globals.prompts.summary.selected).text,'RECOVERED RULE');f.c.chatMetadata=clone(f.disk.metadata);f.host.save=save;let confirmed;f.host.saveSettings=async patch=>{confirmed=clone(patch);};await f.e.recover('complete');assert.equal(confirmed.prompts.summary.presets.find(p=>p.id===confirmed.prompts.summary.selected).text,'RECOVERED RULE');assert.equal(f.e.prompt('summary').text,'RECOVERED RULE');assert.equal(f.e.archive().pending,null);
});

test('late chat switch during global restore preserves newer user settings and never rolls back another chat',async()=>{
 const f=fixture();await saved(f);const file=fullCopy(f);file.prompts.summary.presets[0].text='BACKUP RULE';f.host.saveSettings=async()=>{f.c.chatId='different';f.c.chatMetadata={};f.e.prompt('summary').text='NEW USER EDIT';f.e.settings().theme='light';};await assert.rejects(()=>f.e.restoreBackup(file,{restorePrompts:true}),/чат/i);assert.deepEqual(f.c.chatMetadata,{});assert.equal(f.e.prompt('summary').text,'NEW USER EDIT');assert.equal(f.e.settings().theme,'light');
});


test('native reveal stays readable while the request gets memory instead of source history',async()=>{
 const f=fixture();await saved(f,1,2);f.c.chat[1].is_system=false;f.c.chat[2].is_system=false;
 const before=JSON.stringify(f.c.chat),archive=JSON.stringify(f.c.chatMetadata),saves=f.saves;
 assert.equal((await f.e.memory()).blocked,false,'revealing native sources must not block generation');
 const request=f.c.chat.filter(m=>!m.is_system).map(m=>({...m,mes:'REGEX_'+m.mes}));
 const memory=await f.e.prepareContext(request);
 assert.equal(memory.blocked,false);assert.deepEqual(request.map(m=>m.mes),['REGEX_Исходник 3','REGEX_Исходник 4','REGEX_Исходник 5','REGEX_Исходник 6','REGEX_Исходник 7']);assert.ok(f.host.injected.includes('Результат'));
 assert.equal(JSON.stringify(f.c.chat),before);assert.equal(JSON.stringify(f.c.chatMetadata),archive);assert.equal(f.saves,saves);
});

test('active volume excludes revealed source episodes through inactive chapters without duplicate memory',async()=>{
 const f=fixture(),pair=await chapters(f),d=await f.e.generateVolume(pair.map(e=>e.id));await f.e.saveDraft(d,{title:'Том №1',text:'ONLY_VOLUME'});
 for(const m of f.c.chat)m.is_system=false;f.c.chat.push({name:'Игрок',mes:'NEW_UNCOVERED',is_user:true,is_system:false,extra:{}});
 const before=JSON.stringify(f.c.chat),request=f.c.chat.map(m=>({...m}));const memory=await f.e.prepareContext(request);
 assert.equal(memory.blocked,false);assert.deepEqual(request.map(m=>m.mes),['NEW_UNCOVERED']);assert.ok(f.host.injected.includes('ONLY_VOLUME'));assert.ok(!f.host.injected.includes('CHAPTER_A')&&!f.host.injected.includes('Результат'));assert.equal(JSON.stringify(f.c.chat),before);
});

for(const mode of ['enabled','inject','inactive','overflow'])test(`context leaves raw messages intact when memory is ${mode}`,async()=>{
 const f=fixture(),entry=await saved(f,1,2);f.c.chat[1].is_system=false;f.c.chat[2].is_system=false;
 if(mode==='inactive')await f.e.toggle(entry.id,false);else if(mode==='overflow')f.e.settings().tokenLimit=1;else f.e.settings()[mode]=false;
 const request=f.c.chat.filter(m=>!m.is_system).map(m=>({...m})),before=JSON.stringify(request);await f.e.prepareContext(request);assert.equal(JSON.stringify(request),before);assert.equal(f.host.injected,'');
});

test('context filtering never operates on the live array or a stale chat session',async()=>{
 const f=fixture();await saved(f,1,2);f.c.chat[1].is_system=false;const before=JSON.stringify(f.c.chat);
 await assert.rejects(()=>f.e.prepareContext(f.c.chat),/копи|контекст|сообщ/i);assert.equal(JSON.stringify(f.c.chat),before);
 const count=f.host.count;f.host.count=async text=>{f.c.chatId='other';return count(text);};const request=f.c.chat.map(m=>({...m})),original=JSON.stringify(request);await assert.rejects(()=>f.e.prepareContext(request),/чат/i);assert.equal(JSON.stringify(request),original);
});


test('moved sources are filtered by verified UUID even when request text and indices are reformatted',async()=>{
 const f=fixture();await saved(f,1,2);f.c.chat[1].is_system=false;f.c.chat[2].is_system=false;f.c.chat.unshift({name:'Игрок',mes:'INSERTED',is_user:true,is_system:false,extra:{}});
 const request=f.c.chat.filter(m=>!m.is_system).map((m,i)=>({...m,index:i,mes:'formatted-'+i})),ids=request.filter(m=>m.extra?.pensieve?.id).map(m=>m.extra.pensieve.id);assert.equal(ids.length,2);
 const before=JSON.stringify(f.c.chat);await f.e.prepareContext(request);assert.equal(request.length,6);assert.ok(request.every(m=>!ids.includes(m.extra?.pensieve?.id)));assert.equal(JSON.stringify(f.c.chat),before);
});

for(const change of ['edited','ambiguous','foreign','origin-only'])test(`source identity ${change} never silently removes current chat messages`,async()=>{
 const f=fixture(),entry=await saved(f,1,2);f.c.chat[1].is_system=false;f.c.chat[2].is_system=false;
 if(change==='edited')f.c.chat[1].mes='NEW_EDITED_TEXT';else if(change==='ambiguous')f.c.chat.push(clone(f.c.chat[1]));else if(change==='origin-only')entry.origin={chat:'another-chat',id:entry.id};else{entry.sourceChat='another-chat';entry.detachedSources=true;}
 const request=f.c.chat.filter(m=>!m.is_system).map(m=>({...m})),before=JSON.stringify(request);await f.e.prepareContext(request);assert.equal(JSON.stringify(request),before);
});


test('native continue of a covered terminal source is refused before request or live-source mutation',async()=>{
 const f=fixture();f.c.chat.splice(0,f.c.chat.length,...f.c.chat.slice(0,3));await saved(f,1,2);f.c.chat[2].is_system=false;
 const request=f.c.chat.filter(m=>!m.is_system).map(m=>({...m})),before=JSON.stringify([f.c.chat,request,f.c.chatMetadata]),saves=f.saves;
 await assert.rejects(()=>f.e.prepareContext(request,'continue'),/допис|продолж/i);
 assert.equal(JSON.stringify([f.c.chat,request,f.c.chatMetadata]),before);assert.equal(f.saves,saves);
});

test('native continue of a new uncovered reply keeps its prefix while filtering only older sources',async()=>{
 const f=fixture();await saved(f,1,2);f.c.chat[1].is_system=false;f.c.chat[2].is_system=false;
 const request=f.c.chat.filter(m=>!m.is_system).map(m=>({...m})),before=JSON.stringify(f.c.chat);await f.e.prepareContext(request,'continue');
 assert.equal(request.at(-1).mes,'Исходник 7');assert.deepEqual(request.map(m=>m.mes),['Исходник 3','Исходник 4','Исходник 5','Исходник 6','Исходник 7']);assert.equal(JSON.stringify(f.c.chat),before);
});

for(const enabled of [true,false])test(`quiet generation without a chat is unaffected, extension enabled=${enabled}`,async()=>{
 const f=fixture();f.c.chatId=null;f.c.chatMetadata={};f.c.chat=[];f.e.settings().enabled=enabled;
 const request=[{name:'Utility',mes:'QUIET_INPUT',is_user:true,is_system:false,extra:{}}],before=JSON.stringify(request),memory=await f.e.prepareContext(request,'quiet');
 assert.equal(memory.enabled,false);assert.equal(memory.blocked,false);assert.equal(JSON.stringify(request),before);assert.deepEqual(f.c.chatMetadata,{});assert.equal(f.host.injected,'');assert.equal(f.saves,0);
});

test('full backup restores shared prompt selection without deleting local presets and repeated restore adds no duplicates',async()=>{
 const f=fixture();await saved(f);const copy=fullCopy(f),original=f.e.prompt('summary').text;copy.prompts.summary.presets[0].text='BACKUP CHAPTER';importPreset(f.e.settings(),JSON.stringify({format:'pensieve-prompt-preset',version:1,name:'Local',prompts:{chapter:'LOCAL CHAPTER',part:'LOCAL PART',volume:'LOCAL VOLUME'}}),()=> 'local');await f.e.restoreBackup(copy,{restorePrompts:true});assert.equal(f.e.prompt('summary').text,'BACKUP CHAPTER');const groups=f.e.settings().prompts;assert.ok(groups.summary.presets.some(p=>p.text==='LOCAL CHAPTER'));assert.ok(groups.summary.presets.some(p=>p.text===original));const once=JSON.stringify(groups);await f.e.restoreBackup(copy,{restorePrompts:true});assert.equal(JSON.stringify(f.e.settings().prompts),once);
});
