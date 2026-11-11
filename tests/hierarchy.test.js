import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import {narrativeOrder} from '../src/order.js';
import {memoryViewState,entryDisplayTitle,filterArchive} from '../src/view-state.js';
const make=(id,type,order,children=[])=>({id,type,title:id,text:'TEXT_'+id,order,active:true,version:1,history:[],createdAt:'2026-11-10',updatedAt:'2026-11-10',sources:type==='summary'?[{id:'m'+order,index:order,hash:'a'.repeat(32),previousHidden:false}]:[],summaryIds:type==='arc'?children:[],...(type==='volume'?{chapterIds:children}:{}),needsReview:false});
const fixture=()=>[make('s1','summary',0),make('s2','summary',2),make('s3','summary',4),make('s4','summary',6),make('a1','arc',0,['s1','s2']),make('a2','arc',4,['s3','s4']),make('v1','volume',0,['a1','a2']),make('new','summary',8)];

test('an active volume replaces inactive or active descendant chapters and episodes, keeping later episodes',()=>{
 const entries=fixture(),before=JSON.stringify(entries);assert.deepEqual(core.memoryEntries(entries).map(e=>e.id),['v1','new']);assert.equal(JSON.stringify(entries),before);
 entries[4].active=false;assert.deepEqual(core.memoryEntries(entries).map(e=>e.id),['v1','new']);
});
test('overlapping volumes conflict while their own nested chapters do not',()=>{
 const entries=fixture();assert.deepEqual(core.memoryConflicts(entries),[]);
 entries.push({...structuredClone(entries[6]),id:'v2'});assert.deepEqual(core.memoryConflicts(entries),[['v1','v2']]);
});
test('a volume and unrelated chapter sharing original messages are blocked as duplicate coverage',()=>{
 const entries=fixture();entries.push(make('copy','summary',0),make('other','arc',0,['copy','new']));
 assert.ok(core.memoryConflicts(entries).some(pair=>pair.includes('v1')&&pair.includes('other')));
});
test('volume narrative position follows all original source ranges instead of creation/order fields',()=>{
 const entries=fixture(),chat=Array.from({length:10},(_,i)=>({extra:{pensieve:{id:'m'+i}}}));entries[6].order=999;
 const result=narrativeOrder([entries[7],entries[6]],entries,chat);assert.deepEqual(result.entries.map(e=>e.id),['v1','new']);assert.deepEqual(result.ranges.get('v1'),{start:0,end:6});assert.deepEqual(result.warnings,[]);
});
test('volume archive roundtrip and merge retain/remap every level, user text and legacy records',()=>{
 const archive=core.emptyArchive('legacy');archive.entries=fixture();const before=JSON.stringify(archive);
 const parsed=core.parseArchive(JSON.stringify(core.exportArchive(archive)));assert.deepEqual(parsed.entries.find(e=>e.id==='v1').chapterIds,['a1','a2']);assert.equal(parsed.entries[0].text,'TEXT_s1');assert.equal(JSON.stringify(archive),before);
 let i=0;const merged=core.mergeArchives(core.emptyArchive('other'),parsed,()=> 'n'+i++);assert.deepEqual(merged.entries.find(e=>e.type==='volume').chapterIds,['n4','n5']);assert.deepEqual(merged.entries[4].summaryIds,['n0','n1']);
 const old=core.emptyArchive('old');old.entries=fixture().filter(e=>e.type!=='volume');assert.ok(core.parseArchive(JSON.stringify(core.exportArchive(old))).entries.every(e=>!Object.hasOwn(e,'chapterIds')));
});
test('volume validator rejects wrong, missing, duplicate or cyclic chapter links',()=>{
 for(const ids of [['a1','missing'],['a1','s1'],['a1','a1'],['a1','v1']]){const a=core.emptyArchive('x');a.entries=fixture();a.entries[6].chapterIds=ids;assert.throws(()=>core.validateArchive(a));}
});
test('changing an episode marks chapters and volumes transitively without rewriting either parent',()=>{
 const entries=fixture(),texts=entries.map(e=>e.text);core.reviseEntry(entries,'s1',{title:'Новая глава',text:'Новый текст'});
 assert.equal(entries[4].needsReview,true);assert.equal(entries[6].needsReview,true);assert.equal(entries[5].needsReview,false);assert.deepEqual(entries.slice(1).map(e=>e.text),texts.slice(1));
});
test('legacy titles are projected as episodes and chapters without rewriting their saved titles',()=>{
 const entries=fixture();entries[0].title='Сводка №7 — {{char}}';entries[4].title='Арка №9 — Тайна';const before=JSON.stringify(entries);
 assert.equal(entryDisplayTitle(entries[0],entries),'Глава №7 — {{char}}');assert.equal(entryDisplayTitle(entries[4],entries),'Часть №9 — Тайна');assert.equal(entryDisplayTitle(entries[6],entries),'Том №1 — v1');assert.equal(JSON.stringify(entries),before);
});
test('effective state and hierarchy membership stay independent at every level',()=>{
 const entries=fixture(),volume=entries[6],memory={enabled:true,blocked:false,text:'EXACT',entries:[volume,entries[7]]},state=memoryViewState(entries,memory,['a2']);
 assert.equal(state.byId.get('a1').label,'В архиве');assert.equal(state.byId.get('s1').label,'В архиве');assert.equal(state.byId.get('v1').label,'Активна');
 assert.deepEqual(state.byId.get('a1').parents.map(e=>e.id),['v1']);assert.deepEqual(state.byId.get('s1').parents.map(e=>e.id),['a1']);assert.deepEqual(state.byId.get('s1').covering.map(e=>e.id),['a1','v1']);assert.equal(state.byId.get('a2').selectedForVolume,true);
 assert.ok(core.memoryText(entries,core.defaults()).includes('[Том: v1]'));
});
test('legacy records can be found by the new visible episode/chapter name without rewriting titles',()=>{
 const entries=fixture();entries[0].title='Сводка №7 — Тайна';entries[4].title='Арка №9';const state=memoryViewState(entries,{enabled:true,blocked:false,entries:[],text:''});
 assert.deepEqual(filterArchive(entries,state,'all','Глава №7').map(e=>e.id),['s1']);assert.deepEqual(filterArchive(entries,state,'all','Часть №9').map(e=>e.id),['a1']);assert.equal(entries[0].title,'Сводка №7 — Тайна');
});
