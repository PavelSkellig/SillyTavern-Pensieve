import {trace,tagError} from './diagnostics.js';
import {KEY} from './core.js';
import {MEMORY_ECHO,automaticMemory} from './placement.js';
import {memorySources} from './source-links.js';
import {PromptEnvelope} from './prompt-envelope.js';
import {LITERAL_PROMPT} from './host.js';

const REQUEST=Symbol('pensieve-request');
const hasEcho=text=>new RegExp(MEMORY_ECHO.source,'i').test(text??'');
const usable=m=>m?.enabled&&!m.blocked&&!!m.text;
const promptKey=data=>Array.isArray(data.messages)?'messages':typeof data.input==='string'?'input':'prompt';
const mapText=(prompt,fn)=>typeof prompt==='string'?fn(prompt):prompt.map(m=>({...m,content:typeof m.content==='string'?fn(m.content):Array.isArray(m.content)?m.content.map(p=>p?.type==='text'?{...p,text:fn(p.text)}:p):m.content}));
const textOf=x=>typeof x==='string'?x:JSON.stringify(x);
const messageText=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(p=>p.type==='text').map(p=>p.text).join(''):'';
function alignHistory(values,records,match){
    const found=new Map();let cursor=records.length-1;
    for(let i=values.length-1;i>=0;i--){for(let r=cursor;r>=0;r--){if(match(values[i],records[r])){found.set(i,records[r]);cursor=r-1;break;}}}
    return found;
}

