import {KEY,clone,fingerprint,validateArchive,bytes,MAX_ARCHIVE_BYTES} from './core.js';
import {tagError} from './diagnostics.js';

export const SAVE_POLICY=Object.freeze({delays:[200,600],saveTimeout:15000,readTimeout:5000,tokensTimeout:30000});
export function bounded(fn,ms){
 let timer;return Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>timer=setTimeout(()=>reject(Object.assign(Error('Время проверки операции истекло. Результат пока неизвестен.'),{name:'TimeoutError'})),ms))]).finally(()=>clearTimeout(timer));
}
export async function verifyWrite({write,read,check,exists=()=>false,assert=()=>{},onCheck=()=>{},policy={}}){
 const p={...SAVE_POLICY,...policy},delay=p.delay??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));let writeError,lastError,lastCheck=null,outcome='unknown';
 try{await bounded(write,p.saveTimeout);}catch(error){writeError=error;}assert();
 for(let i=0;i<3;i++){
  if(i)await delay(p.delays[i-1]??p.delays.at(-1)??0);assert();
  try{const disk=await bounded(read,p.readTimeout);assert();lastCheck=Date.now();
   if(check(disk)){onCheck({outcome:'saved',attempt:i+1,lastCheck});return disk;}
   outcome=exists(disk)||writeError?.name==='TimeoutError'?'unknown':'missing';
  }catch(error){assert();lastError=error;outcome='unknown';lastCheck=Date.now();}
  onCheck({outcome,attempt:i+1,lastCheck});
 }
 const error=writeError??lastError??Error('Не удалось подтвердить сохранение на сервере. Источники не будут исключены без проверки. Проверьте соединение и используйте «Повторить сохранение / восстановление».');
 throw tagError(error,{stage:'save',reason:'save-unconfirmed',saveOutcome:outcome,lastCheck});
}
const valid=note=>{
 if(!note||note.version!==1||typeof note.owner!=='string'||!note.owner||typeof note.operationId!=='string'||!note.operationId||note.operationId.length>200||typeof note.entryId!=='string'||!Number.isSafeInteger(note.entryVersion)||note.entryVersion<1||typeof note.base!=='string'||typeof note.createdAt!=='string'||bytes(note)>MAX_ARCHIVE_BYTES*2)throw tagError(Error('Повреждён журнал незавершённого сохранения. Данные не удалены.'),{code:'DATA-006',stage:'read',reason:'invalid-data'});
 validateArchive(note.archive);if(!note.archive.entries.some(e=>e.id===note.entryId&&e.version===note.entryVersion))throw tagError(Error('В журнале сохранения отсутствует ожидаемая запись.'),{code:'DATA-006',stage:'read',reason:'invalid-data'});return clone(note);
};
/** Temporary outstanding save only. The primary archive remains native chat metadata. */
export class SaveJournal {
 constructor(storage=null,getScope=()=> 'local'){
  if(!storage){const map=new Map();storage={getItem:async k=>map.get(k)??null,setItem:async(k,v)=>map.set(k,clone(v)),removeItem:async k=>map.delete(k)};}
  this.storage=storage;this.getScope=getScope;
 }
 key(owner){return 'pending:'+fingerprint({name:String(this.getScope()),mes:owner});}
 async get(owner){const note=await this.storage.getItem(this.key(owner));if(note==null)return null;const result=valid(note);if(result.owner!==owner)throw tagError(Error('Журнал восстановления принадлежит другому чату.'),{code:'DATA-006',stage:'read',reason:'invalid-data'});return result;}
 async put(owner,note){const key=this.key(owner),current=await this.get(owner);if(current&&current.operationId!==note.operationId)throw tagError(Error('Другая запись ожидает восстановления. Сначала завершите её проверку.'),{code:'INT-003',stage:'save',reason:'pending'});const value=valid(note);if(value.owner!==owner)throw Error('Неверный чат журнала сохранения.');await this.storage.setItem(key,value);}
 async remove(owner,operationId){const current=await this.get(owner);if(current?.operationId===operationId)await this.storage.removeItem(this.key(owner));}
}
export const archiveStamp=archive=>fingerprint({name:KEY,mes:JSON.stringify(archive)});
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const sameSavedValue=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
