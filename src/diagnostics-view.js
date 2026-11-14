import {describeError,tagError} from './diagnostics.js';
let errorSink=null;
export function setErrorSink(sink){errorSink=sink;}
export function guardAction(action,meta={}){return function(...args){try{const result=action.apply(this,args);return result&&typeof result.then==='function'?Promise.resolve(result).catch(error=>{errorSink?.(error,meta);return null;}):result;}catch(error){errorSink?.(error,meta);return null;}};}
const node=(tag,attrs={},text='')=>{const n=document.createElement(tag);for(const [k,v]of Object.entries(attrs))if(k==='class')n.className=v;else n.setAttribute(k,String(v));n.textContent=text;return n;};
const button=(text,fn)=>{const b=node('button',{type:'button'},text);b.addEventListener('click',guardAction(fn,{operation:'diagnostics',stage:'ui'}));return b;};
export async function copyDiagnostics(text){
    try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}}catch{}
    const active=document.activeElement,area=node('textarea',{'aria-label':'Диагностический отчёт для копирования',readonly:'true'},text);area.style.cssText='position:fixed;left:-10000px;top:0;width:1px;height:1px;';
    try{document.body.append(area);area.select();area.setSelectionRange(0,area.value.length);if(!document.execCommand('copy'))throw Error('Браузер запретил копирование диагностики.');}
    finally{area.remove();try{active?.focus?.({preventScroll:true});}catch{}}
}
export class DiagnosticsView {
    constructor(service){this.service=service;this.settingsOpen=false;this.journalOpen=false;this.unsubscribe=service.subscribe((entry,meta)=>{if(entry&&meta.notify)this.show(entry);else if(!entry)this.hide();this.refreshSettings();});this.watchOwnErrors();}
    watchOwnErrors(){
        const base=new URL('./',import.meta.url).pathname;
        const ours=(event,error)=>typeof event.filename==='string'&&event.filename.includes(base)||typeof error?.stack==='string'&&error.stack.split('\n').slice(1).some(line=>line.includes(base));
        for(const kind of ['error','unhandledrejection'])window.addEventListener(kind,event=>{const error=event.error??event.reason;if(!ours(event,error))return;event.preventDefault();this.service.report(error??Error('Не удалось выполнить обработчик расширения.'),{code:['TypeError','ReferenceError','RangeError','SyntaxError'].includes(error?.name)?'INT-001':'INT-002',stage:'handler',operation:'ui',severity:'warning'});});
    }
    noticeRoot(){
        if(this.notice?.isConnected)return this.notice;
        const n=node('section',{id:'pensieve-diagnostics-notice','aria-live':'polite','aria-label':'Уведомление Омута памяти'});n.hidden=true;const composer=document.getElementById('send_form');if(composer)composer.before(n);else document.body?.append(n);this.notice=n;return n;
    }
    hide(){clearTimeout(this.timer);if(this.notice){this.notice.hidden=true;this.notice.replaceChildren();}}
    show(entry){
        const n=this.noticeRoot(),d=describeError(entry);if(!d)return;n.replaceChildren();n.hidden=false;n.dataset.severity=entry.severity;n.dataset.errorCode=entry.code;
        n.append(node('strong',{},entry.severity==='error'?'Омут памяти — ошибка':entry.severity==='warning'?'Омут памяти — предупреждение':'Омут памяти — уведомление'),node('p',{},d.title),node('small',{},`Код: ${entry.code} · Этап: ${d.stage}`));
        const expanded=node('div',{class:'pv-diag-expanded'});expanded.hidden=true;expanded.append(...this.details(entry));
        const detail=button('Подробности',()=>{expanded.hidden=!expanded.hidden;detail.setAttribute('aria-expanded',String(!expanded.hidden));if(!expanded.hidden)clearTimeout(this.timer);});detail.setAttribute('aria-expanded','false');
        const actions=node('div',{class:'pv-diag-actions'}),status=node('p',{'role':'status',class:'pv-diag-copy-status'});actions.append(detail,button('Копировать диагностику',()=>this.copy(this.service.reportText([entry]),status,expanded)));n.append(actions,expanded,status);
        clearTimeout(this.timer);this.timer=setTimeout(()=>{if(expanded.hidden)this.hide();},18000);
    }
    details(entry){
        const d=describeError(entry),status={error:'ошибка',blocked:'запрос остановлен',canceled:'отменена',warning:'предупреждение'}[entry.status];return [node('p',{},`Код: ${entry.code} · Операция: ${d.operation}`),node('p',{},`Этап: ${d.stage} · Статус: ${status} · Повторений: ${entry.repeats}`),node('p',{},`Причина: ${d.reason}`),node('p',{},`Что делать: ${d.action}`),node('pre',{},`Техническое сообщение: ${d.technical}\nСтек:\n${d.stack}`)];
    }
    async copy(text,status,container){
        try{await copyDiagnostics(text);status.textContent='Диагностика скопирована.';}
        catch(error){
            this.service.report(tagError(error,{code:'UI-002',stage:'ui',operation:'diagnostics'}),{notify:false});
            // The journal refresh replaces its old children while reporting the denial.
            if(!status.isConnected&&this.settingRoot?.isConnected){status=this.settingBody.querySelector('.pv-diag-copy-status');container=this.settingBody.querySelector('.pv-diag-journal');this.journalOpen=true;this.settingBody.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded','true');}
            status.textContent='Браузер запретил копирование. Можно выделить отчёт ниже и скопировать вручную.';const area=node('textarea',{readonly:'true','aria-label':'Диагностический отчёт'},text);area.className='pv-diag-manual';container.hidden=false;container.append(area);area.focus();area.select();
        }
    }
    settings(container){
        const root=node('details',{class:'pv-diagnostics','data-diagnostics':'settings'}),summary=node('summary',{},'Диагностика');root.open=this.settingsOpen;root.addEventListener('toggle',()=>this.settingsOpen=root.open);this.settingRoot=root;this.settingBody=node('div',{class:'pv-diag-settings-body'});root.append(summary,this.settingBody);container.append(root);this.refreshSettings();
    }
    refreshSettings(){
        if(!this.settingRoot?.isConnected)return;const b=this.settingBody,entries=this.service.entries;b.replaceChildren();
        b.append(node('p',{'role':'status'},this.service.persistent?'Диагностика доступна. Журнал сохраняется локально в этом браузере.':'Диагностика доступна. Хранилище недоступно: журнал только до перезагрузки.'),node('p',{},`Зарегистрировано записей: ${entries.length} / 20`));
        const recent=node('ul',{class:'pv-diag-recent'});for(const e of entries.slice(-3).reverse())recent.append(node('li',{},`${new Date(e.lastTime).toLocaleString('ru-RU')} · ${e.code} · ${describeError(e).title}`));if(!entries.length)recent.append(node('li',{},'Ошибок пока нет.'));b.append(recent);
        const journal=node('div',{class:'pv-diag-journal','aria-label':'Журнал ошибок'});journal.hidden=!this.journalOpen;
        const actions=node('div',{class:'pv-diag-actions'}),status=node('p',{'role':'status',class:'pv-diag-copy-status'});
        const open=button('Открыть журнал ошибок',()=>{this.journalOpen=!this.journalOpen;journal.hidden=!this.journalOpen;open.setAttribute('aria-expanded',String(this.journalOpen));});open.setAttribute('aria-expanded',String(this.journalOpen));
        actions.append(open,button('Скопировать отчёт',()=>this.copy(this.service.reportText(),status,journal)),button('Очистить журнал',()=>this.service.clear()));b.append(actions,status,journal);
        if(!entries.length)journal.append(node('p',{},'Журнал пуст.'));
        for(const e of entries.slice().reverse()){
            const item=node('details',{class:'pv-diag-entry','data-error-code':e.code}),s=node('summary',{},`${new Date(e.lastTime).toLocaleString('ru-RU')} · ${e.code}`),copyStatus=node('p',{'role':'status'}),content=node('div');content.append(...this.details(e),button('Копировать диагностику',()=>this.copy(this.service.reportText([e]),copyStatus,content)),copyStatus);item.append(s,content);journal.append(item);
        }
    }
}
