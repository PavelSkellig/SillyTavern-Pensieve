import {LEVELS} from './hierarchy.js';

const labels={summary:{making:'эпизод',ready:'Эпизод готов'},arc:{making:'глава',ready:'Глава готова'},volume:{making:'том',ready:'Том готов'}};
const node=(tag,className='',text='')=>{const n=document.createElement(tag);n.className=className;n.textContent=text;return n;};
const button=(text,action)=>{const n=node('button','',text);n.type='button';n.addEventListener('click',action);return n;};

/** Presentation of one existing engine operation. Hiding never owns request cancellation. */
export class GenerationView {
    constructor(engine,{makeDialog,preview,onSaved,onMinimize=()=>{},onClear=()=>{}}) {
        Object.assign(this,{engine,makeDialog,preview,onSaved,onMinimize,onClear});this.job=null;
    }
    get isMinimized(){return !!this.job?.minimized;}
    async generate(fn,{type='summary',episode=false,waitForPreview=false}={}) {
        if(this.job||this.engine.busy)throw Error('Другая операция или её результат ещё открыты. Вернитесь к индикатору «Омут памяти».');
        const session=typeof this.engine.session==='function'?this.engine.session():null;
        const job={fn,type,session,episode,status:'new',phase:'generate',minimized:episode&&!this.engine.settings().previewEpisodes,canceled:false};
        job.previewDone=new Promise(resolve=>job.resolvePreview=resolve);this.job=job;this.createWindow(job);
        if(!job.minimized)job.dialog.showModal();this.update(job);
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
        const label=labels[job.type];const title=job.status==='ready'?label.ready:error?'Ошибка создания '+LEVELS[job.type].genitive:saving?'Омут памяти — сохраняется эпизод':'Омут памяти — создаётся '+label.making;
        this.dock.replaceChildren(button(title,()=>this.restore(job)));this.dock.hidden=!job.minimized;
    }
    minimize(job) {
        if(this.job!==job||!['running','saving','error'].includes(job.status))return;
        job.minimized=true;if(job.dialog.open)job.dialog.close();this.onMinimize();this.update(job);
    }
    restore(job) {
        if(!this.current(job)||!['running','saving','ready','error'].includes(job.status))return;
        if(job.status==='ready'){this.showPreview(job);return;}
        job.minimized=false;this.update(job);if(!job.dialog.open)job.dialog.showModal();
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
    async run(job) {
        if(!this.current(job)||!['new','error'].includes(job.status))return null;
        job.status=job.phase==='save'?'saving':'running';job.errorMessage='';this.update(job);
        try {
            this.assert(job);
            if(job.phase!=='save')job.draft=await job.fn();
            if(!this.current(job))return null;
            this.assert(job);const draft=job.draft;job.type=draft.type;
            if(draft.type==='summary'&&!this.engine.settings().previewEpisodes){
                job.phase='save';job.status='saving';this.update(job);
                await this.engine.saveDraft(draft,{title:draft.title,text:draft.text});
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
        job.status='preview';job.minimized=false;this.dock.hidden=true;
        if(job.dialog.open)job.dialog.close();job.dialog.remove();
        const {done,dialog}=this.preview(job.draft);job.previewDialog=dialog;
        Promise.resolve(done).then(()=>this.clear(job),error=>{this.engine.host?.notify?.('error',error.message);this.clear(job);});
    }
}
