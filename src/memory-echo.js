import {trace,tagError,errorMeta} from './diagnostics.js';
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
/** Native assembly stays unmodified; temporary envelopes exist only inside the final resolver. */
export class MemoryEcho {
    constructor(engine,{onError=()=>{}}={}){this.engine=engine;this.host=engine.host;this.jobs=[];this.guardErrors=new WeakMap();this.onError=onError;}
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
            if(data.dryRun||this.engine.busy)return;
            const job=this.job,marked=typeof data.prompt==='string'&&job?.envelope&&data.prompt.includes(job.envelope.prefix);
            if(!marked&&!hasEcho(data.prompt))return;
            const normal=job&&!job.finalized&&(marked||job.tcHistory&&data.prompt.includes(job.tcHistory));
            if(normal||job?.request&&this.host.context().mainApi==='openai')return;
            try{await this.finalizeRaw(data);}catch(error){return this.fail(error,null,data);}
        });
        listen(t.GENERATE_AFTER_DATA,async(data,dryRun)=>{
            const job=this.job;
            try{
                if(dryRun){await this.finalizeRaw(data);return;}
                if(!job)return;if(job.failed){this.tagPacket(data,job);this.blockPacket(data);return;}
                if(job.invalidated){if(job.envelope&&textOf(data[promptKey(data)])?.includes(job.envelope.prefix))this.blockPacket(data);return;}
                if(this.host.context().mainApi==='openai'&&Array.isArray(data.prompt)){this.tagPacket(data,job);return;}
                await this.finalize(data,false,job);
                this.tagPacket(data,job);
            }catch(error){return this.fail(error,job,data);}
        });
        listen(t.CHAT_COMPLETION_SETTINGS_READY,async data=>{
            if(data.messages?.some(m=>m[LITERAL_PROMPT]))return;
            const active=this.job;
            const job=data.messages?.find(m=>m[REQUEST])?.[REQUEST]??(active?.failed||active?.envelope&&textOf(data.messages)?.includes(active.envelope.prefix)?active:null);
            try{
                if(job?.failed){this.blockPacket(data);return;}
                if(job){this.assert(job);await this.finalize(data,false,job);}else await this.finalizeRaw(data);
            }catch(error){return this.fail(error,job,data);}finally{this.releasePacket(job,data);}
        });
        listen(t.GENERATION_ENDED,()=>this.end());
        listen(t.GENERATION_STOPPED,()=>{if(this.job)this.job.invalidated=true;});
        listen(t.CHAT_CHANGED,()=>{for(const j of this.jobs)j.invalidated=true;this.jobs=[];this.host.inject('');});
    }
    // ST substitutes the live greeting even for Prompt Manager dry runs. Keep it literal.
    // The supported final prompt boundaries expand it, once per outgoing request.
    macro(){return '{{memory_echo}}';}
    async start(type='normal'){
        const session=this.engine.optionalSession();
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
        try{job.memory=await this.engine.prepareContext(request,type,{deferDelivery:true});this.assert(job);}
        catch(error){if(job.automatic)throw error;job.memory={failure:error,enabled:true,blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        if(job.automatic&&job.memory.enabled&&job.memory.blocked)throw tagError(job.memory.failure??Error(job.memory.reason),job.memory.diagnostic??{code:'MEM-002',stage:'active'});
        job.memory.sourceIds??=new Set();
        if(type==='continue'){const ref=job.session?.chat.at(-1);job.continueTarget={ref,text:ref?.mes,hasEcho:hasEcho(request.at(-1)?.mes)};}
        job.envelope=new PromptEnvelope(this.host.uuid());
        job.sources=[];
        if(usable(job.memory)){
            for(const [index,message] of request.entries()){
                const id=message.extra?.[KEY]?.id;
                if(!job.memory.sourceIds.has(id)||type==='continue'&&index===request.length-1)continue;
                const toolIds=(message.extra?.tool_invocations??[]).map(tool=>tool.id);
                job.sources.push({id,toolIds});
                // Native interception receives the request copy after prompt Regex and reasoning formatting.
                request[index]={...message,mes:job.envelope.wrap('source',message.mes??'',{id,name:message.name})};
            }
        }
        return job.memory;
    }
    captureFrames(data){
        const job=this.job;if(!job||job.finalized)return;
        job.tcHistory=data.mesSendString||(data.finalMesSend??[]).map(f=>(f.extensionPrompts??[]).join('')+f.message).join('');
        const prefix=job.envelope?.prefix;
        job.frames=prefix?(data.finalMesSend??[]).flatMap(frame=>{
            if(frame.injected||!frame.message?.includes(prefix))return [];
            const sources=job.envelope.parse(frame.message).filter(node=>node.kind==='source');
            return sources.length===1?[{text:frame.message,id:sources[0].meta.id}]:[];
        }):[];
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
        }
        return prompt;
    }
    async resolve(data,job,{automatic=job.automatic}={}){
        this.assert(job);const key=promptKey(data),input=data[key];
        if(typeof input!=='string'&&!Array.isArray(input))return null;
        const payloadText=textOf(input)+textOf([data.assistant_prefill??'',data.negative_prompt??'']);
        if(!automatic&&!payloadText.includes(job.envelope?.prefix??'\u0000')&&!hasEcho(payloadText))return {prompt:input,delivered:false,kind:null,hadMacro:false};
        const envelope=job.envelope??new PromptEnvelope(this.host.uuid()),extraFields=['assistant_prefill','negative_prompt'].filter(k=>typeof data[k]==='string');
        let decorated=trace({code:'MEM-008',stage:'sources',operation:'context'},()=>this.decorate(input,job,envelope,automatic));
        if(extraFields.length)decorated=[...(typeof decorated==='string'?[{content:decorated,pvField:key}]:decorated),...extraFields.map(k=>({content:this.decorate(data[k],job,envelope,false),pvField:k}))];
        const result=trace({code:'MEM-006',stage:'macro',operation:'context'},()=>envelope.resolve(decorated,job.memory,automatic));job.usedMacro=result.hadMacro;
        const delivered=result.delivered;
        if(delivered&&job.continueTarget){const t=job.continueTarget;if(job.session.chat.at(-1)!==t.ref||t.ref?.mes!==t.text||job.memory.sourceIds.has(t.ref?.extra?.[KEY]?.id)||t.hasEcho)throw tagError(Error('Дописывание остановлено: последнее сообщение уже использует активную память. Для новой реплики используйте обычную отправку. Исходный текст сохранён.'),{code:'MEM-010',stage:'sources',reason:'continue-covered'});}
        let output=result.prompt;
        if(delivered&&Array.isArray(output)){
            const ids=new Set((job.sources??[]).flatMap(s=>s.toolIds));
            output=output.filter(m=>!(m.tool_call_id&&ids.has(m.tool_call_id))&&!m.tool_calls?.some(t=>ids.has(t.id)));
        }
        if(delivered&&job.session){
            const ids=trace({code:'MEM-008',stage:'sources',operation:'context'},()=>memorySources(this.engine.archive(job.session).entries,job.session.chat,job.session.key,job.memory.entries).ids);
            if([...job.memory.sourceIds].some(id=>!ids.has(id)))throw tagError(Error('Исходные сообщения изменились во время сборки памяти. Повторите запрос.'),{code:'MEM-008',stage:'sources',reason:'source-changed'});
            const assembled=Array.isArray(output)?output.map(message=>typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(part=>part?.type==='text').map(part=>part.text).join(''):'').join('\n'):output;
            const after=await trace({code:'MEM-005',stage:'tokens',operation:'context'},()=>this.host.count(assembled));this.assert(job);const l=this.host.limits();
            if(!Number.isFinite(after)||!Number.isFinite(l.context)||after>=l.context)throw tagError(Error('Промпт с Memory Echo превышает контекст модели. Уменьшите объём памяти; записи не обрезаны.'),{code:'MEM-005',stage:'tokens',reason:!Number.isFinite(after)||!Number.isFinite(l.context)?'count-invalid':'context-local'});
            const remaining=Math.floor(l.context-after);
            for(const field of ['max_tokens','max_completion_tokens','max_length','max_new_tokens']){
                if(Number.isFinite(data[field])&&data[field]>remaining)data[field]=remaining;
            }
        }
        if(extraFields.length){for(const field of extraFields)data[field]=output.find(m=>m.pvField===field)?.content??'';output=typeof input==='string'?output.find(m=>m.pvField===key)?.content??'':output.filter(m=>!m.pvField);}
        data[key]=output;return {...result,prompt:output};
    }
    async finalize(data,_dryRun=false,job=this.job){
        if(!job)return this.finalizeRaw(data);
        const result=await this.resolve(data,job);if(!result?.delivered&&job.memory.failure)this.host.report?.(job.memory.failure,{operation:'context',severity:'warning',snapshot:{macroUsed:false,generation:'running'}});job.finalized=true;job.result=result;return result;
    }
    async finalizeRaw(data){
        const key=promptKey(data);if(typeof data[key]==='string'&&this.job?.envelope&&data[key].includes(this.job.envelope.prefix))throw tagError(Error('Служебные границы источников не были обработаны.'),{code:'MEM-006',stage:'macro',reason:'envelope'});if(!hasEcho(textOf(data[key]??'')+textOf([data.assistant_prefill??'',data.negative_prompt??''])))return;
        const session=this.engine.optionalSession();
        const job={session,automatic:false,sources:[],frames:[],stamp:this.stamp(session)};
        job.memory=session?await this.engine.memory(session):{enabled:false,text:'',sourceIds:new Set()};
        return this.resolve(data,job,{automatic:false});
    }
    async fail(error,job=this.job,data=null){
        error=this.guardErrors.get(error)??error;if(job){job.finalized=true;job.failed=true;job.failure=error;}
        const record=this.host.report?.(error,{operation:'context',status:'blocked',snapshot:{macroUsed:job?.usedMacro??null,generation:'running'}});
        // Native EventEmitter swallows errors. Serialization also fails closed if Stop itself fails.
        try{this.tagPacket(data,job);}catch{}this.blockPacket(data,error);
        try{this.host.context().stopGeneration?.();}catch(failure){this.host.report?.(tagError(failure,{code:'INT-004',stage:'unlock',reason:'release'}),{operation:'context',notify:false});try{const c=this.host.context();await c.eventSource.emit(c.eventTypes.GENERATION_STOPPED);}catch{}try{this.host.emergencyUnlock?.();}catch{}}
        try{this.host.inject('');}catch(failure){this.host.report?.(failure,{code:'MEM-007',stage:'injection',operation:'context',notify:false});}
        try{this.onError(error,record);}catch(failure){this.host.report?.(failure,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning',notify:false});}
    }

    tagPacket(data,job){if(!job||this.host.context().mainApi!=='openai'||!Array.isArray(data?.prompt))return;const list=data.prompt;for(let i=0;i<list.length;i++){const m=list[i];if(!m||typeof m!=='object')continue;try{m[REQUEST]=job;}catch{try{list[i]={...m,[REQUEST]:job};}catch{}}}job.packet=list;}
    releasePacket(job,data){for(const list of [job?.packet,data?.messages])for(const m of list??[])if(m&&typeof m==='object')try{delete m[REQUEST];}catch{}if(job)job.packet=null;}
    blockPacket(data,error=this.job?.failure){if(!data||typeof data!=='object')return;const guard=tagError(Error('Омут памяти остановил передачу некорректного контекста.'),errorMeta(error));if(error&&typeof error==='object')this.guardErrors.set(guard,error);const stop=()=>{throw guard;};try{Object.defineProperty(data,'toJSON',{configurable:true,value:stop});}catch{}const key=promptKey(data);if(typeof data[key]==='string')try{data[key]={toJSON:stop,toString:stop,[Symbol.toPrimitive]:stop};}catch{}else if(Array.isArray(data[key])){try{Object.defineProperty(data[key],'toJSON',{configurable:true,value:stop});}catch{}for(const message of data[key])if(message&&typeof message==='object')try{Object.defineProperty(message,'toJSON',{configurable:true,enumerable:true,value:stop});}catch{}}}
    end(){this.releasePacket(this.job);this.jobs.pop();const memory=this.engine.peekMemory();this.host.inject(usable(memory)?memory.text:'');}
}

export async function installMemoryEcho(engine,options) {
    const [{MacrosParser},{macros,MacroCategory},{power_user}]=await Promise.all([import('/scripts/macros.js'),import('/scripts/macros/macro-system.js'),import('/scripts/power-user.js')]);
    const echo=new MemoryEcho(engine,options);
    echo.attach(handler=>{
        const description='Memory Echo — активная память текущего чата.';
        if(power_user.experimental_macro_engine&&typeof macros?.register==='function')macros.register('memory_echo',{category:MacroCategory.CHAT,description,handler});
        else MacrosParser.registerMacro('memory_echo',handler,description);
    });
    return echo;
}

for(const [name,meta]of Object.entries({prepare:{code:'MEM-002',stage:'active'},resolve:{code:'MEM-009',stage:'handoff'},finalizeRaw:{code:'MEM-006',stage:'macro'},end:{code:'MEM-007',stage:'injection'},captureFrames:{code:'MEM-008',stage:'sources'}})){const original=MemoryEcho.prototype[name];MemoryEcho.prototype[name]=function(...args){return trace({...meta,operation:'context'},()=>original.apply(this,args));};}
