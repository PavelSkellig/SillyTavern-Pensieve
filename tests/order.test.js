import test from 'node:test';
import assert from 'node:assert/strict';
import * as order from '../src/order.js';
const chat=Array.from({length:12},(_,i)=>({extra:{pensieve:{id:`m${i}`}}}));
const summary=(id,start,end,extra={})=>({id,type:'summary',title:id,order:999,createdAt:'2026-11-09',sources:[{id:`m${start}`,index:start},{id:`m${end}`,index:end}],summaryIds:[],...extra});
test('source messages determine narrative order instead of creation date, number or saved order',()=>{
 const a=summary('Сводка №3',0,2,{order:300,createdAt:'later'}),b=summary('Сводка №1',3,5,{order:0,createdAt:'earlier'}),c=summary('Сводка №2',6,8);
 assert.deepEqual(order.narrativeOrder([b,c,a],[a,b,c],chat).entries.map(e=>e.id),[a.id,b.id,c.id]);
});
test('current message locations supersede stale original indices',()=>{
 const a=summary('a',0,2),b=summary('b',3,5),moved=[...chat.slice(3),...chat.slice(0,3)];
 assert.deepEqual(order.narrativeOrder([a,b],[a,b],moved).entries.map(e=>e.id),['b','a']);
});
test('arcs use their source summaries and interleave with standalone summaries',()=>{
 const a=summary('a',0,2),b=summary('b',3,5),c=summary('c',6,8),arc={id:'arc',type:'arc',title:'arc',order:900,summaryIds:['a','b']};
 const result=order.narrativeOrder([c,arc],[a,b,c,arc],chat);assert.deepEqual(result.entries.map(e=>e.id),['arc','c']);assert.equal(result.warnings.length,0);
});
test('missing sources preserve the supplied user order with a warning',()=>{
 const a=summary('a',0,2),b=summary('b',3,5);const result=order.narrativeOrder([b,a],[a,b],chat.slice(1));
 assert.deepEqual(result.entries.map(e=>e.id),['b','a']);assert.ok(result.warnings.length);
});
test('overlapping ranges and duplicate message IDs never invent an ordering',()=>{
 const a=summary('a',0,4),b=summary('b',3,5);const result=order.narrativeOrder([b,a],[a,b],chat);assert.deepEqual(result.entries.map(e=>e.id),['b','a']);assert.ok(result.warnings.length);
 const duplicates=[...chat,chat[0]];assert.ok(order.narrativeOrder([a],[a],duplicates).warnings.length);
});
test('sorting never changes story dates, record numbers, text, links or saved metadata',()=>{
 const a=summary('Сводка №3',0,2,{text:'Вспоминает 1 января 1400 года'}),b=summary('Сводка №1',3,5,{text:'31 декабря 9999 года'}),entries=[b,a],before=JSON.stringify(entries);
 order.narrativeOrder(entries,entries,chat);assert.equal(JSON.stringify(entries),before);
});
test('empty and legacy records remain usable without metadata migrations',()=>{
 assert.deepEqual(order.narrativeOrder([],[],chat).entries,[]);const a={id:'legacy',type:'summary',order:4};const result=order.narrativeOrder([a],[a],chat);assert.equal(result.entries[0],a);assert.ok(result.warnings.length);
});
test('very long source ranges do not overflow the JavaScript argument limit',()=>{
 const large=Array.from({length:150000},(_,i)=>({extra:{pensieve:{id:`large-${i}`}}})),entry={id:'large',type:'summary',title:'Длинная сводка',sources:large.map(m=>({id:m.extra.pensieve.id}))};
 assert.equal(order.narrativeOrder([entry],[entry],large).ranges.get('large').end,149999);
});
