import {KEY, defaults, emptyArchive, clone, bytes, MAX_ARCHIVE_BYTES, WARN_ARCHIVE_BYTES, captureRange, sourceText, sourceRecord, fingerprint, inspectSources, findOverlaps, chronological, memoryText, memoryEntries, memoryConflicts, reviseEntry, mergeArchives} from './core.js';

export class Engine {
    constructor(host) {this.host=host;this.busy=false;this.cancelled=false;this.memoryEpoch=0;}
    settings() {
        const c=this.host.context();
        c.extensionSettings[KEY]??=defaults();return c.extensionSettings[KEY];
    }
    key(c=this.host.context()) {return JSON.stringify([c.groupId??null,c.characters[c.characterId]?.avatar??null,c.chatId]);}
    session() {
        const c=this.host.context();
        if(!c.chatId||!Array.isArray(c.chat)||!c.chatMetadata)throw Error('Сначала откройте сохранённый чат персонажа или группы.');
        return {key:this.key(c),chat:c.chat,metadata:c.chatMetadata};
    }
    assert(s) {
        const c=this.host.context();
        if(s.key!==this.key(c)||s.chat!==c.chat||s.metadata!==c.chatMetadata)throw Error('Чат изменился. Операция остановлена; вернитесь в исходный чат.');
    }
    archive(s=this.session()) {return s.metadata[KEY]??emptyArchive(s.key);}
    async run(fn) {
        if(this.busy)throw Error('Другая операция уже выполняется. Дождитесь её завершения.');
        this.busy=true;this.cancelled=false;
        try{return await fn();}finally{this.busy=false;this.host.refresh?.();}
    }
    cancel() {this.cancelled=true;this.host.cancel?.();}
    prompt(type) {
        const p=this.settings().prompts[type],preset=p.presets.find(x=>x.id===p.selected);
        if(!preset?.text.trim())throw Error(`Сначала сохраните свой промпт ${type==='arc'?'арки':'сводки'} в разделе «Промпты».`);
        return preset;
    }
    checkRange(s,range) {
        this.assert(s);
        for(const source of range)if(!s.chat.includes(source.ref)||fingerprint(source.ref)!==source.hash)throw Error('Исходные сообщения изменились после выбора или генерации. Создайте предварительный просмотр заново.');
        const first=s.chat.indexOf(range[0].ref);
        if(range.some((source,i)=>s.chat[first+i]!==source.ref))throw Error('Порядок или непрерывность выбранного диапазона изменились. Выберите сообщения заново.');
    }
    async generateDraft(draft) {
        const s=draft.session;this.assert(s);
        const configuration=this.host.configuration?.();
        let source;
        if(draft.type==='summary') {this.checkRange(s,draft.range);source=sourceText(draft.range);}
        else {
            const entries=this.archive(s).entries;
            const chosen=draft.summaryIds.map(id=>entries.find(e=>e.id===id));
            if(chosen.some((e,i)=>!e||e.version!==draft.sourceVersions[i]))throw Error('Исходные сводки изменились. Выберите их заново.');
            source=chosen.map(e=>`${e.title}\n${e.text}`).join('\n\n');
        }
        const preset=this.prompt(draft.type),limits=this.host.limits();
        const tokens=await this.host.count(`${preset.text}\n\n${source}`);
        this.assert(s);
        if(this.cancelled)throw Error('Генерация отменена до отправки запроса.');
        if(!Number.isFinite(tokens)||!Number.isFinite(limits.context)||!Number.isFinite(limits.output))throw Error('Не удалось проверить лимит контекста модели.');
        if(tokens+limits.output+256>limits.context)throw Error(`Выбрано примерно ${tokens} токенов; с резервом ответа это превышает контекст ${limits.context}. Уменьшите диапазон или число сводок либо увеличьте контекст в SillyTavern. Ничего не обрезано.`);
        const unlock=this.host.lock?.();
        try {
            const text=await this.host.generate(preset.text,source);
            this.assert(s);
            if(this.cancelled)throw Error('Генерация отменена.');
            if(configuration!==this.host.configuration?.())throw Error('Подключение к модели изменилось во время запроса. Повторите генерацию.');
            if(typeof text!=='string'||!text.trim())throw Error('Модель вернула пустой ответ. Исходные сообщения не изменены.');
            draft.text=text;draft.preset=preset.name;return draft;
        } finally {unlock?.();}
    }
    async generateSummary(start,end,{allowOverlap=false,replaceId=null}={}) {
        return this.run(async()=>{
            const s=this.session();if(this.archive(s).pending)throw Error('Сначала завершите или восстановите незавершённую операцию в настройках.');
            const range=captureRange(s.chat,start,end),overlaps=findOverlaps(this.archive(s).entries,range);
            if(overlaps.length&&!allowOverlap)throw Error('Диапазон пересекается с уже обработанными сообщениями. Разрешите отдельную версию или выберите запись для замены.');
            if(replaceId&&!overlaps.some(e=>e.id===replaceId))throw Error('Запись для замены не связана с диапазоном.');
            return this.generateDraft({session:s,type:'summary',range,replaceId,title:`Сводка №${this.archive(s).entries.filter(e=>e.type==='summary').length+1}`,order:start});
        });
    }
    async generateArc(ids,{replaceId=null}={}) {
        return this.run(async()=>{
            const s=this.session(),entries=this.archive(s).entries;
            if(this.archive(s).pending)throw Error('Сначала завершите незавершённую операцию.');
            if(ids.length<2||new Set(ids).size!==ids.length)throw Error('Выберите не менее двух разных сводок.');
            const chosen=ids.map(id=>entries.find(e=>e.id===id));
            if(chosen.some(e=>e?.type!=='summary'))throw Error('Арку можно создать только из существующих сводок.');
            return this.generateDraft({session:s,type:'arc',summaryIds:[...ids],sourceVersions:chosen.map(e=>e.version),replaceId,title:`Арка №${entries.filter(e=>e.type==='arc').length+1}`,order:Math.min(...chosen.map(e=>e.order))});
        });
    }
    async regenerate(draft) {return this.run(()=>this.generateDraft(draft));}
    async persist(s,archive,verify=null) {
        this.assert(s);
        if(bytes(archive)>MAX_ARCHIVE_BYTES&&bytes(archive)>=bytes(this.archive(s)))throw Error('Архив достиг 20 MiB. Экспортируйте его и освободите место перед добавлением.');
        archive.owner=s.key;archive.revision=(archive.revision||0)+1;
        s.metadata[KEY]=archive;
        const expected=JSON.stringify(archive);
        await this.host.save();this.assert(s);
        const disk=await this.host.read();this.assert(s);
        if(JSON.stringify(disk.metadata?.[KEY])!==expected||verify&&!verify(disk))throw Error('Не удалось подтвердить сохранение на сервере. Источники не будут исключены без проверки. Проверьте соединение и используйте «Повторить сохранение / восстановление».');
        if(bytes(archive)>WARN_ARCHIVE_BYTES)this.host.notify?.('warning','Архив больше 5 MiB. Рекомендуется экспортировать резервную копию.');
    }
    async saveDraft(draft,{title,text}) {
        return this.run(async()=>{
            const s=draft.session;this.assert(s);
            if(!title?.trim()||!text?.trim())throw Error('Введите название и непустой текст.');
            const archive=clone(this.archive(s));if(archive.pending)throw Error('Предыдущая запись ожидает восстановления. Не сохраняйте её повторно.');
            const old=draft.replaceId?archive.entries.find(e=>e.id===draft.replaceId):null;
            if(draft.replaceId&&!old)throw Error('Заменяемая запись удалена.');
            if(draft.type==='summary') {
                this.checkRange(s,draft.range);
                for(const source of draft.range) {
                    source.ref.extra??={};source.ref.extra[KEY]??={};
                    source.ref.extra[KEY].id??=this.host.uuid();source.id=source.ref.extra[KEY].id;
                }
                // Replacement keeps the same provenance; extending an existing range is a separate version.
                if(old&&(old.sources.length!==draft.range.length||old.sources.some((x,i)=>x.id!==draft.range[i].id)))throw Error('Для замены выберите ровно исходные сообщения этой сводки. Для другого диапазона сохраните отдельную версию.');
            } else {
                if(draft.summaryIds.some((id,i)=>archive.entries.find(e=>e.id===id)?.version!==draft.sourceVersions[i]))throw Error('Исходные сводки изменились. Повторите генерацию.');
            }
            const now=new Date().toISOString();
            const entry=old?reviseEntry(archive.entries,old.id,{title,text}):{
                id:this.host.uuid(),type:draft.type,title,text,createdAt:now,updatedAt:now,order:draft.order,version:1,history:[],active:true,
                sources:[],summaryIds:[],needsReview:false,restored:false,preset:draft.preset,
            };
            entry.active=true;entry.preset=draft.preset;
            if(draft.type==='summary')entry.sources=draft.range.map(sourceRecord);
            else {entry.summaryIds=[...draft.summaryIds];for(const e of archive.entries)if(entry.summaryIds.includes(e.id))e.active=false;}
            if(!old)archive.entries.push(entry);
            archive.pending={type:draft.type==='summary'&&this.settings().exclude?'hide':'commit',entryId:entry.id};
            await this.persist(s,archive,disk=>entry.type!=='summary'||inspectSources(disk.messages,entry.sources).issues.length===0);
            if(archive.pending)await this.completePending(s);
            await this.refreshMemory();return this.archive(s).entries.find(e=>e.id===entry.id);
        });
    }
    async completePending(s) {
        this.assert(s);
        const archive=this.archive(s),pending=archive.pending;if(!pending)return {issues:[]};
        const entry=archive.entries.find(e=>e.id===pending.entryId);if(!entry)throw Error('Журнал ссылается на отсутствующую запись. Экспортируйте архив и обратитесь за восстановлением.');
        if(pending.type==='restore')return this.restoreInternal(s,entry);
        // Recovery must pass the same durability gate as the first attempt.
        await this.persist(s,archive,disk=>inspectSources(disk.messages,entry.sources).issues.length===0);
        if(pending.type==='commit') {archive.pending=null;await this.persist(s,archive);return {issues:[]};}
        const {matches,issues}=inspectSources(s.chat,entry.sources);
        if(issues.length)throw Error('Исходники незавершённой операции изменены или недоступны. Используйте восстановление; сообщения не будут скрыты автоматически.');
        // All ownership metadata exists before the first native save. Repeating this step is idempotent.
        for(const {message:m} of matches) {
            const data=m.extra[KEY];
            if(data.exclusion) {if(!data.exclusion.owners.includes(entry.id))data.exclusion.owners.push(entry.id);}
            else if(!m.is_system)data.exclusion={owners:[entry.id],previousHidden:!!m.is_system};
        }
        let remaining=entry.sources;
        while(remaining.length) {
            this.assert(s);
            const current=inspectSources(s.chat,remaining);
            if(current.issues.length)throw Error('Источники изменились во время исключения. Операция сохранена для восстановления.');
            const candidates=current.matches.filter(x=>x.message.extra[KEY].exclusion?.owners.includes(entry.id)&&!x.message.is_system).sort((a,b)=>a.index-b.index);
            if(!candidates.length)break;
            const group=[candidates[0]];
            for(const next of candidates.slice(1)){if(next.index!==group.at(-1).index+1)break;group.push(next);}
            // The native function changes the whole contiguous range synchronously, then saves once.
            await this.host.hide(group[0].index,group.at(-1).index,false);
            const done=new Set(group.map(x=>x.source.id));remaining=remaining.filter(x=>!done.has(x.id));
        }
        this.assert(s);
        await this.persist(s,archive,disk=>{const check=inspectSources(disk.messages,entry.sources);return !check.issues.length&&check.matches.every(x=>x.message.is_system===true);});
        archive.pending=null;entry.restored=false;await this.persist(s,archive);
        return {issues:[]};
    }
    async restoreInternal(s,entry) {
        const archive=this.archive(s);
        const {matches,issues}=inspectSources(s.chat,entry.sources);
        let remaining=[];
        for(const {message:m,source} of matches) {
            const owned=m.extra?.[KEY]?.exclusion;
            if(!owned?.owners.includes(entry.id))continue;
            if(owned.owners.length>1)owned.owners=owned.owners.filter(id=>id!==entry.id);
            else remaining.push(source);
        }
        while(remaining.length) {
            this.assert(s);
            const current=inspectSources(s.chat,remaining);issues.push(...current.issues);
            const candidates=current.matches.filter(x=>x.message.extra?.[KEY]?.exclusion?.owners.includes(entry.id)).sort((a,b)=>a.index-b.index);
            if(!candidates.length)break;
            const group=[candidates[0]],previousHidden=candidates[0].message.extra[KEY].exclusion.previousHidden;
            for(const next of candidates.slice(1)){if(next.index!==group.at(-1).index+1||next.message.extra[KEY].exclusion.previousHidden!==previousHidden)break;group.push(next);}
            // Markers stay present during the native save: a crash can safely retry restoration.
            if(group.some(x=>!!x.message.is_system!==previousHidden))await this.host.hide(group[0].index,group.at(-1).index,!previousHidden);
            this.assert(s);
            for(const {message:m} of group)delete m.extra[KEY].exclusion;
            const done=new Set([...group.map(x=>x.source.id),...current.issues.map(x=>x.source.id)]);
            remaining=remaining.filter(x=>!done.has(x.id));
        }
        const finalSources=inspectSources(s.chat,entry.sources),restoredMatches=finalSources.matches;
        for(const issue of finalSources.issues)if(!issues.some(x=>x.source.id===issue.source.id))issues.push(issue);
        entry.restored=issues.length===0;entry.active=false;
        if(entry.type==='arc')for(const source of archive.entries)if(entry.summaryIds.includes(source.id))source.active=true;
        // Preserve unresolved ownership for changed sources, with an explicit issue marker.
        entry.needsReview=entry.needsReview||issues.length>0;
        archive.pending=null;
        await this.persist(s,archive,disk=>{
            const expected=new Map(restoredMatches.map(x=>[x.source.id,x.message])),check=inspectSources(disk.messages,restoredMatches.map(x=>x.source));
            return !check.issues.length&&check.matches.every(({source,message:m})=>{const current=expected.get(source.id);return !!m.is_system===!!current.is_system&&JSON.stringify(m.extra?.[KEY])===JSON.stringify(current.extra?.[KEY]);});
        });
        return {issues};
    }
    async restore(id) {
        return this.run(async()=>{
            const s=this.session(),archive=clone(this.archive(s)),entry=archive.entries.find(e=>e.id===id);
            if(!entry||entry.type!=='summary')throw Error('Выберите сводку для восстановления исходников.');
            if(archive.pending)throw Error('Сначала восстановите незавершённую операцию.');
            archive.pending={type:'restore',entryId:id};await this.persist(s,archive);
            const result=await this.restoreInternal(s,entry);await this.refreshMemory();return result;
        });
    }
    async recover(mode) {
        return this.run(async()=>{
            const s=this.session(),archive=this.archive(s);
            if(mode==='restore'&&archive.pending) {archive.pending.type='restore';await this.persist(s,archive);}
            const result=archive.pending?await this.completePending(s):await this.persist(s,archive);
            await this.refreshMemory();return result;
        });
    }
    async change(fn) {
        return this.run(async()=>{
            const s=this.session(),archive=clone(this.archive(s));
            if(archive.pending)throw Error('Сначала завершите незавершённую операцию.');
            await fn(archive,s);await this.persist(s,archive);await this.refreshMemory();return archive;
        });
    }
    edit(id,patch) {return this.change(a=>reviseEntry(a.entries,id,patch));}
    toggle(id,active) {return this.change(a=>{const e=a.entries.find(e=>e.id===id);if(!e)throw Error('Запись не найдена.');e.active=active;});}
    disableAll() {return this.change(a=>a.entries.forEach(e=>e.active=false));}
    deleteEntry(id,restoreSummaries=false) {
        return this.change((a,s)=>{
            const e=a.entries.find(e=>e.id===id);if(!e)throw Error('Запись не найдена.');
            if(e.type==='summary') {
                if(a.entries.some(x=>x.summaryIds.includes(id)))throw Error('Сводка связана с аркой. Сначала удалите соответствующие арки.');
                if(s.chat.some(m=>m.extra?.[KEY]?.exclusion?.owners.includes(id)))throw Error('Сначала восстановите исходники сводки. Для изменённых источников верните исходный ответ и повторите восстановление.');
            }
            if(e.type==='arc'&&restoreSummaries)for(const source of a.entries)if(e.summaryIds.includes(source.id))source.active=true;
            a.entries=a.entries.filter(x=>x.id!==id);
        });
    }
    importArchive(incoming,mode) {
        return this.change((a,s)=>{
            if(mode==='replace'&&s.chat.some(m=>m.extra?.[KEY]?.exclusion?.owners.length))throw Error('Перед заменой архива восстановите все исходники. Объединение доступно без этого.');
            const result=mode==='replace'?clone(incoming):mergeArchives(a,incoming,()=>this.host.uuid());
            a.entries=result.entries;a.pending=null;
        });
    }
    async memory() {
        const s=this.session(),settings=this.settings(),archive=this.archive(s),entries=archive.entries;
        const text=memoryText(entries,settings),tokens=await this.host.count(text);this.assert(s);
        const conflicts=memoryConflicts(entries),enabled=settings.enabled&&settings.inject;
        const limits=this.host.limits(),modelOverflow=!!text&&(!Number.isFinite(limits.context)||!Number.isFinite(limits.output)||tokens+limits.output+256>limits.context);
        const blocked=enabled&&(!!archive.pending||tokens>settings.tokenLimit||conflicts.length>0||!Number.isFinite(tokens)||modelOverflow);
        return {text,tokens,conflicts,blocked,enabled,entries:memoryEntries(entries),reason:archive.pending?'Есть незавершённая операция памяти. Завершите её или восстановите исходники в настройках.':conflicts.length?'Активные арки пересекаются. Отключите одну из них.':modelOverflow?'Активная память с резервом ответа не помещается в контекст текущей модели. Отключите часть записей либо увеличьте контекст подключения.':`Память занимает ≈${tokens} токенов при лимите ${settings.tokenLimit}. Отключите часть записей или увеличьте лимит.`};
    }
    refreshMemory() {
        const epoch=++this.memoryEpoch;
        this.host.inject('');
        this.memoryTask=(async()=>{
            let s;try{s=this.session();}catch{return {text:'',tokens:0,enabled:false,blocked:false,entries:[]};}
            const stamp=()=>JSON.stringify([this.archive(s).revision,this.settings()]);
            let memory,before;
            do {before=stamp();memory=await this.memory();this.assert(s);if(epoch!==this.memoryEpoch)return this.memoryTask;}while(before!==stamp());
            this.host.inject(memory.enabled&&!memory.blocked?memory.text:'');return memory;
        })();
        return this.memoryTask;
    }
    entries() {return chronological(this.archive().entries);}
}
