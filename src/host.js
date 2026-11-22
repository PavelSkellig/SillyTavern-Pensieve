import {Diagnostics,trace,tagError,diagnosticSnapshot} from './diagnostics.js';
import {PROMPT_KEY,fingerprint} from './core.js';
import {automaticMemory} from './placement.js';
import {TOKENIZER_NAMES,validateCounter} from './compression.js';

export const LITERAL_PROMPT=Symbol.for('pensieve-literal-prompt');

export function createHost(context,core,chats,fetcher=globalThis.fetch,diagnostics=null) {
    let ownGeneration=false,deliveryFormatter=null,cancelCurrent=null,attachedEngine=null;
    diagnostics??=new Diagnostics({logger:globalThis.console});
    diagnostics.getSnapshot=()=>diagnosticSnapshot(context,attachedEngine,core);diagnostics.stVersion=()=>core.CLIENT_VERSION;
    const release=()=>{ownGeneration=false;let failure;try{core.setSendButtonState(false);}catch(error){failure=error;}try{context().activateSendButtons();}catch(error){failure??=error;}if(failure)throw tagError(failure,{code:'INT-004',stage:'unlock',reason:'release'});};
    const host={
        diagnostics,setEngine(engine){attachedEngine=engine;},report:(error,meta={})=>diagnostics.report(error,meta),emergencyUnlock:release,
        context,uuid:()=>context().uuidv4(),count:text=>context().getTokenCountAsync(text),
        async macroPresence(){
            const c=context();if(c.mainApi!=='openai')return {status:'unknown'};
            const {promptManager}=await import('/scripts/openai.js');if(!promptManager?.activeCharacter)return {status:'unknown'};
            const order=promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);if(!Array.isArray(order)||!order.length)return {status:'unknown'};
            const enabled=order.filter(entry=>entry.enabled).map(entry=>promptManager.getPromptById(entry.identifier)).filter(prompt=>prompt&&promptManager.shouldTrigger(prompt,'normal'));
            // Inspect raw enabled preset fields only; preparing them could execute unrelated macros.
            const present=enabled.some(prompt=>typeof prompt.content==='string'&&/{{\s*memory_echo\s*}}/i.test(prompt.content));
            return {status:present?'present':'missing',scope:'enabled-preset'};
        },
        async statisticsCounter(){
            const [native,{power_user}]=await Promise.all([import('/scripts/tokenizers.js'),import('/scripts/power-user.js')]),c=context(),t=native.tokenizers;
            let type=c.mainApi==='openai'?t.OPENAI:power_user.tokenizer;if(type===t.BEST_MATCH)type=native.getTokenizerBestMatch(c.mainApi);
            if(type===t.API_CURRENT)type=c.mainApi==='textgenerationwebui'?t.API_TEXTGENERATIONWEBUI:['kobold','koboldhorde'].includes(c.mainApi)?t.API_KOBOLD:t.NONE;
            const names={GPT2:'gpt2',OPENAI:'openai',LLAMA:'llama',NERD:'nerdstash',NERD2:'nerdstash_v2',MISTRAL:'mistral',YI:'yi',CLAUDE:'claude',LLAMA3:'llama3',GEMMA:'gemma',JAMBA:'jamba',QWEN2:'qwen2',COMMAND_R:'command-r',NEMO:'nemo',DEEPSEEK:'deepseek',COMMAND_A:'command-a'},name=Object.keys(names).find(key=>t[key]===type);
            if(name)return {kind:'server',tokenizer:names[name],...(type===t.OPENAI?{model:String(native.getTokenizerModel()).slice(0,256)}:{})};
            if(type===t.API_TEXTGENERATIONWEBUI){const api=await import('/scripts/textgen-settings.js');return {kind:'current',tokenizer:'remote-textgen',signature:fingerprint({name:'tokenizer',mes:JSON.stringify([c.mainApi,api.textgenerationwebui_settings.type,api.getTextGenServer(),api.getTextGenModel()])})};}
            if(type===t.API_KOBOLD){const {kai_settings}=await import('/scripts/kai-settings.js');return {kind:'current',tokenizer:'remote-kobold',signature:fingerprint({name:'tokenizer',mes:JSON.stringify([c.mainApi,kai_settings.api_server,core.online_status??''])})};}
            return {kind:'estimate'};
        },
        async countStatistic(text,recipe,signal){
            recipe=validateCounter(recipe);if(!text)return 0;
            if(recipe.kind==='current'){
                if(JSON.stringify(await host.statisticsCounter())!==JSON.stringify(recipe))throw Error('Токенизатор изменился.');
                let body,endpoint;if(recipe.tokenizer==='remote-textgen'){const api=await import('/scripts/textgen-settings.js');endpoint='/api/tokenizers/remote/textgenerationwebui/encode';body={text,api_type:api.textgenerationwebui_settings.type,url:api.getTextGenServer(),model:api.getTextGenModel()};}else{const {kai_settings}=await import('/scripts/kai-settings.js');endpoint='/api/tokenizers/remote/kobold/count';body={text,url:kai_settings.api_server};}
                const response=await fetcher(endpoint,{method:'POST',headers:context().getRequestHeaders(),body:JSON.stringify(body),signal});if(!response.ok)throw Error('Удалённый токенизатор не ответил.');const data=await response.json();
                if(!Array.isArray(data.ids)||!data.ids.length||JSON.stringify(await host.statisticsCounter())!==JSON.stringify(recipe))throw Error('Токенизатор изменился или недоступен.');return data.ids.length;
            }
            if(recipe.kind!=='server'||!TOKENIZER_NAMES.has(recipe.tokenizer))throw Error('Точный токенизатор недоступен.');
            const endpoint=`/api/tokenizers/${recipe.tokenizer}/encode`+(recipe.tokenizer==='openai'?`?model=${encodeURIComponent(recipe.model??'')}`:'');
            const response=await fetcher(endpoint,{method:'POST',headers:context().getRequestHeaders(),body:JSON.stringify({text}),signal});if(!response.ok)throw Error('Токенизатор не ответил.');
            const data=await response.json();if(!Array.isArray(data.ids)||!data.ids.length)throw Error('Токенизатор вернул некорректный результат.');return data.ids.length;
        },
        configuration() {
            const c=context();return JSON.stringify([c.mainApi,c.maxContext,c.chatCompletionSettings,c.textCompletionSettings,core.amount_gen]);
        },
        limits() {
            const c=context(),cc=c.mainApi==='openai';
            return {context:Number(core.getMaxContextTokens?.()??(cc?c.chatCompletionSettings.openai_max_context:c.maxContext)),output:Number(core.getMaxResponseTokens?.()??(cc?c.chatCompletionSettings.openai_max_tokens:core.amount_gen))};
        },
        async cleanReasoning(text) {
            let native;
            try {native=await import('/scripts/reasoning.js');}catch{}
            let body=text;
            // Only a leading, closed reasoning envelope is a candidate for automatic cleanup.
            const opening=/^\s*<(think|thought)>/i.exec(body);
            if(opening){
                const tag=opening[1].toLowerCase();
                const closed=new RegExp('^\\s*<'+tag+'>([\\s\\S]*?)</'+tag+'>','i').exec(body);
                if(!closed||/<\/?(?:think|thought)>/i.test(closed[1]))return {text:body,ambiguous:true};
                const remainder=body.slice(closed[0].length);
                if(remainder&&!/^\s*\r?\n/.test(remainder))return {text:body,ambiguous:true};
                const prefix=opening[0].trim(),suffix=closed[0].match(/<\/(?:think|thought)>$/i)[0];
                const parsed=native?.parseReasoningFromString?.(body,{strict:true},{prefix,suffix});
                body=parsed?.content!==undefined&&parsed.content!==body?parsed.content:remainder.trimStart();
            }else if(typeof native?.removeReasoningFromString==='function'){
                body=native.removeReasoningFromString(body)??body;
            }
            return {text:body,ambiguous:/<\/?(?:think|thought)>/i.test(body)};
        },
        lock() {
            if(core.isGenerating())throw tagError(Error('SillyTavern уже генерирует ответ. Дождитесь завершения.'),{code:'INT-003',stage:'api',reason:'busy'});
            ownGeneration=true;
            try{core.setSendButtonState(true);context().deactivateSendButtons();}catch(error){try{release();}catch(failure){diagnostics.report(failure,{notify:false});}throw tagError(error,{code:'INT-003',stage:'handler'});}
            return release;
        },
        cancel(reason='cancel-user') {
            if(!ownGeneration)return;cancelCurrent?.(reason);
            try{context().stopGeneration();}catch(error){diagnostics.report(tagError(error,{code:'INT-004',stage:'unlock',reason:'release'}));try{context().eventSource.emit(context().eventTypes.GENERATION_STOPPED);}catch{}}
        },
        async generate(prompt,source,{responseLength}={}) {
            const c=context(),api=c.mainApi;
            if(!['openai','textgenerationwebui','kobold','koboldhorde','novel'].includes(api))throw tagError(Error('Это подключение не поддерживает проверенную отдельную генерацию. Используйте Chat Completion или Text Completion.'),{code:'GEN-001',stage:'api',reason:'unsupported-api'});
            // ST createRawPrompt substitutes macros, even in structured messages. A nonce-bearing
            // raw request lets us restore the user's exact prompt and source after that formatting.
            const nonce=`PENSIEVE_LITERAL_${c.uuidv4()}`;
            const event=api==='openai'?c.eventTypes.CHAT_COMPLETION_PROMPT_READY:c.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS;
            let applied=false;const nativeCancel=()=>cancelCurrent?.('cancel-unknown');
            const literal=payload=>{
                if(api==='openai') {
                    if(!payload.chat?.some(m=>typeof m.content==='string'&&m.content.includes(nonce)))return;
                    payload.chat=[{role:'system',content:prompt,[LITERAL_PROMPT]:true},{role:'user',content:source,[LITERAL_PROMPT]:true}];
                } else {
                    if(!payload.prompt?.includes(nonce))return;
                    payload.prompt=`${prompt}\n\n${source}`;
                }
                applied=true;
            };
            c.eventSource.on(event,literal);
            try {
                let cancel;const stopped=new Promise((_,reject)=>cancel=(reason='cancel-user')=>reject(tagError(Object.assign(Error('Генерация отменена.'),{name:'AbortError'}),{code:'GEN-006',stage:'api',reason:['chat-changed','cancel-unknown'].includes(reason)?reason:'cancel-user',snapshot:{macroUsed:false,generation:'canceled'}})));cancelCurrent=cancel;
                c.eventSource.on(c.eventTypes.GENERATION_STOPPED,nativeCancel);
                const data=await trace({code:'GEN-001',stage:'api',snapshot:{macroUsed:false,generation:'running'}},()=>Promise.race([c.generateRawData({api,prompt:[{role:'user',content:nonce}],systemPrompt:'',instructOverride:true,quietToLoud:true,responseLength}),stopped]));
                if(!applied)throw tagError(Error('SillyTavern не применил буквальный пользовательский промпт. Генерация не сохранена.'),{code:'GEN-005',stage:'response',reason:'literal-hook'});
                const reason=data?.choices?.[0]?.finish_reason??data?.stop_reason??data?.candidates?.[0]?.finishReason;
                const interrupted=data?.incomplete_details!=null||data?.status==='incomplete'||['error','cancelled','canceled','interrupted'].includes(reason);
                const truncated=interrupted||['length','max_tokens','MAX_TOKENS','max_output_tokens'].includes(reason);
                if(['content_filter','safety','SAFETY','refusal'].includes(reason))throw tagError(Error('Модель остановила ответ фильтром. Исходники не изменены.'),{code:'GEN-008',stage:'response',reason:'refused'});
                const text=trace({code:'GEN-005',stage:'response'},()=>core.extractMessageFromData(data,api));
                if(truncated&&!text?.trim())throw tagError(Error('Ответ модели был обрезан до появления текста.'),{code:'GEN-007',stage:'response',reason:'truncated'});
                return {text,truncated,interrupted};
            } finally {cancelCurrent=null;c.eventSource.removeListener(c.eventTypes.GENERATION_STOPPED,nativeCancel);c.eventSource.removeListener(event,literal);}
        },
        save:()=>trace({stage:'save'},()=>context().saveMetadata()),
        async saveSettings(expected) {
            if(typeof core.saveSettings!=='function')throw Error('SillyTavern не поддерживает проверяемое сохранение настроек.');
            await core.saveSettings();
            const response=await fetcher('/api/settings/get',{method:'POST',headers:context().getRequestHeaders(),cache:'no-store',body:'{}'});
            if(!response.ok)throw Error('Не удалось проверить сохранение настроек на сервере.');
            const data=await response.json(),stored=JSON.parse(data.settings).extension_settings?.pensieve;
            if(!stored||Object.keys(expected).some(key=>JSON.stringify(stored[key])!==JSON.stringify(expected[key])))throw tagError(Error('Сервер не подтвердил сохранение промптов или настроек. Повторите восстановление после подключения.'),{stage:'save',reason:'save-unconfirmed'});
        },
        async read() {
            const c=context(),group=c.groupId!=null,character=c.characters[c.characterId];
            const body=group?{id:c.chatId}:{ch_name:character?.name,file_name:c.chatId,avatar_url:character?.avatar};
            const response=await fetcher(group?'/api/chats/group/get':'/api/chats/get',{method:'POST',headers:c.getRequestHeaders(),cache:'no-store',body:JSON.stringify(body)});
            if(!response.ok)throw Error('Не удалось проверить сохранение чата на сервере.');
            const file=await response.json();
            if(!Array.isArray(file)||!file[0]?.chat_metadata)throw tagError(Error('Сервер вернул неожиданный формат чата. Сообщения не исключены.'),{code:'DATA-006',stage:'read',reason:'invalid-data'});
            return {metadata:file[0].chat_metadata,messages:file.slice(1)};
        },
        hide:(start,end,unhide)=>chats.hideChatMessageRange(start,end,unhide),
        setDeliveryFormatter(formatter){deliveryFormatter=formatter;},
        inject(text) {
            const c=context(),settings=c.extensionSettings.pensieve;
            const custom=deliveryFormatter?.(text),position=Number(settings?.position??1);
            c.setExtensionPrompt(PROMPT_KEY,typeof custom==='string'?custom:automaticMemory(text,settings),position,Number(settings?.depth??4),false,position===1?Number(settings?.role??0):0);
        },
        refresh() {context().swipe?.refresh();},
        notify(type,message) {if(type==='error')return diagnostics.report(typeof message==='string'?Error(message):message,{operation:'ui'});globalThis.toastr?.[type]?.(message,'Омут памяти');},
    };
    for(const [method,meta]of Object.entries({read:{code:'DATA-005',stage:'read'},saveSettings:{stage:'save'},hide:{code:'MEM-008',stage:'sources'},inject:{code:'MEM-007',stage:'injection'},generate:{code:'GEN-001',stage:'api'}})){const original=host[method];host[method]=(...args)=>trace(meta,()=>original(...args));}
    return host;
}

export function verifyHost(c,core,chats) {
    for(const name of ['generateRawData','getTokenCountAsync','saveMetadata','saveSettingsDebounced','setExtensionPrompt','uuidv4','stopGeneration'])if(typeof c[name]!=='function')throw Error(`Требуется SillyTavern 1.19.0 или новее: отсутствует ${name}.`);
    if(typeof chats.hideChatMessageRange!=='function'||typeof core.setSendButtonState!=='function'||typeof core.isGenerating!=='function')throw Error('Обновите SillyTavern до 1.19.0 или новее.');
}
