import test from 'node:test';import assert from 'node:assert/strict';
import {PromptEnvelope} from '../src/prompt-envelope.js';
const memory={enabled:true,blocked:false,text:'CANONICAL_MEMORY',sourceIds:new Set(['old'])};
test('actual user macro wins over auto and repeats while covered raw content is removed only from request copies',()=>{
 const e=new PromptEnvelope('test'),body=e.wrap('body','BUDGET'),auto=e.wrap('auto','[Past '+body+']'),first=e.wrap('macro',''),second=e.wrap('macro',''),source=e.wrap('source','OLD_RAW',{id:'old',name:'Hero'}),input=[{role:'system',content:auto},{role:'system',content:'BEGIN '+first+' END '+second},{role:'assistant',content:'Hero: '+source},{role:'user',content:'NEW_RAW'}],before=JSON.stringify(input);
 const r=e.resolve(input,memory,true);assert.equal(r.kind,'macro');assert.equal(r.delivered,true);assert.deepEqual(r.prompt,[{role:'system',content:'BEGIN CANONICAL_MEMORY END '},{role:'user',content:'NEW_RAW'}]);assert.equal(JSON.stringify(input),before);
});
test('template-owned echo and repeated auto candidates do not create user macro priority or duplicates',()=>{
 const e=new PromptEnvelope('test'),nested=e.wrap('macro','NOISE'),auto=e.wrap('auto','[Past '+e.wrap('body','BUDGET')+nested+']');
 const r=e.resolve([{role:'system',content:auto},{role:'user',content:'NEW'},{role:'system',content:auto}],memory,true);assert.equal(r.kind,'auto');assert.deepEqual(r.prompt,[{role:'system',content:'[Past CANONICAL_MEMORY]'},{role:'user',content:'NEW'}]);
});
test('none without an actually sent macro preserves source content; unused macro evaluations do not count',()=>{
 const e=new PromptEnvelope('test');e.wrap('macro','UNUSED');const source=e.wrap('source','OLD_RAW',{id:'old',name:'Hero'});const r=e.resolve([{role:'assistant',content:source},{role:'user',content:'NEW'}],memory,false);assert.equal(r.delivered,false);assert.deepEqual(r.prompt,[{role:'assistant',content:'OLD_RAW'},{role:'user',content:'NEW'}]);
});
test('echo inside a covered message keeps its actual slot while dropping only its covered raw text',()=>{
 const e=new PromptEnvelope('test'),source=e.wrap('source','OLD '+e.wrap('macro','BUDGET')+' RAW',{id:'old',name:'Hero'}),r=e.resolve([{role:'user',content:source}],memory,false);assert.deepEqual(r.prompt,[{role:'user',content:'CANONICAL_MEMORY'}]);
});
test('raw early macro, empty/disabled memory, invalid blocks and missing automatic placement are handled without leaking tags',()=>{
 const e=new PromptEnvelope('test');assert.deepEqual(e.resolve('BEGIN {{memory_echo}} END {{memory_echo}}',memory,false).prompt,'BEGIN CANONICAL_MEMORY END ');
 const source=e.wrap('source','RAW',{id:'old',name:'Hero'}),macro=e.wrap('macro','BUDGET');assert.equal(e.resolve(source+macro,{...memory,enabled:false},false).prompt,'RAW');assert.equal(e.resolve(macro,{...memory,text:''},false).prompt,'');assert.throws(()=>e.resolve(macro,{...memory,blocked:true,reason:'TOKEN_LIMIT'},false),/TOKEN_LIMIT/);assert.equal(e.resolve('RAW',{...memory,blocked:true},false).prompt,'RAW');assert.throws(()=>e.resolve('RAW',memory,true),/встав|подстанов|памят/i);assert.throws(()=>e.resolve(macro.slice(0,-5),memory,false),/памят|маркер|сбор/i);
});
test('multimodal source messages disappear as a whole only when memory is delivered',()=>{
 const e=new PromptEnvelope('test'),source=e.wrap('source','OLD',{id:'old',name:'Hero'}),macro=e.wrap('macro','BUDGET'),input=[{role:'system',content:macro},{role:'user',content:[{type:'text',text:source},{type:'image_url',image_url:{url:'synthetic-image'}}]},{role:'user',content:'NEW'}];assert.deepEqual(e.resolve(input,memory,false).prompt,[{role:'system',content:'CANONICAL_MEMORY'},{role:'user',content:'NEW'}]);
 assert.deepEqual(e.resolve(input,{...memory,enabled:false},false).prompt,[{role:'user',content:[{type:'text',text:'OLD'},{type:'image_url',image_url:{url:'synthetic-image'}}]},{role:'user',content:'NEW'}]);
});

test('probe removal preserves image-only messages without empty text parts',()=>{
 const e=new PromptEnvelope('images'),probe=e.wrap('probe','');const image={type:'image_url',image_url:{url:'data:image/png;base64,AAA'}};const input=[{role:'user',content:[image,{type:'text',text:probe}]}];const result=e.resolve(input,{enabled:false,text:''},false);assert.deepEqual(result.prompt,[{role:'user',content:[image]}]);
});
