import test from 'node:test';
import assert from 'node:assert/strict';
import * as view from '../src/view-state.js';
const summary=(id,active=true)=>({id,type:'summary',title:id,active,summaryIds:[]});
const arc=(id,ids,active=true)=>({id,type:'arc',title:id,active,summaryIds:ids});
const memory=(entries,patch={})=>({enabled:true,blocked:false,entries,text:'EXACT BLOCK',tokens:10,...patch});

test('active means included in the actual enabled engine snapshot',()=>{
 const a=summary('a'),b=summary('b',false),result=view.memoryViewState([a,b],memory([a]),[]);
 assert.equal(result.byId.get('a').label,'Активна');assert.equal(result.byId.get('b').label,'В архиве');assert.deepEqual(result.current.map(e=>e.id),['a']);
});
test('global disable never labels selected records as transmitted',()=>{
 const a=summary('a'),r=view.memoryViewState([a],memory([a],{enabled:false}),[]);
 assert.equal(r.current.length,0);assert.equal(r.byId.get('a').label,'В архиве');assert.equal(r.byId.get('a').gate,'disabled');assert.equal(r.actualText,'');assert.equal(r.candidateText,'EXACT BLOCK');
});
test('overflow blocks the complete memory block instead of inventing a subset',()=>{
 const a=summary('a'),r=view.memoryViewState([a],memory([a],{blocked:true,reason:'Память превышает лимит токенов'}),[]);
 assert.equal(r.current.length,0);assert.equal(r.byId.get('a').gate,'blocked');assert.equal(r.byId.get('a').label,'В архиве');assert.equal(r.actualText,'');assert.ok(r.byId.get('a').note.includes('лимит'));
});
test('an active arc identifies suppressed sources even if their active flag is true',()=>{
 const a=summary('a'),b=summary('b',false),c=arc('arc',[a.id,b.id]),r=view.memoryViewState([a,b,c],memory([c]),[]);
 assert.equal(r.byId.get('a').label,'В архиве');assert.deepEqual(r.byId.get('a').parents.map(e=>e.id),['arc']);assert.equal(r.byId.get('b').label,'В архиве');assert.deepEqual(r.current.map(e=>e.id),['arc']);assert.equal(r.archived.length,2);
});
test('inactive arcs do not suppress a summary restored into active memory',()=>{
 const a=summary('a'),c=arc('arc',['a','b'],false),r=view.memoryViewState([a,c],memory([a]),[]);
 assert.equal(r.byId.get('a').label,'Активна');assert.equal(r.byId.get('arc').label,'В архиве');
});
test('temporary arc selection is an independent presentation flag',()=>{
 const a=summary('a'),r=view.memoryViewState([a],memory([a]),['a']);
 assert.equal(r.byId.get('a').label,'Активна');assert.equal(r.byId.get('a').selectedForArc,true);assert.equal(a.active,true);
});
test('filters use effective participation, not the saved preference flag',()=>{
 const a=summary('a'),b=summary('b'),r=view.memoryViewState([a,b],memory([a,b],{enabled:false}),[]);
 assert.equal(view.filterArchive([a,b],r,'active').length,0);assert.equal(view.filterArchive([a,b],r,'inactive').length,2);assert.equal(view.filterArchive([a,b],r,'all').length,2);
});
test('projection is read-only and accepts an empty archive',()=>{
 const a=summary('a'),entries=[a],before=JSON.stringify(entries);view.memoryViewState(entries,memory([a]),['a']);assert.equal(JSON.stringify(entries),before);
 assert.deepEqual(view.memoryViewState([],memory([]),[]).current,[]);
});
test('arc status retains the existing visible arc number after earlier arcs were removed',()=>{
 const a=summary('a'),c={...arc('arc',['a','b']),title:'Арка №7 — Продолжение'};
 const state=view.memoryViewState([a,c],memory([c]),[]).byId.get('a');assert.equal(state.label,'В архиве');assert.equal(state.parents[0].title,'Арка №7 — Продолжение');
});
test('search matches titles and full texts without changing the archive',()=>{
 const a={...summary('a'),title:'Библиотека',text:'Скрытая важная деталь'},b={...summary('b'),title:'Другая сцена',text:'Иное'},entries=[a,b],r=view.memoryViewState(entries,memory(entries),[]);
 assert.deepEqual(view.filterArchive(entries,r,'all','ВАЖНАЯ').map(e=>e.id),['a']);assert.deepEqual(view.filterArchive(entries,r,'all','библио').map(e=>e.id),['a']);
});
test('current-memory list uses the exact order of the engine snapshot',()=>{
 const a=summary('a'),b=summary('b');assert.deepEqual(view.memoryViewState([a,b],memory([b,a]),[]).current.map(e=>e.id),['b','a']);
});
