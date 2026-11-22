import {guardAction} from './diagnostics-view.js';
import {tagError,describeError,errorMeta} from './diagnostics.js';
import {LEVELS} from './hierarchy.js';

const labels={summary:{making:'глава',ready:'Глава готова'},arc:{making:'часть',ready:'Часть готова'},volume:{making:'том',ready:'Том готов'}};
export function operationLabel(op={}){
    const title=op.title?` · ${op.title}`:'',target=({summary:'главу',arc:'часть',volume:'том'})[op.type]??'воспоминание';
    if(op.state==='waiting'&&op.recordConfirmed)return `Запись сохранена${title} · Ожидает завершения проверки` ;
    if(op.state==='waiting')return `Ошибка: ожидает восстановления${title} · ${op.outcome==='missing'?'Запись пока не обнаружена':'Результат пока неизвестен'}`;
    if(op.state==='error')return `Ошибка операции${title}${op.outcome==='saved'?' · Запись сохранена, требуется завершить обработку':''}`;
    if(op.state==='saved')return `Сохранено${title}`;
    if(op.state==='canceled')return 'Операция отменена';
    if(op.stage==='tokens')return `Проверяю токены${title}${op.outcome==='saved'?' · Запись подтверждена':''}`;
    if(op.stage==='confirm')return `Проверяю сохранение${title}${op.attempt?` · Проверка ${op.attempt}/3`:''}`;
    if(op.stage==='write')return `Сохраняю ${target}${title}`;
    if(op.stage==='api')return `Создаю ${target}${title} · Другой запрос к модели должен подождать`;
    return 'Операция выполняется';
}
const node=(tag,className='',text='')=>{const n=document.createElement(tag);n.className=className;n.textContent=text;return n;};
const button=(text,action)=>{const n=node('button','',text);n.type='button';n.addEventListener('click',guardAction(action,{stage:'handler',operation:'ui',severity:'warning'}));return n;};

