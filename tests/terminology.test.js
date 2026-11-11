import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {displayTitle,entryNumber,nextNumber,relationLabel} from '../src/hierarchy.js';
import {messageLabels} from '../src/source-links.js';
import {createBackup,parseBackup,planRestore} from '../src/backup.js';
import {Engine} from '../src/engine.js';
const oldText=fs.readFileSync(new URL('./fixtures/v164-backup.json',import.meta.url),'utf8');
const fixture=()=>({file:JSON.parse(oldText),chat:JSON.parse(fs.readFileSync(new URL('./fixtures/v164-chat.json',import.meta.url),'utf8'))});
test('old record types project to chapter/part/volume without rewriting old titles, bodies, history or links',()=>{
 const {file,chat}=fixture(),a=file.archive,before=JSON.stringify([file,chat]);
 assert.deepEqual(a.entries.map(e=>displayTitle(e,a.entries)),['Глава №9 — Старое название','Глава №7 — На мосту','Глава №3 — Дневник: Эпизод на мосту','Глава №2','Часть №3 — Пользовательское','Часть №8 — Сохранить','Том №1 — Архив']);
 assert.equal(messageLabels(a.entries,chat,file.source.key).get('legacy-msg-0'),'Омут памяти · Глава №9 → Часть №3 → Том №1');
 assert.equal(relationLabel(a.entries[4],a.entries),'Входит в часть №3');assert.equal(JSON.stringify([file,chat]),before);
});
test('numbering understands every previous and current prefix by stored type',()=>{
 const {file}=fixture(),entries=file.archive.entries;
 for(const [type,title,want] of [['summary','Сводка №14',14],['summary','Эпизод №15',15],['summary','Глава №16',16],['arc','Арка №17',17],['arc','Глава №18',18],['arc','Часть №19',19]])assert.equal(entryNumber({type,title,id:'new'},[]),String(want));
 assert.equal(nextNumber('summary',entries),10);assert.equal(nextNumber('arc',entries),9);
 entries.push({...entries[0],id:'new-s',title:'Глава №20'},{...entries[4],id:'new-a',title:'Часть №21'});assert.equal(nextNumber('summary',entries),21);assert.equal(nextNumber('arc',entries),22);
});
test('existing prompt keys/settings stay untouched and new drafts reuse the old generation routes with new default titles',async()=>{
 const {file,chat}=fixture(),settings={...file.settings,prompts:file.prompts},c={chatId:'legacy-local',characterId:0,characters:[{avatar:'legacy.png'}],chat,chatMetadata:{pensieve:file.archive},extensionSettings:{pensieve:settings}},before=JSON.stringify(c);let saves=0,request;
 const host={context:()=>c,count:async()=>100,limits:()=>({context:32000,output:2000}),generate:async(prompt,source)=>{request={prompt,source};return 'DRAFT';},refresh(){},save(){saves++;}};
 const e=new Engine(host);assert.equal(e.settings().previewEpisodes,false);
 const chapter=await e.generateSummary(8,9);assert.equal(chapter.type,'summary');assert.equal(chapter.title,'Глава №10');assert.equal(request.prompt,file.prompts.summary.presets[0].text);assert.ok(request.source.includes('STORED_SOURCE_8'));
 const part=await e.generateArc(['old-s0','old-s1']);assert.equal(part.type,'arc');assert.equal(part.title,'Часть №9');assert.equal(request.prompt,file.prompts.arc.presets[0].text);assert.ok(request.source.includes('Эпизод №9 — Старое название'));
 assert.equal(JSON.stringify(c),before);assert.equal(saves,0);
});
test('v1.6.4 backup remains idempotent and new exports keep all raw records, prompt groups and settings',()=>{
 const {file,chat}=fixture(),parsed=parseBackup(oldText),before=JSON.stringify(parsed),merged=planRestore(parsed.archive,parsed,{targetKey:file.source.key,uuid:()=>{throw Error('No new IDs expected');},chat});
 assert.equal(merged.added,0);assert.equal(merged.skipped,7);assert.deepEqual(merged.archive.entries,parsed.archive.entries);
 const exported=createBackup(parsed.archive,{...parsed.settings,prompts:parsed.prompts},parsed.source),round=parseBackup(JSON.stringify(exported));
 assert.deepEqual(round.archive.entries,file.archive.entries);assert.deepEqual(round.prompts,file.prompts);assert.deepEqual(round.settings,file.settings);assert.equal(JSON.stringify(parsed),before);
});
