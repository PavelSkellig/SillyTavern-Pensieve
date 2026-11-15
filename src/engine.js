import {trace,tagError,errorMeta} from './diagnostics.js';
import {normalisePromptPresets,mergePromptGroups} from './prompt-presets.js';
import {DEFAULT_INJECTION_TEMPLATE} from './placement.js';
import {KEY, defaults, emptyArchive, clone, bytes, MAX_ARCHIVE_BYTES, WARN_ARCHIVE_BYTES, captureRange, sourceText, sourceRecord, fingerprint, inspectSources, findOverlaps, chronological, memoryText, memoryEntries, memoryConflicts, reviseEntry, mergeArchives} from './core.js';
import {narrativeOrder} from './order.js';
import {childrenIds,hierarchyIndex,LEVELS,nextNumber} from './hierarchy.js';
import {parseBackup,planRestore,validatePromptGroups,validateBackupSettings} from './backup.js';
import {importedSourceConflicts,hasDetachedSources} from './core.js';
import {memorySources,stripMemorySources} from './source-links.js';
import {SAVE_POLICY,bounded,verifyWrite,SaveJournal,archiveStamp,sameSavedValue,archiveBody,captureSourceState,sourceProof,matchesSourceProof,sourceOutcome,chatStamp} from './save-recovery.js';

