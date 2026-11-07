import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const chat = () => Array.from({length: 6}, (_, i) => ({name: i % 2 ? 'Игрок' : 'Персонаж', is_user: !!(i % 2), mes: `Событие ${i} {{char}}`, send_date: `real-${i}`, extra: {pensieve:{id:`m${i}`}}}));
const summary = (id, order, active = true) => ({id, type:'summary', title:id, text:`Текст ${id}`, order, active, version:1, history:[], sources:[], summaryIds:[], createdAt:'2026-11-07T12:00:00.000Z', updatedAt:'2026-11-07T12:00:00.000Z'});

test('range is inclusive, in order, with unchanged literal content and names', () => {
  const c=chat(), r=core.captureRange(c, 1, 3);
  assert.equal(r.length, 3); assert.deepEqual(r.map(x=>x.index), [1,2,3]);
  assert.equal(core.sourceText(r), 'Игрок:\nСобытие 1 {{char}}\n\nПерсонаж:\nСобытие 2 {{char}}\n\nИгрок:\nСобытие 3 {{char}}');
  assert.ok(!core.sourceText(r).includes('real-'));
});
test('invalid and reverse ranges are rejected', () => {
  for (const [a,b] of [[3,1],[-1,2],[1,10],[1.5,2]]) assert.throws(()=>core.captureRange(chat(),a,b));
});
test('IDs survive deletion/movement; edited/swiped and ambiguous sources are diagnosed', () => {
  const c=chat(), r=core.captureRange(c,2,3); c.unshift(c.pop());
  assert.equal(core.inspectSources(c,r).issues.length,0);
  c.find(m=>m.extra.pensieve.id==='m2').mes='Альтернативный ответ';
  assert.ok(core.inspectSources(c,r).issues.some(x=>x.reason==='changed'));
  c.push(structuredClone(c.find(m=>m.extra.pensieve.id==='m3')));
  assert.ok(core.inspectSources(c,r).issues.some(x=>x.reason==='ambiguous'));
});
test('overlap follows source UUIDs instead of numeric indices', () => {
  const c=chat(), e=summary('s1',0); e.sources=core.captureRange(c,1,3).map(core.sourceRecord);
  assert.deepEqual(core.findOverlaps([e], core.captureRange(c,3,4)).map(x=>x.id),['s1']);
  assert.equal(core.findOverlaps([e],core.captureRange(c,4,5)).length,0);
});
test('active arc suppresses source summaries; chronology is stable', () => {
  const a=summary('s1',0), b=summary('s2',1), c=summary('s3',2);
  const arc={...summary('a1',0),type:'arc',summaryIds:['s1','s2']};
  assert.deepEqual(core.memoryEntries([c,b,arc,a]).map(x=>x.id),['a1','s3']);
  arc.active=false; assert.deepEqual(core.memoryEntries([c,b,arc,a]).map(x=>x.id),['s1','s2','s3']);
});
test('overlapping arcs report conflict without silently selecting one', () => {
  const a={...summary('a',0),type:'arc',summaryIds:['s1','s2']}, b={...a,id:'b'};
  assert.equal(core.memoryConflicts([a,b]).length,1);
});
test('versions preserve text and mark dependent arcs for review', () => {
  const s=summary('s',1), arc={...summary('arc',0),type:'arc',summaryIds:['s']};
  core.reviseEntry([s,arc],'s',{text:'Новая версия',title:'Новое имя'});
  assert.equal(s.history[0].text,'Текст s'); assert.equal(s.version,2); assert.equal(arc.needsReview,true);
});
test('JSON roundtrip retains relationships and disables unverified hide journals on import', () => {
  const a=core.emptyArchive('chat'); a.entries=[summary('s',0)];
  a.pending={type:'hide',entryId:'s'};
  const imported=core.parseArchive(JSON.stringify(core.exportArchive(a)));
  assert.equal(imported.entries[0].text,'Текст s'); assert.equal(imported.pending,null);
});
test('malformed, future and duplicate-ID imports are rejected', () => {
  for(const x of ['{}','[]',JSON.stringify({format:'pensieve',version:99,archive:{entries:[]}}),JSON.stringify({format:'pensieve',version:1,archive:{entries:[summary('s',0),summary('s',1)]}})]) assert.throws(()=>core.parseArchive(x));
});
test('merge remaps all entry relationships and keeps existing records', () => {
  const original=core.emptyArchive('a'); original.entries=[summary('s',0)];
  const incoming=core.emptyArchive('b'); incoming.entries=[summary('s',0),{...summary('arc',0),type:'arc',summaryIds:['s']}];
  let n=0; const result=core.mergeArchives(original,incoming,()=>`new${n++}`);
  assert.equal(result.entries.length,3); assert.deepEqual(result.entries[2].summaryIds,[result.entries[1].id]);
  assert.equal(original.entries.length,1);
});
test('past-events note is editable and can be turned off',()=>{
  const e=[summary('s',0)];
  assert.ok(core.memoryText(e,{pastNoteEnabled:true,pastNote:'Прошлое'}).startsWith('Прошлое'));
  assert.ok(!core.memoryText(e,{pastNoteEnabled:false,pastNote:'Прошлое'}).includes('Прошлое'));
});
