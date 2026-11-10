import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHost} from '../src/host.js';
function setup(api='openai') {
 const eventSource=new EventEmitter(),c={mainApi:api,chatId:'story',characterId:0,groupId:null,characters:[{name:'Test',avatar:'test.png'}],extensionSettings:{},uuidv4:()=> 'nonce',eventSource,eventTypes:{CHAT_COMPLETION_PROMPT_READY:'cc',GENERATE_AFTER_COMBINE_PROMPTS:'tc'},getRequestHeaders:()=>({'Content-Type':'application/json'})};
 let payload;
 c.generateRawData=async options=>{payload=api==='openai'?{chat:options.prompt}:{prompt:options.prompt[0].content};eventSource.emit(api==='openai'?'cc':'tc',payload);return {choices:[{message:{content:'raw {{char}}'}}]}};
 const core={extractMessageFromData:d=>d.choices[0].message.content};
 return {c,host:createHost(()=>c,core,{}),get payload(){return payload}};
}
test('raw chat request preserves user prompt, literal macros and only selected input',async()=>{
 const f=setup();assert.equal(await f.host.generate('Точное {{char}}','Имя:\n{{user}}'),'raw {{char}}');
 assert.deepEqual(f.payload.chat,[{role:'system',content:'Точное {{char}}'},{role:'user',content:'Имя:\n{{user}}'}]);assert.equal(f.c.eventSource.listenerCount('cc'),0);
});
test('text completion preserves literal source and prompt',async()=>{
 const f=setup('textgenerationwebui');await f.host.generate('Промпт {{char}}','Данные {{user}}');assert.equal(f.payload.prompt,'Промпт {{char}}\n\nДанные {{user}}');
});
test('nonce guard never modifies another extension request',async()=>{
 const f=setup();let alien;
 f.c.generateRawData=async options=>{alien={chat:[{role:'user',content:'other'}]};f.c.eventSource.emit('cc',alien);const p={chat:options.prompt};f.c.eventSource.emit('cc',p);return {choices:[{message:{content:'OK'}}]}};
 await f.host.generate('prompt','source');assert.equal(alien.chat[0].content,'other');
});
test('truncated output is rejected; listeners are removed on error',async()=>{
 const f=setup();f.c.generateRawData=async o=>{f.c.eventSource.emit('cc',{chat:o.prompt});return {choices:[{finish_reason:'length'}]}};
 await assert.rejects(()=>f.host.generate('p','s'),/обрезан/);assert.equal(f.c.eventSource.listenerCount('cc'),0);
});
test('group readback uses group chat ID and metadata header',async()=>{
 const f=setup();f.c.groupId='g';let request;
 const host=createHost(()=>f.c,{}, {}, async(url,options)=>{request={url,body:JSON.parse(options.body)};return {ok:true,json:async()=>[{chat_metadata:{pensieve:{entries:[]}}},{mes:'test'}]}});
 const disk=await host.read();assert.equal(request.url,'/api/chats/group/get');assert.deepEqual(request.body,{id:'story'});assert.equal(disk.messages.length,1);
});

test('settings persistence verifies actual ST readback instead of trusting a debounce or swallowed error',async()=>{
 const c={getRequestHeaders:()=>({}),extensionSettings:{pensieve:{inject:true}}};let stored={inject:false},writes=0;const core={saveSettings:async()=>{writes++;}},host=createHost(()=>c,core,{},async()=>({ok:true,json:async()=>({settings:JSON.stringify({extension_settings:{pensieve:stored}})})}));await assert.rejects(()=>host.saveSettings({inject:true}),/настрой|сохран/i);core.saveSettings=async()=>{writes++;stored={inject:true};};await host.saveSettings({inject:true});assert.equal(writes,2);
});
