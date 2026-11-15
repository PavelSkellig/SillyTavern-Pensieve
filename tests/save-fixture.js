import {Engine} from '../src/engine.js';
import {KEY,defaults,clone} from '../src/core.js';
export function saveFixture(){
 let serial=0;const f={writes:0,reads:0,hides:0,reports:[],notes:[]},c={chatId:'save-test',characterId:0,characters:[{avatar:'save.png'}],chatMetadata:{},extensionSettings:{[KEY]:defaults()},chat:Array.from({length:8},(_,i)=>({name:i%2?'User':'Character',mes:'SOURCE '+i,is_user:!!(i%2),is_system:false,extra:{}}))};
 const host={context:()=>c,uuid:()=> 'save-'+(++serial),configuration:()=>c.chatId,count:async s=>s.length/4,limits:()=>({context:32000,output:2000}),generate:async()=> 'GENERATED MEMORY',lock:()=>()=>{},inject(){},refresh(){},report:(e,m)=>f.reports.push({error:e,meta:m}),notify:(type,text)=>f.notes.push({type,text}),
  savePolicy:{delays:[0,0],saveTimeout:20,readTimeout:20,tokensTimeout:30,delay:async()=>{}},
  async save(){f.writes++;if(f.write)return f.write();f.disk=clone({metadata:c.chatMetadata,messages:c.chat});},
  async read(){f.reads++;return f.read?f.read():clone(f.disk??{metadata:{},messages:c.chat});},
  async hide(start,end,unhide){f.hides++;for(let i=start;i<=end;i++)c.chat[i].is_system=!unhide;return host.save();}
 };
 f.c=c;f.host=host;f.e=new Engine(host);f.save=async()=>{const d=await f.e.generateSummary(1,2);f.draft=d;return f.e.saveDraft(d,{title:'Глава №1',text:d.text});};return f;
}
