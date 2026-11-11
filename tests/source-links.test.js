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
 assert.equal(label([episode]),'Омут памяти · Эпизод №9');
 assert.equal(label([episode,chapter]),'Омут памяти · Эпизод №9 → Глава №3');
 assert.equal(label([episode,chapter,volume]),'Омут памяти · Эпизод №9 → Глава №3 → Том №1');
 assert.equal(label([episode,{...chapter,active:true},{...volume,active:false}]),'Омут памяти · Эпизод №9 → Глава №3 → Том №1');
});
test('removed links, missing parents and branches update labels without invented levels',()=>{
 assert.equal(label([episode,{...chapter,summaryIds:[]},volume]),'Омут памяти · Эпизод №9');
 assert.equal(label([episode,volume]),'Омут памяти · Эпизод №9');
 assert.equal(label([episode,chapter,{...volume,chapterIds:[]}]),'Омут памяти · Эпизод №9 → Глава №3');
 assert.equal(label([episode,chapter,volume,{...chapter,id:'c4',title:'Глава №4'}]),'Омут памяти · Эпизод №9 → Глава №3 → Том №1 · Эпизод №9 → Глава №4');
});
test('labels never bind foreign or ambiguous messages and do not modify messages or entries',()=>{
 const entries=[episode,chapter,volume],before=JSON.stringify([entries,message]);
 assert.equal(links.messageLabels?.([{...episode,sourceChat:'foreign'},chapter,volume],[message],'local')?.size,0);
 assert.equal(links.messageLabels?.([{...episode,imported:true},chapter,volume],[message],'local')?.size,0);
 assert.equal(links.messageLabels?.(entries,[message,structuredClone(message)],'local')?.size,0);
 assert.equal(JSON.stringify([entries,message]),before);
});