/** Native assembly stays unmodified; temporary envelopes exist only inside the final resolver. */
export class MemoryEcho {
    constructor(engine,{onError=()=>{}}={}){this.engine=engine;this.host=engine.host;this.jobs=[];this.onError=onError;}
    get job(){return this.jobs.at(-1);}
    stamp(s){return JSON.stringify([s?this.engine.archive(s).revision:null,this.engine.settings()]);}
    assert(job){
        if(job.invalidated)throw tagError(Error('Чат изменился во время сборки памяти. Повторите запрос.'),{code:'MEM-001',stage:'chat',reason:'chat-changed'});
        if(job.session)this.engine.assert(job.session);
        else{let s;try{s=this.engine.session();}catch{}if(s)throw tagError(Error('Чат изменился во время сборки памяти. Повторите запрос.'),{code:'MEM-001',stage:'chat',reason:'chat-changed'});}
        if(job.stamp!==this.stamp(job.session))throw tagError(Error('Память или её настройки изменились во время сборки. Повторите запрос.'),{code:'MEM-002',stage:'active',reason:'state-changed'});
    }
    attach(registerMacro){
        if(this.attached)return;this.attached=true;trace({code:'MEM-011',stage:'registration',operation:'startup'},()=>registerMacro(()=>this.macro()));
        const {eventSource:events,eventTypes:t}=this.host.context();
        const critical=new Set([t.GENERATE_BEFORE_COMBINE_PROMPTS,t.GENERATE_AFTER_COMBINE_PROMPTS,t.GENERATE_AFTER_DATA,t.CHAT_COMPLETION_SETTINGS_READY]);
        const listen=(event,handler)=>events.on(event,(...args)=>{const failed=error=>critical.has(event)?this.fail(tagError(error,{code:'MEM-009',stage:'handoff'}),this.job,args[0]):this.host.report?.(error,{code:'INT-002',stage:'handler',operation:'context',severity:'warning'});try{const result=handler(...args);return result&&typeof result.then==='function'?Promise.resolve(result).catch(failed):result;}catch(error){return failed(error);}});
        listen(t.GENERATE_BEFORE_COMBINE_PROMPTS,data=>this.captureFrames(data));
        listen(t.GENERATE_AFTER_COMBINE_PROMPTS,async data=>{
            if(data.dryRun||this.engine.busy||!hasEcho(data.prompt))return;
            const job=this.job,normal=job&&!job.finalized&&job.tcHistory&&data.prompt.includes(job.tcHistory);
            try{if(normal){await this.finalize(data,false,job);job.tcPrepared=true;}else await this.finalizeRaw(data);}catch(error){this.fail(error,normal?job:null,data);}
        });
        listen(t.GENERATE_AFTER_DATA,async(data,dryRun)=>{
            const job=this.job;
            try{
                if(dryRun){await this.finalizeRaw(data);return;}
                if(!job)return;if(job.failed){this.tagPacket(data,job);this.blockPacket(data);return;}if(job.invalidated)return;
                if(job.tcPrepared){this.assert(job);await this.resolveLate(data,job);}
                else await this.finalize(data,false,job);
                this.tagPacket(data,job);
            }catch(error){this.fail(error,job,data);}
        });
        listen(t.CHAT_COMPLETION_SETTINGS_READY,async data=>{
            if(data.messages?.some(m=>m[LITERAL_PROMPT]))return;
            const job=data.messages?.find(m=>m[REQUEST])?.[REQUEST];
            try{if(job?.failed){this.blockPacket(data);return;}if(job){this.assert(job);await this.resolveLate(data,job);}else await this.finalizeRaw(data);}catch(error){this.fail(error,job,data);}finally{this.releasePacket(job,data);}
        });
        listen(t.GENERATION_ENDED,()=>this.end());
        listen(t.GENERATION_STOPPED,()=>{if(this.job)this.job.invalidated=true;});
        listen(t.CHAT_CHANGED,()=>{for(const j of this.jobs)j.invalidated=true;this.jobs=[];this.host.inject('');});
    }
    // ST substitutes the live greeting even for Prompt Manager dry runs. Keep it literal.
    // The supported final prompt boundaries expand it, once per outgoing request.
    macro(){return '{{memory_echo}}';}
    async start(type='normal'){
        let session=null;try{session=this.engine.session();}catch{}
        const job={type,session,automatic:Number(this.engine.settings().position)!==-1,finalized:false,sources:[],frames:[]};
        job.stamp=this.stamp(session);this.jobs.push(job);
        try{job.memory=await this.engine.refreshMemory();this.assert(job);}
        catch(error){job.error=error;job.memory={failure:error,enabled:!!(this.engine.settings().enabled&&this.engine.settings().inject),blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        return job;
    }
    async prepare(request,type='normal'){
        if(!this.job||this.job.finalized)await this.start(type);
        const job=this.job;if(job.request===request)return job.memory;
        this.assert(job);job.request=request;
        try{job.memory=await this.engine.prepareContext(request,type,{deferDelivery:!job.automatic});this.assert(job);}
        catch(error){if(job.automatic)throw error;job.memory={failure:error,enabled:true,blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        if(job.automatic&&job.memory.enabled&&job.memory.blocked)throw tagError(job.memory.failure??Error(job.memory.reason),job.memory.diagnostic??{code:'MEM-002',stage:'active'});
        job.memory.sourceIds??=new Set();
        if(type==='continue'){const ref=job.session?.chat.at(-1);job.continueTarget={ref,text:ref?.mes,hasEcho:hasEcho(request.at(-1)?.mes)};}
        job.records=request.map(m=>({id:m.extra?.[KEY]?.id,body:m.mes.replace(/\r/g,''),name:m.name,media:!!m.extra?.media?.length,role:m.is_user?'user':m.extra?.type==='narrator'?'system':'assistant',toolIds:(m.extra?.tool_invocations??[]).map(t=>t.id)}));
        job.sources=job.records.filter(m=>job.memory.sourceIds.has(m.id));
        return job.memory;
    }
    captureFrames(data){
        const job=this.job;if(!job||job.finalized)return;
        job.tcHistory=data.mesSendString||(data.finalMesSend??[]).map(f=>(f.extensionPrompts??[]).join('')+f.message).join('');
        const frames=data.finalMesSend??[],matched=alignHistory(frames,job.records??[],(f,r)=>r.body&&f.message.includes(r.body));
        job.frames=frames.flatMap((frame,index)=>{const record=matched.get(index);return record&&job.memory.sourceIds.has(record.id)?[{text:frame.message,id:record.id}]:[];});
    }
    decorate(input,job,envelope,automatic){
        let autoFound=false;
        const memory=job.memory,block=usable(memory)?trace({code:'MEM-012',stage:'injection',operation:'context'},()=>automaticMemory(memory.text,this.engine.settings())):'';
        let prompt=mapText(input,text=>{
            if(automatic&&block&&!autoFound&&text.includes(block)){
                autoFound=true;const body=envelope.wrap('body',memory.text),internal=block.replace(memory.text,body);return text.replace(block,envelope.wrap('auto',internal));
            }
            return text;
        });
        if(typeof prompt==='string'){
            for(const f of job.frames??[])if(f.text&&prompt.includes(f.text))prompt=prompt.replace(f.text,envelope.wrap('source',f.text,{id:f.id}));
        }else {
            const matched=alignHistory(prompt,job.records??[],(m,r)=>m.role===r.role&&(r.body?(messageText(m)===r.body||messageText(m)===r.name+': '+r.body):r.media&&Array.isArray(m.content)&&m.content.some(p=>p.type!=='text')));
            prompt=prompt.map((message,index)=>{
                const source=matched.get(index);if(!source||!memory.sourceIds.has(source.id))return message;
                const content=typeof message.content==='string'?envelope.wrap('source',message.content,{id:source.id}):message.content.some(p=>p.type==='text')?message.content.map(p=>p.type==='text'?{...p,text:envelope.wrap('source',p.text,{id:source.id})}:p):[{type:'text',text:envelope.wrap('source','',{id:source.id})},...message.content];
                return {...message,content};
            });
        }
        return prompt;
    }
    async resolve(data,job,{automatic=job.automatic,already=null}={}){
        this.assert(job);const key=promptKey(data),input=data[key];
        if(typeof input!=='string'&&!Array.isArray(input))return null;
        if(!automatic&&!already&&!hasEcho(textOf(input)+textOf([data.assistant_prefill??'',data.negative_prompt??''])))return {prompt:input,delivered:false,kind:null,hadMacro:false};
        const envelope=new PromptEnvelope(this.host.uuid()),extraFields=['assistant_prefill','negative_prompt'].filter(k=>typeof data[k]==='string');
        let decorated=trace({code:'MEM-008',stage:'sources',operation:'context'},()=>this.decorate(input,job,envelope,automatic));
        if(extraFields.length)decorated=[...(typeof decorated==='string'?[{content:decorated,pvField:key}]:decorated),...extraFields.map(k=>({content:data[k],pvField:k}))];
        // A first actual macro resolved before provider-specific parameters owns the block.
        if(already==='macro')decorated=mapText(decorated,text=>{
            const opaque=envelope.wrap('literal','',{text:job.memory.text});
            return text.replace(job.memory.text,opaque).replace(new RegExp(MEMORY_ECHO.source,'gi'),'');
        });
        const result=trace({code:'MEM-006',stage:'macro',operation:'context'},()=>envelope.resolve(decorated,job.memory,automatic&&already!=='macro'));job.usedMacro=result.hadMacro;
        const delivered=result.delivered||!!already;
        if(delivered&&job.continueTarget){const t=job.continueTarget;if(job.session.chat.at(-1)!==t.ref||t.ref?.mes!==t.text||job.memory.sourceIds.has(t.ref?.extra?.[KEY]?.id)||t.hasEcho)throw tagError(Error('Дописывание остановлено: последнее сообщение уже использует активную память. Для новой реплики используйте обычную отправку. Исходный текст сохранён.'),{code:'MEM-010',stage:'sources',reason:'continue-covered'});}
        let output=result.prompt;
        if(delivered&&Array.isArray(output)){
            const ids=new Set((job.sources??[]).flatMap(s=>s.toolIds));
            output=output.filter(m=>!(m.tool_call_id&&ids.has(m.tool_call_id))&&!m.tool_calls?.some(t=>ids.has(t.id)));
        }
        if(delivered&&job.session){
            const ids=trace({code:'MEM-008',stage:'sources',operation:'context'},()=>memorySources(this.engine.archive(job.session).entries,job.session.chat,job.session.key,job.memory.entries).ids);
            if([...job.memory.sourceIds].some(id=>!ids.has(id)))throw tagError(Error('Исходные сообщения изменились во время сборки памяти. Повторите запрос.'),{code:'MEM-008',stage:'sources',reason:'source-changed'});
            const [before,after]=await trace({code:'MEM-005',stage:'tokens',operation:'context'},()=>Promise.all([this.host.count(textOf(input)+extraFields.map(k=>data[k]).join('')),this.host.count(textOf(output))]));this.assert(job);const l=this.host.limits();
            if(!Number.isFinite(before)||!Number.isFinite(after)||after>before&&after+l.output+256>l.context)throw tagError(Error('Промпт с Memory Echo превышает контекст модели. Уменьшите объём памяти; записи не обрезаны.'),{code:'MEM-005',stage:'tokens',reason:!Number.isFinite(before)||!Number.isFinite(after)?'count-invalid':'context-local'});
        }
        if(extraFields.length){for(const field of extraFields)data[field]=output.find(m=>m.pvField===field)?.content??'';output=typeof input==='string'?output.find(m=>m.pvField===key)?.content??'':output.filter(m=>!m.pvField);}
        data[key]=output;return {...result,prompt:output,delivered,kind:already==='macro'?'macro':result.kind??already};
    }
    async finalize(data,_dryRun=false,job=this.job){
        if(!job)return this.finalizeRaw(data);
        const result=await this.resolve(data,job);if(!result?.delivered&&job.memory.failure)this.host.report?.(job.memory.failure,{operation:'context',severity:'warning',snapshot:{macroUsed:false,generation:'running'}});job.finalized=true;job.result=result;return result;
    }
    async resolveLate(data,job){
        const key=promptKey(data),text=textOf(data[key])+textOf([data.assistant_prefill??'',data.negative_prompt??'']);
        // No late macro: initial cleaned payload and its native token budget remain intact.
        const protectedText=usable(job.memory)?text.split(JSON.stringify(job.memory.text).slice(1,-1)).join(''):text;
        if(!hasEcho(protectedText)){this.assert(job);return;}
        return this.resolve(data,job,{automatic:job.result?.kind==='auto',already:job.result?.kind??null});
    }
    async finalizeRaw(data){
        const key=promptKey(data);if(!hasEcho(textOf(data[key]??'')+textOf([data.assistant_prefill??'',data.negative_prompt??''])))return;
        let session=null;try{session=this.engine.session();}catch{}
        const job={session,automatic:false,sources:[],frames:[],stamp:this.stamp(session)};
        job.memory=session?await this.engine.memory(session):{enabled:false,text:'',sourceIds:new Set()};
        return this.resolve(data,job,{automatic:false});
    }
    fail(error,job=this.job,data=null){
        if(job){job.finalized=true;job.failed=true;}
        const record=this.host.report?.(error,{operation:'context',status:'blocked',snapshot:{macroUsed:job?.usedMacro??null,generation:'running'}});
        // Native EventEmitter swallows errors. Serialization also fails closed if Stop itself fails.
        this.tagPacket(data,job);this.blockPacket(data);
        try{this.host.context().stopGeneration?.();}catch(failure){this.host.report?.(tagError(failure,{code:'INT-004',stage:'unlock',reason:'release'}),{operation:'context',notify:false});try{this.host.emergencyUnlock?.();}catch{}}
        try{this.host.inject('');}catch(failure){this.host.report?.(failure,{code:'MEM-007',stage:'injection',operation:'context',notify:false});}
        try{this.onError(error,record);}catch(failure){this.host.report?.(failure,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning',notify:false});}
    }

    tagPacket(data,job){if(!job||this.host.context().mainApi!=='openai'||!Array.isArray(data?.prompt))return;data.prompt=data.prompt.filter(m=>m&&typeof m==='object').map(m=>({...m,[REQUEST]:job}));if(!data.prompt.length&&job.failed)data.prompt=[{role:'system',content:'',[REQUEST]:job}];job.packet=data.prompt;}
    releasePacket(job,data){for(const list of [job?.packet,data?.messages])for(const m of list??[])if(m&&typeof m==='object')delete m[REQUEST];if(job)job.packet=null;}
    blockPacket(data){if(data&&typeof data==='object')try{Object.defineProperty(data,'toJSON',{configurable:true,value(){throw Error('Омут памяти остановил передачу некорректного контекста.');}});}catch{}}
    end(){this.releasePacket(this.job);this.jobs.pop();const memory=this.engine.peekMemory();this.host.inject(usable(memory)?memory.text:'');}
}

export async function installMemoryEcho(engine,options) {
    const [{MacrosParser},{macros,MacroCategory},{power_user}]=await Promise.all([import('/scripts/macros.js'),import('/scripts/macros/macro-system.js'),import('/scripts/power-user.js')]);
    const echo=new MemoryEcho(engine,options);
    echo.attach(handler=>{
        if(power_user.experimental_macro_engine)macros.register('memory_echo',{category:MacroCategory.CHAT,description:'Memory Echo — активная память текущего чата.',handler});
        else MacrosParser.registerMacro('memory_echo',handler,'Memory Echo — активная память текущего чата.');
    });
    return echo;
}

for(const [name,meta]of Object.entries({prepare:{code:'MEM-002',stage:'active'},resolve:{code:'MEM-009',stage:'handoff'},finalizeRaw:{code:'MEM-006',stage:'macro'},end:{code:'MEM-007',stage:'injection'},captureFrames:{code:'MEM-008',stage:'sources'}})){const original=MemoryEcho.prototype[name];MemoryEcho.prototype[name]=function(...args){return trace({...meta,operation:'context'},()=>original.apply(this,args));};}
