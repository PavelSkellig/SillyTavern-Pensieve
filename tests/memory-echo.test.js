import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {Engine} from '../src/engine.js';import {createHost} from '../src/host.js';import {defaults,fingerprint} from '../src/core.js';import {MemoryEcho} from '../src/memory-echo.js';
function fixture(position=-1){let id=0;const c={chatId:'one',characterId:0,characters:[{avatar:'test.png'}],chat:[{name:'Hero',mes:'OLD_RAW',is_user:false,is_system:false,extra:{pensieve:{id:'old'}}},{name:'User',mes:'NEW_RAW',is_user:true,is_system:false,extra:{}}],chatMetadata:{},extensionSettings:{pensieve:{...defaults(),position,template:''}},mainApi:'openai',chatCompletionSettings:{openai_max_context:32000,openai_max_tokens:2000},uuidv4:()=> 'id'+(++id),getTokenCountAsync:async text=>Math.ceil(text.length/4),eventSource:new EventEmitter(),eventTypes:Object.fromEntries(['GENERATION_AFTER_COMMANDS','GENERATE_AFTER_DATA','CHAT_COMPLETION_SETTINGS_READY','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED'].map(x=>[x,x])),setExtensionPrompt(...args){f.injected=args[1];},saveSettingsDebounced(){}};const f={c,injected:'',macro:null};const h=createHost(()=>c,{amount_gen:2000},{}),e=new Engine(h);c.chatMetadata.pensieve={version:1,owner:e.key(),revision:1,pending:null,entries:[{id:'saved',type:'summary',title:'Глава №1',text:'CANONICAL_MEMORY',order:0,active:true,version:1,history:[],createdAt:'2026',updatedAt:'2026',summaryIds:[],sources:[{id:'old',hash:fingerprint(c.chat[0]),index:0,previousHidden:false}]}]};const echo=new MemoryEcho(e);echo.attach(handler=>f.macro=handler);return Object.assign(f,{h,e,echo});}
test('macro-only delivery suppresses only covered request sources and leaves original messages unchanged',async()=>{
 const f=fixture(),before=JSON.stringify([f.c.chat,f.c.chatMetadata]);await f.echo.start('normal');const request=[...f.c.chat];await f.echo.prepare(request,'normal');const macro=f.macro(),data={prompt:[{role:'system',content:'HERE '+macro+' END '+f.macro()},...request.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))]};await f.echo.finalize(data);assert.deepEqual(data.prompt,[{role:'system',content:'HERE '+f.e.peekMemory().text+' END '},{role:'user',content:'NEW_RAW'}]);assert.equal(JSON.stringify([f.c.chat,f.c.chatMetadata]),before);
});
test('macro absent in NONE preserves sources and blocked memory does not block unrelated normal requests',async()=>{
 const f=fixture();f.c.extensionSettings.pensieve.tokenLimit=1;await f.echo.start('normal');const request=[...f.c.chat];await f.echo.prepare(request,'normal');const data={prompt:request.map(m=>({role:'user',content:m.mes}))};await f.echo.finalize(data);assert.deepEqual(data.prompt,[{role:'user',content:'OLD_RAW'},{role:'user',content:'NEW_RAW'}]);
});
test('auto template remains automatic, actual macro overrides it, and unused macro evaluations do not',async()=>{
 for(const useMacro of [false,true]){const f=fixture(0);f.c.extensionSettings.pensieve.template='[PAST {{memory_echo}} / {{memory_echo}}]';await f.echo.start('normal');const request=f.c.chat.map(m=>({...m}));await f.echo.prepare(request,'normal');const auto=f.injected,macro=f.macro(),data={prompt:[{role:'system',content:auto},{role:'system',content:useMacro?'USER '+macro:'NO_MACRO'},...request.map(m=>({role:'user',content:m.mes}))]};await f.echo.finalize(data);const text=data.prompt.map(m=>m.content).join('\n'),canonical=f.e.peekMemory().text;assert.equal(text.split('CANONICAL_MEMORY').length-1,1);assert.ok(!text.includes('OLD_RAW'));assert.ok(useMacro?text.includes('USER '+canonical)&&!text.includes('[PAST'):text.includes('[PAST '+canonical+' / ]'));}
});
test('native registration is single, no-chat/empty snapshots are empty, and scopes invalidate across chat/edit changes',async()=>{
 const f=fixture();let registered=0;f.echo.attach(()=>registered++);assert.equal(registered,0);await f.e.refreshMemory();assert.equal(f.macro(),'{{memory_echo}}');await f.echo.start('normal');const request=[...f.c.chat];await f.echo.prepare(request);const data={prompt:[{role:'system',content:f.macro()}]};f.c.chatMetadata.pensieve.revision++;await assert.rejects(()=>f.echo.finalize(data),/измен|повтор/i);f.echo.end();f.c.chatId=null;await f.echo.start('quiet');assert.equal(f.macro(),'{{memory_echo}}');
});
test('covered Continue with actual macro is guarded, but NONE without macro continues without marker writeback',async()=>{
 for(const useMacro of [false,true]){const f=fixture();f.c.chat.pop();await f.echo.start('continue');const request=[...f.c.chat];await f.echo.prepare(request,'continue');assert.equal(request.at(-1).mes,'OLD_RAW');const data={prompt:[...(useMacro?[{role:'system',content:f.macro()}]:[]),{role:'assistant',content:request[0].mes}]};if(useMacro)await assert.rejects(()=>f.echo.finalize(data),/допис|продолж/i);else{await f.echo.finalize(data);assert.equal(data.prompt.at(-1).content,'OLD_RAW');}assert.equal(f.c.chat[0].mes,'OLD_RAW');}
});

