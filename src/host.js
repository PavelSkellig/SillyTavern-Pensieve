import {PROMPT_KEY} from './core.js';

export function createHost(context,core,chats,fetcher=globalThis.fetch) {
    let ownGeneration=false;
    return {
        context,uuid:()=>context().uuidv4(),count:text=>context().getTokenCountAsync(text),
        configuration() {
            const c=context();return JSON.stringify([c.mainApi,c.maxContext,c.chatCompletionSettings,c.textCompletionSettings,core.amount_gen]);
        },
        limits() {
            const c=context(),cc=c.mainApi==='openai';
            return {context:Number(cc?c.chatCompletionSettings.openai_max_context:c.maxContext),output:Number(cc?c.chatCompletionSettings.openai_max_tokens:core.amount_gen)};
        },
        lock() {
            if(core.isGenerating())throw Error('SillyTavern уже генерирует ответ. Дождитесь завершения.');
            ownGeneration=true;core.setSendButtonState(true);context().deactivateSendButtons();
            return ()=>{ownGeneration=false;core.setSendButtonState(false);context().activateSendButtons();};
        },
        cancel() {if(ownGeneration)context().stopGeneration();},
        async generate(prompt,source) {
            const c=context(),api=c.mainApi;
            if(!['openai','textgenerationwebui','kobold','koboldhorde','novel'].includes(api))throw Error('Это подключение не поддерживает проверенную отдельную генерацию. Используйте Chat Completion или Text Completion.');
            // ST createRawPrompt substitutes macros, even in structured messages. A nonce-bearing
            // raw request lets us restore the user's exact prompt and source after that formatting.
            const nonce=`PENSIEVE_LITERAL_${c.uuidv4()}`;
            const event=api==='openai'?c.eventTypes.CHAT_COMPLETION_PROMPT_READY:c.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS;
            let applied=false;
            const literal=payload=>{
                if(api==='openai') {
                    if(!payload.chat?.some(m=>typeof m.content==='string'&&m.content.includes(nonce)))return;
                    payload.chat=[{role:'system',content:prompt},{role:'user',content:source}];
                } else {
                    if(!payload.prompt?.includes(nonce))return;
                    payload.prompt=`${prompt}\n\n${source}`;
                }
                applied=true;
            };
            c.eventSource.on(event,literal);
            try {
                const data=await c.generateRawData({api,prompt:[{role:'user',content:nonce}],systemPrompt:'',instructOverride:true,quietToLoud:true});
                if(!applied)throw Error('SillyTavern не применил буквальный пользовательский промпт. Генерация не сохранена.');
                const reason=data?.choices?.[0]?.finish_reason??data?.stop_reason??data?.candidates?.[0]?.finishReason;
                if(['length','max_tokens','MAX_TOKENS','max_output_tokens'].includes(reason))throw Error('Ответ модели обрезан лимитом. Увеличьте длину ответа в SillyTavern и повторите.');
                if(['content_filter','safety','SAFETY','refusal'].includes(reason))throw Error('Модель остановила ответ фильтром. Исходники не изменены.');
                return core.extractMessageFromData(data,api);
            } finally {c.eventSource.removeListener(event,literal);}
        },
        save:()=>context().saveMetadata(),
        async read() {
            const c=context(),group=c.groupId!=null,character=c.characters[c.characterId];
            const body=group?{id:c.chatId}:{ch_name:character?.name,file_name:c.chatId,avatar_url:character?.avatar};
            const response=await fetcher(group?'/api/chats/group/get':'/api/chats/get',{method:'POST',headers:c.getRequestHeaders(),cache:'no-store',body:JSON.stringify(body)});
            if(!response.ok)throw Error('Не удалось проверить сохранение чата на сервере.');
            const file=await response.json();
            if(!Array.isArray(file)||!file[0]?.chat_metadata)throw Error('Сервер вернул неожиданный формат чата. Сообщения не исключены.');
            return {metadata:file[0].chat_metadata,messages:file.slice(1)};
        },
        hide:(start,end,unhide)=>chats.hideChatMessageRange(start,end,unhide),
        inject(text) {
            const c=context(),settings=c.extensionSettings.pensieve;
            c.setExtensionPrompt(PROMPT_KEY,text,Number(settings?.position??1),Number(settings?.depth??4),false,0);
        },
        refresh() {context().swipe?.refresh();},
        notify(type,message) {globalThis.toastr?.[type]?.(message,'Омут памяти');},
    };
}

export function verifyHost(c,core,chats) {
    for(const name of ['generateRawData','getTokenCountAsync','saveMetadata','saveSettingsDebounced','setExtensionPrompt','uuidv4','stopGeneration'])if(typeof c[name]!=='function')throw Error(`Требуется SillyTavern 1.19.0 или новее: отсутствует ${name}.`);
    if(typeof chats.hideChatMessageRange!=='function'||typeof core.setSendButtonState!=='function'||typeof core.isGenerating!=='function')throw Error('Обновите SillyTavern до 1.19.0 или новее.');
}