/** Presentation of one existing engine operation. Hiding never owns request cancellation. */
export class GenerationView {
    constructor(engine,{makeDialog,preview,onSaved,onMinimize=()=>{},onClear=()=>{},onError=()=>{}}) {
        Object.assign(this,{engine,makeDialog,preview,onSaved,onMinimize,onClear,onError});this.job=null;
        this.unsubscribe=engine.subscribeOperation?.(op=>{if(this.job){this.job.operation=op;this.paint(this.job);}});
    }
    get isMinimized(){return !!this.job?.windowHidden;}
    async generate(fn,{type='summary',episode=false,inline=false,waitForPreview=false}={}) {
        if(this.job||this.engine.busy)throw Error('Другая операция или её результат ещё открыты. Вернитесь к индикатору «Омут памяти».');
        const session=typeof this.engine.session==='function'?this.engine.session():null;
        const job={fn,type,session,episode,status:'new',phase:'generate',minimized:false,windowHidden:inline||episode&&!this.engine.settings().previewEpisodes,canceled:false};
        job.previewDone=new Promise(resolve=>job.resolvePreview=resolve);this.job=job;try{this.createWindow(job);if(job.windowHidden)this.onMinimize(false);else job.dialog.showModal();this.update(job);}catch(error){this.clear(job);this.engine.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'});throw error;}
        const draft=await this.run(job);
        if(waitForPreview&&draft)await job.previewDone;
        return draft;
    }
    createWindow(job) {
        const {dialog,body}=this.makeDialog(`Создание ${LEVELS[job.type].genitive}`,true);job.dialog=dialog;dialog.classList.add('pv-generation-window');
        const head=dialog.querySelector('.pv-header'),close=head.querySelector('button');job.close=close;
        const minimize=button('−',()=>this.minimize(job));minimize.className='pv-icon';minimize.setAttribute('aria-label','Свернуть окно генерации');head.insertBefore(minimize,close);
        job.message=node('p','pv-muted','Генерация выполняется. Можно свернуть окно и продолжить пользоваться чатом.');job.progress=node('progress');job.progress.setAttribute('aria-label','Генерация выполняется');
        job.error=node('p','pv-warning');job.error.setAttribute('role','status');
        job.retry=button('Повторить запрос',()=>{if(job.status==='error')this.run(job).catch(error=>this.engine.host?.notify?.('error',error));});
        job.cancel=button('Отменить генерацию',()=>job.status==='error'?this.clear(job):this.cancel(job));
        body.append(job.message,job.progress,job.error,job.retry,job.cancel,node('p','pv-muted pv-generation-note','Продолжается внутри открытой страницы. Перезагрузка или приостановка браузера системой могут прервать запрос. Исходники исключаются только после успешного сохранения.'));
        dialog.oncancel=event=>{event.preventDefault();job.status==='error'?this.clear(job):this.cancel(job);};
        this.dock??=document.getElementById('pensieve-generation-dock');
        if(!this.dock){this.dock=node('div');this.dock.id='pensieve-generation-dock';this.dock.hidden=true;const composer=document.getElementById('send_form');if(composer)composer.before(this.dock);else document.body.append(this.dock);}
    }
    current(job){return this.job===job&&!job.canceled;}
    assert(job){if(job.session)this.engine.assert(job.session);}
    update(job) {
        if(this.job!==job)return;
        const running=job.status==='running',saving=job.status==='saving'||job.previewSaving,error=job.status==='error';
        job.dialog.dataset.generationState=job.status;job.progress.hidden=!running&&!saving;job.error.hidden=!error;job.error.textContent=job.errorMessage??'';
        if(job.previewStatus?.isConnected&&(job.previewSaving||['waiting','error'].includes(job.operation?.state))){const op=job.operation??{},result=op.outcome==='saved'?'подтверждено':op.outcome==='missing'?'запись не обнаружена':'результат неизвестен';job.previewStatus.textContent=[job.previewError,operationLabel(op),op.lastCheck?`Последняя проверка: ${new Date(op.lastCheck).toLocaleTimeString()} · ${result}`:''].filter(Boolean).join('\n');}
        job.message.textContent=job.operation&&['running','saving','confirming','recovering','waiting'].includes(job.operation.state)?operationLabel(job.operation):saving?'Результат получен. Проверяется сохранение на сервере…':'Генерация выполняется. Можно свернуть окно и продолжить пользоваться чатом.';
        job.retry.hidden=!error;job.retry.disabled=!error;job.retry.textContent=job.phase==='save'?'Повторить сохранение':job.phase==='preview'?'Показать результат повторно':'Повторить запрос';job.cancel.textContent=error?'Закрыть':'Отменить генерацию';job.cancel.disabled=saving;job.close.disabled=saving;
        const label=labels[job.type],op=job.operation;const title=job.status==='ready'?label.ready:op&&['running','saving','confirming','recovering','waiting','error','saved'].includes(op.state)?operationLabel(op):error?'Ошибка создания '+LEVELS[job.type].genitive:saving?'Сохраняется '+label.making:'Создаётся '+label.making;
        this.dock.replaceChildren(button(`Омут памяти · ${title} · Развернуть`,()=>this.restore(job)));this.dock.hidden=!job.windowHidden||!!job.noticeCovered;this.dock.setAttribute('aria-busy',String(!!this.engine.busy));
    }
    minimize(job) {
        if(this.job!==job||!['running','saving','ready','error','preview'].includes(job.status))return;
        job.minimized=true;job.windowHidden=true;const dialog=job.previewDialog?.isConnected?job.previewDialog:job.dialog;
        if(dialog.open){if(dialog===job.previewDialog)dialog.pensieveMinimizeClosures=(dialog.pensieveMinimizeClosures??0)+1;dialog.close();}this.onMinimize();this.paint(job);
    }
    restore(job) {
        if(!this.current(job)||!['running','saving','ready','error','preview'].includes(job.status))return;
        job.noticeCovered=false;
        if(job.previewDialog?.isConnected){job.minimized=false;job.windowHidden=false;this.paint(job);if(!job.previewDialog.open)job.previewDialog.showModal();return;}
        if(job.status==='ready'){this.showPreview(job);return;}
        job.minimized=false;job.windowHidden=false;this.update(job);if(!job.dialog.open)job.dialog.showModal();
    }
    cancel(job) {
        if(this.job!==job||job.status==='saving'||job.previewSaving)return;
        job.canceled=true;this.engine.host.report?.(tagError(Error('Генерация отменена.'),{code:'GEN-006',stage:'api',reason:'cancel-user'}),{operation:'generate-'+job.type,status:'canceled',snapshot:{generation:'canceled',macroUsed:false}});this.engine.cancel();this.clear(job);
    }
    clear(job=this.job) {
        if(!job||this.job!==job)return;
        job.canceled=true;this.job=null;
        for(const dialog of [job.dialog,job.previewDialog])if(dialog?.isConnected){if(dialog.open)dialog.close();dialog.remove();}
        if(this.dock){this.dock.hidden=true;this.dock.replaceChildren();}
        job.resolvePreview(null);this.onClear(job);
    }
    async save(job) {
        this.assert(job);
        const draft=job.draft,archive=this.engine.archive(job.session),pending=archive.pending;
        if(!pending)return this.engine.saveDraft(draft,{title:draft.title,text:draft.text});
        // Only resume this exact automatic save. Unrelated journals belong to Settings recovery.
        const matches=entry=>entry&&entry.id===draft.commitId&&entry.version===draft.commitVersion&&entry.type===draft.type&&entry.title===draft.title&&entry.text===draft.text&&entry.active&&entry.sources.length===draft.range.length&&entry.sources.every((s,i)=>s.id===draft.range[i].id&&s.hash===draft.range[i].hash);
        if(!['hide','commit'].includes(pending.type)||!draft.commitId||pending.entryId!==draft.commitId||!matches(archive.entries.find(e=>e.id===pending.entryId)))throw Error('Незавершённая операция отличается от этого результата. Откройте восстановление в настройках; повторный запрос не требуется.');
        await this.engine.recover('complete');this.assert(job);
        const recovered=this.engine.archive(job.session),entry=recovered.entries.find(e=>e.id===draft.commitId);
        if(recovered.pending||!matches(entry))throw Error('Не удалось подтвердить завершение сохранения. Откройте восстановление в настройках.');
        return entry;
    }
    paint(job) {try{this.update(job);}catch(error){this.engine.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'});}}
    async run(job) {
        if(!this.current(job)||!['new','error'].includes(job.status))return null;
        job.status=job.phase==='save'?'saving':'running';job.errorMessage='';this.paint(job);
        try {
            this.assert(job);
            job.noticeCovered=false;if(job.phase==='generate')job.draft=await job.fn();
            if(!this.current(job))return null;
            this.assert(job);const draft=job.draft;job.type=draft.type;
            if(job.phase==='save'||draft.type==='summary'&&!draft.replaceId&&!this.engine.settings().previewEpisodes&&!draft.truncated&&!draft.reasoningAmbiguous){
                job.phase='save';job.status='saving';this.paint(job);
                await this.save(job);
                if(!this.current(job))return null;
                try{await this.onSaved(draft);}catch(error){this.engine.host.report?.(error,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'});}this.clear(job);
            }else{
                job.phase='preview';job.status='ready';this.paint(job);
                if(!job.minimized)this.showPreview(job);
            }
            return draft;
        }catch(error){
            if(!this.current(job))return null;
            const presentation=job.phase==='preview',record=this.engine.host.report?.(error,presentation?{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'}:{operation:job.phase==='save'?'save-'+job.type:'generate-'+job.type});job.status='error';job.errorMessage=record?describeError(record).brief:error?.message??String(error);if(errorMeta(error).code==='GEN-001'){
                job.errorMessage+='\nГенерация прервана. SillyTavern не вернул пригодный черновик. Повторите запрос.';
            }
            this.onError(record);this.minimize(job);this.paint(job);if(presentation)return job.draft;throw error;
        }
    }
    showPreview(job) {
        if(!this.current(job)||job.status!=='ready')return;
        try{this.assert(job);}catch(error){const record=this.engine.host.report?.(error,{operation:'generate-'+job.type});job.status='error';job.errorMessage=record?describeError(record).brief:error.message;this.onError(record);this.minimize(job);return;}
        job.status='preview';job.minimized=false;job.windowHidden=false;this.dock.hidden=true;
        if(job.dialog.open)job.dialog.close();
        const {done,dialog}=this.preview(job.draft);job.previewDialog=dialog;job.dialog.remove();
        Promise.resolve(done).then(()=>this.clear(job),error=>{this.engine.host?.notify?.('error',error);this.clear(job);});
    }
}
