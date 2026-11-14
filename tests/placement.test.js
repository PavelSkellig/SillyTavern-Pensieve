import test from 'node:test';import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';import {createHost} from '../src/host.js';import {defaults,fingerprint} from '../src/core.js';import {validateBackupSettings} from '../src/backup.js';
function fixture(settings=defaults()){
 const chat=[{name:'User',mes:'SOURCE',is_user:true,is_system:false,extra:{pensieve:{id:'source-id'}}},{name:'User',mes:'NEW',is_user:true,is_system:false,extra:{}}],c={chatId:'one',characterId:0,characters:[{avatar:'test.png'}],chat,chatMetadata:{},extensionSettings:settings?{pensieve:settings}:{},saveSettingsDebounced(){f.settingsWrites++;}};
 const f={c,settingsWrites:0,injected:null};f.host={context:()=>c,count:async text=>Math.ceil(text.length/4),limits:()=>({context:32000,output:2000}),inject:text=>f.injected=text};f.e=new Engine(f.host);c.chatMetadata.pensieve={version:1,owner:f.e.key(),revision:1,pending:null,entries:[{id:'saved',type:'summary',title:'Глава №1',text:'ACTIVE_BODY',active:true,version:1,order:0,createdAt:'2026',updatedAt:'2026',history:[],summaryIds:[],sources:[{id:'source-id',hash:fingerprint(chat[0]),index:0,previousHidden:false}]}]};return f;
}
test('new installation uses native after-main placement, plain Echo template and system role',()=>{
 const f=fixture(null),s=f.e.settings();const calls=[];f.c.setExtensionPrompt=(...args)=>calls.push(args);const h=createHost(()=>f.c,{},{});h.inject('BODY');assert.equal(calls[0][2],0);assert.equal(calls[0][5],0);assert.equal(calls[0][1],'BODY');assert.equal(s.template,'{{memory_echo}}');assert.equal(s.depth,4);
});
for(const position of [0,1,2])test(`legacy placement ${position} and global memory state are retained`,()=>{
 const s=defaults();Object.assign(s,{position,depth:7,inject:false});delete s.role;delete s.template;const f=fixture(s);f.e.settings();assert.equal(s.position,position);assert.equal(s.depth,7);assert.equal(s.inject,false);assert.equal(s.role,0);assert.equal(s.template,'{{memory_echo}}');assert.equal(f.settingsWrites,1);f.e.settings();assert.equal(f.settingsWrites,1);
});
test('native injection receives selected position/depth/role and template Echo is internal and single-use',()=>{
 const f=fixture(),calls=[];f.c.setExtensionPrompt=(...args)=>calls.push(args);const h=createHost(()=>f.c,{},{});
 Object.assign(f.c.extensionSettings.pensieve,{position:1,depth:0,role:2,template:'[Past {{memory_echo}} | {{memory_echo}}]'});h.inject('MEMORY');assert.deepEqual(calls.at(-1).slice(1),['[Past MEMORY | ]',1,0,false,2]);
 f.c.extensionSettings.pensieve.position=2;h.inject('MEMORY');assert.equal(calls.at(-1)[5],0);f.c.extensionSettings.pensieve.position=-1;h.inject('MEMORY');assert.equal(calls.at(-1)[1],'');
 f.c.extensionSettings.pensieve.position=0;f.c.extensionSettings.pensieve.template='[Past]';h.inject('MEMORY');assert.equal(calls.at(-1)[1],'[Past]\nMEMORY');f.c.extensionSettings.pensieve.template='';h.inject('MEMORY');assert.equal(calls.at(-1)[1],'MEMORY');
});
test('none mode keeps active memory available but leaves request sources and automatic prompt untouched',async()=>{
 const f=fixture();f.e.settings().position=-1;const request=f.c.chat.map(m=>({...m})),before=JSON.stringify([request,f.c.chat,f.c.chatMetadata]);const memory=await f.e.prepareContext(request);assert.equal(memory.enabled,true);assert.ok(memory.text.includes('ACTIVE_BODY'));assert.equal(f.injected,'');assert.equal(JSON.stringify([request,f.c.chat,f.c.chatMetadata]),before);
});
test('macro snapshot is current-chat-only and invalidates on edits or setting changes',async()=>{
 const f=fixture();await f.e.refreshMemory();assert.ok(f.e.peekMemory().text.includes('ACTIVE_BODY'));f.c.chatMetadata.pensieve.revision++;assert.equal(f.e.peekMemory(),null);await f.e.refreshMemory();f.e.settings().tokenLimit=1;assert.equal(f.e.peekMemory(),null);f.e.settings().tokenLimit=6000;await f.e.refreshMemory();f.c.chatId='other';assert.equal(f.e.peekMemory(),null);
});
test('legacy backups get compatible defaults and new placement fields roundtrip without changing other settings',()=>{
 const old=defaults();delete old.role;delete old.template;old.position=1;const result=validateBackupSettings(old);assert.equal(result.role,0);assert.equal(result.template,'');assert.equal(result.position,1);
 const next={...old,position:-1,role:1,template:'[{{memory_echo}}]'};const {prompts,...expected}=next;assert.deepEqual(validateBackupSettings(next),expected);for(const patch of [{position:99},{role:3},{template:5}])assert.throws(()=>validateBackupSettings({...next,...patch}));
});

test('blank template is filled once while custom templates and later deliberate clears are retained',()=>{for(const template of ['', 'CUSTOM {{memory_echo}}']){const s=defaults();s.template=template;const f=fixture(s);f.e.settings();assert.equal(s.template,template||'{{memory_echo}}');s.template='';f.e.settings();assert.equal(s.template,'');assert.equal(f.settingsWrites,1);}});