test('early live-chat evaluation preserves literal macros even with disabled or empty memory',async()=>{
 for(const mode of ['disabled','empty']){const f=fixture();if(mode==='disabled')f.c.extensionSettings.pensieve.inject=false;else f.c.chatMetadata.pensieve.entries=[];await f.echo.start('normal');assert.equal(f.macro(),'{{memory_echo}}');await f.echo.prepare([...f.c.chat]);const data={prompt:[{role:'system',content:f.macro()}]};await f.echo.finalize(data);assert.equal(JSON.stringify(data.prompt).includes('memory_echo'),false);}
});

test('native-boundary cancellation is explicit, NONE has no pre-budget markers, NovelAI input is accepted',async()=>{
 const f=fixture();let stopped=0;f.c.stopGeneration=()=>stopped++;await f.echo.start();const request=[...f.c.chat];await f.echo.prepare(request);assert.equal(request[0].mes,'OLD_RAW');f.echo.fail(Error('late failure'));assert.equal(stopped,1);f.echo.end();await f.echo.start();await f.echo.prepare([...f.c.chat]);const data={input:'HERE '+f.macro()};await f.echo.finalize(data);assert.ok(data.input.includes('CANONICAL_MEMORY'));
});
test('raw/dry macro callbacks preserve live text and do not duplicate or leak request state',async()=>{
 const f=fixture();await f.e.refreshMemory();assert.equal(f.macro(),'{{memory_echo}}');const data={messages:[{role:'system',content:f.macro()+' / '+f.macro()}]};await f.echo.finalizeRaw(data);assert.equal(JSON.stringify(data).split('CANONICAL_MEMORY').length-1,1);assert.ok(!JSON.stringify(data).includes('<!--pv'));
});
test('complete source records include tool calls/results and TC role frames only on delivery',async()=>{
 const f=fixture();f.c.chat[0].extra.tool_invocations=[{id:'tool-old',name:'lookup',parameters:{},result:'OLD_TOOL_RESULT'}];await f.echo.start();await f.echo.prepare([...f.c.chat]);f.echo.captureFrames({finalMesSend:[{message:'Hero: OLD_RAW\n'},{message:'User: NEW_RAW'}]});const data={prompt:'SYSTEM '+f.macro()+'\nHero: OLD_RAW\nUser: NEW_RAW'};await f.echo.finalize(data);assert.ok(!data.prompt.includes('Hero:'));
 f.echo.end();await f.echo.start();await f.echo.prepare([...f.c.chat]);const cc={messages:[{role:'system',content:f.macro()},{role:'assistant',tool_calls:[{id:'tool-old',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool-old',content:'OLD_TOOL_RESULT'},{role:'user',content:'NEW_RAW'}]};await f.echo.finalize(cc);assert.equal(cc.messages.length,2);
});

test('native scopes begin only at the interceptor, not offline/group wrappers or dry-run live substitution',()=>{
 const f=fixture();assert.equal(f.c.eventSource.listenerCount(f.c.eventTypes.GENERATION_AFTER_COMMANDS),0);assert.equal(f.echo.jobs.length,0);assert.equal(f.macro(),'{{memory_echo}}');
});

test('late native assistant prefill gets macro priority once and negative prompt participates in the same request',async()=>{
 const f=fixture(0);await f.echo.start();await f.echo.prepare([...f.c.chat]);const data={messages:[{role:'system',content:f.injected},{role:'user',content:'NEW_RAW'}]};await f.echo.finalize(data);data.assistant_prefill='LATE {{memory_echo}} {{memory_echo}}';await f.echo.resolveLate(data,f.echo.job);assert.equal(JSON.stringify(data).split('CANONICAL_MEMORY').length-1,1);assert.ok(data.assistant_prefill.includes('CANONICAL_MEMORY'));
 f.echo.end();f.c.extensionSettings.pensieve.position=-1;await f.echo.start();await f.echo.prepare([...f.c.chat]);const tc={prompt:'NORMAL',negative_prompt:'NEG {{memory_echo}} {{memory_echo}}'};await f.echo.finalize(tc);assert.equal(JSON.stringify(tc).split('CANONICAL_MEMORY').length-1,1);assert.ok(tc.negative_prompt.includes('CANONICAL_MEMORY'));
});

test('no-chat quiet requests need no source identity set and remain usable',async()=>{const f=fixture();f.c.chatId=null;await f.echo.prepare([{mes:'UTILITY'}],'quiet');const data={prompt:[{role:'user',content:'UTILITY'}]};await f.echo.finalize(data);assert.equal(data.prompt[0].content,'UTILITY');});

test('late exclusion aligns repeated source text to the actual ordered history, preserving new identical replies',async()=>{
 const f=fixture();f.c.chat.push({name:'Hero',mes:'OLD_RAW',is_user:false,extra:{pensieve:{id:'new'}}});await f.echo.start();await f.echo.prepare([...f.c.chat]);const data={messages:[{role:'system',content:f.macro()},{role:'assistant',content:'OLD_RAW'},{role:'user',content:'NEW_RAW'},{role:'assistant',content:'OLD_RAW'}]};await f.echo.finalize(data);assert.equal(data.messages.filter(m=>m.content==='OLD_RAW').length,1);assert.equal(data.messages.at(-1).content,'OLD_RAW');
});

test('NONE without an actual macro preserves the exact native payload including empty content records',async()=>{const f=fixture();await f.echo.prepare([...f.c.chat]);const data={messages:[{role:'user',content:''},{role:'assistant',content:'OLD_RAW'},{role:'user',content:'NEW_RAW'}]},before=JSON.stringify(data);await f.echo.finalize(data);assert.equal(JSON.stringify(data),before);});

test('covered image-only history is removed as a complete multimodal source only when memory is delivered',async()=>{
 for(const macro of [false,true]){const f=fixture();f.c.chat[0].mes='';f.c.chat[0].extra.media=[{url:'image.png',type:'image'}];f.c.chatMetadata.pensieve.entries[0].sources[0].hash=fingerprint(f.c.chat[0]);await f.echo.prepare([...f.c.chat]);const image={role:'assistant',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]},data={messages:[...(macro?[{role:'system',content:f.macro()}]:[]),image,{role:'user',content:'NEW_RAW'}]};await f.echo.finalize(data);assert.equal(data.messages.some(m=>Array.isArray(m.content)),!macro);}
});
