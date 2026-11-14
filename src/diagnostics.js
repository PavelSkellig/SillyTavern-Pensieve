import {VERSION} from './version.js';
import {fingerprint} from './core.js';
import {ERRORS,STAGES,OPERATIONS,REASONS} from './diagnostic-catalog.js';
const tags=new WeakMap(),classes=new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError','TimeoutError','AbortError','AggregateError']);
const files=new Set(['index.js','engine.js','host.js','core.js','ui.js','memory-echo.js','prompt-envelope.js','placement.js','source-links.js','order.js','hierarchy.js','backup.js','prompt-presets.js','builtin-prompts.js','generation-view.js','diagnostics.js','diagnostic-catalog.js','diagnostics-view.js','version.js','script.js','openai.js','macros.js','macro-system.js','eventemitter.js']);
const apiCodes=new Set(['context_length_exceeded','max_tokens_exceeded','token_limit_exceeded','invalid_api_key','authentication_error','insufficient_quota','rate_limit_exceeded','rate_limit_error','request_timeout','timeout']);
const severities=new Set(['error','warning','info']),statuses=new Set(['error','blocked','canceled','warning']),generationStates=new Set(['idle','running','saving','canceled','error','unknown']);
const read=(o,k)=>{try{return o?.[k];}catch{return undefined;}};
const version=value=>typeof value==='string'?value.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/)?.[0]??null:null;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e7?value:null;
const objectError=error=>error&&(typeof error==='object'||typeof error==='function')?error:Error('Ошибка без объекта исключения');
const enumValue=(map,value,fallback)=>Object.hasOwn(map,value)?value:fallback;
export function tagError(error,meta={}){
    error=objectError(error);const old=tags.get(error)??{},merged={...meta,...old};
    if(old.operation==='unknown'&&meta.operation)merged.operation=meta.operation;
    tags.set(error,merged);return error;
}
export function trace(meta,fn){try{const result=fn();return result&&typeof result.then==='function'?Promise.resolve(result).catch(error=>{throw tagError(error,meta);}):result;}catch(error){throw tagError(error,meta);}}
export function errorMeta(error){return {...(tags.get(objectError(error))??{})};}
function safeFrames(stack){
    if(typeof stack!=='string')return [];
    return stack.slice(0,16000).split('\n').slice(1,25).flatMap(line=>{
        if(!/^\s*at\s/.test(line)&&!line.includes('@'))return [];
        const m=line.match(/(?:^|[\/\\(])([A-Za-z0-9_-]+\.js):(\d{1,6}):(\d{1,6})(?:\)|\s|$)/);
        return m&&files.has(m[1])?[{file:m[1],line:Number(m[2]),column:Number(m[3])}]:[];
    }).slice(0,8);
}
function safeSnapshot(value={}){
    const active=value.active??{};
    return {mode:[-1,0,1,2].includes(value.mode)?value.mode:null,macroUsed:typeof value.macroUsed==='boolean'?value.macroUsed:null,active:Object.fromEntries(['episodes','chapters','parts','volumes'].map(k=>[k,count(active[k])])),generation:generationStates.has(value.generation)?value.generation:'unknown'};
}
function technical(entry){
    const parts=[entry.kind];if(entry.http)parts.push('HTTP '+entry.http);if(entry.apiCode)parts.push('API: '+entry.apiCode);
    if(entry.reason!=='unknown')parts.push(REASONS[entry.reason]);else parts.push('Исходное сообщение скрыто: может содержать личные данные.');
    return parts.join('; ');
}
function classify(error,meta){
    const name=read(error,'name'),kind=classes.has(name)?name:'Error',raw=typeof read(error,'message')==='string'?read(error,'message').slice(0,2048):'';
    let code=enumValue(ERRORS,meta.code,kind==='Error'?'INT-005':'INT-001'),reason=enumValue(REASONS,meta.reason,'unknown');
    const stage=enumValue(STAGES,meta.stage,ERRORS[code].stage),api=stage==='api';
    const rawCode=read(read(error,'error'),'code')??read(error,'code')??read(read(error,'error'),'type'),apiCode=api&&apiCodes.has(rawCode)?rawCode:null;
    let http=read(error,'status')??read(read(error,'response'),'status');if(!Number.isInteger(http)||http<100||http>599)http=api?Number(raw.match(/^Got response status (\d{3})$/)?.[1])||null:null;
    if(api){
        if(['context_length_exceeded','max_tokens_exceeded','token_limit_exceeded'].includes(apiCode)){code='GEN-002';reason='api-context';}
        else if(kind==='TimeoutError'||['request_timeout','timeout'].includes(apiCode)||[408,504].includes(http)){code='GEN-003';reason='api-timeout';}
        else if(kind==='AbortError'||raw==='Cancelled by stop event'||raw==='Clicked stop button'){code='GEN-006';if(reason!=='cancel-user')reason='cancel-unknown';}
        else if(['invalid_api_key','authentication_error'].includes(apiCode)||http===401||http===403)reason='api-auth';
        else if(['insufficient_quota','rate_limit_exceeded','rate_limit_error'].includes(apiCode)||http===429)reason='api-rate';
        else if(raw==='Failed to fetch'||raw==='NetworkError when attempting to fetch resource.')reason='network';
    }
    return {code,reason,stage,kind,http,apiCode,operation:enumValue(OPERATIONS,meta.operation,'unknown'),severity:severities.has(meta.severity)?meta.severity:code==='GEN-006'?'info':code==='UI-001'?'warning':'error',status:statuses.has(meta.status)?meta.status:code==='GEN-006'?'canceled':code==='UI-001'?'warning':'error',frames:safeFrames(read(error,'stack'))};
}
function validEntry(value){
    if(!value||!Object.hasOwn(ERRORS,value.code)||!Number.isFinite(value.time)||value.time<0||value.time>9e12)return null;
    const e={id:typeof value.id==='string'&&/^\d+-\d+$/.test(value.id)?value.id:'0-0',time:value.time,lastTime:Number.isFinite(value.lastTime)&&value.lastTime>=value.time&&value.lastTime<=9e12?value.lastTime:value.time,repeats:count(value.repeats)||1,code:value.code,reason:enumValue(REASONS,value.reason,'unknown'),stage:enumValue(STAGES,value.stage,ERRORS[value.code].stage),operation:enumValue(OPERATIONS,value.operation,'unknown'),kind:classes.has(value.kind)?value.kind:'Error',http:Number.isInteger(value.http)&&value.http>=100&&value.http<=599?value.http:null,apiCode:apiCodes.has(value.apiCode)?value.apiCode:null,severity:severities.has(value.severity)?value.severity:'error',status:statuses.has(value.status)?value.status:'error',version:version(value.version)??VERSION,stVersion:version(value.stVersion),...safeSnapshot(value),frames:Array.isArray(value.frames)?value.frames.filter(f=>files.has(f.file)&&Number.isInteger(f.line)&&f.line>=0&&f.line<1e6&&Number.isInteger(f.column)&&f.column>=0&&f.column<1e6).slice(0,8).map(f=>({file:f.file,line:f.line,column:f.column})):[]};
    e.technical=technical(e);return e;
}
export function describeError(value){
    const e=validEntry(value);if(!e)return null;
    const reason=REASONS[e.reason]+(e.http?' Получен HTTP '+e.http+'.':'');
    return {title:ERRORS[e.code].title,reason,action:ERRORS[e.code].action,stage:STAGES[e.stage],operation:OPERATIONS[e.operation],technical:e.technical,stack:e.frames.map(f=>`${f.file}:${f.line}:${f.column}`).join('\n')||'Безопасные кадры стека недоступны.',brief:`Ошибка: ${ERRORS[e.code].title}.\nПричина: ${reason}\nЭтап: ${STAGES[e.stage]}.\nЧто делать: ${ERRORS[e.code].action}`};
}
export function formatDiagnosticReport(entries){
    const safe=entries.slice(-20).map(validEntry).filter(Boolean);
    return 'Омут памяти — диагностика\n'+(safe.length?safe.map(e=>{const d=describeError(e),a=e.active,mode=({'-1':'Никуда (только макрос)','0':'После основного промпта','1':'Внутри чата','2':'Перед основным промптом'})[e.mode]??'не определён';return [`Версия: ${e.version}`,`SillyTavern: ${e.stVersion??'не определена'}`,`Дата: ${new Date(e.time).toISOString()}`,`Код: ${e.code}`,`Операция: ${d.operation}`,`Этап: ${d.stage}`,`Статус операции: ${e.status}`,`Техническое сообщение: ${d.technical}`,`Причина: ${d.reason}`,`Что делать: ${d.action}`,`Стек:\n${d.stack}`,`Режим инжекта: ${mode}`,`{{memory_echo}}: ${e.macroUsed===null?'не определено':e.macroUsed?'использовался':'не использовался'}`,`Активные записи — Эпизодов: ${a.episodes??'—'}; Глав: ${a.chapters??'—'}; Частей: ${a.parts??'—'}; Томов: ${a.volumes??'—'}`,`Состояние генерации: ${e.generation}`,`Повторов: ${e.repeats}`].join('\n');}).join('\n\n---\n\n'):'Журнал пуст.');
}
export class Diagnostics {
    constructor({storage=null,getScope=()=> 'local',getSnapshot=()=>({}),stVersion=null,now=()=>Date.now(),logger=globalThis.console}={}){
        Object.assign(this,{storage,getScope,getSnapshot,stVersion,now,logger});this.persistent=!!storage;this.listeners=new Set();this.seen=new WeakMap();this.records=[];this.serial=0;this.key=null;this.load();
    }
    scopeKey(){let scope='local';try{const value=this.getScope();if(typeof value==='string')scope=value.slice(0,2000);}catch{}return 'pensieve.diagnostics.v1:'+fingerprint({name:'scope',mes:scope});}
    load(){
        const key=this.scopeKey();if(key===this.key)return;this.key=key;this.records=[];
        if(!this.persistent)return;
        try{const raw=this.storage.getItem(key);if(!raw)return;if(raw.length>128*1024){this.corrupt=true;return;}const value=JSON.parse(raw);if(value.version!==1||!Array.isArray(value.entries)){this.corrupt=true;return;}this.records=value.entries.slice(-20).map(validEntry).filter(Boolean);}catch{this.persistent=false;}
    }
    persist(){if(!this.persistent)return;try{this.storage.setItem(this.key,JSON.stringify({version:1,entries:this.records}));}catch{this.persistent=false;}}
    get entries(){this.load();return structuredClone(this.records);}
    subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
    emit(entry,notify){
        if(this.emitting)return;this.emitting=true;
        try{for(const listener of this.listeners)try{listener(entry?structuredClone(entry):null,{notify});}catch(error){this.report(error,{code:'UI-001',stage:'ui',operation:'diagnostics',notify:false});}}finally{this.emitting=false;}
    }
    report(error,meta={}){
        try{
            this.load();error=objectError(error);const seen=this.seen.get(error);if(seen?.key===this.key){const previous=this.records.find(e=>e.id===seen.id);if(previous)return structuredClone(previous);}
            const info=classify(error,{...meta,...(tags.get(error)??{})});let snapshot={};try{snapshot=safeSnapshot(this.getSnapshot());}catch{}
            const time=this.now(),entry=validEntry({...info,...snapshot,id:`${time}-${++this.serial}`,time,lastTime:time,repeats:1,version:VERSION,stVersion:typeof this.stVersion==='function'?this.stVersion():this.stVersion});
            if(!entry)return null;while(this.records.some(e=>e.id===entry.id))entry.id=`${time}-${++this.serial}`;
            const signature=e=>JSON.stringify([e.code,e.reason,e.stage,e.operation,e.kind,e.http,e.apiCode,e.mode,e.macroUsed,e.generation,e.status,e.severity]);
            const repeated=this.records.find(e=>time-e.lastTime<60000&&time>=e.lastTime&&signature(e)===signature(entry));
            if(repeated){this.records=this.records.filter(e=>e!==repeated);this.records.push(repeated);repeated.lastTime=time;repeated.repeats=Math.min(1e7,repeated.repeats+1);this.seen.set(error,{key:this.key,id:repeated.id});this.persist();this.emit(repeated,false);return structuredClone(repeated);}
            this.records.push(entry);this.records=this.records.slice(-20);this.seen.set(error,{key:this.key,id:entry.id});this.persist();
            try{const fn=entry.severity==='info'?this.logger?.info:this.logger?.warn;fn?.call(this.logger,'[Pensieve]',formatDiagnosticReport([entry]));}catch{}
            this.emit(entry,meta.notify!==false);return structuredClone(entry);
        }catch{return null;}
    }
    reportText(entries=this.entries){return formatDiagnosticReport(entries);}
    clear(){this.load();this.records=[];this.persist();this.emit(null,false);}
}