export class Engine {
    constructor(host) {this.host=host;this.busy=false;this.cancelled=false;this.memoryEpoch=0;this.diagnosticState='idle';this.operation={state:'idle',stage:'idle',outcome:null};this.operationListeners=new Set();this.recovery=host.recovery??=new SaveJournal();this.nativeWrites=host.saveWrites??=new Map();host.setEngine?.(this);}
    subscribeOperation(listener){this.operationListeners.add(listener);return()=>this.operationListeners.delete(listener);}
    setOperation(patch){Object.assign(this.operation,patch);for(const listener of this.operationListeners)try{listener({...this.operation});}catch(error){this.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'});}}
    policy(){return {...SAVE_POLICY,...this.host.savePolicy};}
    settings() {
        const c=this.host.context();
        c.extensionSettings[KEY]??=defaults();const settings=c.extensionSettings[KEY];
        let changed=false;if(settings.prompts&&!Object.hasOwn(settings.prompts,'volume')){settings.prompts.volume=defaults().prompts.volume;changed=true;}
        if(!Object.hasOwn(settings,'previewEpisodes')){settings.previewEpisodes=true;changed=true;}
        for(const [key,value]of Object.entries({position:1,depth:4,role:0,template:''}))if(!Object.hasOwn(settings,key)){settings[key]=value;changed=true;}
        if(!settings.templateDefaultsVersion){if(typeof settings.template==='string'&&!settings.template.trim())settings.template=DEFAULT_INJECTION_TEMPLATE;settings.templateDefaultsVersion=1;changed=true;}
        if(normalisePromptPresets(settings))changed=true;
        if(changed)c.saveSettingsDebounced?.();
        return settings;
    }
    key(c=this.host.context()) {return JSON.stringify([c.groupId??null,c.characters[c.characterId]?.avatar??null,c.chatId]);}
    session() {
        const c=this.host.context();
        if(!c.chatId||!Array.isArray(c.chat)||!c.chatMetadata)throw tagError(Error('Сначала откройте сохранённый чат персонажа или группы.'),{code:'MEM-001',stage:'chat',reason:'no-chat'});
        return {key:this.key(c),chat:c.chat,metadata:c.chatMetadata};
    }
    optionalSession() {try{return this.session();}catch(error){if(errorMeta(error).reason==='no-chat')return null;throw tagError(error,{code:'MEM-001',stage:'chat'});}}
    assert(s) {
        const c=this.host.context();
        if(s.key!==this.key(c)||s.chat!==c.chat||s.metadata!==c.chatMetadata)throw tagError(Error('Чат изменился. Операция остановлена; вернитесь в исходный чат.'),{code:'MEM-001',stage:'chat',reason:'chat-changed'});
    }
    archive(s=this.session()) {return s.metadata[KEY]??emptyArchive(s.key);}
    async run(fn,{allowOutstanding=false}={}) {
        const current=this.optionalSession();if(!allowOutstanding&&current&&this.nativeWrites.has(this.recovery.key(current.key)))throw this.receiptError();
        if(this.busy)throw tagError(Error('Другая операция уже выполняется. Дождитесь её завершения.'),{code:'INT-003',stage:'handler',reason:'busy'});
        this.busy=true;this.cancelled=false;this.cancelReason='cancel-user';this.diagnosticState='running';this.setOperation({state:'running',stage:'running',outcome:null,attempt:0,lastCheck:null,type:null,title:null,entryId:null,recordConfirmed:false});
        try{return await fn();}catch(error){if(this.operation.state!=='waiting')this.setOperation({state:this.cancelled?'canceled':'error'});throw tagError(error,{snapshot:{generation:this.diagnosticState}});}finally{this.activeReceipt=null;this.saveGuard=null;this.busy=false;this.cancelled=false;this.diagnosticState='idle';this.setOperation({state:['running','saving','confirming','recovering'].includes(this.operation.state)?this.operation.outcome==='saved'?'saved':'idle':this.operation.state});try{this.host.refresh?.();}catch(error){this.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'});}if(this.reconcileQueued){this.reconcileQueued=false;queueMicrotask(()=>this.requestReconciliation());}}
    }
    cancel(reason='cancel-user') {this.cancelled=true;this.cancelReason=reason==='chat-changed'?'chat-changed':'cancel-user';this.host.cancel?.(this.cancelReason);}
    prompt(type) {
        const settings=this.settings(),p=settings.prompts[type],preset=p.presets.find(x=>x.id===settings.prompts.summary.selected);
        if(!preset?.text.trim())throw tagError(Error(`Сначала сохраните свой промпт ${LEVELS[type].genitive} в разделе «Промпты».`),{code:'DATA-006',stage:'validation',reason:'missing-prompt'});
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
            const chosen=childrenIds(draft).map(id=>entries.find(e=>e.id===id));
            if(chosen.some((e,i)=>!e||e.version!==draft.sourceVersions[i]))throw Error('Исходные записи изменились. Выберите их заново.');
            source=chosen.map(e=>`${e.title}\n${e.text}`).join('\n\n');
        }
        this.setOperation({stage:'tokens',type:draft.type,title:draft.title,owner:s.key,scope:this.recovery.key(s.key)});
        const preset=this.prompt(draft.type),limits=trace({code:'MEM-005',stage:'tokens'},()=>this.host.limits());
        const tokens=await trace({code:'MEM-005',stage:'tokens'},()=>bounded(()=>this.host.count(`${preset.text}\n\n${source}`),this.policy().tokensTimeout));
        this.assert(s);
        if(this.cancelled)throw tagError(Error('Генерация отменена до отправки запроса.'),{code:'GEN-006',stage:'api',reason:this.cancelReason??'cancel-user'});
        if(!Number.isFinite(tokens)||!Number.isFinite(limits.context)||!Number.isFinite(limits.output))throw tagError(Error('Не удалось проверить лимит контекста модели.'),{code:'MEM-005',stage:'tokens',reason:'limits-unavailable'});
        if(tokens+limits.output+256>limits.context)throw tagError(Error(`Выбрано примерно ${tokens} токенов; с резервом ответа это превышает контекст ${limits.context}. Уменьшите диапазон или число записей либо увеличьте контекст в SillyTavern. Ничего не обрезано.`),{code:'MEM-005',stage:'tokens',reason:'context-local'});
        const unlock=this.host.lock?.();
        try {
            this.setOperation({stage:'api'});
            const text=await trace({code:'GEN-001',stage:'api',operation:'generate-'+draft.type,snapshot:{macroUsed:false,generation:'running'}},()=>this.host.generate(preset.text,source));
            this.assert(s);
            if(this.cancelled)throw tagError(Error('Генерация отменена.'),{code:'GEN-006',stage:'api',reason:this.cancelReason??'cancel-user'});
            if(configuration!==this.host.configuration?.())throw Error('Подключение к модели изменилось во время запроса. Повторите генерацию.');
            if(typeof text!=='string')throw tagError(Error('Модель вернула некорректный формат ответа. Исходные сообщения не изменены.'),{code:'GEN-005',stage:'response',reason:'invalid-response'});
            if(!text.trim())throw tagError(Error('Модель вернула пустой ответ. Исходные сообщения не изменены.'),{code:'GEN-004',stage:'response',reason:'empty'});
            draft.text=text;draft.preset=preset.name;return draft;
        } finally {try{unlock?.();}catch(error){this.host.report?.(tagError(error,{code:'INT-004',stage:'unlock',reason:'release'}),{severity:'warning'});try{this.host.emergencyUnlock?.();}catch(failure){this.host.report?.(failure,{code:'INT-004',stage:'unlock',reason:'release',notify:false});}}}
    }
    async generateSummary(start,end,{allowOverlap=false,replaceId=null}={}) {
        return this.run(async()=>{
            const s=this.session();if(this.archive(s).pending||await this.pendingReceipt(s))throw Error('Сначала завершите или восстановите незавершённую операцию в настройках.');
            const range=captureRange(s.chat,start,end),overlaps=findOverlaps(this.archive(s).entries,range);
            if(replaceId&&hasDetachedSources(this.archive(s).entries.find(e=>e.id===replaceId)))throw Error('Источники этой копии относятся к другому чату. Создайте отдельную новую главу.');
            if(overlaps.length&&!allowOverlap)throw Error('Диапазон пересекается с уже обработанными сообщениями. Разрешите отдельную версию или выберите запись для замены.');
            if(replaceId&&!overlaps.some(e=>e.id===replaceId))throw Error('Запись для замены не связана с диапазоном.');
            return this.generateDraft({session:s,type:'summary',range,replaceId,title:`Глава №${nextNumber('summary',this.archive(s).entries)}`,order:start});
        });
    }
    generateArc(ids,options={}) {return this.generateCollection('arc',ids,options);}
    generateVolume(ids,options={}) {return this.generateCollection('volume',ids,options);}
    async generateCollection(type,ids,{replaceId=null}={}) {
        return this.run(async()=>{
            const s=this.session(),entries=this.archive(s).entries;
            if(this.archive(s).pending||await this.pendingReceipt(s))throw Error('Сначала завершите незавершённую операцию.');
            if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw Error('Выберите не менее двух разных исходных записей.');
            const chosen=ids.map(id=>entries.find(e=>e.id===id));
            if(chosen.some(e=>e?.type!==LEVELS[type].sourceType))throw Error('Выбран неверный уровень или отсутствующая исходная запись.');
            if(replaceId&&entries.find(e=>e.id===replaceId)?.type!==type)throw Error('Тип заменяемой записи не совпадает.');
            const links=type==='volume'?{chapterIds:[...ids],summaryIds:[]}:{summaryIds:[...ids]};
            return this.generateDraft({session:s,type,...links,sourceVersions:chosen.map(e=>e.version),replaceId,title:`${LEVELS[type].name} №${nextNumber(type,entries)}`,order:Math.min(...chosen.map(e=>e.order))});
        });
    }
    async regenerate(draft) {return this.run(()=>this.generateDraft(draft));}
    journalKey(s,note=null){return note?.__journalKey??this.recovery.key(s.key);}
    pinReceipt(note,key){if(note&&!note.__journalKey)Object.defineProperty(note,'__journalKey',{value:key});return note;}
    receiptError(reason='save-unconfirmed'){this.setOperation({state:'waiting',outcome:'unknown'});return tagError(Error('Предыдущая запись ещё не подтверждена. Данные сохранены для проверки в настройках.'),{stage:'save',reason,saveOutcome:'unknown'});}
    guardLive(s,note,disk){
        this.assert(s);this.checkReceiptOwner(this.archive(s),note);
        const local=this.archive(s),stored=disk.metadata?.[KEY]??emptyArchive(s.key);
        const sameBody=sameSavedValue(archiveBody(local),archiveBody(stored));
        const localCandidate=sameSavedValue(archiveBody(local),archiveBody(note.archive)),storedCandidate=sameSavedValue(archiveBody(stored),archiveBody(note.archive));
        if(!sameBody&&!(archiveStamp(local)===note.base&&storedCandidate)&&!(archiveStamp(stored)===note.base&&localCandidate))throw this.receiptError('state-changed');
        if(chatStamp(s.chat,note)!==chatStamp(disk.messages,note))throw this.receiptError('source-changed');
        this.saveGuard={key:this.journalKey(s,note),archive:s.metadata[KEY],chat:chatStamp(s.chat,note)};
    }
    guardWrite(s,archive,note){
        this.assert(s);if(this.journalKey(s,note)!==this.recovery.key(s.key))throw this.receiptError('chat-changed');
        if(this.saveGuard&&(this.saveGuard.archive!==s.metadata[KEY]||this.saveGuard.chat!==chatStamp(s.chat,note)))throw this.receiptError('state-changed');
        const wanted=note.archive.entries.find(e=>e.id===note.entryId),actual=archive.entries.find(e=>e.id===note.entryId),view=e=>note.intent==='restore'&&e?Object.fromEntries(Object.entries(e).filter(([key])=>!['active','restored','needsReview'].includes(key))):e;
        if(!sameSavedValue(view(actual),view(wanted)))throw this.receiptError('state-changed');
    }
    trackedWrite(s,archive,kind,fn,override=new Map()){
        const note=this.activeReceipt,key=this.journalKey(s,note);if(this.nativeWrites.has(key))throw this.receiptError();
        const target=note?.archive.entries.find(e=>e.id===note.entryId),task={timedOut:false,settled:false,started:false};this.nativeWrites.set(key,task);
        const descriptor=note?{id:this.host.uuid(),state:'pending',kind,archive:archiveStamp(archive),chat:chatStamp(s.chat,note),sources:sourceProof(s.chat,target,override)}:null;
        let promise;task.run=()=>promise??=(async()=>{
            try{
                if(note){note.write=descriptor;await this.keepReceipt(s,note);this.guardWrite(s,archive,note);}
                if(task.timedOut)throw Object.assign(Error('Запись не запущена после истечения времени проверки.'),{name:'TimeoutError'});
                task.started=true;return await this.recovery.writeExclusive(key,fn);
            }finally{
                task.settled=true;if(this.nativeWrites.get(key)===task)this.nativeWrites.delete(key);
                if(note&&note.write?.id===descriptor.id){note.write.state='settled';try{await bounded(()=>this.recovery.settle(s.key,note.operationId,descriptor.id,key),this.policy().saveTimeout);}catch(error){this.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning',notify:false});}}
                if(task.timedOut){try{this.assert(s);if(key===this.recovery.key(s.key))queueMicrotask(()=>this.requestReconciliation());}catch{}}
            }
        })();return task;
    }
    writeProof(note,disk){return !!note.write&&archiveStamp(disk.metadata?.[KEY])===note.write.archive&&chatStamp(disk.messages,note)===note.write.chat&&matchesSourceProof(disk.messages,note.write.sources);}
    async settledReceipt(s,note,disk){
        const key=this.journalKey(s,note);if(this.nativeWrites.has(key))throw this.receiptError();
        if(note.write?.state==='pending'){
            if(await this.recovery.writeHeld(key)||!this.writeProof(note,disk))throw this.receiptError();
            await bounded(()=>this.recovery.settle(s.key,note.operationId,note.write.id,key),this.policy().saveTimeout);note.write.state='settled';this.assert(s);
        }
    }
    async persist(s,archive,verify=null) {
        this.assert(s);const note=this.activeReceipt;
        if(note)this.guardWrite(s,archive,note);
        if(note?.intent==='restore'){note.archive=clone(archive);note.archive.owner=s.key;note.archive.pending??={type:'restore',entryId:note.entryId,operationId:note.operationId};await this.keepReceipt(s,note);this.guardWrite(s,archive,note);}
        if(bytes(archive)>MAX_ARCHIVE_BYTES&&bytes(archive)>=bytes(this.archive(s)))throw Error('Архив достиг 20 MiB. Экспортируйте его и освободите место перед добавлением.');
        archive.owner=s.key;archive.revision=(archive.revision||0)+1;s.metadata[KEY]=archive;if(this.saveGuard)this.saveGuard.archive=archive;
        const expected=clone(archive),task=this.trackedWrite(s,archive,'save',()=>trace({stage:'save'},()=>this.host.save()));
        this.setOperation({state:'saving',stage:'write',owner:s.key,scope:this.recovery.key(s.key)});const target=archive.pending?.entryId??this.operation.entryId;
        try{
            const verified=await verifyWrite({write:task.run,onWriteTimeout:()=>task.timedOut=true,read:()=>trace({code:'DATA-005',stage:'read'},()=>this.host.read()),assert:()=>this.assert(s),policy:this.policy(),
                exists:disk=>!!target&&!!disk.metadata?.[KEY]?.entries?.some(e=>e.id===target),
                check:disk=>(!target||disk.metadata?.[KEY]?.entries?.some(e=>e.id===target&&e.version===archive.entries.find(x=>x.id===target)?.version))&&sameSavedValue(disk.metadata?.[KEY],expected)&&(!note||matchesSourceProof(disk.messages,note.write.sources))&&(!verify||verify(disk)),
                onCheck:check=>this.setOperation({state:'confirming',stage:'confirm',...check}),
            });if(target&&verified.metadata?.[KEY]?.entries?.some(e=>e.id===target))this.setOperation({recordConfirmed:true});
            if(!task.settled)throw this.receiptError();
        }catch(error){if(!archive.pending&&note?.owner===s.key)archive.pending=clone(note.archive.pending);this.setOperation({state:'waiting',stage:'confirm',outcome:errorMeta(error).saveOutcome??'unknown',lastCheck:errorMeta(error).lastCheck??Date.now()});throw error;}
        if(bytes(archive)>WARN_ARCHIVE_BYTES)try{this.host.notify?.('warning','Архив больше 5 MiB. Рекомендуется экспортировать резервную копию.');}catch(error){this.host.report?.(error,{code:'UI-001',stage:'ui',severity:'warning'});}
    }
    async refreshAfterSave(s,entry){
        this.assert(s);this.setOperation({state:'saved',stage:'saved',outcome:'saved',recordConfirmed:true,entryId:entry.id,type:entry.type,title:entry.title});
        bounded(()=>this.refreshMemory(),this.policy().tokensTimeout).catch(error=>this.host.report?.(tagError(error,{code:'MEM-005',stage:'tokens'}),{operation:'save-'+entry.type,severity:'warning'}));return entry;
    }
    async pendingReceipt(s){const key=this.recovery.key(s.key),note=await bounded(()=>this.recovery.get(s.key,key),this.policy().readTimeout);this.assert(s);return this.pinReceipt(note,key);}
    requestReconciliation(){if(this.busy){this.reconcileQueued=true;return;}return this.reconcilePending().catch(error=>this.host.report?.(error,{operation:'backup-restore'}));}
    async keepReceipt(s,note){const key=this.journalKey(s,note);this.pinReceipt(note,key);await trace({stage:'save',reason:'storage'},()=>bounded(()=>this.recovery.put(s.key,note,key),this.policy().saveTimeout));this.assert(s);this.activeReceipt=note;if(!this.saveGuard)this.saveGuard={key,archive:s.metadata[KEY],chat:chatStamp(s.chat,note)};return note;}
    async clearReceipt(s,note){if(this.nativeWrites.has(this.journalKey(s,note)))throw this.receiptError();try{await bounded(()=>this.recovery.remove(s.key,note.operationId,this.journalKey(s,note)),this.policy().saveTimeout);}catch(error){if(errorMeta(error).reason==='pending')throw this.receiptError();this.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'});}this.assert(s);}
    makeReceipt(s,archive,operationId,base,previousActive=null){const snapshot=clone(archive);snapshot.owner=s.key;const entry=snapshot.entries.find(e=>e.id===snapshot.pending.entryId);return {version:1,owner:s.key,operationId,entryId:entry.id,entryVersion:entry.version,base,archive:snapshot,sourceState:captureSourceState(entry,s.chat),previousActive:previousActive??snapshot.entries.filter(e=>e.id!==entry.id).map(e=>({id:e.id,version:e.version,active:e.active})),createdAt:new Date().toISOString()};}
    checkReceiptOwner(archive,note){if(archive.pending&&(archive.pending.entryId!==note.entryId||archive.pending.type!==note.archive.pending.type||archive.pending.operationId&&archive.pending.operationId!==note.operationId))throw Error('Незавершённая операция отличается от этого результата. Откройте восстановление в настройках; повторный запрос не требуется.');}
    receiptMatches(note,archive,messages){
        const expected=note.archive.entries.find(e=>e.id===note.entryId),entry=archive?.entries?.find(e=>e.id===note.entryId),view=e=>note.intent==='restore'&&e?Object.fromEntries(Object.entries(e).filter(([key])=>!['active','restored','needsReview'].includes(key))):e;
        if(!sameSavedValue(view(entry),view(expected))||archive.pending&&(archive.pending.entryId!==note.entryId||archive.pending.type!==note.archive.pending.type||archive.pending.operationId&&archive.pending.operationId!==note.operationId))return false;
        if(!archive.pending){if(note.intent==='restore'){if(entry.active||entry.restored&&!sourceOutcome(note,messages,true))return false;}else if(!sourceOutcome(note,messages))return false;}
        return true;
    }
    async inspectReceipt(s,note){
        const expected=note.archive.entries.find(e=>e.id===note.entryId);let disk=null;
        this.setOperation({state:'recovering',stage:'confirm',type:expected.type,title:expected.title,entryId:expected.id,owner:s.key,scope:this.recovery.key(s.key)});
        try{await verifyWrite({write:async()=>{},read:()=>trace({code:'DATA-005',stage:'read'},()=>this.host.read()),assert:()=>this.assert(s),policy:this.policy(),exists:d=>d.metadata?.[KEY]?.entries?.some(e=>e.id===note.entryId),
            check:d=>{disk=d;return this.receiptMatches(note,d.metadata?.[KEY],d.messages);},onCheck:check=>this.setOperation({stage:'confirm',...check}),
        });return {status:'saved',disk};}catch(error){this.assert(s);const stored=disk?.metadata?.[KEY],entry=stored?.entries?.find(e=>e.id===note.entryId),baseline=disk&&archiveStamp(stored??emptyArchive(s.key))===note.base,status=!errorMeta(error).readAccepted?'unknown':baseline?'missing':entry||stored?.pending&&stored.pending.entryId!==note.entryId?'conflict':disk?'missing':'unknown';this.setOperation({state:'waiting',stage:'confirm',outcome:status==='missing'?'missing':'unknown'});return {status,disk,error};}
    }
    async finishReceipt(s,note,disk){
        await this.settledReceipt(s,note,disk);this.guardLive(s,note,disk);const stored=disk.metadata[KEY],entry=stored.entries.find(e=>e.id===note.entryId);
        if(stored.pending&&entry.type==='summary'&&inspectSources(disk.messages,entry.sources).issues.length)throw this.receiptError('source-changed');
        s.metadata[KEY]=clone(stored);this.saveGuard.archive=s.metadata[KEY];this.activeReceipt=note;
        if(this.archive(s).pending){this.archive(s).pending.operationId=note.operationId;await this.completePending(s);}
        await this.clearReceipt(s,note);const result=this.archive(s).entries.find(e=>e.id===note.entryId);await this.refreshAfterSave(s,result);return {status:'saved',entry:result};
    }
    async reconcilePending(){
        const s=this.optionalSession();if(!s||this.busy)return null;const pending=this.archive(s).pending;if(pending&&!['hide','commit'].includes(pending.type))return null;
        let note=await this.pendingReceipt(s);if(!note&&!pending||this.busy||note?.intent==='restore')return null;
        return this.run(async()=>{
            if(!note){const archive=clone(this.archive(s)),operationId=archive.pending.operationId??this.host.uuid();archive.pending.operationId=operationId;note=await this.keepReceipt(s,this.makeReceipt(s,archive,operationId,'legacy'));}
            this.checkReceiptOwner(this.archive(s),note);const checked=await this.inspectReceipt(s,note);
            if(checked.status==='saved'){const result=await this.finishReceipt(s,note,checked.disk);this.host.notify?.('success','Незавершённое сохранение подтверждено. Воспоминание сохранено.');return result;}
            this.host.report?.(tagError(checked.error??Error('Запись ещё не подтверждена. Выполните восстановление в настройках.'),{code:'DATA-002',stage:'save',reason:'save-unconfirmed'}),{operation:'save-'+note.archive.entries.find(e=>e.id===note.entryId).type});return checked;
        },{allowOutstanding:true});
    }
    async saveDraft(draft,{title,text}) {
        return this.run(async()=>{
            this.diagnosticState='saving';const s=draft.session;this.assert(s);
            if(!title?.trim()||!text?.trim())throw Error('Введите название и непустой текст.');
            const archive=clone(this.archive(s)),previousReceipt=await this.pendingReceipt(s);
            const committed=draft.commitId&&(archive.entries.find(e=>e.id===draft.commitId)??(previousReceipt?.operationId===draft.operationId?previousReceipt.archive.entries.find(e=>e.id===draft.commitId):null));
            if(committed&&committed.version>=draft.commitVersion){
                if(committed.version!==draft.commitVersion||committed.type!==draft.type||committed.title!==title||committed.text!==text)throw Error('Этот результат уже записан. Завершите проверку сохранения с прежним текстом; изменения внесите через архив.');
                if(previousReceipt&&previousReceipt.entryId!==committed.id)throw Error('Предыдущая запись ожидает восстановления. Не сохраняйте её повторно.');
                const operationId=draft.operationId??this.host.uuid(),kind=committed.type==='summary'&&s.chat.some(m=>m.extra?.[KEY]?.exclusion?.owners?.includes(committed.id))?'hide':'commit';
                const note=previousReceipt??this.makeReceipt(s,{...archive,pending:{type:kind,entryId:committed.id,operationId}},operationId,'legacy');this.checkReceiptOwner(archive,note);
                const checked=await this.inspectReceipt(s,note);return (await this.resumeReceipt(s,note,checked)).entry;
            }
            if(archive.pending||previousReceipt)throw Error('Предыдущая запись ожидает восстановления. Не сохраняйте её повторно.');
            const base=archiveStamp(archive),previousActive=archive.entries.filter(e=>e.id!==draft.commitId&&e.id!==draft.replaceId).map(e=>({id:e.id,version:e.version,active:e.active}));
            const old=draft.replaceId?archive.entries.find(e=>e.id===draft.replaceId):null;
            if(draft.replaceId&&!old)throw Error('Заменяемая запись удалена.');
            if(draft.type==='summary') {
                this.checkRange(s,draft.range);
                for(const source of draft.range) {
                    source.ref.extra??={};source.ref.extra[KEY]??={};
                    source.ref.extra[KEY].id??=this.host.uuid();source.id=source.ref.extra[KEY].id;
                }
                // Replacement keeps the same provenance; extending an existing range is a separate version.
                if(old&&(old.sources.length!==draft.range.length||old.sources.some((x,i)=>x.id!==draft.range[i].id)))throw Error('Для замены выберите ровно исходные сообщения этой главы. Для другого диапазона сохраните отдельную версию.');
            } else {
                if(childrenIds(draft).some((id,i)=>archive.entries.find(e=>e.id===id)?.version!==draft.sourceVersions[i]))throw Error('Исходные записи изменились. Повторите генерацию.');
            }
            const now=new Date().toISOString();
            const entry=old?reviseEntry(archive.entries,old.id,{title,text}):{
                id:draft.commitId??this.host.uuid(),type:draft.type,title,text,createdAt:now,updatedAt:now,order:draft.order,version:1,history:[],active:true,
                sources:[],summaryIds:[],needsReview:false,restored:false,preset:draft.preset,
            };
            entry.active=true;entry.preset=draft.preset;
            if(draft.type==='summary')entry.sources=draft.range.map(sourceRecord);
            else {
                if(draft.type==='volume')entry.chapterIds=[...draft.chapterIds];else entry.summaryIds=[...draft.summaryIds];
                entry.needsReview=entry.needsReview||childrenIds(entry).some(id=>archive.entries.find(e=>e.id===id)?.needsReview);
                const replaced=draft.type==='volume'?hierarchyIndex(archive.entries).descendants(entry):new Set(childrenIds(entry));
                for(const e of archive.entries)if(replaced.has(e.id))e.active=false;
            }
            if(!old)archive.entries.push(entry);
            draft.commitId=entry.id;draft.commitVersion=entry.version;this.setOperation({type:entry.type,title:entry.title,entryId:entry.id});
            draft.operationId??=this.host.uuid();archive.pending={type:draft.type==='summary'&&this.settings().exclude?'hide':'commit',entryId:entry.id,operationId:draft.operationId};
            const receipt=await this.keepReceipt(s,this.makeReceipt(s,archive,draft.operationId,base,previousActive));
            await this.persist(s,archive,disk=>entry.type!=='summary'||inspectSources(disk.messages,entry.sources).issues.length===0);
            if(archive.pending)await this.completePending(s);
            await this.clearReceipt(s,receipt);return this.refreshAfterSave(s,this.archive(s).entries.find(e=>e.id===entry.id));
        });
    }
    async completePending(s) {
        this.assert(s);
        const archive=this.archive(s),pending=archive.pending;if(!pending)return {issues:[]};
        if(pending.type==='backup'){await this.persist(s,archive);await this.saveBackupGlobals(s,pending.globals);archive.pending=null;await this.persist(s,archive);return {issues:[]};}
        const entry=archive.entries.find(e=>e.id===pending.entryId);if(!entry)throw Error('Журнал ссылается на отсутствующую запись. Экспортируйте архив и обратитесь за восстановлением.');
        if(pending.type==='restore')return this.restoreInternal(s,entry);
        // Recovery must pass the same durability gate as the first attempt.
        await this.persist(s,archive,disk=>!entry.active||inspectSources(disk.messages,entry.sources).issues.length===0);
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
            const task=this.trackedWrite(s,archive,'hide',()=>this.host.hide(group[0].index,group.at(-1).index,false),new Map(group.map(x=>[x.source.id,true])));
            try{await bounded(task.run,this.policy().saveTimeout,()=>task.timedOut=true);}catch(error){this.setOperation({state:'waiting',stage:'sources',outcome:'unknown'});throw tagError(error,{code:'MEM-008',stage:'sources'});}
            const done=new Set(group.map(x=>x.source.id));remaining=remaining.filter(x=>!done.has(x.id));
        }
        this.assert(s);
        await this.persist(s,archive,disk=>{const check=inspectSources(disk.messages,entry.sources);return !check.issues.length&&check.matches.every(x=>x.message.is_system===true)&&(!this.activeReceipt||sourceOutcome(this.activeReceipt,disk.messages));});
        archive.pending=null;entry.restored=false;await this.persist(s,archive,disk=>!this.activeReceipt||sourceOutcome(this.activeReceipt,disk.messages));
        return {issues:[]};
    }
    async restoreInternal(s,entry) {
        const archive=this.archive(s);
        const {matches,issues}=inspectSources(s.chat,entry.sources);
        let remaining=[];
        for(const {message:m,source} of matches) {
            const prior=this.activeReceipt?.sourceState.find(x=>x.id===source.id);
            if(!m.extra[KEY].exclusion&&prior&&!prior.hidden&&m.is_system)m.extra[KEY].exclusion={owners:[entry.id],previousHidden:false};
            const owned=m.extra?.[KEY]?.exclusion;
            if(!owned?.owners?.includes(entry.id))continue;
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
            if(group.some(x=>!!x.message.is_system!==previousHidden)){
                const task=this.trackedWrite(s,archive,'unhide',()=>this.host.hide(group[0].index,group.at(-1).index,!previousHidden),new Map(group.map(x=>[x.source.id,previousHidden])));
                try{await bounded(task.run,this.policy().saveTimeout,()=>task.timedOut=true);}catch(error){this.setOperation({state:'waiting',stage:'sources',outcome:'unknown'});throw tagError(error,{code:'MEM-008',stage:'sources'});}
            }
            this.assert(s);
            for(const {message:m} of group)delete m.extra[KEY].exclusion;
            const done=new Set([...group.map(x=>x.source.id),...current.issues.map(x=>x.source.id)]);
            remaining=remaining.filter(x=>!done.has(x.id));
        }
        const finalSources=inspectSources(s.chat,entry.sources),restoredMatches=finalSources.matches;
        for(const issue of finalSources.issues)if(!issues.some(x=>x.source.id===issue.source.id))issues.push(issue);
        entry.restored=issues.length===0;entry.active=false;
        if(entry.type==='arc')for(const source of archive.entries)if(entry.summaryIds.includes(source.id))source.active=true;
        if(this.activeReceipt?.previousActive&&entry.type!=='summary'){
            const children=hierarchyIndex(archive.entries).descendants(entry),previous=new Map(this.activeReceipt.previousActive.map(x=>[x.id,x]));
            for(const child of archive.entries)if(children.has(child.id)&&previous.has(child.id)&&previous.get(child.id).version===child.version)child.active=previous.get(child.id).active;
        }
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
            if(!entry||entry.type!=='summary')throw Error('Выберите главу для восстановления исходников.');
            if(hasDetachedSources(entry))throw Error('Исходники восстановленной копии принадлежат другому чату или отсутствуют. Сообщения текущего чата не изменены.');
            if(archive.pending)throw Error('Сначала восстановите незавершённую операцию.');
            archive.pending={type:'restore',entryId:id};await this.persist(s,archive);
            const result=await this.restoreInternal(s,entry);await this.refreshMemory();return result;
        });
    }
    async resumeReceipt(s,note,checked,restore=false){
        if(checked.status==='conflict'||checked.status==='unknown')throw checked.error??this.receiptError();
        await this.settledReceipt(s,note,checked.disk);this.guardLive(s,note,checked.disk);
        restore=restore||note.intent==='restore';if(!restore&&checked.status==='saved')return this.finishReceipt(s,note,checked.disk);
        const stored=checked.disk.metadata?.[KEY]??emptyArchive(s.key);
        if(checked.status==='missing'&&archiveStamp(stored)!==note.base)throw this.receiptError('state-changed');
        const archive=clone(checked.status==='missing'?note.archive:stored),entry=archive.entries.find(e=>e.id===note.entryId);
        if(!restore&&entry.type==='summary'&&inspectSources(s.chat,entry.sources).issues.length)throw Error('Исходные сообщения не удалось надёжно сопоставить. Выберите «Вернуть исходники незавершённой операции», чтобы сохранить результат в архив без активации.');
        if(restore){note.intent='restore';archive.pending={type:'restore',entryId:note.entryId,operationId:note.operationId};note.archive=clone(archive);}
        await this.keepReceipt(s,note);await this.persist(s,archive);
        const result=restore?await this.restoreInternal(s,entry):await this.completePending(s);
        await this.clearReceipt(s,note);const saved=this.archive(s).entries.find(e=>e.id===note.entryId);await this.refreshAfterSave(s,saved);return {status:'saved',entry:saved,issues:result.issues??[]};
    }
    async recover(mode) {
        return this.run(async()=>{
            const s=this.session();let note=await this.pendingReceipt(s),archive=this.archive(s);
            if(!note&&['hide','commit'].includes(archive.pending?.type)){const copy=clone(archive),operationId=copy.pending.operationId??this.host.uuid();copy.pending.operationId=operationId;note=await this.keepReceipt(s,this.makeReceipt(s,copy,operationId,'legacy'));}
            if(note){this.checkReceiptOwner(archive,note);const checked=await this.inspectReceipt(s,note);return this.resumeReceipt(s,note,checked,mode==='restore');}
            if(mode==='restore'&&archive.pending?.type==='backup'){await this.saveBackupGlobals(s,archive.pending.previousGlobals);archive.entries.forEach(e=>e.active=false);archive.pending=null;await this.persist(s,archive);await this.refreshMemory();return {issues:[]};}
            if(mode==='restore'&&archive.pending){archive.pending.type='restore';await this.persist(s,archive);}
            const result=archive.pending?await this.completePending(s):await this.persist(s,archive);await this.refreshMemory();return result;
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
    toggle(id,active) {return this.change(a=>{const e=a.entries.find(e=>e.id===id);if(!e)throw Error('Запись не найдена.');if(e.type==='volume'){const covered=hierarchyIndex(a.entries).descendants(e);for(const child of a.entries)if(covered.has(child.id))child.active=false;}e.active=active;});}
    disableAll() {return this.change(a=>a.entries.forEach(e=>e.active=false));}
    deleteEntry(id,restoreSummaries=false,{unlink=false}={}) {
        return this.change((a,s)=>{
            const e=a.entries.find(e=>e.id===id);if(!e)throw Error('Запись не найдена.');
            const index=hierarchyIndex(a.entries),parents=index.parents.get(id)??[];
            if(parents.length&&(!unlink||parents.some(p=>childrenIds(p).length<3)))throw Error('Запись входит в связанную часть или том. У каждого родителя после удаления должны остаться минимум две исходные записи; требуется явное подтверждение отвязывания.');
            if(e.type==='summary') {
                if(s.chat.some(m=>m.extra?.[KEY]?.exclusion?.owners.includes(id)))throw Error('Сначала восстановите исходники главы. Для изменённых источников верните исходный ответ и повторите восстановление.');
            }
            if(e.type!=='summary'&&(e.active||index.ancestors(e).some(p=>p.active))){const covered=index.descendants(e);for(const source of a.entries)if(covered.has(source.id))source.active=false;}
            for(const parent of index.ancestors(e))parent.needsReview=true;
            for(const parent of parents){const key=parent.type==='volume'?'chapterIds':'summaryIds';parent[key]=parent[key].filter(sourceId=>sourceId!==id);}
            if(e.type!=='summary'&&restoreSummaries)for(const source of a.entries)if(childrenIds(e).includes(source.id))source.active=true;
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
    async saveBackupGlobals(s,patch) {
        if(!patch||!Object.keys(patch).length)return;
        this.assert(s);const validated={};
        if(patch.settings)Object.assign(validated,validateBackupSettings(patch.settings));
        if(patch.prompts)validated.prompts=validatePromptGroups(patch.prompts);
        if(typeof this.host.saveSettings!=='function')throw Error('Не удалось проверить сохранение общих настроек. Обновите SillyTavern и повторите восстановление.');
        Object.assign(this.settings(),clone(validated));await this.host.saveSettings(validated);this.assert(s);
    }
    async restoreBackup(backup,options={},session=null) {
        return this.run(async()=>{
            const s=session??this.session();this.assert(s);
            const file=backup?.legacy?parseBackup(JSON.stringify({format:'pensieve',version:1,archive:backup.archive})):parseBackup(JSON.stringify(backup));
            if(backup?.source?.hadPendingOperation)file.source.hadPendingOperation=true;
            const mode=options.mode??'merge',current=this.archive(s),settings=this.settings();
            if(current.pending)throw Error('Сначала завершите незавершённую операцию памяти.');
            if(mode==='replace'&&s.chat.some(m=>m.extra?.[KEY]?.exclusion?.owners.length))throw Error('Перед заменой архива восстановите собственные исключения сообщений. Объединение доступно без этого.');
            if(options.restorePrompts&&!file.prompts||options.restoreSettings&&!file.settings)throw Error('В этой прежней копии нет выбранных промптов или настроек.');
            const restoredPrompts=options.restorePrompts?mergePromptGroups(settings.prompts,validatePromptGroups(file.prompts)):clone(settings.prompts);
            const candidateSettings={...clone(settings),...(options.restoreSettings?validateBackupSettings(file.settings):{}),prompts:restoredPrompts};
            const stamp=JSON.stringify([s.metadata[KEY]??null,settings]),previousArchive=s.metadata[KEY],hadArchive=Object.hasOwn(s.metadata,KEY);
            const plan=planRestore(current,file,{targetKey:s.key,mode,activate:options.activate===true,uuid:()=>this.host.uuid(),chat:s.chat});
            if(options.activate){
                const ordered=narrativeOrder(memoryEntries(plan.archive.entries),plan.archive.entries,s.chat),text=memoryText(plan.archive.entries,candidateSettings,ordered.entries),tokens=await this.host.count(text);this.assert(s);
                const limits=this.host.limits();if(memoryConflicts(plan.archive.entries,s.key).length)throw Error('Восстановление активности создаёт пересечения памяти. Восстановите записи без активности.');
                if(importedSourceConflicts(plan.archive.entries,s.chat).length)throw Error('В текущем чате уже есть исходные сообщения копии. Восстановите без активности или сначала вручную исключите эти сообщения штатными средствами SillyTavern.');
                if(!Number.isFinite(tokens)||tokens>candidateSettings.tokenLimit||text&&(!Number.isFinite(limits.context)||!Number.isFinite(limits.output)||tokens+limits.output+256>limits.context))throw Error('Активная копия превышает лимит токенов или контекст модели. Восстановите без активности либо измените лимит.');
            }
            this.assert(s);if(stamp!==JSON.stringify([s.metadata[KEY]??null,settings]))throw Error('Память или настройки изменились во время проверки. Повторите восстановление.');
            // A durable marker blocks all injection until both complete-archive writes verify.
            const globals={...(options.restoreSettings?{settings:clone(file.settings)}:{}),...(options.restorePrompts?{prompts:clone(restoredPrompts)}:{})},previousGlobals={...(options.restoreSettings?{settings:validateBackupSettings(settings)}:{}),...(options.restorePrompts?{prompts:clone(settings.prompts)}:{})};
            plan.archive.pending={type:'backup',globals,previousGlobals};
            let globalsApplied=false;this.restoring=true;
            try{
                this.host.inject('');await this.persist(s,plan.archive);
                if(Object.keys(globals).length){globalsApplied=true;await this.saveBackupGlobals(s,globals);}
                plan.archive.pending=null;await this.persist(s,plan.archive);this.assert(s);
                this.restoring=false;await this.refreshMemory();return plan;
            }catch(error){
                if(hadArchive)s.metadata[KEY]=previousArchive;else delete s.metadata[KEY];
                let globalsRollback=!globalsApplied;
                if(globalsApplied){
                    const desired={...globals.settings,...(globals.prompts?{prompts:globals.prompts}:{})},previous={...previousGlobals.settings,...(previousGlobals.prompts?{prompts:previousGlobals.prompts}:{})};
                    // Preserve any newer user edit instead of overwriting it during a late rollback.
                    if(Object.keys(desired).every(key=>JSON.stringify(settings[key])===JSON.stringify(desired[key]))){Object.assign(settings,clone(previous));try{await this.saveBackupGlobals(s,previousGlobals);globalsRollback=true;}catch{}}
                }
                let rollback=false;try{this.assert(s);await trace({stage:'save'},()=>this.host.save());this.assert(s);const disk=await trace({code:'DATA-005',stage:'read'},()=>this.host.read());this.assert(s);rollback=JSON.stringify(disk.metadata?.[KEY])===JSON.stringify(previousArchive);}catch{}
                this.restoring=false;try{this.assert(s);await this.refreshMemory();}catch{}
                throw tagError(Error(error.message+(rollback&&globalsRollback?' Предыдущее состояние восстановлено.':' Восстановление не подтверждено. Локальное состояние возвращено; проверьте архив и настройки после подключения. Незавершённая копия не внедряется до проверки.'),{cause:error}),errorMeta(error));
            }
        });
    }
    async memory() {
        const s=trace({code:'MEM-001',stage:'chat'},()=>this.session()),settings=this.settings(),entries=trace({code:'MEM-002',stage:'active'},()=>this.archive(s).entries),archive=this.archive(s);
        const active=trace({code:'MEM-003',stage:'hierarchy'},()=>memoryEntries(entries));
        const ordered=trace({code:'MEM-003',stage:'hierarchy'},()=>narrativeOrder(active,entries,s.chat));
        const text=trace({code:'MEM-004',stage:'content'},()=>memoryText(entries,settings,ordered.entries));
        const tokens=await trace({code:'MEM-005',stage:'tokens'},()=>this.host.count(text));this.assert(s);
        const sources=trace({code:'MEM-008',stage:'sources'},()=>memorySources(entries,s.chat,s.key,ordered.entries));
        const conflicts=trace({code:'MEM-003',stage:'hierarchy'},()=>memoryConflicts(entries,s.key)),sourceConflicts=trace({code:'MEM-008',stage:'sources'},()=>importedSourceConflicts(entries,s.chat).filter(c=>!sources.episodes.has(c.entryId))),enabled=settings.enabled&&settings.inject;
        const limits=trace({code:'MEM-005',stage:'tokens'},()=>this.host.limits()),modelOverflow=!!text&&(!Number.isFinite(limits.context)||!Number.isFinite(limits.output)||tokens+limits.output+256>limits.context);
        const blocked=enabled&&(!!this.restoring||!!archive.pending||sourceConflicts.length>0||tokens>settings.tokenLimit||conflicts.length>0||!Number.isFinite(tokens)||modelOverflow);
        const diagnostic=this.restoring||archive.pending?{code:'MEM-002',stage:'active',reason:'pending'}:sourceConflicts.length?{code:'MEM-010',stage:'sources',reason:'source-duplicate'}:conflicts.length?{code:'MEM-010',stage:'hierarchy',reason:'memory-overlap'}:!Number.isFinite(tokens)?{code:'MEM-005',stage:'tokens',reason:'count-invalid'}:!Number.isFinite(limits.context)||!Number.isFinite(limits.output)?{code:'MEM-005',stage:'tokens',reason:'limits-unavailable'}:modelOverflow?{code:'MEM-005',stage:'tokens',reason:'context-local'}:{code:'MEM-005',stage:'tokens',reason:'memory-limit'};
        return {text,tokens,conflicts,sourceConflicts,sourceIds:sources.ids,blocked,enabled,diagnostic,placement:Number(settings.position),limitExceeded:tokens>settings.tokenLimit||modelOverflow,entries:ordered.entries,orderWarnings:ordered.warnings,reason:this.restoring?'Восстановление памяти ожидает подтверждения сохранения.':archive.pending?'Есть незавершённая операция памяти. Завершите её или восстановите исходники в настройках.':sourceConflicts.length?'Восстановленная память повторяет исходные сообщения текущего чата. Отключите её или вручную исключите эти сообщения штатными средствами SillyTavern.':conflicts.length?'Активные воспоминания пересекаются. Отключите дублирующую запись.':modelOverflow?'Активная память с резервом ответа не помещается в контекст текущей модели. Отключите часть записей либо увеличьте лимит.':`Память занимает ≈${tokens} токенов при лимите ${settings.tokenLimit}. Отключите часть записей или увеличьте лимит.`};
    }
    async prepareContext(request,type='normal',{deferDelivery=false}={}) {
        const s=this.optionalSession();if(!s)return this.refreshMemory();
        if(!Array.isArray(request)||request===s.chat)throw tagError(Error('Для формирования контекста требуется отдельная копия сообщений.'),{code:'MEM-008',stage:'sources',reason:'separate-copy'});
        const memory=await this.refreshMemory();this.assert(s);
        if(memory.enabled&&!memory.blocked&&memory.placement!==-1&&!deferDelivery){
            const ids=memory.sourceIds??new Set();
            // ST derives Continue's writeback prefix from the terminal request item.
            // Removing a covered terminal source would overwrite it with another message.
            if(type==='continue'&&ids.has(s.chat.at(-1)?.extra?.[KEY]?.id))throw tagError(Error('Дописывание этого сообщения остановлено: оно уже входит в активную память. Для новой реплики используйте обычную отправку в чат. Исходный текст сохранён.'),{code:'MEM-010',stage:'sources',reason:'continue-covered'});
            trace({code:'MEM-008',stage:'sources'},()=>stripMemorySources(request,s.chat,ids));
        }
        return memory;
    }
    refreshMemory() {
        const epoch=++this.memoryEpoch;
        this.host.inject('');
        this.memoryTask=(async()=>{
            const s=this.optionalSession();if(!s)return {text:'',tokens:0,enabled:false,blocked:false,entries:[]};
            const stamp=()=>JSON.stringify([this.archive(s).revision,this.settings()]);
            let memory,before;
            do {before=stamp();memory=await this.memory();this.assert(s);if(epoch!==this.memoryEpoch)return this.memoryTask;}while(before!==stamp());
            this.memorySnapshot={memory,session:s,stamp:stamp()};
            this.host.inject(memory.enabled&&!memory.blocked&&memory.placement!==-1?memory.text:'');return memory;
        })();
        return this.memoryTask;
    }
    peekMemory() {
        const cached=this.memorySnapshot;if(!cached)return null;
        try{this.assert(cached.session);if(cached.stamp!==JSON.stringify([this.archive(cached.session).revision,this.settings()]))return null;}catch{return null;}
        return cached.memory;
    }
    orderEntries(entries=null) {const s=this.session(),all=this.archive(s).entries;return narrativeOrder(entries??chronological(all),all,s.chat);}
    entries() {return this.orderEntries().entries;}
}

const operationMeta={generateSummary:{operation:'generate-summary',stage:'handler'},generateArc:{operation:'generate-arc',stage:'handler'},generateVolume:{operation:'generate-volume',stage:'handler'},memory:{code:'MEM-002',stage:'active',operation:'context'},prepareContext:{code:'MEM-009',stage:'handoff',operation:'context'},refreshMemory:{code:'MEM-007',stage:'injection',operation:'context'},restoreBackup:{code:'DATA-009',stage:'restore',operation:'backup-restore'},importArchive:{code:'DATA-007',stage:'import',operation:'backup-import'},recover:{code:'DATA-009',stage:'restore',operation:'backup-restore'},change:{code:'DATA-010',stage:'save',operation:'archive-edit'}};
for(const [name,meta]of Object.entries(operationMeta)){const method=Engine.prototype[name];Engine.prototype[name]=function(...args){return trace(meta,()=>method.apply(this,args));};}
const saveDraft=Engine.prototype.saveDraft;
Engine.prototype.saveDraft=function(draft,...args){const code={episode:'DATA-001',summary:'DATA-002',arc:'DATA-003',volume:'DATA-004'}[draft?.type]??'DATA-010';return trace({code,stage:'save',operation:'save-'+draft?.type},()=>saveDraft.call(this,draft,...args));};
