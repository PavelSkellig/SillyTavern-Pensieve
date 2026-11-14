import {KEY} from './core.js';
import {MEMORY_ECHO,automaticMemory} from './placement.js';
import {memorySources} from './source-links.js';
import {PromptEnvelope} from './prompt-envelope.js';

const hasEcho=text=>new RegExp(MEMORY_ECHO.source,'i').test(text??'');
const textOf=prompt=>typeof prompt==='string'?prompt:JSON.stringify(prompt);
const usable=memory=>memory?.enabled&&!memory.blocked&&!!memory.text;

/** One compiler, native placement, and arbitration at the actual outgoing prompt boundary. */
export class MemoryEcho {
    constructor(engine,{onError=()=>{}}={}){this.engine=engine;this.host=engine.host;this.jobs=[];this.onError=onError;}
    get job(){return this.jobs.at(-1);}
    stamp(session){return JSON.stringify([session?this.engine.archive(session).revision:null,this.engine.settings()]);}
    assert(job){
        if(job.invalidated)throw Error('Чат изменился во время сборки памяти. Повторите запрос.');
        if(job.session)this.engine.assert(job.session);else{let current;try{current=this.engine.session();}catch{}if(current)throw Error('Чат изменился во время сборки памяти. Повторите запрос.');}
        if(job.stamp!==this.stamp(job.session))throw Error('Память или её настройки изменились во время сборки. Повторите запрос.');
    }
    attach(registerMacro) {
        if(this.attached)return;this.attached=true;registerMacro(()=>this.macro());
        this.host.setDeliveryFormatter?.(()=>{const job=this.job;if(!job||job.finalized)return undefined;return !job.invalidated&&job.automatic&&usable(job.memory)?job.autoBlock:'';});
        const {eventSource:events,eventTypes:t}=this.host.context();
        events.on(t.GENERATION_AFTER_COMMANDS,(type,params,dryRun)=>this.start(type,params,dryRun));
        events.on(t.GENERATE_AFTER_DATA,async(data,dryRun)=>{
            const job=this.job;if(!job||job.finalized)return;
            try{
                if(dryRun){this.cleanPreview(data,job);return;}
                this.assert(job);
                if(this.host.context().mainApi==='openai'){
                    job.probe??=job.envelope.wrap('probe','');
                    const prompt=data.prompt;if(!Array.isArray(prompt))throw Error('Неожиданный формат Chat Completion промпта.');
                    data.prompt=prompt.map((m,i)=>i?m:{...m,content:typeof m.content==='string'?m.content+job.probe:[...(m.content??[]),{type:'text',text:job.probe}]});
                    if(!prompt.length)data.prompt=[{role:'system',content:job.probe}];
                }else await this.finalize(data,false,job);
            }catch(error){this.fail(error,job);throw error;}
        });
        events.on(t.CHAT_COMPLETION_SETTINGS_READY,async data=>{
            const serialized=JSON.stringify(data),job=[...this.jobs].reverse().find(j=>j.probe&&serialized.includes(j.probe));
            try{
                if(job&&!job.finalized)await this.finalize(data,false,job);
                else if(this.job&&!this.job.finalized&&serialized.includes(this.job.envelope.prefix))await this.finalize(data,false,this.job,false);
            }catch(error){this.fail(error,job??this.job);throw error;}
        });
        events.on(t.GENERATION_ENDED,()=>this.end());
        events.on(t.GENERATION_STOPPED,()=>{if(this.job)this.job.invalidated=true;});
        events.on(t.CHAT_CHANGED,()=>{for(const job of this.jobs)job.invalidated=true;this.host.inject('');});
    }
    async start(type='normal',_params={},dryRun=false) {
        if(dryRun||this.engine.busy)return;
        let session=null;try{session=this.engine.session();}catch{}
        const job={type,session,envelope:new PromptEnvelope(this.host.uuid()),phase:'early',automatic:Number(this.engine.settings().position)!==-1,finalized:false};
        job.stamp=this.stamp(session);this.jobs.push(job);
        try{job.memory=await this.engine.refreshMemory();this.assert(job);}
        catch(error){job.error=error;job.memory={enabled:!!(this.engine.settings().enabled&&this.engine.settings().inject),blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        this.setAutoBlock(job);this.host.inject(usable(job.memory)?job.memory.text:'');return job;
    }
    setAutoBlock(job) {
        if(!usable(job.memory)||!job.automatic){job.autoBlock='';return;}
        const body=job.envelope.wrap('body',job.memory.text);
        job.autoBlock=job.envelope.wrap('auto',automaticMemory(body,this.engine.settings()));
    }
    macro() {
        const job=this.job;
        if(!job||job.finalized||job.invalidated){const memory=this.engine.peekMemory();return usable(memory)?memory.text:'';}
        // ST also evaluates the live first message before the prompt-copy interceptor.
        // Leave its literal macro intact; no request envelopes may enter saved chat data.
        if(job.phase==='early'&&job.session)return '{{memory_echo}}';
        if(!job.memory?.enabled||!job.memory.text&&!job.error)return '';
        const budget=!job.automatic&&!job.budgeted?job.memory.text:'';job.budgeted=true;
        return job.envelope.wrap('macro',budget);
    }
    async prepare(request,type=this.job?.type??'normal') {
        if(!this.job||this.job.finalized)await this.start(type);
        const job=this.job;if(!job) return this.engine.prepareContext(request,type);
        if(job.request===request)return job.memory;
        this.assert(job);job.request=request;
        try{job.memory=await this.engine.prepareContext(request,type,{deferDelivery:!job.automatic});this.assert(job);job.error=null;}
        catch(error){if(job.automatic)throw error;job.error=error;job.memory={enabled:true,blocked:true,reason:error.message,text:'',sourceIds:new Set()};}
        if(job.automatic&&job.memory.enabled&&job.memory.blocked)throw Error(job.memory.reason);
        const target=job.session?.chat.at(-1);
        if(type==='continue')job.continueTarget={ref:target,text:target?.mes,hasEcho:hasEcho(request.at(-1)?.mes)};
        if(!job.automatic&&job.session){
            for(let i=0;i<request.length;i++){
                const message=request[i],id=message.extra?.[KEY]?.id;
                if(job.memory.sourceIds.has(id)&&!(type==='continue'&&i===request.length-1))request[i]={...message,mes:job.envelope.wrap('source',message.mes,{id,name:message.name})};
            }
        }
        job.phase='prompt';this.setAutoBlock(job);this.host.inject(usable(job.memory)?job.memory.text:'');return job.memory;
    }
    cleanPreview(data,job) {
        const key=Array.isArray(data.messages)?'messages':'prompt';
        if(typeof data[key]!=='string'&&!Array.isArray(data[key]))return;
        data[key]=job.envelope.resolve(data[key],{...job.memory,blocked:false},false).prompt;
    }
    async finalize(data,dryRun=false,job=this.job,complete=true) {
        if(!job||job.finalized)return;
        if(dryRun){this.cleanPreview(data,job);return;}
        this.assert(job);
        const key=Array.isArray(data.messages)?'messages':'prompt',input=data[key];
        if(typeof input!=='string'&&!Array.isArray(input))throw Error('Неожиданный формат собранного промпта памяти.');
        const automatic=complete&&job.automatic;
        let result,output,negative;
        if(typeof input==='string'&&typeof data.negative_prompt==='string'){
            result=job.envelope.resolve([{content:input,pvField:'prompt'},{content:data.negative_prompt,pvField:'negative_prompt'}],job.memory,automatic);
            output=result.prompt.find(p=>p.pvField==='prompt')?.content??'';negative=result.prompt.find(p=>p.pvField==='negative_prompt')?.content??'';
        }else{result=job.envelope.resolve(input,job.memory,automatic);output=result.prompt;}
        if(job.type==='continue'&&job.continueTarget){
            const target=job.session?.chat.at(-1),saved=job.continueTarget;
            if(target!==saved.ref||target?.mes!==saved.text)throw Error('Последняя реплика изменилась. Дописывание остановлено до отправки запроса.');
            if(result.delivered&&(job.memory.sourceIds.has(target?.extra?.[KEY]?.id)||saved.hasEcho))throw Error('Дописывание этого сообщения остановлено: оно уже использует активную память. Для новой реплики используйте обычную отправку в чат. Исходный текст сохранён.');
        }
        if(result.delivered&&job.session){
            const current=memorySources(this.engine.archive(job.session).entries,job.session.chat,job.session.key,job.memory.entries).ids;
            if([...job.memory.sourceIds].some(id=>!current.has(id)))throw Error('Исходные сообщения изменились во время сборки памяти. Повторите запрос.');
            const before=textOf(input)+(data.negative_prompt??''),after=textOf(output)+(negative??'');
            const [beforeTokens,afterTokens]=await Promise.all([this.host.count(before),this.host.count(after)]);this.assert(job);
            const limits=this.host.limits();
            if(!Number.isFinite(afterTokens)||!Number.isFinite(beforeTokens))throw Error('Не удалось проверить объём итогового промпта памяти.');
            if(afterTokens>beforeTokens&&afterTokens+limits.output+256>limits.context)throw Error('Промпт с Memory Echo превышает контекст модели. Уменьшите память или контекст промпта; записи не обрезаны.');
        }
        const candidate={...data,[key]:output,...(negative!==undefined?{negative_prompt:negative}:{})};
        if(JSON.stringify(candidate).includes(job.envelope.prefix))throw Error('Служебный маркер памяти оказался вне поддерживаемого поля промпта. Запрос не отправлен.');
        data[key]=output;if(negative!==undefined)data.negative_prompt=negative;
        if(complete){job.finalized=true;job.result={delivered:result.delivered,kind:result.kind};this.restoreInjection();}
        return result;
    }
    restoreInjection(){const memory=this.engine.peekMemory();this.host.inject(usable(memory)?memory.text:'');}
    fail(error,job=this.job){if(job)job.finalized=true;this.host.inject('');this.host.notify?.('error',error.message);this.onError(error);}
    end(){
        let index=this.jobs.findLastIndex(j=>j.finalized||j.invalidated);if(index<0)index=this.jobs.length-1;
        if(index>=0)this.jobs.splice(index,1);this.restoreInjection();
    }
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
