import test from 'node:test';
import assert from 'node:assert/strict';
import {UI} from '../src/ui.js';
test('global UI disable preserves archive choices and only changes existing injection setting',async()=>{
 const settings={enabled:true,inject:true},archive={entries:[{id:'a',active:true},{id:'b',active:false}]},before=JSON.stringify(archive);let saves=0,refreshes=0;
 const ui=new UI({settings:()=>settings,host:{context:()=>({saveSettingsDebounced:()=>saves++})}});
 ui.refresh=async()=>{refreshes++;};
 assert.equal(typeof ui.setMemoryEnabled,'function');
 await ui.setMemoryEnabled(false);assert.deepEqual(settings,{enabled:true,inject:false});assert.equal(JSON.stringify(archive),before);assert.equal(saves,1);assert.equal(refreshes,1);
 await ui.setMemoryEnabled(true);assert.deepEqual(settings,{enabled:true,inject:true});assert.equal(JSON.stringify(archive),before);
});
test('explicit UI enable can restore a globally disabled extension without touching prompts',async()=>{
 const settings={enabled:false,inject:false,prompts:{literal:'{{char}} unchanged'}},before=JSON.stringify(settings.prompts);
 const ui=new UI({settings:()=>settings,host:{context:()=>({saveSettingsDebounced:()=>{}})}});ui.refresh=async()=>{};
 assert.equal(typeof ui.setMemoryEnabled,'function');await ui.setMemoryEnabled(true);
 assert.equal(settings.enabled,true);assert.equal(settings.inject,true);assert.equal(JSON.stringify(settings.prompts),before);
});
