import test from 'node:test';
import assert from 'node:assert/strict';
import {UI} from '../src/ui.js';
const message=mes=>({name:'Игрок',is_user:true,mes,extra:{}});
const fixture=chat=>{const c={chat};return {c,ui:new UI({key:()=> 'chat',session:()=>({}),host:{context:()=>c}})};};
test('deleting a boundary never transfers it to an identical neighbouring reply',()=>{
 const {c,ui}=fixture([message('Да'),message('Да'),message('Конец')]);ui.setRangeEdge('start',0);ui.setRangeEdge('end',2);c.chat.splice(0,1);ui.resolveRange();
 assert.equal(ui.start,null);assert.equal(ui.end,1);
});
test('moving a live boundary follows its object while edits invalidate it',()=>{
 const {c,ui}=fixture([message('До'),message('Начало'),message('Конец')]);ui.setRangeEdge('start',1);c.chat.splice(0,1);ui.resolveRange();assert.equal(ui.start,0);
 c.chat[0].mes='Изменено';ui.resolveRange();assert.equal(ui.start,null);
});
test('reload restores unique idless sources but rejects ambiguous identical sources',()=>{
 const storage=new Map();globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 try{
  const chat=[message('Да'),message('Да'),message('Уникальный конец')],a=fixture(chat);a.ui.setRangeEdge('start',0);a.ui.setRangeEdge('end',2);
  const b=fixture(structuredClone(chat));b.ui.loadRange();assert.equal(b.ui.start,null);assert.equal(b.ui.end,2);
 }finally{delete globalThis.sessionStorage;}
});
