import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,emptyArchive,exportArchive,fingerprint,findOverlaps} from '../src/core.js';
import {narrativeOrder} from '../src/order.js';
import * as backup from '../src/backup.js';
const entry=(id,type,order,ids=[],active=false)=>({id,type,order,active,title:id,text:'Русский текст '+id+' {{char}}',createdAt:'2026-11-10',updatedAt:'2026-11-10',version:2,history:[{version:1,title:'До',text:'Прежний текст',updatedAt:'2026'}],sources:type==='summary'?[{id:'m'+order,index:order,hash:fingerprint({name:'Test',mes:'Original '+order}),previousHidden:false}]:[],summaryIds:type==='arc'?ids:[],...(type==='volume'?{chapterIds:ids}:{}),needsReview:false});
const fixture=()=>{const archive=emptyArchive('origin');archive.entries=[entry('s1','summary',0),entry('s2','summary',2),entry('s3','summary',4),entry('s4','summary',6),entry('a1','arc',0,['s1','s2']),entry('a2','arc',4,['s3','s4']),entry('v','volume',0,['a1','a2'],true),entry('new','summary',8,[],true)];const settings=defaults();for(const t of ['summary','arc','volume']){settings.prompts[t].presets[0].text='Промпт '+t+' {{user}}';settings.prompts[t].presets[0].history=['Прежний '+t];}return {archive,settings,source:{key:'origin',name:'Мой чат'}};};

