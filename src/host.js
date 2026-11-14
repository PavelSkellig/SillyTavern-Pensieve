import {Diagnostics,trace,tagError,diagnosticSnapshot} from './diagnostics.js';
import {PROMPT_KEY} from './core.js';
import {automaticMemory} from './placement.js';

export const LITERAL_PROMPT=Symbol.for('pensieve-literal-prompt');

export function createHost(context,core,chats,fetcher=globalThis.fetch,diagnostics=null) {
    let ownGeneration=false,deliveryFormatter=null,cancelCurrent=null,attachedEngine=null;
    diagnostics??=new Diagnostics({logger:globalThis.console});
    diagnostics.getSnapshot=()=>diagnosticSnapshot(context,attachedEngine,core);diagnostics.stVersion=()=>core.CLIENT_VERSION;
    const release=()=>{ownGeneration=false;let failure;try{core.setSendButtonState(false);}catch(error){failure=error;}try{context().activateSendButtons();}catch(error){failure??=error;}if(failure)throw tagError(failure,{code:'INT-004',stage:'unlock',reason:'release'});};
    const host={
        diagnostics,setEngine(engine){attachedEngine=engine;},report:(error,meta={})=>diagnostics.report(error,meta),emergencyUnlock:release,
        context,uuid:()=>context().uuidv4(),count:text=>context().getTokenCountAsync(text),
        configuration() {
            const c=context();return JSON.stringify([c.mainApi,c.maxContext,c.chatCompletionSettings,c.textCompletionSettings,core.amount_gen]);
        },
        limits() {
            const c=context(),cc=c.mainApi==='openai';
            return {context:Number(cc?c.chatCompletionSettings.openai_max_context:c.maxContext),output:Number(cc?c.chatCompletionSettings.openai_max_tokens:core.amount_gen)};
        },
        lock() {
            if(core.isGenerating())throw tagError(Error('SillyTavern уже генерирует ответ. Дождитесь завершения.'),{code:'INT-003',stage:'api',reason:'busy'});
            ownGeneration=true;
            try{core.setSendButtonState(true);context().deactivateSendButtons();}catch(error){try{release();}catch(failure){diagnostics.report(failure,{notify:false});}throw tagError(error,{code:'INT-003',stage:'handler'});}
            return release;
        },
        cancel() {
            if(!ownGeneration)return;cancelCurrent?.();
            try{context().stopGeneration();}catch(error){diagnostics.report(tagError(error,{code:'INT-004',stage:'unlock',reason:'release'}));try{context().eventSource.emit(context().eventTypes.GENERATION_STOPPED);}catch{}}
        },
        async generate(prompt,source) {
            const c=context(),api=c.mainApi;
            if(!['openai','textgenerationwebui','kobold','koboldhorde','novel'].includes(api))throw tagError(Error('Это подключение не поддерживает проверенную отдельную генерацию. Используйте Chat Completion или Text Completion.'),{code:'GEN-001',stage:'api',reason:'unsupported-api'});
            // ST createRawPrompt substitutes macros, even in structured messages. A nonce-bearing
            // raw request lets us restore the user's exact prompt and source after that formatting.
            const nonce=`PENSIEVE_LITERAL_${c.uuidv4()}`;
            const event=api==='openai'?c.eventTypes.CHAT_COMPLETION_PROMPT_READY:c.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS;
            let applied=false;
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
                let cancel;const stopped=new Promise((_,reject)=>cancel=()=>reject(tagError(Object.assign(Error('Генерация отменена.'),{name:'AbortError'}),{code:'GEN-006',stage:'api',reason:'cancel-user',snapshot:{macroUsed:false,generation:'canceled'}})));cancelCurrent=cancel;
                const data=await trace({code:'GEN-001',stage:'api',snapshot:{macroUsed:false,generation:'running'}},()=>Promise.race([c.generateRawData({api,prompt:[{role:'user',content:nonce}],systemPrompt:'',instructOverride:true,quietToLoud:true}),stopped]));
                if(!applied)throw tagError(Error('SillyTavern не применил буквальный пользовательский промпт. Генерация не сохранена.'),{code:'GEN-005',stage:'response',reason:'literal-hook'});
                const reason=data?.choices?.[0]?.finish_reason??data?.stop_reason??data?.candidates?.[0]?.finishReason;
                if(['length','max_tokens','MAX_TOKENS','max_output_tokens'].includes(reason))throw tagError(Error('Ответ модели обрезан лимитом. Увеличьте длину ответа в SillyTavern и повторите.'),{code:'GEN-007',stage:'response',reason:'truncated'});
                if(['content_filter','safety','SAFETY','refusal'].includes(reason))throw tagError(Error('Модель остановила ответ фильтром. Исходники не изменены.'),{code:'GEN-008',stage:'response',reason:'refused'});
                return trace({code:'GEN-005',stage:'response'},()=>core.extractMessageFromData(data,api));
            } finally {cancelCurrent=null;c.eventSource.removeListener(event,literal);}
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
