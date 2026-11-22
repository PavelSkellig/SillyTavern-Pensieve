import {VERSION} from './version.js';
import {fingerprint} from './core.js';
import {ERRORS,STAGES,OPERATIONS,REASONS,STATIC_MESSAGES} from './diagnostic-catalog.js';
import {FINISH_REASONS} from './generation.js';
import {COVERAGE_STATES} from './coverage.js';
const knownMessages=new Map(Object.entries(STATIC_MESSAGES).map(([id,text])=>[text,id]));
const tags=new WeakMap(),classes=new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError','TimeoutError','AbortError','AggregateError']);
const files=new Set(['index.js','engine.js','host.js','core.js','ui.js','memory-echo.js','prompt-envelope.js','placement.js','source-links.js','order.js','hierarchy.js','backup.js','prompt-presets.js','builtin-prompts.js','generation.js','generation-view.js','diagnostics.js','diagnostic-catalog.js','diagnostics-view.js','version.js','compression.js','script.js','openai.js','macros.js','macro-system.js','eventemitter.js']);
const apiCodes=new Set(['context_length_exceeded','max_tokens_exceeded','token_limit_exceeded','invalid_api_key','authentication_error','insufficient_quota','rate_limit_exceeded','rate_limit_error','request_timeout','timeout']);
const severities=new Set(['error','warning','info']),statuses=new Set(['error','blocked','canceled','warning']),generationStates=new Set(['idle','running','saving','canceled','error','unknown']);
const read=(o,k)=>{try{return o?.[k];}catch{return undefined;}};
const version=value=>typeof value==='string'?value.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/)?.[0]??null:null;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e7?value:null;
const generationKinds={create:'создание',regenerate:'перегенерация',continue:'продолжение'};
const saveResults={draft:'черновик',saved:'подтверждено',waiting:'ожидает проверки',error:'ошибка',canceled:'отменено'};
const generationLevels={summary:'Глава',arc:'Часть',volume:'Том'};
const generationPhases={draft:'сводка источников',reduce:'сжатие промежуточных сводок',synthesis:'объединение',coverage:'проверка охвата'};
const privateReference=value=>typeof value!=='string'||!value?null:/^(?:ref-[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
    ?value:'ref-'+fingerprint({name:'generation-reference',mes:value.slice(0,200)}).slice(0,16);
function validGeneration(value){
    if(!value||!Object.hasOwn(generationKinds,value.kind)||!Object.hasOwn(generationLevels,value.level))return null;
    const id=privateReference(value.id),time=value.time;
    if(!id||!Number.isSafeInteger(time)||time<0||time>8640000000000000)return null;
    const numbers=Object.fromEntries(['number','sourceCount','rangeStart','rangeEnd','inputFirst','inputLast','segment','segments','context','configuredOutput','input','reportedInput','requestedOutput','actualOutput','received','stopCount'].map(key=>[key,count(value[key])]));
    return {id,time,kind:value.kind,level:value.level,target:privateReference(value.target),...numbers,
        phase:Object.hasOwn(generationPhases,value.phase)?value.phase:'draft',
        coverage:Object.hasOwn(COVERAGE_STATES,value.coverage)?value.coverage:'not-run',
        technical:typeof value.technical==='boolean'?value.technical:null,
        finish:FINISH_REASONS.has(value.finish)?value.finish:'unknown',
        stream:['non-streaming','unexpected-stream'].includes(value.stream)?value.stream:'unknown',
        save:Object.hasOwn(saveResults,value.save)?value.save:'draft'};
}
function generationReport(entries){
    return entries.map(value=>{
        const e=validGeneration(value);if(!e)return '';
        const number=v=>v??'—';
        return [
            `${new Date(e.time).toISOString()} · ${generationKinds[e.kind]} · ${generationLevels[e.level]} №${number(e.number)}`,
            `ID операции: ${e.id} · ID записи: ${number(e.target)}`,
            `Источников: ${number(e.sourceCount)} · Фрагмент: ${number(e.segment)}/${number(e.segments)}`,
            `${e.level==='summary'?'Диапазон сообщений':'Диапазон записей'} ${number(e.rangeStart)}–${number(e.rangeEnd)} · В запросе ${number(e.inputFirst)}–${number(e.inputLast)} · Этап: ${generationPhases[e.phase]}`,
            `Токены: вход ≈${number(e.input)} · вход по API ${number(e.reportedInput)} · контекст ${number(e.context)}`,
            `Выход: настройка ${number(e.configuredOutput)} · запрошено ${number(e.requestedOutput)} · параметры SillyTavern ${number(e.actualOutput)} · получено по API ${number(e.received)}`,
            `Завершение: ${e.finish} · Режим потока: ${e.stream} · Стоп-последовательностей: ${number(e.stopCount)} · Сохранение: ${saveResults[e.save]}`,
            `Технический обрыв: ${e.technical===null?'не определено':e.technical?'да':'нет'} · Охват: ${COVERAGE_STATES[e.coverage]}`,
        ].join('\n');
    }).filter(Boolean).join('\n\n');
}
const objectError=error=>error&&(typeof error==='object'||typeof error==='function')?error:Error('Ошибка без объекта исключения');
const enumValue=(map,value,fallback)=>Object.hasOwn(map,value)?value:fallback;
const recoveryKinds={none:'Незавершённой операции нет',hide:'Сохранение главы и исключение исходников',commit:'Сохранение воспоминания',restore:'Возврат исходников',backup:'Восстановление резервной копии'};
const recoveryStages={confirm:'Проверка сервера',write:'Запись данных',sources:'Обработка исходников',rollback:'Безопасный откат'};
const recoveryOutcomes={saved:'Запись обнаружена',missing:'Запись не сохранена',unknown:'Результат неизвестен',conflict:'Состояния различаются'};
const recoveryReasons={unknown:'Нет достаточного подтверждения сервера.',unsettled:'Нативная запись ещё может завершиться; новая запись не должна её обгонять.',conflict:'Серверная и текущая копии различаются либо данные изменились. Автоматическая перезапись остановлена.', 'rolled-back':'Сбой восстановления; предыдущее состояние подтверждено.'};
const recoveryActions={retry:'Повторить проверку и восстановление из того же файла.',wait:'Дождаться завершения записи и повторить проверку. Незавершённый результат доступен в настройках.',inspect:'Открыть архив и раздел восстановления, сохранить отдельную копию и устранить расхождение перед повторной проверкой.'};
function safeBackupRecovery(value){
    if(!value||typeof value!=='object')return null;
    const raw=typeof value.operationId==='string'?value.operationId.slice(0,200):'',operationId=!raw?null:/^ref-[a-f0-9]{16}$/.test(raw)?raw:/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw)?raw:'ref-'+fingerprint({name:'pending-operation',mes:raw}).slice(0,16);
    return {kind:enumValue(recoveryKinds,value.kind,'none'),operationId,stage:enumValue(recoveryStages,value.stage,'confirm'),checked:value.checked===true,outcome:enumValue(recoveryOutcomes,value.outcome,'unknown'),reason:enumValue(recoveryReasons,value.reason,'unknown'),action:enumValue(recoveryActions,value.action,'retry')};
}
function backupRecoveryText(value){const r=safeBackupRecovery(value);return r?[`Обнаруженная операция: ${recoveryKinds[r.kind]}`,`ID операции: ${r.operationId??'не задан'}`,`Этап операции: ${recoveryStages[r.stage]}`,`Наличие на сервере проверено: ${r.checked?'да':'нет'}`,`Результат: ${recoveryOutcomes[r.outcome]}`,`Почему остановлено: ${recoveryReasons[r.reason]}`,`Безопасное действие: ${recoveryActions[r.action]}`].join('\n'):'';}
export function tagError(error,meta={}){
    error=objectError(error);const old=tags.get(error)??{},merged={...Object.fromEntries(Object.entries(meta).filter(([,v])=>v!==undefined)),...Object.fromEntries(Object.entries(old).filter(([,v])=>v!==undefined))};
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
    if(entry.messageId)parts.push(STATIC_MESSAGES[entry.messageId]);
    if(entry.reason!=='unknown')parts.push(REASONS[entry.reason]);else parts.push('Исходное сообщение скрыто: может содержать личные данные.');
    return parts.join('; ');
}
function classify(error,meta){
    const name=read(error,'name'),kind=classes.has(name)?name:'Error',raw=typeof read(error,'message')==='string'?read(error,'message').slice(0,2048):'';
    let code=enumValue(ERRORS,meta.code,kind==='Error'?'INT-005':'INT-001'),reason=enumValue(REASONS,meta.reason,'unknown');
    const stage=enumValue(STAGES,meta.stage,ERRORS[code].stage),api=stage==='api';
    const rawCode=read(read(error,'error'),'code')??read(error,'code')??read(read(error,'error'),'type')??(apiCodes.has(raw)?raw:null),apiCode=api&&apiCodes.has(rawCode)?rawCode:null;
    let http=read(error,'status')??read(read(error,'response'),'status');if(!Number.isInteger(http)||http<100||http>599)http=api?Number(raw.match(/^Got response status (\d{3})$/)?.[1])||null:null;
    if(api){
        if(['context_length_exceeded','max_tokens_exceeded','token_limit_exceeded'].includes(apiCode)){code='GEN-002';reason='api-context';}
        else if(kind==='TimeoutError'||['request_timeout','timeout'].includes(apiCode)||[408,504].includes(http)){code='GEN-003';reason='api-timeout';}
        else if(kind==='AbortError'||raw==='Cancelled by stop event'||raw==='Clicked stop button'){code='GEN-006';if(!['cancel-user','chat-changed'].includes(reason))reason='cancel-unknown';}
        else if(['invalid_api_key','authentication_error'].includes(apiCode)||http===401||http===403)reason='api-auth';
        else if(['insufficient_quota','rate_limit_exceeded','rate_limit_error'].includes(apiCode)||http===429)reason='api-rate';
        else if(raw==='Failed to fetch'||raw==='NetworkError when attempting to fetch resource.')reason='network';
    }
    return {code,reason,stage,kind,http,apiCode,messageId:knownMessages.get(raw)??null,operation:enumValue(OPERATIONS,meta.operation,'unknown'),severity:severities.has(meta.severity)?meta.severity:code==='GEN-006'?'info':code==='UI-001'?'warning':'error',status:statuses.has(meta.status)?meta.status:code==='GEN-006'?'canceled':meta.severity==='warning'||code==='UI-001'?'warning':'error',frames:safeFrames(read(error,'stack')),backupRecovery:safeBackupRecovery(meta.backupRecovery)};
}
function validEntry(value){
    if(!value||!Object.hasOwn(ERRORS,value.code)||!Number.isFinite(value.time)||value.time<0||value.time>9e12)return null;
    const e={id:typeof value.id==='string'&&/^\d+-\d+$/.test(value.id)?value.id:'0-0',time:value.time,lastTime:Number.isFinite(value.lastTime)&&value.lastTime>=value.time&&value.lastTime<=9e12?value.lastTime:value.time,repeats:count(value.repeats)||1,code:value.code,reason:enumValue(REASONS,value.reason,'unknown'),stage:enumValue(STAGES,value.stage,ERRORS[value.code].stage),operation:enumValue(OPERATIONS,value.operation,'unknown'),kind:classes.has(value.kind)?value.kind:'Error',messageId:Object.hasOwn(STATIC_MESSAGES,value.messageId)?value.messageId:null,http:Number.isInteger(value.http)&&value.http>=100&&value.http<=599?value.http:null,apiCode:apiCodes.has(value.apiCode)?value.apiCode:null,severity:severities.has(value.severity)?value.severity:'error',status:statuses.has(value.status)?value.status:'error',version:version(value.version)??VERSION,stVersion:version(value.stVersion),...safeSnapshot(value),frames:Array.isArray(value.frames)?value.frames.filter(f=>files.has(f.file)&&Number.isInteger(f.line)&&f.line>=0&&f.line<1e6&&Number.isInteger(f.column)&&f.column>=0&&f.column<1e6).slice(0,8).map(f=>({file:f.file,line:f.line,column:f.column})):[]};
    e.backupRecovery=safeBackupRecovery(value.backupRecovery);e.technical=technical(e);return e;
}
export function describeError(value){
    const e=validEntry(value);if(!e)return null;
    const reason=(e.reason==='unknown'&&e.messageId?'Обнаружено: '+STATIC_MESSAGES[e.messageId]:REASONS[e.reason])+(e.http?' Получен HTTP '+e.http+'.':'');
    const recovery=backupRecoveryText(e.backupRecovery);return {title:ERRORS[e.code].title,reason,action:ERRORS[e.code].action,stage:STAGES[e.stage],operation:OPERATIONS[e.operation],technical:e.technical,stack:e.frames.map(f=>`${f.file}:${f.line}:${f.column}`).join('\n')||'Безопасные кадры стека недоступны.',recovery,brief:[`Ошибка: ${ERRORS[e.code].title}.\nПричина: ${reason}\nЭтап: ${STAGES[e.stage]}.\nЧто делать: ${ERRORS[e.code].action}`,recovery].filter(Boolean).join('\n')};
}
export function formatDiagnosticReport(entries){
    const safe=entries.slice(-20).map(validEntry).filter(Boolean);
    return 'Омут памяти — диагностика\n'+(safe.length?safe.map(e=>{const d=describeError(e),a=e.active,mode=({'-1':'Никуда (только макрос)','0':'После основного промпта','1':'Внутри чата','2':'Перед основным промптом'})[e.mode]??'не определён';return [`Версия: ${e.version}`,`SillyTavern: ${e.stVersion??'не определена'}`,`Дата: ${new Date(e.time).toISOString()}`,`Код: ${e.code}`,`Операция: ${d.operation}`,`Этап: ${d.stage}`,`Статус операции: ${e.status}`,...(d.recovery?[d.recovery]:[]),`Техническое сообщение: ${d.technical}`,`Причина: ${d.reason}`,`Что делать: ${d.action}`,`Стек:\n${d.stack}`,`Режим инжекта: ${mode}`,`{{memory_echo}}: ${e.macroUsed===null?'не определено':e.macroUsed?'использовался':'не использовался'}`,`Активные записи — Глав: ${a.chapters??'—'}; Частей: ${a.parts??'—'}; Томов: ${a.volumes??'—'}`,`Состояние генерации: ${e.generation}`,`Повторов: ${e.repeats}`].join('\n');}).join('\n\n---\n\n'):'Журнал пуст.');
}
export class Diagnostics {
    constructor({storage=null,getScope=()=> 'local',getSnapshot=()=>({}),stVersion=null,now=()=>Date.now(),logger=globalThis.console}={}){
        Object.assign(this,{storage,getScope,getSnapshot,stVersion,now,logger});this.persistent=!!storage;this.listeners=new Set();this.seen=new WeakMap();this.records=[];this.serial=0;this.key=null;this.load();
    }
    scopeKey(){let scope='local';try{const value=this.getScope();if(typeof value==='string')scope=value.slice(0,2000);}catch{}return 'pensieve.diagnostics.v1:'+fingerprint({name:'scope',mes:scope});}
    load(fresh=false){
        const key=this.scopeKey();if(key===this.key&&(!fresh||!this.persistent))return;this.key=key;this.records=[];this.generations=[];
        if(!this.persistent)return;
        let raw;try{raw=this.storage.getItem(key);}catch{this.persistent=false;return;}if(!raw)return;try{if(raw.length>128*1024)throw Error();const value=JSON.parse(raw);if(value.version!==1||!Array.isArray(value.entries))throw Error();this.records=value.entries.slice(-20).map(validEntry).filter(Boolean);this.generations=Array.isArray(value.generations)?value.generations.slice(-20).map(validGeneration).filter(Boolean):[];this.corrupt=false;}catch{this.corrupt=true;}
    }
    persist(){if(!this.persistent)return;try{this.storage.setItem(this.key,JSON.stringify({version:1,entries:this.records,generations:this.generations}));}catch{this.persistent=false;}}
    get entries(){this.load(true);return structuredClone(this.records);}
    recordGeneration(value){
        try{
            this.load(true);const entry=validGeneration({...value,time:this.now()});
            if(entry){this.generations.push(entry);this.generations=this.generations.slice(-20);this.persist();this.emit(null,false);}
        }catch{}
    }
    markGeneration(id,save,target=null){
        if((!id&&!target)||!Object.hasOwn(saveResults,save))return;
        try{
            this.load(true);const ref=privateReference(id),targetRef=privateReference(target);let changed=false;
            for(const entry of this.generations)if(ref?entry.id===ref:entry.target===targetRef&&entry.save==='waiting'){
                entry.save=save;entry.target=targetRef??entry.target;changed=true;
            }
            if(changed){this.persist();this.emit(null,false);}
        }catch{}
    }
    markCoverage(id,status){
        if(!id||!Object.hasOwn(COVERAGE_STATES,status))return;
        try{
            this.load(true);const ref=privateReference(id);let changed=false;
            for(const entry of this.generations)if(entry.id===ref){entry.coverage=status;changed=true;}
            if(changed){this.persist();this.emit(null,false);}
        }catch{}
    }
    generationText(){this.load(true);return generationReport(this.generations);}
    subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
    emit(entry,notify){
        if(this.emitting)return;this.emitting=true;
        try{for(const listener of this.listeners)try{listener(entry?structuredClone(entry):null,{notify});}catch(error){this.report(error,{code:'UI-001',stage:'ui',operation:'diagnostics',notify:false});}}finally{this.emitting=false;}
    }
    report(error,meta={}){
        try{
            this.load(true);error=objectError(error);const seen=this.seen.get(error);
            const info=classify(error,{...meta,...(tags.get(error)??{})});let snapshot={};try{snapshot=safeSnapshot({...this.getSnapshot(),...(meta.snapshot??{}),...((tags.get(error)??{}).snapshot??{})});}catch{}
            const time=this.now(),entry=validEntry({...info,...snapshot,id:`${time}-${++this.serial}`,time,lastTime:time,repeats:1,version:VERSION,stVersion:typeof this.stVersion==='function'?this.stVersion():this.stVersion});
            if(!entry)return null;
            if(seen?.key===this.key){const previous=this.records.find(e=>e.id===seen.id);if(previous){const rank={info:0,warning:1,error:2};if(rank[entry.severity]>rank[previous.severity]||entry.status==='blocked'&&previous.status!=='blocked'){this.records=this.records.filter(e=>e!==previous);this.records.push(previous);Object.assign(previous,{severity:entry.severity,status:entry.status,lastTime:time,macroUsed:entry.macroUsed,generation:entry.generation});this.persist();this.emit(previous,meta.notify!==false);}return structuredClone(previous);}}
            while(this.records.some(e=>e.id===entry.id))entry.id=`${time}-${++this.serial}`;
            const signature=e=>JSON.stringify([e.code,e.reason,e.stage,e.operation,e.kind,e.http,e.apiCode,e.messageId,e.frames,e.mode,e.macroUsed,e.generation,e.status,e.severity,e.backupRecovery]);
            const repeated=this.records.find(e=>time-e.lastTime<60000&&time>=e.lastTime&&signature(e)===signature(entry));
            if(repeated){this.records=this.records.filter(e=>e!==repeated);this.records.push(repeated);repeated.lastTime=time;repeated.repeats=Math.min(1e7,repeated.repeats+1);this.seen.set(error,{key:this.key,id:repeated.id});this.persist();this.emit(repeated,false);return structuredClone(repeated);}
            this.records.push(entry);this.records=this.records.slice(-20);this.seen.set(error,{key:this.key,id:entry.id});this.persist();
            try{const fn=entry.severity==='info'?this.logger?.info:this.logger?.warn;fn?.call(this.logger,'[Pensieve]',formatDiagnosticReport([entry]));}catch{}
            this.emit(entry,meta.notify!==false);return structuredClone(entry);
        }catch{return null;}
    }
    reportText(entries){
        const report=formatDiagnosticReport(entries??this.entries),generation=this.generationText();
        return generation&&(!entries||entries.some(entry=>['api','response','save'].includes(entry.stage)))?report+'\n\nПоследние запросы генерации\n'+generation:report;
    }
    clear(){this.load(true);this.records=[];this.generations=[];this.persist();this.emit(null,false);}
}

export function diagnosticSnapshot(context,engine=null,core={}) {
    try{
        const c=context(),settings=c.extensionSettings?.pensieve??{},entries=c.chatMetadata?.pensieve?.entries,active={episodes:0,chapters:0,parts:0,volumes:0};
        if(Array.isArray(entries))for(const e of entries)if(e?.active){const key={episode:'episodes',summary:'chapters',arc:'parts',volume:'volumes'}[e.type];if(key)active[key]++;}
        return safeSnapshot({mode:Number(settings.position),active,generation:engine?.busy?(engine.diagnosticState??'running'):(core.isGenerating?.()?'running':'idle')});
    }catch{return safeSnapshot();}
}