test('full UTF-8 backup includes every archived descendant, links, flags, prompts/settings and no unrelated credentials',()=>{
 const f=fixture(),before=JSON.stringify(f);f.settings.apiKey='DO_NOT_EXPORT';const file=backup.createBackup(f.archive,f.settings,f.source),parsed=backup.parseBackup(JSON.stringify(file));
 assert.equal(parsed.archive.entries.length,8);assert.deepEqual(parsed.archive.entries.find(e=>e.id==='v').chapterIds,['a1','a2']);assert.equal(parsed.archive.entries[0].text,'Русский текст s1 {{char}}');assert.deepEqual(parsed.prompts,f.settings.prompts);assert.equal(parsed.settings.tokenLimit,6000);assert.equal(JSON.stringify(file).includes('DO_NOT_EXPORT'),false);delete f.settings.apiKey;assert.equal(JSON.stringify(f),before);
});
test('new-chat restore is inactive, detached and idempotent without rewriting historical sources or globals',()=>{
 const f=fixture(),file=backup.parseBackup(JSON.stringify(backup.createBackup(f.archive,f.settings,f.source))),before=JSON.stringify(file);let n=0;
 const first=backup.planRestore(emptyArchive('target'),file,{targetKey:'target',uuid:()=> 'u'+n++});assert.equal(first.added,8);assert.ok(first.archive.entries.every(e=>!e.active&&e.detachedSources));assert.equal(first.archive.entries.find(e=>e.id==='v').backupActive,true);assert.deepEqual(first.archive.entries[0].sources,file.archive.entries[0].sources);
 const again=backup.planRestore(first.archive,file,{targetKey:'target',uuid:()=> 'u'+n++});assert.equal(again.added,0);assert.equal(again.skipped,8);assert.equal(again.archive.entries.length,8);assert.equal(JSON.stringify(file),before);
});
test('same-chat merge recognizes native records and keeps independently edited existing text',()=>{
 const f=fixture(),file=backup.parseBackup(JSON.stringify(backup.createBackup(f.archive,f.settings,f.source)));f.archive.entries[0].text='LOCAL EDIT';const before=JSON.stringify(f.archive),plan=backup.planRestore(f.archive,file,{targetKey:'origin',uuid:()=> 'unused'});
 assert.equal(plan.added,0);assert.equal(plan.conflicts,1);assert.equal(plan.archive.entries[0].text,'LOCAL EDIT');assert.equal(JSON.stringify(f.archive),before);
});
test('same IDs from different source chats remap collisions and every dependent link',()=>{
 const f=fixture(),file=backup.parseBackup(JSON.stringify(backup.createBackup(f.archive,f.settings,f.source)));const current=structuredClone(f.archive);current.owner='target';let n=0;
 const plan=backup.planRestore(current,file,{targetKey:'target',uuid:()=> 'u'+n++});assert.equal(plan.added,8);const imported=plan.archive.entries.filter(e=>e.origin?.chat==='origin');assert.equal(imported.length,8);const a1=imported.find(e=>e.origin.id==='a1'),s1=imported.find(e=>e.origin.id==='s1'),v=imported.find(e=>e.type==='volume');assert.notEqual(s1.id,'s1');assert.ok(a1.summaryIds.includes(s1.id));assert.ok(v.chapterIds.includes(a1.id));assert.equal(new Set(plan.archive.entries.map(e=>e.id)).size,16);
});
test('explicit active restore selects only the saved effective roots rather than all descendants',()=>{
 const f=fixture();f.archive.entries[0].active=true;f.archive.entries[4].active=true;const file=backup.parseBackup(JSON.stringify(backup.createBackup(f.archive,f.settings,f.source))),plan=backup.planRestore(emptyArchive('target'),file,{targetKey:'target',activate:true,uuid:()=> 'unused'});
 assert.deepEqual(plan.archive.entries.filter(e=>e.active).map(e=>e.id),['v','new']);
});
test('malformed JSON, unsupported versions, broken links, corrupt prompt history and invalid settings reject before planning',()=>{
 const f=fixture(),file=backup.createBackup(f.archive,f.settings,f.source);
 for(const mutate of [x=>x.version=99,x=>x.archive.entries[6].chapterIds=['missing','a1'],x=>x.prompts.arc.presets[0].history=[42],x=>x.settings.tokenLimit=-1,x=>delete x.prompts.volume,x=>x.archive.entries[0].text='']){const invalid=structuredClone(file);mutate(invalid);assert.throws(()=>backup.parseBackup(JSON.stringify(invalid)));}
 assert.throws(()=>backup.parseBackup('{wrong'));
});
test('legacy archive-only JSON is accepted with absent optional global configuration',()=>{
 const f=fixture(),file=backup.parseBackup(JSON.stringify(exportArchive(f.archive)));assert.equal(file.archive.entries.length,8);assert.equal(file.prompts,null);assert.equal(file.settings,null);
});
test('foreign UUID matches never participate in live overlap or chronology binding',()=>{
 const f=fixture(),file=backup.parseBackup(JSON.stringify(backup.createBackup(f.archive,f.settings,f.source))),plan=backup.planRestore(emptyArchive('target'),file,{targetKey:'target',uuid:()=> 'unused'});const foreign=plan.archive.entries[0];const chat=[{name:'Test',mes:'Original 0',extra:{pensieve:{id:'m0'}}}];
 assert.equal(findOverlaps([foreign],[{id:'m0',hash:foreign.sources[0].hash}]).length,0);
 const live=entry('live','summary',0,[],true);live.sources[0].id='m0';const order=narrativeOrder([live,foreign],[live,foreign],chat);assert.deepEqual(order.entries.map(e=>e.id),['s1','live']);assert.equal(order.ranges.get('s1').historical,true);
});
test('export/import through an intermediate chat preserves the original detached provenance',()=>{
 const f=fixture(),file=backup.parseBackup(JSON.stringify(backup.createBackup(f.archive,f.settings,f.source))),first=backup.planRestore(emptyArchive('target'),file,{targetKey:'target',uuid:()=> 'unused'}),secondFile=backup.parseBackup(JSON.stringify(backup.createBackup(first.archive,f.settings,{key:'target'})));
 assert.equal(secondFile.archive.entries[0].origin.chat,'origin');assert.equal(secondFile.archive.entries[0].sourceChat,'origin');const back=backup.planRestore(emptyArchive('origin'),secondFile,{targetKey:'origin',uuid:()=> 'unused'});assert.equal(back.archive.entries[0].detachedSources,true);
});
test('duplicate origin identities in a file are rejected rather than silently dropping a distinct record',()=>{
 const f=fixture(),file=backup.createBackup(f.archive,f.settings,f.source);file.archive.entries[7].origin=structuredClone(file.archive.entries[0].origin);assert.throws(()=>backup.parseBackup(JSON.stringify(file)));
});
