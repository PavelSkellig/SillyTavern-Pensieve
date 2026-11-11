import {LEVELS} from './hierarchy.js';

const labels={summary:{making:'глава',ready:'Глава готова'},arc:{making:'часть',ready:'Часть готова'},volume:{making:'том',ready:'Том готов'}};
const node=(tag,className='',text='')=>{const n=document.createElement(tag);n.className=className;n.textContent=text;return n;};
const button=(text,action)=>{const n=node('button','',text);n.type='button';n.addEventListener('click',action);return n;};

/** Presentation of one existing engine operation. Hiding never owns request cancellation. */
export class GenerationView {
    constructor(engine,{makeDialog,preview,onSaved,onMinimize=()=>{},onClear=()=>{}}) {
        Object.assign(this,{engine,makeDialog,preview,onSaved,onMinimize,onClear});this.job=null;
    }
    get isMinimized(){return !!this.job?.windowHidden;}
    async generate(fn,{type='summary',episode=false,inline=false,waitForPreview=false}={}) {
        if(this.job||this.engine.busy)throw Error('Другая операция или её результат ещё открыты. Вернитесь к индикатору «Омут памяти».');
        const session=typeof this.engine.session==='function'?this.engine.session():null;
        const job={fn,type,session,episode,status:'new',phase:'generate',minimized:false,windowHidden:inline||episode&&!this.engine.settings().previewEpisodes,canceled:false};
        job.previewDone=new Promise(resolve=>job.resolvePreview=resolve);this.job=job;this.createWindow(job);
        if(job.windowHidden)this.onMinimize(false);else job.dialog.showModal();this.update(job);
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
        job.retry=button('Повторить запрос',()=>{if(job.status==='error')this.run(job).catch(error=>this.engine.host?.notify?.('error',error.message));});
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
        const running=job.status==='running',saving=job.status==='saving',error=job.status==='error';
        job.dialog.dataset.generationState=job.status;job.progress.hidden=!running&&!saving;job.error.hidden=!error;job.error.textContent=job.errorMessage??'';
        job.message.textContent=saving?'Результат получен. Проверяется сохранение на сервере…':'Генерация выполняется. Можно свернуть окно и продолжить пользоваться чатом.';
        job.retry.hidden=!error;job.retry.disabled=!error;job.retry.textContent=job.phase==='save'?'Повторить сохранение':'Повторить запрос';job.cancel.textContent=error?'Закрыть':'Отменить генерацию';job.cancel.disabled=saving;job.close.disabled=saving;
        const label=labels[job.type];const title=job.status==='ready'?label.ready:error?'Ошибка создания '+LEVELS[job.type].genitive:saving?'Омут памяти — сохраняется глава':'Омут памяти — создаётся '+label.making;
        this.dock.replaceChildren(button(title,()=>this.restore(job)));this.dock.hidden=!job.windowHidden;
    }
    minimize(job) {
        if(this.job!==job||!['running','saving','error'].includes(job.status))return;
        job.minimized=true;job.windowHidden=true;if(job.dialog.open)job.dialog.close();this.onMinimize();this.update(job);
    }
    restore(job) {
        if(!this.current(job)||!['running','saving','ready','error'].includes(job.status))return;
        if(job.status==='ready'){this.showPreview(job);return;}
        job.minimized=false;job.windowHidden=false;this.update(job);if(!job.dialog.open)job.dialog.showModal();
    }
    cancel(job) {
        if(this.job!==job||job.status==='saving')return;
        job.canceled=true;this.engine.cancel();this.clear(job);
    }
    clear(job=this.job) {
        if(!job||this.job!==job)return;
        job.canceled=true;this.job=null;
        for(const dialog of [job.dialog,job.previewDialog])if(dialog?.isConnected){if(dialog.open)dialog.close();dialog.remove();}
        if(this.dock){this.dock.hidden=true;this.dock.replaceChildren();}
        job.resolvePreview(null);this.onClear();
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
    async run(job) {
        if(!this.current(job)||!['new','error'].includes(job.status))return null;
        job.status=job.phase==='save'?'saving':'running';job.errorMessage='';this.update(job);
        try {
            this.assert(job);
            if(job.phase!=='save')job.draft=await job.fn();
            if(!this.current(job))return null;
            this.assert(job);const draft=job.draft;job.type=draft.type;
            if(job.phase==='save'||draft.type==='summary'&&!this.engine.settings().previewEpisodes){
                job.phase='save';job.status='saving';this.update(job);
                await this.save(job);
                if(!this.current(job))return null;
                await this.onSaved(draft);this.clear(job);
            }else{
                job.phase='preview';job.status='ready';this.update(job);
                if(!job.minimized)this.showPreview(job);
            }
            return draft;
        }catch(error){
            if(!this.current(job))return null;
            job.status='error';job.errorMessage=error?.message??String(error);this.update(job);throw error;
        }
    }
    showPreview(job) {
        if(!this.current(job)||job.status!=='ready')return;
        try{this.assert(job);}catch(error){job.status='error';job.errorMessage=error.message;this.restore(job);return;}
        job.status='preview';job.minimized=false;job.windowHidden=false;this.dock.hidden=true;
        if(job.dialog.open)job.dialog.close();job.dialog.remove();
        const {done,dialog}=this.preview(job.draft);job.previewDialog=dialog;
        Promise.resolve(done).then(()=>this.clear(job),error=>{this.engine.host?.notify?.('error',error.message);this.clear(job);});
    }
}
