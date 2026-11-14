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
        if(job.invalidated)throw Error('Чат изменился во время сборки памяти. Повторите запрос.');
        if(job.session)this.engine.assert(job.session);
        else{let s;try{s=this.engine.session();}catch{}if(s)throw Error('Чат изменился во время сборки памяти. Повторите запрос.');}
        if(job.stamp!==this.stamp(job.session))throw Error('Память или её настройки изменились во время сборки. Повторите запрос.');
    }
    attach(registerMacro){
        if(this.attached)return;this.attached=true;registerMacro(()=>this.macro());
        const {eventSource:events,eventTypes:t}=this.host.context();
        events.on(t.GENERATE_BEFORE_COMBINE_PROMPTS,data=>this.captureFrames(data));
        events.on(t.GENERATE_AFTER_COMBINE_PROMPTS,async data=>{
            if(data.dryRun||this.engine.busy||!hasEcho(data.prompt))return;
            const job=this.job,normal=job&&!job.finalized&&job.tcHistory&&data.prompt.includes(job.tcHistory);
            try{if(normal){await this.finalize(data,false,job);job.tcPrepared=true;}else await this.finalizeRaw(data);}catch(error){this.fail(error,normal?job:null);}
        });
        events.on(t.GENERATE_AFTER_DATA,async(data,dryRun)=>{
            const job=this.job;
            try{
                if(dryRun){await this.finalizeRaw(data);return;}
                if(!job||job.invalidated)return;
                if(job.tcPrepared){this.assert(job);await this.resolveLate(data,job);}
                else await this.finalize(data,false,job);
                if(this.host.context().mainApi==='openai')for(const m of data.prompt??[])m[REQUEST]=job;
            }catch(error){this.fail(error,job);}
        });
        events.on(t.CHAT_COMPLETION_SETTINGS_READY,async data=>{
            if(data.messages?.some(m=>m[LITERAL_PROMPT]))return;
            const job=data.messages?.find(m=>m[REQUEST])?.[REQUEST];
            try{if(job){this.assert(job);await this.resolveLate(data,job);}else await this.finalizeRaw(data);}catch(error){this.fail(error,job);}
        });
        events.on(t.GENERATION_ENDED,()=>this.end());
        events.on(t.GENERATION_STOPPED,()=>{if(this.job)this.job.invalidated=true;});
        events.on(t.CHAT_CHANGED,()=>{for(const j of this.jobs)j.invalidated=true;this.jobs=[];this.host.inject('');});
    }
    // ST substitutes the live greeting even for Prompt Manager dry runs. Keep it literal.
    // The supported final prompt boundaries expand it, once per outgoing request.
    macro(){return '{{memory_echo}}';}
    async start(type='normal'){
        let session=null;try{session=this.engine.session();}catch{}
        const job={type,session,automatic:Number(this.engine.settings().position)!==-1,finalized:false,sources:[],frames:[]};
        job.stamp=this.stamp(session);this.jobs.push(job);
        try{job.memory=await this.engine.refreshMemory();this.assert(job);}
        catch(error){job.error=error;job.memory={enabled:!!(this.engine.settings().enabled&&this.engine.settings().inject),blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        return job;
    }
    async prepare(request,type='normal'){
        if(!this.job||this.job.finalized)await this.start(type);
        const job=this.job;if(job.request===request)return job.memory;
        this.assert(job);job.request=request;
        try{job.memory=await this.engine.prepareContext(request,type,{deferDelivery:!job.automatic});this.assert(job);}
        catch(error){if(job.automatic)throw error;job.memory={enabled:true,blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        if(job.automatic&&job.memory.enabled&&job.memory.blocked)throw Error(job.memory.reason);
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
        const memory=job.memory,block=usable(memory)?automaticMemory(memory.text,this.engine.settings()):'';
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
        let decorated=this.decorate(input,job,envelope,automatic);
        if(extraFields.length)decorated=[...(typeof decorated==='string'?[{content:decorated,pvField:key}]:decorated),...extraFields.map(k=>({content:data[k],pvField:k}))];
        // A first actual macro resolved before provider-specific parameters owns the block.
        if(already==='macro')decorated=mapText(decorated,text=>{
            const opaque=envelope.wrap('literal','',{text:job.memory.text});
            return text.replace(job.memory.text,opaque).replace(new RegExp(MEMORY_ECHO.source,'gi'),'');
        });
        const result=envelope.resolve(decorated,job.memory,automatic&&already!=='macro');
        const delivered=result.delivered||!!already;
        if(delivered&&job.continueTarget){const t=job.continueTarget;if(job.session.chat.at(-1)!==t.ref||t.ref?.mes!==t.text||job.memory.sourceIds.has(t.ref?.extra?.[KEY]?.id)||t.hasEcho)throw Error('Дописывание остановлено: последнее сообщение уже использует активную память. Для новой реплики используйте обычную отправку. Исходный текст сохранён.');}
        let output=result.prompt;
        if(delivered&&Array.isArray(output)){
            const ids=new Set((job.sources??[]).flatMap(s=>s.toolIds));
            output=output.filter(m=>!(m.tool_call_id&&ids.has(m.tool_call_id))&&!m.tool_calls?.some(t=>ids.has(t.id)));
        }
        if(delivered&&job.session){
            const ids=memorySources(this.engine.archive(job.session).entries,job.session.chat,job.session.key,job.memory.entries).ids;
            if([...job.memory.sourceIds].some(id=>!ids.has(id)))throw Error('Исходные сообщения изменились во время сборки памяти. Повторите запрос.');
            const [before,after]=await Promise.all([this.host.count(textOf(input)+extraFields.map(k=>data[k]).join('')),this.host.count(textOf(output))]);this.assert(job);const l=this.host.limits();
            if(!Number.isFinite(before)||!Number.isFinite(after)||after>before&&after+l.output+256>l.context)throw Error('Промпт с Memory Echo превышает контекст модели. Уменьшите объём памяти; записи не обрезаны.');
        }
        if(extraFields.length){for(const field of extraFields)data[field]=output.find(m=>m.pvField===field)?.content??'';output=typeof input==='string'?output.find(m=>m.pvField===key)?.content??'':output.filter(m=>!m.pvField);}
        data[key]=output;return {...result,prompt:output,delivered,kind:already==='macro'?'macro':result.kind??already};
    }
    async finalize(data,_dryRun=false,job=this.job){
        if(!job)return this.finalizeRaw(data);
        const result=await this.resolve(data,job);job.finalized=true;job.result=result;return result;
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
    fail(error,job=this.job){
        if(job)job.finalized=true;
        // Native EventEmitter catches listener exceptions: explicit abort is mandatory.
        this.host.context().stopGeneration?.();this.host.inject('');this.host.notify?.('error',error.message);this.onError(error);
    }
    end(){this.jobs.pop();const memory=this.engine.peekMemory();this.host.inject(usable(memory)?memory.text:'');}
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
