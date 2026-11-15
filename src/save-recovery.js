import {KEY,clone,fingerprint,validateArchive,bytes,MAX_ARCHIVE_BYTES,inspectSources} from './core.js';
import {tagError} from './diagnostics.js';

export const SAVE_POLICY=Object.freeze({delays:[200,600],saveTimeout:15000,readTimeout:5000,tokensTimeout:30000});
export function bounded(fn,ms,onTimeout=()=>{}){
 let timer;return Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>timer=setTimeout(()=>{onTimeout();reject(Object.assign(Error('Время проверки операции истекло. Результат пока неизвестен.'),{name:'TimeoutError'}));},ms))]).finally(()=>clearTimeout(timer));
}
export async function verifyWrite({write,read,check,exists=()=>false,assert=()=>{},onCheck=()=>{},onWriteTimeout=()=>{},policy={}}){
 const p={...SAVE_POLICY,...policy},delay=p.delay??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));let writeError,lastError,lastCheck=null,outcome='unknown',readAccepted=false;
 try{await bounded(write,p.saveTimeout,onWriteTimeout);}catch(error){writeError=error;}assert();
 for(let i=0;i<3;i++){
  if(i)await delay(p.delays[i-1]??p.delays.at(-1)??0);assert();readAccepted=false;
  try{const disk=await bounded(read,p.readTimeout);assert();lastCheck=Date.now();const matched=check(disk),found=exists(disk);readAccepted=true;
   if(matched){onCheck({outcome:'saved',attempt:i+1,lastCheck});return disk;}
   outcome=found||writeError?.name==='TimeoutError'?'unknown':'missing';
  }catch(error){assert();lastError=error;outcome='unknown';lastCheck=Date.now();readAccepted=false;}
  onCheck({outcome,attempt:i+1,lastCheck});
 }
 const error=writeError??lastError??Error('Не удалось подтвердить сохранение на сервере. Источники не будут исключены без проверки. Проверьте соединение и используйте «Повторить сохранение / восстановление».');
 throw tagError(error,{stage:'save',reason:'save-unconfirmed',saveOutcome:outcome,lastCheck,readAccepted});
}
const ordered=value=>value instanceof Date?value.toJSON():Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const sameSavedValue=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
export const archiveStamp=archive=>fingerprint({name:KEY,mes:JSON.stringify(ordered(archive))});
export const archiveBody=archive=>Object.fromEntries(Object.entries(archive??{}).filter(([key])=>!['pending','revision'].includes(key)));
const invalid=()=>tagError(Error('Повреждён журнал незавершённого сохранения. Данные не удалены.'),{code:'DATA-006',stage:'read',reason:'invalid-data'});
const id=value=>typeof value==='string'&&!!value&&value.length<=200;
const exclusionValid=value=>value===null||value&&typeof value==='object'&&typeof value.previousHidden==='boolean'&&Array.isArray(value.owners)&&value.owners.every(id)&&new Set(value.owners).size===value.owners.length;
const stateValid=(states,sources)=>Array.isArray(states)&&states.length<=sources.length&&new Set(states.map(s=>s?.id)).size===states.length&&states.every(s=>s&&sources.includes(s.id)&&typeof s.hidden==='boolean'&&exclusionValid(s.exclusion));
const valid=note=>{
 const fields=['version','owner','operationId','entryId','entryVersion','base','archive','createdAt','intent','sourceState','previousActive','write'];
 if(!note||note.version!==1||typeof note.owner!=='string'||!note.owner||!id(note.operationId)||!id(note.entryId)||!Number.isSafeInteger(note.entryVersion)||note.entryVersion<1||typeof note.base!=='string'||!(note.base==='legacy'||/^[a-f0-9]{32}$/.test(note.base))||typeof note.createdAt!=='string'||note.createdAt.length>100||!Number.isFinite(Date.parse(note.createdAt))||bytes(note)>MAX_ARCHIVE_BYTES*2||Object.keys(note).some(k=>!fields.includes(k)))throw invalid();
 validateArchive(note.archive);const a=note.archive,p=a.pending,e=a.entries.find(e=>e.id===note.entryId&&e.version===note.entryVersion);
 if(a.owner!==note.owner||!p||!e||p.entryId!==note.entryId||p.operationId!==note.operationId||!['hide','commit',...(note.intent==='restore'?['restore']:[])].includes(p.type)||Object.keys(p).some(k=>!['type','entryId','operationId'].includes(k))||note.intent!==undefined&&note.intent!=='restore')throw invalid();
 const sources=e.sources.map(s=>s.id);
 if(!stateValid(note.sourceState,sources)||note.sourceState.length!==sources.length||!Array.isArray(note.previousActive)||new Set(note.previousActive.map(x=>x?.id)).size!==note.previousActive.length||!note.previousActive.every(x=>x&&id(x.id)&&typeof x.active==='boolean'&&Number.isSafeInteger(x.version)&&x.version>0&&a.entries.some(e=>e.id===x.id)))throw invalid();
 if(note.write&&(!id(note.write.id)||!['pending','settled'].includes(note.write.state)||!['save','hide','unhide'].includes(note.write.kind)||!(/^[a-f0-9]{32}$/.test(note.write.archive))||!(/^[a-f0-9]{32}$/.test(note.write.chat))||!stateValid(note.write.sources,sources)))throw invalid();
 return clone(note);
};
const queues=new WeakMap();
function serial(storage,key,fn){let map=queues.get(storage);if(!map)queues.set(storage,map=new Map());const next=(map.get(key)??Promise.resolve()).catch(()=>{}).then(fn);map.set(key,next);return next.finally(()=>{if(map.get(key)===next)map.delete(key);});}
/** Atomic compare/update in Web Locks, or a native IndexedDB transaction across tabs. */
export function nativeRecoveryStorage(storage){
 const writeName=key=>'pensieve-native:'+storage.config().name+':'+key;
 return {getItem:key=>storage.getItem(key),writeExclusive:(key,fn)=>globalThis.navigator?.locks?.request?globalThis.navigator.locks.request(writeName(key),fn):fn(),writeHeld:async key=>{const locks=globalThis.navigator?.locks;if(!locks?.query)return true;return (await locks.query()).held.some(lock=>lock.name===writeName(key));},atomic:async(key,change)=>{
  await storage.ready();const cfg=storage.config(),locks=globalThis.navigator?.locks;
  if(locks?.request)return locks.request('pensieve-save:'+cfg.name+':'+key,async()=>{const action=change(await storage.getItem(key));if(action.delete)await storage.removeItem(key);else if(action.put)await storage.setItem(key,action.put);return action.result;});
  if(storage.driver()!==(storage.INDEXEDDB??'asyncStorage')||!globalThis.indexedDB)throw tagError(Error('Не удалось открыть защищённый журнал восстановления.'),{stage:'save',reason:'storage'});
  return new Promise((resolve,reject)=>{const open=indexedDB.open(cfg.name);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;let failure,action;let tx;try{tx=db.transaction(cfg.storeName,'readwrite');const table=tx.objectStore(cfg.storeName),get=table.get(key);get.onsuccess=()=>{try{action=change(get.result??null);if(action.delete)table.delete(key);else if(action.put)table.put(action.put,key);}catch(error){failure=error;tx.abort();}};tx.oncomplete=()=>{db.close();resolve(action?.result);};tx.onabort=tx.onerror=()=>{db.close();reject(failure??tx.error);};}catch(error){db.close();reject(error);}};});
 }};
}
/** Only one outstanding account/chat save. Keys are pinned before the first await. */
export class SaveJournal {
 constructor(storage=null,getScope=()=> 'local'){
  if(!storage){const map=new Map();storage={getItem:async k=>map.get(k)??null,setItem:async(k,v)=>map.set(k,clone(v)),removeItem:async k=>map.delete(k)};}
  this.storage=storage;this.getScope=getScope;
 }
 key(owner){return 'pending:'+fingerprint({name:String(this.getScope()),mes:owner});}
 read(raw,owner){if(raw==null)return null;const note=valid(raw);if(note.owner!==owner)throw invalid();return note;}
 async get(owner,key=this.key(owner)){return this.read(await this.storage.getItem(key),owner);}
 atomic(key,change){return this.storage.atomic?this.storage.atomic(key,change):serial(this.storage,key,async()=>{const action=change(await this.storage.getItem(key));if(action.delete)await this.storage.removeItem(key);else if(action.put)await this.storage.setItem(key,action.put);return action.result;});}
 async put(owner,note,key=this.key(owner)){const value=valid(note);if(value.owner!==owner)throw invalid();return this.atomic(key,raw=>{const current=this.read(raw,owner);if(current&&(current.operationId!==value.operationId||current.write?.state==='pending'&&(value.write?.id!==current.write.id||value.write?.state!=='pending')))throw tagError(Error('Другая запись ожидает восстановления. Сначала завершите её проверку.'),{code:'INT-003',stage:'save',reason:'pending'});return {put:value};});}
 remove(owner,operationId,key=this.key(owner)){return this.atomic(key,raw=>{const note=this.read(raw,owner);if(note?.operationId===operationId&&note.write?.state==='pending')throw tagError(Error('Предыдущая запись ещё выполняется.'),{code:'INT-003',stage:'save',reason:'pending'});return {delete:note?.operationId===operationId};});}
 writeExclusive(key,fn){return this.storage.writeExclusive?this.storage.writeExclusive(key,fn):fn();}
 writeHeld(key){return this.storage.writeHeld?this.storage.writeHeld(key):Promise.resolve(false);}
 settle(owner,operationId,writeId,key=this.key(owner)){return this.atomic(key,raw=>{const note=this.read(raw,owner);if(note?.operationId!==operationId||note.write?.id!==writeId)return {};note.write.state='settled';return {put:note};});}
}
export function captureSourceState(entry,chat){const matches=new Map(chat.map(m=>[m.extra?.[KEY]?.id,m]));return entry.sources.map(s=>{const m=matches.get(s.id);return {id:s.id,hidden:s.previousHidden,exclusion:clone(m?.extra?.[KEY]?.exclusion??null)};});}
export function expectedSourceState(note,restoring=false){const e=note.archive.entries.find(e=>e.id===note.entryId),hide=note.archive.pending.type==='hide';return note.sourceState.map(s=>{let exclusion=clone(s.exclusion),hidden=s.hidden;if(restoring){if(exclusion){exclusion.owners=exclusion.owners.filter(id=>id!==e.id);hidden=exclusion.owners.length?true:exclusion.previousHidden;if(!exclusion.owners.length)exclusion=null;}}else if(hide){hidden=true;if(exclusion){if(!exclusion.owners.includes(e.id))exclusion.owners.push(e.id);}else if(!s.hidden)exclusion={owners:[e.id],previousHidden:false};}return {id:s.id,hidden,exclusion};});}
export function sourceProof(chat,entry,override=new Map()){const matches=new Map(chat.map(m=>[m.extra?.[KEY]?.id,m]));return entry.sources.flatMap(s=>{const m=matches.get(s.id);return m?[{id:s.id,hidden:override.has(s.id)?override.get(s.id):!!m.is_system,exclusion:clone(m.extra?.[KEY]?.exclusion??null)}]:[];});}
export function matchesSourceProof(chat,proof){const byId=new Map(chat.map(m=>[m.extra?.[KEY]?.id,m]));return proof.every(s=>{const m=byId.get(s.id);return m&&!!m.is_system===s.hidden&&sameSavedValue(m.extra?.[KEY]?.exclusion??null,s.exclusion);});}
export function sourceOutcome(note,chat,restoring=false){const e=note.archive.entries.find(e=>e.id===note.entryId),check=inspectSources(chat,e.sources);return !check.issues.length&&matchesSourceProof(chat,expectedSourceState(note,restoring));}
/** Hashes chat content; receipts retain only this hash and ownership flags, never chat text. */
export function chatStamp(chat,note){const e=note.archive.entries.find(e=>e.id===note.entryId),sources=new Map(e.sources.map(s=>[s.id,s])),states=new Map(note.sourceState.map(s=>[s.id,s]));const normalized=chat.map((message,index)=>{const m=clone(message),id=m.extra?.[KEY]?.id,source=sources.get(id)??(!id?e.sources.find(s=>s.index===index):null);if(source){const state=states.get(source.id),p=m.extra?.[KEY];if(p){if(p.id===source.id)delete p.id;if(p.exclusion?.owners?.includes(e.id)){p.exclusion.owners=p.exclusion.owners.filter(id=>id!==e.id);if(!p.exclusion.owners.length)delete p.exclusion;}if(!Object.keys(p).length)delete m.extra[KEY];}m.is_system=state?.exclusion?state.exclusion.owners.some(id=>id!==e.id)||state.exclusion.previousHidden:!!state?.hidden;}if(m.extra&&!Object.keys(m.extra).length)delete m.extra;return m;});return fingerprint({name:'chat',mes:JSON.stringify(ordered(normalized))});}
