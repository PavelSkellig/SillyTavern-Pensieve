import test from 'node:test';
import assert from 'node:assert/strict';
import * as links from '../src/source-links.js';
import {fingerprint} from '../src/core.js';
const message={name:'Test',mes:'ORIGINAL',is_user:true,extra:{pensieve:{id:'m9'}}};
const episode={id:'e9',type:'summary',title:'Сводка №9',active:false,sources:[{id:'m9',hash:fingerprint(message),index:0}],summaryIds:[]};
const chapter={id:'c3',type:'arc',title:'Арка №3',active:false,sources:[],summaryIds:['e9']};
const volume={id:'v1',type:'volume',title:'Том №1',active:true,sources:[],summaryIds:[],chapterIds:['c3']};
const label=entries=>links.messageLabels?.(entries,[message],'local')?.get('m9');
test('labels show the existing complete hierarchy including inactive descendants and legacy numbering',()=>{
 assert.equal(label([episode]),'Омут памяти · Глава №9');
 assert.equal(label([episode,chapter]),'Омут памяти · Глава №9 → Часть №3');
 assert.equal(label([episode,chapter,volume]),'Омут памяти · Глава №9 → Часть №3 → Том №1');
 assert.equal(label([episode,{...chapter,active:true},{...volume,active:false}]),'Омут памяти · Глава №9 → Часть №3 → Том №1');
});
test('removed links, missing parents and branches update labels without invented levels',()=>{
 assert.equal(label([episode,{...chapter,summaryIds:[]},volume]),'Омут памяти · Глава №9');
 assert.equal(label([episode,volume]),'Омут памяти · Глава №9');
 assert.equal(label([episode,chapter,{...volume,chapterIds:[]}]),'Омут памяти · Глава №9 → Часть №3');
 assert.equal(label([episode,chapter,volume,{...chapter,id:'c4',title:'Часть №4'}]),'Омут памяти · Глава №9 → Часть №3 → Том №1 · Глава №9 → Часть №4');
});
test('labels never bind foreign or ambiguous messages and do not modify messages or entries',()=>{
 const entries=[episode,chapter,volume],before=JSON.stringify([entries,message]);
 assert.equal(links.messageLabels?.([{...episode,sourceChat:'foreign'},chapter,volume],[message],'local')?.size,0);
 assert.equal(links.messageLabels?.([{...episode,imported:true},chapter,volume],[message],'local')?.size,0);
 assert.equal(links.messageLabels?.(entries,[message,structuredClone(message)],'local')?.size,0);
 assert.equal(JSON.stringify([entries,message]),before);
});
test('contents ranges use the live zero-based message numbers and include hidden originals',()=>{
 const hidden={...message,extra:{pensieve:{id:'hidden'}},mes:'HIDDEN SOURCE',is_system:true};
 const tail={...message,extra:{pensieve:{id:'tail'}},mes:'LAST SOURCE'};
 const second={...episode,id:'e10',sources:[{id:'hidden',hash:fingerprint(hidden),index:24},{id:'tail',hash:fingerprint(tail),index:25}]};
 const part={...chapter,summaryIds:[episode.id,second.id]},entries=[episode,second,part,volume];
 const chat=[message,{mes:'Gap'},hidden,tail],before=JSON.stringify([entries,chat]);
 const ranges=links.contentsRanges(entries,chat,'local');
 assert.deepEqual(ranges.get(episode.id),{start:0,end:0});
 assert.deepEqual(ranges.get(second.id),{start:2,end:3});
 assert.deepEqual(ranges.get(part.id),{start:0,end:3});
 assert.deepEqual(ranges.get(volume.id),{start:0,end:3});
 assert.equal(JSON.stringify([entries,chat]),before);
});
test('contents ranges hide stale or foreign sources along with dependent ranges',()=>{
 const unavailable=[
  [[episode,chapter,volume],[]],
  [[episode,chapter,volume],[message,structuredClone(message)]],
  [[episode,chapter,volume],[{...message,mes:'EDITED'}]],
  [[{...episode,sourceChat:'elsewhere'},chapter,volume],[message]],
  [[{...episode,imported:true},chapter,volume],[message]],
  [[{...episode,detachedSources:true},chapter,volume],[message]],
 ];
 for(const [entries,chat] of unavailable)assert.deepEqual([...links.contentsRanges(entries,chat,'local').values()],[null,null,null]);
 assert.equal(links.contentsRanges([chapter,volume],[message],'local').get(volume.id),null);
});
