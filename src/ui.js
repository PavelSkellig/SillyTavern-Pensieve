import {KEY,defaults,clone,bytes,WARN_ARCHIVE_BYTES,exportArchive,chronological,captureRange,findOverlaps,inspectSources,fingerprint,hasDetachedSources} from './core.js';
import {memoryViewState,filterArchive,entryDisplayTitle} from './view-state.js';
import {LEVELS,childrenIds,hierarchyIndex,entryNumber,relationLabel} from './hierarchy.js';
import {createBackup,parseBackup,planRestore} from './backup.js';
import {GenerationView} from './generation-view.js';
import {messageLabels} from './source-links.js';

export const UI_VERSION='1.6.5';

const el=(tag,attrs={},text='')=>{const node=document.createElement(tag);for(const [k,v]of Object.entries(attrs))if(k==='class')node.className=v;else if(k==='checked')node.checked=v;else node.setAttribute(k,String(v));if(text)node.textContent=text;return node;};
const button=(text,fn,primary=false)=>{const b=el('button',{type:'button',class:primary?'pv-primary':''},text);b.addEventListener('click',fn);return b;};
const iconButton=(text,fn,glyph,primary=false)=>{const b=button('',fn,primary);b.append(el('i',{class:'fa-solid '+glyph,'aria-hidden':'true'}),el('span',{},text));return b;};
const row=(...nodes)=>{const r=el('div',{class:'pv-row'});r.append(...nodes);return r;};
const field=(title,node)=>{const l=el('label',{},title);l.append(node);return l;};
const download=(name,text,type='application/json')=>{const url=URL.createObjectURL(new Blob([text],{type}));const a=el('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const readFile=accept=>new Promise(resolve=>{const input=el('input',{type:'file',accept});input.onchange=async()=>resolve(input.files?.[0]?{name:input.files[0].name,text:await input.files[0].text()}:null);input.oncancel=()=>resolve(null);input.click();});
async function copy(text){try{await navigator.clipboard.writeText(text);}catch{const t=el('textarea',{},text);document.body.append(t);t.select();const success=document.execCommand('copy');t.remove();if(!success)throw Error('Браузер запретил копирование. Выделите текст и скопируйте вручную.');}}

export class UI {
    constructor(engine) {this.e=engine;this.tab='memory';this.archiveTab='summary';this.archiveFilter='all';this.archiveSearch='';this.arcOrderManual=false;this.volumeOrderManual=false;this.promptTab='summary';this.start=null;this.end=null;this.rangeEdges={start:null,end:null};this.rangeChatKey=null;this.rangeCache=new Map();this.chosen=[];this.chaptersChosen=[];this.editor=null;this.timer=null;this.renderId=0;this.windowState='closed';this.resumeDirty=false;}
    async mount(html) {
        const template=el('template');template.innerHTML=html;document.body.append(template.content);
        this.panel=document.querySelector('#pensieve-panel');this.content=this.panel.querySelector('.pv-content');
        // Report the code that actually loaded, even if a newer manifest is already available.
        const version=el('span',{class:'pv-version','aria-label':'Версия интерфейса'},`v${UI_VERSION}`);
        const caption=this.panel.querySelector('.pv-caption')??this.panel.querySelector('.pv-header p');
        if(caption){caption.classList.add('pv-caption');caption.parentElement.classList.add('pv-brand');caption.append(document.createTextNode(' '),version);}
        else this.panel.querySelector('.pv-header').append(version);
        const head=this.panel.querySelector('.pv-header');
        if(!head.querySelector('.pv-brand-mark')){head.querySelector('h2 i')?.remove();const mark=el('div',{class:'pv-brand-mark','aria-hidden':'true'});mark.append(el('i',{class:'fa-solid fa-book-open'}));head.prepend(mark);}
        this.panel.querySelectorAll('[data-tab]').forEach(b=>{const label=b.dataset.tab==='memory'?'Память':b.textContent.trim();b.setAttribute('aria-label',label);b.replaceChildren(el('span',{class:'pv-tab-full'},label));if(b.dataset.tab==='memory')b.append(el('span',{class:'pv-tab-short','aria-hidden':'true'},'Память'));});
        // Also upgrade a cached older panel template without requiring a hard reload.
        let minimize=this.panel.querySelector('[data-action="minimize"]');
        if(!minimize){minimize=button('−',()=>this.minimize());minimize.dataset.action='minimize';minimize.classList.add('pv-icon');minimize.setAttribute('aria-label','Свернуть окно');this.panel.querySelector('[data-action="close"]').before(minimize);}
        minimize.onclick=()=>this.minimize();
        this.panel.querySelector('[data-action="close"]').onclick=()=>this.close();
        this.restoreDock=el('div',{id:'pensieve-restore-dock',hidden:'true'});
        const restore=iconButton('Омут памяти',()=>this.restore(),'fa-book-open');restore.setAttribute('aria-label','Восстановить Омут памяти');this.restoreDock.append(restore);
        const composer=document.getElementById('send_form');
        if(composer)composer.before(this.restoreDock);else this.panel.before(this.restoreDock);
        if(!head.querySelector('.pv-sky')){const sky=el('div',{class:'pv-sky','aria-hidden':'true'});for(const name of ['hills','bridge','castle','eagle','sky-line'])sky.append(el('span',{class:'pv-'+name}));head.prepend(sky);}
        // Keep ST's document-wide drawer handlers out of this window's click path.
        this.panel.addEventListener('click',event=>event.stopPropagation());
        this.panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();this.close();}});
        this.panel.addEventListener('close',()=>{
            // close is queued by the browser; a rapid restore may already have reopened it.
            if(this.panel.open)return;
            if(this.windowState!=='minimized'){this.windowState='closed';this.restoreDock.hidden=true;}
            const target=this.returnFocus;
            if(target?.isConnected&&target.getClientRects().length)target.focus({preventScroll:true});
            else document.querySelector('#send_textarea')?.focus({preventScroll:true});
        });
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>this.go(b.dataset.tab));
        await this.mountSettingsDrawer();
        // ST creates the wand menu after loading third-party extensions.
        const mountMenu=()=>{const menu=document.querySelector('#extensionsMenu');if(!menu||document.getElementById('pensieve-menu-open'))return;const b=button('',event=>{this.returnFocus=event.currentTarget;this.open();});b.id='pensieve-menu-open';b.classList.add('list-group-item');const label=el('span',{class:'pv-lower-label'});label.append(el('span',{},'Омут памяти'),el('small',{class:'pv-lower-caption'},'Архив воспоминаний'));b.append(el('i',{class:'fa-solid fa-book-open','aria-hidden':'true'}),label);menu.append(b);};mountMenu();
        document.addEventListener('click',event=>{
            const action=event.target.closest('[data-pensieve-edge]');if(!action)return;
            const id=Number(action.closest('.mes')?.getAttribute('mesid'));if(!Number.isInteger(id))return;
            const edge=action.dataset.pensieveEdge;
            this.rangeWarning=null;
            this.setRangeEdge(edge,id);this.decorateMessages();
            this.e.host.notify('success',`${edge==='start'?'Начало':'Конец'} главы: сообщение №${id+1}.`);
            if(this.start!==null&&this.end!==null&&this.end<this.start)this.e.host.notify('warning','Конец главы выбран раньше начала. Измените одну из границ.');
            if(this.panel.open&&this.tab==='home')this.render();
        });
        const c=this.e.host.context();
        if(c.eventTypes.APP_READY)c.eventSource.on(c.eventTypes.APP_READY,mountMenu);
        c.eventSource.on(c.eventTypes.CHAT_CHANGED,()=>{
            this.e.host.inject('');if(this.e.busy)this.e.cancel();
            this.generationView?.clear();
            this.loadRange();this.chosen=[];this.chaptersChosen=[];this.arcOrderManual=false;this.volumeOrderManual=false;this.archiveSearch='';
            this.resumeDirty=true;
            this.panel.querySelector('.pv-chat-name').textContent=this.e.host.context().chatId?`Чат: ${this.e.host.context().chatId}`:'Общие настройки · чат не открыт';
            if(this.editor){this.editor.close();this.editor.remove();this.editor=null;}
            for(const dialog of document.querySelectorAll('.pv-editor[data-chat-scoped]')){dialog.close();dialog.remove();}
            // Prompts are global: a chat event must never replace their unsaved DOM.
            if(this.tab!=='prompts'&&this.panel.open){this.rememberView();this.content.dataset.ready='false';this.content.replaceChildren(el('p',{class:'pv-muted'},'Загрузка архива…'));}
            this.schedule(this.tab!=='prompts');
        });
        for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SENT','MESSAGE_RECEIVED','MORE_MESSAGES_LOADED','USER_MESSAGE_RENDERED','CHARACTER_MESSAGE_RENDERED'])if(c.eventTypes[name])c.eventSource.on(c.eventTypes[name],()=>this.schedule());
        const chat=document.querySelector('#chat');if(chat)new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('.mes')||n.querySelector?.('.mes')))))this.schedule();}).observe(chat,{childList:true,subtree:true});
        this.loadRange();await this.refresh();
    }
    rangeStorageKey() {return `pensieve_range_v1:${this.rangeChatKey}`;}
    loadRange() {
        this.start=null;this.end=null;this.rangeEdges={start:null,end:null};this.rangeChatKey=null;this.rangeWarning=null;
        try{this.e.session();this.rangeChatKey=this.e.key();}catch{return;}
        let saved=this.rangeCache.get(this.rangeChatKey);
        if(!saved)try{saved=JSON.parse(sessionStorage.getItem(this.rangeStorageKey())??'null');}catch{}
        if(saved&&typeof saved==='object')this.rangeEdges={start:saved.start??null,end:saved.end??null};
        this.resolveRange();
    }
    persistRange() {
        if(!this.rangeChatKey)return;
        this.rangeCache.set(this.rangeChatKey,this.rangeEdges);
        const record=edge=>edge?{id:edge.id,index:edge.index,hash:edge.hash}:null;
        try{sessionStorage.setItem(this.rangeStorageKey(),JSON.stringify({start:record(this.rangeEdges.start),end:record(this.rangeEdges.end)}));}catch{}
    }
    setRangeEdge(edge,index) {
        if(!['start','end'].includes(edge))return;
        if(this.rangeChatKey!==this.e.key())this.loadRange();
        const m=Number.isInteger(index)?this.e.host.context().chat[index]:null;
        this.rangeEdges[edge]=m?{id:m.extra?.[KEY]?.id??null,index,hash:fingerprint(m),ref:m}:null;
        this[edge]=m?index:null;this.persistRange();
    }
    resolveRange() {
        if(!this.rangeChatKey)return;
        const chat=this.e.host.context().chat;
        for(const edge of ['start','end']) {
            const saved=this.rangeEdges[edge];if(!saved){this[edge]=null;continue;}
            let found=[];
            if(saved.id)found=chat.map((m,i)=>m.extra?.[KEY]?.id===saved.id?i:-1).filter(i=>i>=0);
            else if(saved.ref)found=chat.includes(saved.ref)?[chat.indexOf(saved.ref)]:[];
            else found=chat.map((m,i)=>fingerprint(m)===saved.hash?i:-1).filter(i=>i>=0);
            const index=found.length===1?found[0]:null;
            if(index===null||fingerprint(chat[index])!==saved.hash){this.rangeEdges[edge]=null;this[edge]=null;this.rangeWarning='Выбранная граница изменена, удалена или неоднозначна. Укажите её заново.';}
            else{saved.index=index;saved.ref=chat[index];this[edge]=index;}
        }
        this.persistRange();
    }
    clearRange() {this.rangeEdges={start:null,end:null};this.start=null;this.end=null;this.rangeWarning=null;this.persistRange();}
    async createEpisodeFromChat() {
        if(this.episodeTask||this.e.busy)return;this.episodeTask=true;
        let progress;
        try{return await this.act(async()=>{
            const session=this.e.session();if(this.rangeChatKey!==session.key)throw Error('Выберите диапазон в текущем чате.');this.resolveRange();
            const range=captureRange(this.e.host.context().chat,this.start,this.end);if(findOverlaps(this.e.archive(session).entries,range).length)throw Error('Диапазон уже обработан. Для отдельной версии или замены используйте форму главы на главной странице.');
            const end=this.end,node=[...document.querySelectorAll('#chat .mes[mesid]')].find(n=>Number(n.getAttribute('mesid'))===end);
            progress=el('div',{class:'pv-chat-progress',role:'status'},'Создаётся глава…');(node?.querySelector('.mes_block')??node)?.append(progress);this.decorateMessages();
            return this.generating(()=>this.generateCapturedRange(session,range),{inline:true,episode:true,waitForPreview:true,type:'summary'});
        });}finally{progress?.remove();this.episodeTask=false;this.decorateMessages();}
    }
    async episodeSaved(draft) {
        if(draft.type!=='summary')return;
        if(this.rangeChatKey===draft.session.key&&this.rangeEdges.start?.ref===draft.range[0]?.ref&&this.rangeEdges.end?.ref===draft.range.at(-1)?.ref)this.clearRange();
        this.decorateMessages();this.e.host.notify('success','Глава сохранена в памяти текущего чата.');
    }
    async mountSettingsDrawer() {
        const {toggleDrawer}=await import('/scripts/utils.js');
        if(document.getElementById('pensieve-settings'))return;
        const container=document.getElementById('extensions_settings2')??document.getElementById('extensions_settings');
        if(!container)throw Error('Не удалось найти панель настроек расширений SillyTavern.');
        // A dedicated outer wrapper keeps this drawer a full-width sibling of other extensions.
        const root=el('div',{id:'pensieve-settings',class:'pensieve-settings'});
        const drawer=el('div',{class:'inline-drawer'});
        const header=el('button',{
            id:'pensieve-settings-toggle',class:'inline-drawer-toggle inline-drawer-header pv-settings-header',
            type:'button','aria-expanded':'false','aria-controls':'pensieve-settings-content',
        });
        const title=el('b',{class:'pv-settings-title'});
        title.append(el('i',{class:'fa-solid fa-book-open','aria-hidden':'true'}),el('span',{},'Омут памяти'));
        const icon=el('div',{class:'inline-drawer-icon fa-solid fa-circle-chevron-down down','aria-hidden':'true'});
        header.append(title,icon);
        const content=el('div',{id:'pensieve-settings-content',class:'inline-drawer-content pv-settings-content'});
        const actions=el('div',{class:'pv-settings-actions'});
        const items=[
            ['pensieve-settings-home','Главная','fa-house',()=>this.open('home')],
            ['pensieve-settings-archive','Архив','fa-box-archive',()=>this.open('archive')],
            ['pensieve-settings-memory','Память','fa-eye',()=>this.open('memory')],
            ['pensieve-settings-prompts','Промпты','fa-feather',()=>this.open('prompts')],
            ['pensieve-settings-options','Настройки','fa-gear',()=>this.open('settings')],
        ];
        for(const [id,label,glyph,action]of items) {
            const control=button('',event=>{
                event.stopPropagation();this.returnFocus=event.currentTarget;action();
                const settingsDrawer=document.querySelector('#extensions-settings-button .drawer-content');
                if(settingsDrawer?.classList.contains('openDrawer'))document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
            });control.id=id;control.className='pv-settings-action';
            control.append(el('i',{class:`fa-solid ${glyph}`,'aria-hidden':'true'}),el('span',{},label));
            actions.append(control);
        }
        content.append(actions);drawer.append(header,content);root.append(drawer);container.append(root);
        let restoring=true;
        drawer.addEventListener('inline-drawer-toggle',()=>{
            const expanded=icon.classList.contains('up');
            header.setAttribute('aria-expanded',String(expanded));content.hidden=!expanded;
            if(restoring)return;
            const settings=this.e.settings();settings.ui??={};
            if(settings.ui.drawerExpanded!==expanded){
                settings.ui.drawerExpanded=expanded;this.e.host.context().saveSettingsDebounced();
            }
        });
        // One semantic click (mouse, touch or keyboard) uses ST's native drawer API.
        // Stop the document delegate so the same click cannot toggle this drawer twice.
        header.addEventListener('click',event=>{
            event.preventDefault();event.stopPropagation();
            toggleDrawer(drawer,header.getAttribute('aria-expanded')!=='true');
        });
        toggleDrawer(drawer,this.e.settings().ui?.drawerExpanded===true);restoring=false;
    }
    schedule(render=false) {const tab=this.tab,update=render||(this.panel?.open&&['archive','memory'].includes(tab));clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh(update&&this.tab===tab).catch(error=>console.warn('[Pensieve]',error.message)),100);}
    showNotice(text) {const n=this.panel.querySelector('.pv-notice');n.hidden=!text;n.textContent=text;}
    async act(fn) {
        try {const result=await fn();await this.refresh(true);return result;}
        catch(error){this.showNotice(error.message);this.e.host.notify('error',error.message);await this.refresh(false).catch(()=>{});return null;}
    }
    open(tab=this.tab) {
        const force=this.windowState==='closed'||this.windowState==='minimized'&&tab!=='prompts';
        this.windowState='open';this.restoreDock.hidden=true;
        if(!this.panel.open)this.panel.show();
        // ST replaces chat metadata before emitting CHAT_CHANGED. Check the live
        // session synchronously, including during a pending chat network request.
        this.go(tab,force);
        this.resumeDirty=false;
    }
    minimize() {if(!this.panel.open)return;this.windowState='minimized';this.restoreDock.hidden=!!this.generationView?.isMinimized;this.panel.close();}
    restore() {this.open();}
    close() {this.windowState='closed';this.restoreDock.hidden=true;this.panel.close();}
    isCurrentSession() {try{if(!this.renderSession)return false;this.e.assert(this.renderSession);return true;}catch{return false;}}
    canReuseView(tab) {
        if(this.content.dataset.view!==tab||this.content.dataset.ready!=='true')return false;
        if(tab==='prompts')return true;
        if(tab==='settings'&&!this.renderSession){try{this.e.session();return false;}catch{return true;}}
        return this.isCurrentSession()&&!this.resumeDirty;
    }
    rememberView() {
        if(this.content.dataset.ready!=='true')return;
        const editor=this.promptEditor;
        if(editor&&this.content.contains(editor.node)){
            this.promptDrafts??=new Map();
            if(editor.node.value===editor.base)this.promptDrafts.delete(editor.key);
            else this.promptDrafts.set(editor.key,{base:editor.base,text:editor.node.value});
        }
        this.workspaceViews??=new Map();
        this.workspaceViews.set(JSON.stringify([this.renderSession?.key??null,this.content.dataset.view]),{
            scroll:this.content.scrollTop,overlap:this.content.querySelector('[aria-label="Повторная обработка"]')?.value,
            preview:!!this.content.querySelector('.pv-preview-details[open]'),help:!!this.content.querySelector('.pv-archive-help[open]'),
            openEntries:[...this.content.querySelectorAll('[data-entry-id] .pv-entry-more[open]')].map(n=>n.closest('[data-entry-id]').dataset.entryId),
        });
    }
    restoreView() {
        this.content.dataset.ready='true';
        this.resumeDirty=false;
        const saved=this.workspaceViews?.get(JSON.stringify([this.renderSession?.key??null,this.tab]));if(!saved)return;
        const overlap=this.content.querySelector('[aria-label="Повторная обработка"]');if(overlap&&[...overlap.options].some(o=>o.value===saved.overlap))overlap.value=saved.overlap;
        const preview=this.content.querySelector('.pv-preview-details');if(preview)preview.open=saved.preview;
        const help=this.content.querySelector('.pv-archive-help');if(help)help.open=saved.help;
        for(const details of this.content.querySelectorAll('[data-entry-id] .pv-entry-more'))details.open=saved.openEntries.includes(details.closest('[data-entry-id]').dataset.entryId);
        this.content.scrollTop=saved.scroll;
    }
    go(tab,force=false) {if(!force&&this.canReuseView(tab))return;this.tab=tab;this.showNotice('');this.render().catch(error=>this.showNotice(error.message));}
    async refresh(render=false) {
        if(this.windowState!=='open')this.resumeDirty=true;
        const tab=this.tab;
        this.panel.dataset.theme=this.e.settings().theme;
        const memory=await this.e.refreshMemory();this.lastMemory=memory;this.decorateMessages();
        if(memory.blocked&&tab!=='memory'){this.memoryNotice=memory.reason;this.showNotice(memory.reason);}
        else if(this.panel.querySelector('.pv-notice').textContent===this.memoryNotice){this.showNotice('');this.memoryNotice=null;}
        if(render&&this.panel.open&&this.tab===tab)await this.render(memory);
    }
    async render(snapshot=null) {
        const stamp=++this.renderId;this.panel.dataset.theme=this.e.settings().theme;
        this.rememberView();this.content.dataset.ready='false';
        this.content.dataset.view=this.tab;
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===this.tab?'page':'false'));
        this.content.replaceChildren(el('p',{class:'pv-muted'},'Загрузка архива…'));
        let session;try{session=this.e.session();}catch{
            this.renderSession=null;
            this.lastMemory=null;this.viewState=null;this.sourceRanges=null;
            this.panel.querySelector('.pv-chat-name').textContent='Общие настройки · чат не открыт';this.content.replaceChildren();
            if(this.tab==='prompts')this.promptsView();
            else if(this.tab==='settings')this.settingsView(null);
            else this.content.append(el('p',{class:'pv-empty'},'Откройте сохранённый чат, чтобы работать с его памятью.'),row(button('Промпты',()=>this.go('prompts')),button('Общие настройки',()=>this.go('settings'))));
            this.restoreView();return;
        }
        this.renderSession=session;
        const memory=snapshot??await this.e.refreshMemory();if(stamp!==this.renderId)return;this.e.assert(session);
        const archive=this.e.archive(session);this.lastMemory=memory;this.viewState=memoryViewState(archive.entries,memory,[...this.chosen,...this.chaptersChosen]);this.sourceRanges=this.e.orderEntries(archive.entries).ranges;
        if(this.rangeChatKey!==this.e.key())this.loadRange();else this.resolveRange();
        this.content.replaceChildren();
        this.panel.querySelector('.pv-chat-name').textContent=`Чат: ${this.e.host.context().chatId}`;
        if(archive.pending)this.content.append(el('div',{class:'pv-warning'},'Есть незавершённая операция. В настройках можно завершить её или вернуть исходники в контекст.'));
        if(bytes(archive)>WARN_ARCHIVE_BYTES)this.content.append(el('div',{class:'pv-warning'},'Архив больше 5 MiB. Сохраните резервную копию JSON.'));
        if(this.tab==='home')this.home(archive);
        if(this.tab==='archive')this.archiveView(archive);
        if(this.tab==='memory')await this.memoryView(archive,stamp);
        if(this.tab==='prompts')this.promptsView();
        if(this.tab==='settings')this.settingsView(archive);
        this.restoreView();
    }
    home(archive) {
        const home=el('section',{class:'pv-home'}),actions=el('div',{class:'pv-home-actions'});
        const summary=iconButton('Создать главу',()=>{this.content.querySelector('[name="rangeStart"]')?.focus();},'fa-bookmark');
        const arc=iconButton('Создать часть',()=>{this.archiveTab='summary';this.go('archive');},'fa-book-open'),volume=iconButton('Создать том',()=>{this.archiveTab='arc';this.go('archive');},'fa-book');actions.append(summary,arc,volume);
        const settings=this.e.settings(),memory=this.lastMemory;
        const stats=el('div',{class:'pv-home-stats'},`Глав: ${archive.entries.filter(e=>e.type==='summary').length} · Частей: ${archive.entries.filter(e=>e.type==='arc').length} · Томов: ${archive.entries.filter(e=>e.type==='volume').length} · Память ${settings.enabled&&settings.inject?'включена':'выключена'} · ≈${memory?.tokens??0} токенов`);
        const form=el('section',{class:'pv-summary-form','aria-labelledby':'pv-summary-heading'}),heading=el('div',{class:'pv-section-heading'});
        heading.append(el('h3',{id:'pv-summary-heading'},'Новая глава'),el('small',{},`Память: ${settings.enabled&&settings.inject?(memory?.blocked?'требует внимания':'включена'):'выключена'}`));
        form.append(heading,el('p',{class:'pv-muted'},'Отметьте границы в меню сообщений или укажите номера ниже. Первое сообщение имеет номер 1.'));
        home.append(actions,stats,form);this.content.append(home);
        if(this.rangeWarning)form.append(el('p',{class:'pv-warning'},this.rangeWarning));
        const start=el('input',{type:'number',min:1,max:this.e.host.context().chat.length,name:'rangeStart',value:this.start===null?'':this.start+1});
        const end=el('input',{type:'number',min:1,max:this.e.host.context().chat.length,name:'rangeEnd',value:this.end===null?'':this.end+1});
        const range=el('div',{class:'pv-range'});range.append(field('Первое сообщение',start),field('Последнее сообщение',end));form.append(range);
        const preview=el('section',{class:'pv-range-preview','aria-label':'Предпросмотр диапазона'});form.append(preview);
        let overlaps=[];
        const options=el('select',{'aria-label':'Повторная обработка'});options.append(el('option',{value:'block'},'Не обрабатывать повторно'),el('option',{value:'version'},'Разрешить отдельную версию'));
        const update=()=>{
            this.setRangeEdge('start',start.value===''?null:Number(start.value)-1);this.setRangeEdge('end',end.value===''?null:Number(end.value)-1);
            preview.replaceChildren();overlaps=[];
            try{const r=captureRange(this.e.host.context().chat,this.start,this.end);overlaps=findOverlaps(archive.entries,r);
                const n=r.length%100,tail=n%10,unit=n>=11&&n<=14?'сообщений':tail===1?'сообщение':tail>=2&&tail<=4?'сообщения':'сообщений';
                preview.append(el('strong',{},`Сообщения ${this.start+1}–${this.end+1} · ${r.length} ${unit}`));
                const snippet=(source,label)=>{const text=source.text.replace(/\s+/g,' ').trim();return el('p',{class:'pv-range-snippet'},`${label} · ${source.name}: ${text.length>70?`${text.slice(0,70)}…`:text}`);};
                preview.append(snippet(r[0],r.length===1?'Сообщение':'Начало'));if(r.length>1)preview.append(snippet(r.at(-1),'Конец'));
                const details=el('details',{class:'pv-preview-details'}),toggle=el('summary',{},'Показать подробнее'),full=el('div',{class:'pv-full-preview',tabindex:'0','aria-label':'Все выбранные сообщения'});
                details.append(toggle,full);details.addEventListener('toggle',()=>{
                    toggle.textContent=details.open?'Скрыть подробности':'Показать подробнее';
                    if(!details.open||full.childElementCount)return;
                    const fragment=document.createDocumentFragment();for(const source of r){const item=el('article');item.append(el('strong',{},`№${source.index+1} · ${source.name}`),el('p',{class:'pv-preview-text'},source.text));fragment.append(item);}full.append(fragment);
                });preview.append(details);
                if(overlaps.length){const label=`главе №${entryNumber(overlaps[0],archive.entries)}`;preview.append(el('p',{class:'pv-overlap-note',title:overlaps.map(e=>e.title).join('; ')},`Уже сохранено в ${label}${overlaps.length>1?` и ещё ${overlaps.length-1}`:''}`));}
            }catch{preview.append(el('span',{class:'pv-muted'},'Укажите начало и конец прямого диапазона.'));}
            const previous=options.value;options.querySelectorAll('[data-replace]').forEach(n=>n.remove());
            for(const e of overlaps)options.append(el('option',{value:e.id,'data-replace':'true'},`Заменить: ${e.title}`));if([...options.options].some(o=>o.value===previous))options.value=previous;
            options.hidden=!overlaps.length;this.decorateMessages();
        };
        start.oninput=end.oninput=()=>{this.rangeWarning=null;update();};update();form.append(options);
        form.append(row(button('Создать главу',()=>this.act(async()=>{
            if(this.start===null||this.end===null)throw Error('Сначала выберите обе границы.');
            if(overlaps.length&&options.value!=='block'&&!await this.confirm('Повторная обработка','Этот диапазон уже представлен в архиве. Продолжить выбранным способом?'))return;
            const session=this.e.session(),start=this.start,end=this.end,range=captureRange(this.e.host.context().chat,start,end),mode=options.value;
            await this.generating(()=>this.generateCapturedRange(session,range,{allowOverlap:mode!=='block',replaceId:['block','version'].includes(mode)?null:mode}),{episode:true,type:'summary'});
        }),true),button('Сбросить диапазон',()=>{this.clearRange();this.decorateMessages();this.render();})));
        form.append(el('p',{class:'pv-muted'},'После генерации проверьте и сохраните текст. Только затем исходные сообщения будут исключены из контекста.'));
    }
    archiveView(archive) {
        this.content.append(el('h3',{class:'pv-view-heading'},'Архив воспоминаний'));
        const segments=row(...Object.entries(LEVELS).map(([type,level])=>button(level.plural,()=>{this.archiveTab=type;this.render();},this.archiveTab===type)));segments.classList.add('pv-level-tabs');this.content.append(segments);
        const tools=el('div',{class:'pv-archive-tools'}),search=el('input',{type:'search',value:this.archiveSearch,'aria-label':'Поиск воспоминаний',placeholder:'Название или текст…'});
        const filter=el('select',{'aria-label':'Фильтр архива'});for(const [value,title]of [['all','Все'],['active','Активные'],['inactive','Неактивные']])filter.append(el('option',{value},title));filter.value=this.archiveFilter;
        const results=el('div',{class:'pv-archive-results','aria-live':'polite'});
        const update=()=>{if(results.isConnected)this.archiveResults(archive,results);};
        search.oninput=()=>{this.archiveSearch=search.value;clearTimeout(this.searchTimer);this.searchTimer=setTimeout(update,150);};
        filter.onchange=()=>{this.archiveFilter=filter.value;update();};
        tools.append(field('Поиск',search),field('Показывать записи',filter));
        const help=el('details',{class:'pv-archive-help'});help.append(el('summary',{},'Об активности записей'),el('p',{class:'pv-muted'},'Активные — записи в фактически сформированном блоке памяти. Сохранение в архиве само по себе не включает внедрение.'));
        this.content.append(tools,help);
        if(this.archiveTab!=='volume') {
            const type=this.archiveTab,target=type==='summary'?'arc':'volume',key=type==='summary'?'chosen':'chaptersChosen',manual=type==='summary'?'arcOrderManual':'volumeOrderManual';
            this[key]=this[key].filter(id=>archive.entries.some(e=>e.id===id&&e.type===type));
            if(!this[key].length){this[manual]=false;this.content.append(el('p',{class:'pv-muted pv-archive-hint'},type==='summary'?'Отметьте главы флажками, чтобы создать часть.':'Отметьте части флажками, чтобы создать том.'));}
            else {
                const selected=this[key].map(id=>archive.entries.find(e=>e.id===id)),ordered=this.e.orderEntries(selected);
                if(!this[manual])this[key]=ordered.entries.map(e=>e.id);
                const chosen=el('div',{class:'pv-arc-selection','data-target-level':target});chosen.append(el('strong',{},`Выбрано: ${this[key].length} ${type==='summary'?'глав':'частей'}`),el('small',{},this[manual]?'Ручной порядок. Модель получит записи в показанной последовательности.':'Порядок по исходным сообщениям. Стрелками можно изменить его вручную.'));
                this[key].forEach((id,i)=>{
                    const e=archive.entries.find(x=>x.id===id);
                    const up=button('↑',()=>{this[manual]=true;[this[key][i-1],this[key][i]]=[id,this[key][i-1]];this.render();});up.setAttribute('aria-label','Поднять');up.disabled=i===0;
                    const down=button('↓',()=>{this[manual]=true;[this[key][i+1],this[key][i]]=[id,this[key][i+1]];this.render();});down.setAttribute('aria-label','Опустить');down.disabled=i===this[key].length-1;
                    const range=this.sourceRanges.get(id),location=range?` · Сообщения ${range.start+1}–${range.end+1}`:'';
                    const line=row(el('span',{},`${i+1}. ${entryDisplayTitle(e,archive.entries)}${location}`),up,down);line.dataset.selectedId=id;chosen.append(line);
                });
                const total=el('small',{class:'pv-selection-tokens'},'Подсчёт токенов выбранных записей…');chosen.append(total);this.e.host.count(this[key].map(id=>archive.entries.find(e=>e.id===id).text).join('\n\n')).then(n=>total.textContent=`Выбрано ≈${n} токенов`).catch(()=>total.textContent='Не удалось посчитать токены');
                for(const warning of ordered.warnings)chosen.append(el('p',{class:'pv-warning'},warning));
                const linked=archive.entries.filter(e=>e.type===target&&childrenIds(e).some(id=>this[key].includes(id)));
                if(linked.length)chosen.append(el('p',{class:'pv-warning'},`Уже входят в ${target==='arc'?'части':'тома'}: ${linked.map(e=>entryDisplayTitle(e,archive.entries)).join('; ')}. Проверьте состав перед объединением.`));
                const generate=button(`Создать ${target==='arc'?'часть':'том'}`,()=>this.act(()=>{const session=this.e.session(),ids=[...this[key]];return this.generating(()=>{this.e.assert(session);return target==='arc'?this.e.generateArc(ids):this.e.generateVolume(ids);},{type:target});}),true);generate.disabled=this[key].length<2;
                chosen.append(row(generate,button('По исходным сообщениям',()=>{this[manual]=false;this.render();}),button('Снять выбор',()=>{this[key]=[];this[manual]=false;this.render();})));
                this.content.append(chosen);
            }
        }
        this.content.append(results);this.archiveResults(archive,results);
    }
    archiveResults(archive,results) {
        const ordered=this.e.orderEntries(chronological(archive.entries.filter(e=>e.type===this.archiveTab)));
        const entries=filterArchive(ordered.entries,this.viewState,this.archiveFilter,this.archiveSearch,archive.entries);
        results.replaceChildren(el('small',{},`Найдено: ${entries.length}`));
        for(const warning of ordered.warnings)results.append(el('p',{class:'pv-warning'},warning));
        if(!entries.length)results.append(el('p',{class:'pv-empty'},archive.entries.length?'Нет записей, подходящих под поиск и фильтр.':'Здесь появятся подтверждённые воспоминания.'));
        for(const e of entries)results.append(this.entryCard(e,archive));
    }
    entryCard(e,archive,activeView=false) {
        const session=this.e.session();
        const state=this.viewState.byId.get(e.id),card=el('article',{class:'pv-record pv-entry-card '+(activeView?'pv-memory-card':'pv-archive-row'),'data-entry-id':e.id,'data-memory-state':state.kind}),main=el('div',{class:'pv-entry-main'}),top=el('div',{class:'pv-record-top'});
        const heading=el('div',{class:'pv-entry-title'});
        if(!activeView&&e.type!=='volume') {
            const key=e.type==='summary'?'chosen':'chaptersChosen',target=e.type==='summary'?'части':'тома';
            const check=el('input',{type:'checkbox',checked:this[key].includes(e.id),'aria-label':`Выбрать для ${target}: ${entryDisplayTitle(e,archive.entries)}`});
            check.onchange=()=>{if(check.checked&&!this[key].includes(e.id))this[key].push(e.id);else if(!check.checked)this[key]=this[key].filter(id=>id!==e.id);this.render();};const hit=el('label',{class:'pv-record-select'});hit.append(check);top.append(hit);
        }
        const display=entryDisplayTitle(e,archive.entries),number=display.match(/^(?:Глава|Часть|Том)\s*№\s*\d+/i)?.[0]??display,subtitle=display.slice(number.length).replace(/^\s*[—–\-:·]?\s*/,'');
        const mark=el('div',{class:'pv-record-mark','aria-hidden':'true'});mark.append(el('i',{class:'fa-solid '+LEVELS[e.type].icon}));
        // Membership is independent of activation; the engine's covering list
        // still exclusively controls suppression and activation availability.
        const parents=state.parents;
        const badge=el('span',{},state.label);badge.className=`pv-memory-status pv-memory-${state.kind}`;
        const glyph=el('i',{class:'fa-solid '+(state.kind==='active'?'fa-circle':'fa-circle-dot'),'aria-hidden':'true'});badge.prepend(glyph);
        heading.append(el('h4',{},number),badge);main.append(heading);if(subtitle)main.append(el('p',{class:'pv-record-subtitle'},subtitle));top.append(mark,main);card.append(top);
        if(parents.length){const links=el('div',{class:'pv-entry-links'});for(const parent of parents){const link=iconButton(relationLabel(parent,archive.entries),()=>this.editEntry(parent,false),'fa-link');link.className='pv-memory-status pv-memory-arc';links.append(link);}main.append(links);}
        if(state.selectedForArc||state.selectedForVolume)heading.append(el('span',{class:'pv-selection-status'},state.selectedForArc?'Выбрана для части':'Выбрана для тома'));
        const range=this.sourceRanges?.get(e.id),location=range?`${range.historical?'Исторические сообщения':'Сообщения'} ${range.start+1}–${range.end+1}`:'Порядок источников требует проверки';
        const status=e.type==='summary'?`${location} · ${e.sources.length} шт.`:`${location} · ${e.type==='arc'?'Глав':'Частей'}: ${childrenIds(e).length}`;
        const metadata=el('small',{class:'pv-entry-meta'},`${status} · Версия ${e.version} · Подсчёт токенов…`);main.append(metadata);
        this.e.host.count(e.text).then(n=>metadata.textContent=`${status} · Версия ${e.version} · ≈${n} токенов`).catch(()=>metadata.textContent=`${status} · Версия ${e.version} · Не удалось посчитать токены`);
        if(state.gate==='blocked')heading.append(el('span',{class:'pv-gate-status'},this.lastMemory.limitExceeded?'Не помещается в лимит':'Не внедряется: блокировка'));
        const details=el('details',{class:'pv-entry-more'}),more=el('summary',{'aria-label':`Дополнительные действия: ${display}`},activeView?'Дополнительно':'···');details.append(more);
        if(state.note)details.append(el('p',{class:'pv-status-note'},state.note));
        if(hasDetachedSources(e))details.append(el('p',{class:'pv-muted'},e.type==='summary'?'Источники относятся к сохранённой копии: они не привязаны к сообщениям этого чата. Доступны текст и редактирование; восстановление или перегенерация по чужим исходникам невозможны.':'Диапазон относится к сохранённой копии. Перегенерация использует тексты дочерних записей из архива.'));
        if(e.type==='summary'&&!hasDetachedSources(e)) {
            const inspected=inspectSources(this.e.host.context().chat,e.sources);
            if(inspected.issues.length){heading.append(el('small',{class:'pv-gate-status'},`Требуют проверки источники: ${inspected.issues.length}`));details.append(el('p',{class:'pv-warning'},`Источники изменены, удалены или недоступны: ${inspected.issues.length}. Память требует проверки.`));}
            else if(inspected.matches.some(x=>x.moved))details.append(el('p',{class:'pv-muted'},'Номера сообщений изменились; источники найдены по постоянным ID.'));
        }
        if(e.needsReview){heading.append(el('span',{class:'pv-gate-status'},'Требует проверки'));details.append(el('p',{class:'pv-status-note'},'Требует проверки: исходная запись или сообщение изменились.'));}
        for(const ancestor of state.ancestors.filter(a=>!parents.includes(a)))details.append(button(relationLabel(ancestor,archive.entries),()=>this.editEntry(ancestor,false)));
        if(e.type!=='summary')details.append(button('Показать содержимое',()=>this.showContents(e)));
        const toggle=iconButton(e.active?'Убрать из памяти':'Добавить в память',()=>this.act(()=>{this.e.assert(session);return this.e.toggle(e.id,!e.active);}),e.active?'fa-trash-can':'fa-plus');toggle.disabled=!e.active&&state.covering.length>0;
        const actions=row(iconButton('Открыть',()=>this.editEntry(e,false),'fa-book-open'),iconButton('Изменить',()=>this.editEntry(e,true),'fa-pen'),toggle);actions.classList.add('pv-entry-actions');if(activeView)card.append(actions);else details.append(actions);
        details.append(row(button('Скопировать',()=>this.act(()=>copy(e.text))),button('Экспорт .txt',()=>download(`${e.type}-${e.id}.txt`,`${e.title}\n\n${e.text}`,'text/plain')),button('Перегенерировать',()=>this.act(()=>this.regenerateEntry(e))),button('Удалить',()=>this.act(async()=>{
            if(parents.some(p=>childrenIds(p).length<3)){this.textDialog('Связанные записи',`Эта запись входит в: ${parents.map(p=>entryDisplayTitle(p,archive.entries)).join('; ')}. После удаления у каждого родителя должны оставаться минимум две исходные записи. Сохранённые родительские тексты не изменены; сначала пересоберите или удалите родителя.`);return;}
            const warning=parents.length?` Связи с ${parents.map(p=>entryDisplayTitle(p,archive.entries)).join('; ')} будут убраны. Их тексты сохранятся и получат отметку «Требует проверки».`:'';
            if(!await this.confirm('Удаление записи',`Удалить «${entryDisplayTitle(e,archive.entries)}»? Дочерние записи и история чата останутся. Для исходников главы сначала используйте восстановление.${warning}`,session))return;
            const restore=e.type==='arc'?await this.confirm('Связанные главы','Вернуть исходные главы части в активную память?',session):false;
            this.e.assert(session);
            await this.e.deleteEntry(e.id,restore,{unlink:parents.length>0});
        }))));
        if(e.type==='summary')details.append(button('Восстановить исходные сообщения',()=>this.act(async()=>{
            if(!await this.confirm('Восстановление','Вернуть в контекст исходники, исключённые этой главой, и деактивировать главу? Ранее скрытые сообщения останутся скрытыми.'))return;
            this.e.assert(session);
            const r=await this.e.restore(e.id);if(r.issues.length)this.showNotice(`Восстановление выполнено частично: ${r.issues.length} источников изменены или недоступны. Их состояние сохранено.`);
        })));
        card.append(details);return card;
    }
    async regenerateEntry(e) {
        const session=this.e.session();
        if(e.type==='volume'){const ids=[...e.chapterIds];return this.generating(()=>{this.e.assert(session);return this.e.generateVolume(ids,{replaceId:e.id});},{type:'volume'});}
        if(e.type==='arc'){const ids=[...e.summaryIds];return this.generating(()=>{this.e.assert(session);return this.e.generateArc(ids,{replaceId:e.id});},{type:'arc'});}
        if(hasDetachedSources(e))throw Error('Исходники этой копии относятся к другому чату или отсутствуют. Откройте сохранённый текст; для новых сообщений создайте новую главу.');
        const inspected=inspectSources(this.e.host.context().chat,e.sources);
        if(inspected.issues.length)throw Error('Исходные сообщения изменены или удалены. Выберите новый диапазон вручную.');
        const indices=inspected.matches.map(x=>x.index).sort((a,b)=>a-b);
        if(indices.at(-1)-indices[0]+1!==indices.length)throw Error('Исходники больше не образуют непрерывный диапазон. Выберите новый диапазон вручную.');
        const range=captureRange(this.e.host.context().chat,indices[0],indices.at(-1));
        return this.generating(()=>this.generateCapturedRange(session,range,{allowOverlap:true,replaceId:e.id}),{episode:true,type:'summary'});
    }
    setMemoryEnabled(enabled) {
        return this.act(()=>{const settings=this.e.settings();settings.inject=enabled;if(enabled)settings.enabled=true;this.e.host.context().saveSettingsDebounced();});
    }
    async memoryView(archive,stamp) {
        const memory=this.lastMemory,state=this.viewState;if(stamp!==this.renderId)return;
        const connected=memory.enabled&&!memory.blocked,actualTokens=connected&&state.actualText&&Number.isFinite(memory.tokens)?memory.tokens:0,limitValue=this.e.settings().tokenLimit;
        const overview=el('section',{class:'pv-memory-overview','aria-label':'Состояние памяти'}),head=el('div',{class:'pv-memory-overview-head'}),amount=el('div');
        amount.append(el('p',{class:'pv-memory-caption'},'Память для следующего ответа'),el('p',{class:'pv-memory-amount'},`≈${actualTokens.toLocaleString('ru-RU')} / ${limitValue.toLocaleString('ru-RU')} токенов`));
        head.append(amount,el('span',{class:'pv-connection '+(connected?'pv-connected':'')},!memory.enabled?'Отключена':memory.blocked?'Требует внимания':'Подключена'));
        const meter=el('div',{class:'pv-memory-meter','aria-hidden':'true'}),fill=el('span');fill.style.width=`${Math.min(100,Math.max(0,actualTokens/limitValue*100))}%`;meter.append(fill);
        overview.append(head,meter,el('p',{class:'pv-memory-caption'},connected?(state.actualText?'Подготовлена к отправке при следующем запросе персонажу.':'Память включена. Активных записей для отправки пока нет.'):`Выбрано ≈${Number.isFinite(memory.tokens)?memory.tokens.toLocaleString('ru-RU'):'—'} токенов. Сейчас блок не отправляется.`));this.content.append(overview);
        if(!memory.enabled)this.content.append(el('p',{class:'pv-warning'},'Внедрение памяти глобально отключено. Сохранённые записи сейчас не передаются модели.'));
        if(memory.blocked)this.content.append(el('p',{class:'pv-warning'},memory.reason));
        for(const warning of memory.orderWarnings??[])this.content.append(el('p',{class:'pv-warning'},warning));
        const quick=row(iconButton('Посмотреть память',()=>this.textDialog('Итоговый блок памяти',state.actualText||'Память сейчас не внедряется.'),'fa-book-open'),iconButton('Скопировать память',()=>this.act(()=>copy(state.actualText)),'fa-copy'),iconButton('Обновить',()=>this.act(()=>this.e.refreshMemory()),'fa-rotate'),iconButton(memory.enabled?'Отключить всю память':'Включить память',()=>this.setMemoryEnabled(!memory.enabled),'fa-power-off',!memory.enabled));quick.classList.add('pv-memory-quick');this.content.append(quick);
        const limit=el('input',{type:'number',min:1,step:100,value:this.e.settings().tokenLimit,'aria-label':'Лимит памяти, токенов'});limit.onchange=()=>{const value=Number(limit.value);if(!Number.isFinite(value)||value<1){limit.value=this.e.settings().tokenLimit;return;}this.e.settings().tokenLimit=Math.floor(value);this.saveSettings();this.act(()=>this.e.refreshMemory());};const limitField=field('Лимит памяти, токенов',limit);limitField.classList.add('pv-memory-limit');
        const previews=el('div',{class:'pv-memory-previews'}),details=el('details'),summary=el('summary',{},'Итоговый блок памяти целиком');details.append(summary,el('pre',{},state.actualText||'Память сейчас не внедряется.'));previews.append(details);
        if(state.candidateText&&state.candidateText!==state.actualText){const draft=el('details');draft.append(el('summary',{},'Выбранные записи — предварительный просмотр'),el('p',{class:'pv-muted'},'Этот текст сохранён и выбран, но сейчас не внедряется в запрос.'),el('pre',{},state.candidateText),button('Скопировать выбранные записи',()=>this.act(()=>copy(state.candidateText))));previews.append(draft);}
        if(!archive.entries.length)this.content.append(el('p',{class:'pv-empty'},'Сначала создайте главу.'));
        for(const [name,title,entries]of [['current','Сейчас в памяти модели',state.current],['archive','Только в архиве',this.e.orderEntries(chronological(state.archived)).entries]]){
            const section=el('section',{'data-memory-section':name,class:'pv-memory-section'}),titleRow=el('div',{class:'pv-memory-section-heading'});titleRow.append(el('i',{class:'fa-solid '+(name==='current'?'fa-star':'fa-box-archive'),'aria-hidden':'true'}),el('h3',{},title),el('span',{class:'pv-record-count','aria-label':'Записей: '+entries.length},String(entries.length)));
            section.append(titleRow,el('p',{class:'pv-memory-description'},name==='current'?'Эти записи подключены к памяти и подготовлены для следующего запроса персонажу.':'Эти записи не отправляются в модель, но доступны для просмотра и добавления в память.'));
            if(!entries.length)section.append(el('p',{class:'pv-muted'},name==='current'?'В сформированном блоке нет записей.':'Все записи включены в память.'));
            for(const e of entries)section.append(this.entryCard(e,archive,true));this.content.append(section);
        }
        this.content.append(limitField,previews);
    }
    promptsView() {
        const segments=row(...Object.entries(LEVELS).map(([type,level])=>button(`Промпт ${level.genitive}`,()=>{this.promptTab=type;this.render();},this.promptTab===type)));segments.classList.add('pv-level-tabs');this.content.append(segments);
        const type=this.promptTab,group=this.e.settings().prompts[type],preset=group.presets.find(p=>p.id===group.selected)??group.presets[0];
        const select=el('select',{'aria-label':'Пресет промпта'});group.presets.forEach(p=>select.append(el('option',{value:p.id},p.name)));select.value=preset.id;
        const key=JSON.stringify([type,preset.id]),draft=this.promptDrafts?.get(key);
        if(draft&&draft.base!==preset.text)this.promptDrafts.delete(key);
        const text=el('textarea',{'aria-label':`Промпт ${LEVELS[type].genitive}`,spellcheck:'false'},draft?.base===preset.text?draft.text:preset.text);
        const editor=this.promptEditor={node:text,key,base:preset.text};
        select.onchange=async()=>{if(text.value!==preset.text&&!await this.confirm('Несохранённый промпт','Отбросить изменения и открыть другой пресет?')){select.value=preset.id;return;}text.value=preset.text;this.promptDrafts?.delete(key);group.selected=select.value;this.saveSettings();this.render();};
        text.classList.add('pv-prompt-text');
        const editorHead=el('div',{class:'pv-prompt-heading'});editorHead.append(el('span',{},'Ваш промпт'),iconButton('Развернуть редактор',()=>this.expandPrompt(text),'fa-expand'));
        this.content.append(field('Пресет',select),editorHead,field(`Ваш промпт ${LEVELS[type].genitive}`,text),el('p',{class:'pv-muted'},'Текст используется буквально, включая Markdown и {{макросы}}. Расширение не навязывает структуру воспоминания. Сохраните изменения перед генерацией.'));
        this.content.append(row(button('Сохранить промпт',()=>{preset.history.push(preset.text);preset.text=text.value;editor.base=preset.text;this.promptDrafts?.delete(key);this.saveSettings();this.showNotice('Промпт сохранён.');},true),button('Новый пресет',()=>this.act(async()=>{const name=await this.askText('Название нового пресета','');if(!name)return;const p={id:this.e.host.uuid(),name,text:text.value,history:[]};group.presets.push(p);group.selected=p.id;this.saveSettings();})),button('Переименовать',()=>this.act(async()=>{const name=await this.askText('Название пресета',preset.name);if(name){preset.name=name;this.saveSettings();}})),button('Предыдущая версия',()=>this.act(async()=>{if(!preset.history.length)throw Error('Предыдущих версий пока нет.');if(await this.confirm('Восстановление промпта','Восстановить предыдущую сохранённую версию?')){const previous=preset.history.pop();preset.history.push(preset.text);preset.text=previous;text.value=previous;editor.base=previous;this.promptDrafts?.delete(key);this.saveSettings();}}))));
        this.content.append(row(button('Импорт из .txt',async()=>{try{const f=await readFile('.txt,.md,text/plain');if(f){text.value=f.text;this.showNotice('Текст загружен в редактор. Нажмите «Сохранить промпт».');}}catch(error){this.showNotice(error.message);}}),button('Экспорт .txt',()=>download(`pensieve-prompt-${type}.txt`,text.value,'text/plain')),button('Удалить пресет',()=>this.act(async()=>{if(group.presets.length<2)throw Error('Последний пресет удалить нельзя.');if(await this.confirm('Удаление пресета','Удалить выбранный пресет?')){group.presets=group.presets.filter(p=>p.id!==preset.id);group.selected=group.presets[0].id;this.saveSettings();}}))));
    }
    expandPrompt(text) {
        const {dialog,body}=this.makeDialog('Редактор промпта');dialog.classList.add('pv-prompt-expanded');
        const area=el('textarea',{'aria-label':'Полный редактор промпта',spellcheck:'false'},text.value);
        body.append(area,button('Вернуться к промпту',()=>dialog.close(),true));
        dialog.onclose=()=>{text.value=area.value;dialog.remove();};dialog.showModal();area.focus();
    }
    saveSettings() {this.e.host.context().saveSettingsDebounced();this.schedule();}
    settingsView(archive) {
        const settings=this.e.settings();this.content.append(el('h3',{class:'pv-view-heading'},'Настройки'));
        const group=title=>{const section=el('fieldset',{class:'pv-setting-group'});section.append(el('legend',{},title));this.content.append(section);return section;};
        const memory=group('Память'),messages=group('Создание глав'),archiveGroup=group('Архив'),appearance=group('Интерфейс');
        const preview=el('input',{type:'checkbox',checked:settings.previewEpisodes,'aria-label':'Предпросмотр глав'});preview.onchange=()=>{settings.previewEpisodes=preview.checked;this.saveSettings();};const previewLabel=el('label');previewLabel.append(preview,document.createTextNode('Предпросмотр глав'));messages.append(previewLabel,el('p',{class:'pv-muted'},'Показывать готовую главу перед сохранением. Если выключено, успешный результат ручной генерации сохраняется сразу.'));
        for(const [key,title]of [['enabled','Включить расширение'],['inject','Внедрять активную память'],['exclude','Исключать обработанные сообщения после сохранения'],['collapse','Визуально сворачивать обработанные сообщения'],['pastNoteEnabled','Не акцентировать прошлые события без необходимости']]){
            const check=el('input',{type:'checkbox',checked:settings[key]});check.onchange=()=>{settings[key]=check.checked;this.saveSettings();this.refresh();};const l=el('label');l.append(check,document.createTextNode(title));(['enabled','inject'].includes(key)?memory:['exclude','collapse'].includes(key)?messages:appearance).append(l);
        }
        const limit=el('input',{type:'number',min:1,step:100,value:settings.tokenLimit});limit.onchange=()=>{if(Number.isFinite(Number(limit.value))&&Number(limit.value)>0){settings.tokenLimit=Math.floor(Number(limit.value));this.saveSettings();}else limit.value=settings.tokenLimit;};memory.append(field('Максимальный объём памяти, токенов',limit));
        const position=el('select');for(const [v,t]of [[1,'В истории чата'],[0,'После основного промпта'],[2,'Перед основным промптом']])position.append(el('option',{value:v},t));position.value=settings.position;position.onchange=()=>{settings.position=Number(position.value);this.saveSettings();};
        const depth=el('input',{type:'number',min:0,max:10000,value:settings.depth});depth.onchange=()=>{settings.depth=Math.max(0,Math.min(10000,Number(depth.value)||0));this.saveSettings();};
        memory.append(field('Позиция внедрения',position),field('Глубина в истории чата',depth));
        const note=el('textarea',{class:'pv-short'},settings.pastNote);note.onchange=()=>{settings.pastNote=note.value;this.saveSettings();};appearance.append(field('Редактируемая пометка о прошлых событиях',note));
        const theme=el('select');theme.append(el('option',{value:'dark'},'Полуночный синий'),el('option',{value:'light'},'Светлый пергамент'));theme.value=settings.theme;theme.onchange=()=>{settings.theme=theme.value;this.panel.dataset.theme=theme.value;this.saveSettings();};appearance.append(field('Тема панели',theme));
        archiveGroup.append(el('p',{class:'pv-muted'},'Резервное копирование'));
        if(archive){const complete=el('section',{class:'pv-complete-backup'});complete.append(el('h4',{},'Резервная копия памяти'),el('p',{class:'pv-muted'},'Один JSON: все главы, части, тома, их связи, промпты и настройки. Копия восстанавливает память, а не удалённую переписку.'),row(iconButton('Экспортировать всё',()=>this.act(()=>this.exportFullBackup()),'fa-download',true),iconButton('Восстановить из копии',()=>this.readFullBackup(),'fa-upload')));archiveGroup.append(complete,el('p',{class:'pv-muted'},`Архив текущего чата: ${(bytes(archive)/1024).toFixed(1)} KiB. Резервная копия содержит личные тексты — храните её у себя.`));
        archiveGroup.append(row(button('Экспорт архива JSON',()=>download('pensieve-archive.json',JSON.stringify(exportArchive(this.e.archive()),null,2))),button('Импорт архива JSON',()=>this.readFullBackup())));
        }else archiveGroup.append(el('p',{class:'pv-muted'},'Откройте сохранённый чат для экспорта, импорта и восстановления его архива. Общие настройки и промпты доступны без чата.'));
        archiveGroup.append(row(button('Экспорт промптов JSON',()=>download('pensieve-prompts.json',JSON.stringify({format:'pensieve-prompts',version:1,prompts:settings.prompts},null,2))),button('Импорт промптов JSON',()=>this.act(async()=>{
            const f=await readFile('.json');if(!f)return;const data=JSON.parse(f.text);if(data.format!=='pensieve-prompts'||data.version!==1)throw Error('Неверный формат файла промптов.');
            const result=clone(settings.prompts);
            for(const type of ['summary','arc','volume']){const g=data.prompts?.[type];if(type==='volume'&&!g)continue;if(!g||!Array.isArray(g.presets)||!g.presets.length||g.presets.length>100)throw Error('Неверный список пресетов.');const ids=new Set();result[type].presets=g.presets.map(p=>{if(typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||typeof p.text!=='string')throw Error('Неверные поля пресета.');ids.add(p.id);return{id:p.id,name:p.name,text:p.text,history:Array.isArray(p.history)?p.history.filter(h=>typeof h==='string'):[]};});result[type].selected=ids.has(g.selected)?g.selected:result[type].presets[0].id;}
            if(await this.confirm('Импорт промптов','Заменить наборы пресетов из файла? Если промпта тома в старой копии нет, текущий промпт тома сохранится.')){settings.prompts=result;this.saveSettings();}
        }))));
        if(!archive)return;
        const recovery=el('details',{class:'pv-recovery'});recovery.append(el('summary',{},'Восстановление'));archiveGroup.append(recovery);
        if(archive.pending?.type==='backup')recovery.append(el('p',{class:'pv-muted'},'Завершение повторно проверит целую копию и выбранные промпты/настройки. «Оставить копию в архиве без активности» сохранит её тексты, отключит все записи и вернёт выбранные общие разделы в состояние до восстановления. Прежний архив после подтверждённой замены это действие не возвращает.'));
        recovery.append(row(button('Повторить сохранение / завершить',()=>this.act(()=>this.e.recover('complete'))),button(archive.pending?.type==='backup'?'Оставить копию в архиве без активности':'Вернуть исходники незавершённой операции',()=>this.act(()=>this.e.recover('restore')))));
        recovery.append(button('Восстановить все исходники',()=>this.act(async()=>{
            const session=this.e.session();
            if(!await this.confirm('Восстановление всех исходников','Вернуть исключённые этим расширением сообщения и отключить всю память текущего чата?',session))return;
            this.e.assert(session);
            let issues=0;for(const e of [...this.e.archive(session).entries])if(e.type==='summary'&&!hasDetachedSources(e)){this.e.assert(session);const r=await this.e.restore(e.id);issues+=r.issues.length;}
            this.e.assert(session);
            await this.e.disableAll();this.showNotice(issues?`Не удалось надёжно восстановить источники: ${issues}. Их состояние сохранено.`:'Исходники восстановлены. Архив сохранён.');
        })));
    }
    exportFullBackup() {
        const session=this.e.session(),file=createBackup(this.e.archive(session),this.e.settings(),{key:session.key,name:String(this.e.host.context().chatId)}),date=new Date(),stamp=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
        download(`Omut_Pamyati_${stamp}.json`,JSON.stringify(file,null,2));
    }
    async readFullBackup() {
        return this.act(async()=>{const session=this.e.session(),file=await readFile('.json,application/json');if(!file)return;this.e.assert(session);this.restoreBackupDialog(parseBackup(file.text),session);});
    }
    restoreBackupDialog(file,session) {
        this.e.assert(session);const {dialog,body}=this.makeDialog('Восстановление памяти',true);dialog.classList.add('pv-backup-dialog');
        const counts=Object.entries(LEVELS).map(([type,level])=>`${level.plural}: ${file.archive.entries.filter(e=>e.type===type).length}`).join(' · '),current=this.e.archive(session),preview=el('p',{class:'pv-muted'});
        body.append(el('h3',{},'Найдено: '+counts),preview,el('p',{class:'pv-muted'},'Копия не восстанавливает исходную переписку. Чужие диапазоны останутся историческими сведениями и не будут управлять сообщениями этого чата.'));
        const mode=el('select',{'aria-label':'Способ восстановления'});mode.append(el('option',{value:'merge'},'Объединить с существующими'),el('option',{value:'replace'},'Заменить архив из резервной копии'));body.append(field('Способ восстановления',mode));
        const check=(name,disabled=false)=>{const input=el('input',{type:'checkbox','aria-label':name});input.dataset.unavailable=String(disabled);input.disabled=disabled;const label=el('label');label.append(input,document.createTextNode(name));body.append(label);return input;};
        const active=check('Восстановить активные записи',!!file.source.hadPendingOperation),prompts=check('Восстановить промпты из копии',!file.prompts),settings=check('Восстановить общие настройки из копии',!file.settings);
        body.append(el('p',{class:'pv-muted'},'По умолчанию новые записи останутся в архиве. Активность проверяется по пересечениям и лимиту. Промпты и общие настройки используются и другими чатами — они изменятся только при выбранных флажках.'));
        if(file.source.hadPendingOperation)body.append(el('p',{class:'pv-warning'},'Копия сделана при незавершённой операции. Сначала восстановите её без активности.'));
        const replacement=el('div',{class:'pv-warning',hidden:'true'}),ack=el('input',{type:'checkbox','aria-label':'Подтверждаю замену текущего архива'}),ackLabel=el('label'),exportCurrent=button('Сохранить текущую копию',()=>this.act(()=>{this.e.assert(session);this.exportFullBackup();}));ackLabel.append(ack,document.createTextNode('Подтверждаю замену текущего архива'));replacement.append(el('p',{},'Замена удалит текущие записи из архива этого чата. Сначала можно сохранить их отдельную копию.'),exportCurrent,ackLabel);body.append(replacement);
        const status=el('p',{role:'status'}),cancel=button('Отмена',()=>{if(!applying)dialog.close();}),close=dialog.querySelector('.pv-header button');body.append(status);let applying=false,planError=false;
        const save=button('Восстановить память',async()=>{
            if(applying||planError||mode.value==='replace'&&!ack.checked)return;
            const options={mode:mode.value,activate:active.checked,restorePrompts:prompts.checked,restoreSettings:settings.checked};
            applying=true;update();status.textContent='Проверка и восстановление… Дождитесь завершения; окно можно закрыть после результата.';
            try{this.e.assert(session);const result=await this.e.restoreBackup(file,options,session);dialog.close();this.e.host.notify('success',`Память восстановлена. Новых записей: ${result.added}; уже существовали: ${result.skipped}.`);await this.refresh(true);}
            catch(error){status.textContent='Не удалось подтвердить восстановление: '+error.message;this.e.host.notify('error',error.message);}
            finally{applying=false;update();}
        },true);
        const update=()=>{
            replacement.hidden=mode.value!=='replace';save.disabled=applying||planError||mode.value==='replace'&&!ack.checked;
            for(const control of [mode,ack,cancel,close,exportCurrent])control.disabled=applying;
            for(const control of [active,prompts,settings])control.disabled=applying||control.dataset.unavailable==='true';
        };
        const planMode=()=>{
            try{const plan=planRestore(current,file,{targetKey:session.key,mode:mode.value,uuid:()=>this.e.host.uuid(),chat:this.e.host.context().chat});preview.textContent=`Новых: ${plan.added} · Уже есть: ${plan.skipped} · Отличаются от текущих: ${plan.conflicts}. При объединении существующие тексты сохраняются.`;planError=false;}
            catch(error){preview.textContent=(mode.value==='merge'?'Объединение недоступно: ':'Замена недоступна: ')+error.message;planError=true;}
            update();
        };
        mode.onchange=planMode;ack.onchange=update;body.append(row(save,cancel));dialog.oncancel=event=>{if(applying)event.preventDefault();};dialog.onclose=()=>dialog.remove();planMode();dialog.showModal();
    }
    makeDialog(title,chatScoped=false) {
        const dialog=el('dialog',{class:'pensieve pv-editor','data-theme':this.e.settings().theme});
        if(chatScoped)dialog.dataset.chatScoped='true';
        const head=el('header',{class:'pv-header'}),close=button('×',()=>{if(dialog.dispatchEvent(new Event('cancel',{cancelable:true})))dialog.close();});close.classList.add('pv-icon');close.setAttribute('aria-label','Закрыть окно');head.append(el('h2',{},title),close);dialog.setAttribute('aria-label',title);const body=el('div',{class:'pv-content'});dialog.append(head,body);document.body.append(dialog);return {dialog,body};
    }
    confirm(title,message,session=null) {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog(title,!!session);body.append(el('p',{},message),row(button('Подтвердить',()=>{dialog.returnValue='yes';dialog.close();},true),button('Отмена',()=>dialog.close())));dialog.onclose=()=>{const yes=dialog.returnValue==='yes';dialog.remove();resolve(yes);};dialog.showModal();});
    }
    askText(title,value) {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog(title),input=el('input',{value,'aria-label':title});body.append(input,row(button('Сохранить',()=>{dialog.returnValue='yes';dialog.close();},true),button('Отмена',()=>dialog.close())));dialog.onclose=()=>{const result=dialog.returnValue==='yes'?input.value.trim():null;dialog.remove();resolve(result);};dialog.showModal();input.focus();});
    }
    importMode(session=null) {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog('Импорт архива',!!session);body.append(el('p',{},'Объединить с текущим архивом или заменить его? Импорт не исключает сообщения.'),row(button('Объединить',()=>{dialog.returnValue='merge';dialog.close();},true),button('Заменить',()=>{dialog.returnValue='replace';dialog.close();}),button('Отмена',()=>dialog.close())));dialog.onclose=()=>{const mode=['merge','replace'].includes(dialog.returnValue)?dialog.returnValue:null;dialog.remove();resolve(mode);};dialog.showModal();});
    }
    textDialog(title,text) {const {dialog,body}=this.makeDialog(title);const area=el('textarea',{readonly:'true','aria-label':title},text);body.append(area,row(button('Скопировать',()=>this.act(()=>copy(text))),button('Закрыть',()=>dialog.close())));dialog.onclose=()=>dialog.remove();dialog.showModal();}
    generateCapturedRange(session,range,options={}) {
        this.e.checkRange(session,range);
        return this.e.generateSummary(session.chat.indexOf(range[0].ref),session.chat.indexOf(range.at(-1).ref),options);
    }
    async generating(fn,options={}) {
        this.generationView??=new GenerationView(this.e,{
            makeDialog:(...args)=>this.makeDialog(...args),preview:draft=>{const done=this.preview(draft);return {done,dialog:this.editor};},
            onSaved:async draft=>{await this.episodeSaved(draft);await this.refresh(true);},
            onMinimize:(explicit=true)=>{if(explicit&&this.panel?.open)this.minimize();if(this.restoreDock&&this.windowState==='minimized')this.restoreDock.hidden=true;},
            onClear:()=>{if(this.restoreDock)this.restoreDock.hidden=this.windowState!=='minimized';},
        });
        return this.generationView.generate(fn,options);
    }
    preview(draft) {
        return new Promise(resolve=>{
        const {dialog,body}=this.makeDialog(`Предварительный просмотр ${LEVELS[draft.type].genitive}`,true);this.editor=dialog;
        const title=el('input',{value:draft.title,'aria-label':'Название воспоминания'}),text=el('textarea',{'aria-label':'Текст воспоминания'},draft.text);
        body.append(field('Название',title),field('Текст — можно отредактировать перед сохранением',text));
        const notice=el('p',{role:'status'});body.append(notice);
        const save=button('Сохранить',async()=>{
            save.disabled=true;regen.disabled=true;
            try{const saved=await this.e.saveDraft(draft,{title:title.value,text:text.value});await this.episodeSaved(draft);dialog.savedEntry=saved;dialog.close();await this.refresh(true);this.showNotice('Воспоминание сохранено.');}
            catch(error){notice.textContent=error.message;this.e.host.notify('error',error.message);}
            finally{save.disabled=false;regen.disabled=false;}
        },true);
        const regen=button('Повторить генерацию',async()=>{save.disabled=true;regen.disabled=true;try{await this.e.regenerate(draft);text.value=draft.text;}catch(error){notice.textContent=error.message;}finally{save.disabled=false;regen.disabled=false;}});
        body.append(row(save,regen,button('Скопировать',()=>this.act(()=>copy(text.value))),button('Отменить генерацию',()=>this.e.cancel()),button('Отмена',()=>{if(this.e.busy)this.e.cancel();dialog.close();})));
        dialog.oncancel=()=>{if(this.e.busy)this.e.cancel();};dialog.onclose=()=>{dialog.remove();if(this.editor===dialog)this.editor=null;resolve(dialog.savedEntry??null);};dialog.showModal();
        });
    }
    editEntry(entry,editable) {
        const session=this.e.session(),archive=this.e.archive(session);
        const {dialog,body}=this.makeDialog(editable?'Редактирование воспоминания':entryDisplayTitle(entry,archive.entries),true);this.editor=dialog;
        const title=el('input',{value:entry.title,'aria-label':'Название записи'}),text=el('textarea',{'aria-label':'Текст записи'},entry.text);title.readOnly=text.readOnly=!editable;
        body.append(field('Название',title),field('Текст',text));
        const range=this.sourceRanges?.get(entry.id),details=el('div',{class:'pv-record-info'}),state=this.viewState?.byId.get(entry.id);
        const info=el('p',{class:'pv-muted'},`${range?`${range.historical?'Исторические сообщения':'Сообщения'} ${range.start+1}–${range.end+1}`:'Порядок источников требует проверки'} · Версия ${entry.version}`);details.append(info);
        if(hasDetachedSources(entry))details.append(el('p',{class:'pv-muted'},'Исторический диапазон из резервной копии. Исходники не привязаны к текущему чату.'));
        this.e.host.count(entry.text).then(n=>info.append(document.createTextNode(` · ≈${n} токенов`))).catch(()=>{});
        if(state)details.append(el('p',{class:'pv-status-note'},[state.label,state.note].filter(Boolean).join(' · ')));body.prepend(details);
        if(entry.type!=='summary')body.append(button('Показать содержимое',()=>{this.e.assert(session);this.showContents(entry);}));
        for(const parent of state?.ancestors??[])body.append(button(relationLabel(parent,archive.entries),()=>{this.e.assert(session);this.editEntry(parent,false);}));
        const status=el('p',{role:'status'});body.append(status);
        if(editable)body.append(button('Сохранить изменения',async()=>{try{this.e.assert(session);await this.e.edit(entry.id,{title:title.value,text:text.value});dialog.close();await this.refresh(true);}catch(error){status.textContent=error.message;}},true));
        if(entry.history.length) {
            const versions=el('select',{'aria-label':'Предыдущая версия'});entry.history.forEach((h,i)=>versions.append(el('option',{value:i},`Версия ${h.version} — ${h.title}`)));
            const historyActions=row(button('Посмотреть версию',()=>{const h=entry.history[Number(versions.value)];this.textDialog(`Версия ${h.version}`,h.text);}));
            if(editable)historyActions.append(button('Восстановить версию',async()=>{if(!await this.confirm('Восстановление версии','Сохранить выбранную предыдущую версию как новую редакцию?',session))return;const h=entry.history[Number(versions.value)];try{this.e.assert(session);await this.e.edit(entry.id,{title:h.title,text:h.text});dialog.close();await this.refresh(true);}catch(error){status.textContent=error.message;}}));
            body.append(field('Предыдущие версии',versions),historyActions);
        }
        if(editable&&entry.needsReview)body.append(button('Проверено — снять отметку',()=>this.act(async()=>{this.e.assert(session);await this.e.change(a=>a.entries.find(e=>e.id===entry.id).needsReview=false);dialog.close();})));
        body.append(row(button('Скопировать',()=>this.act(()=>copy(text.value))),button('Закрыть',()=>dialog.close())));dialog.onclose=()=>{dialog.remove();if(this.editor===dialog)this.editor=null;};dialog.showModal();
    }
    showContents(entry) {
        const session=this.e.session(),archive=this.e.archive(session),index=hierarchyIndex(archive.entries),current=index.byId.get(entry.id);
        if(!current)return;
        const {dialog,body}=this.makeDialog(`Содержимое: ${entryDisplayTitle(current,archive.entries)}`,true);
        body.append(el('p',{class:'pv-muted'},'Исходные записи остаются в архиве. Открытие не меняет их активность или текст.'));
        for(const id of childrenIds(current)){
            const child=index.byId.get(id),line=el('article',{class:'pv-source-item','data-source-id':id});
            if(!child){line.append(el('p',{class:'pv-warning'},'Исходная запись недоступна. Сохранённый текст родительской записи не изменён.'));body.append(line);continue;}
            const range=this.sourceRanges?.get(id);line.append(el('strong',{},entryDisplayTitle(child,archive.entries)));
            if(range)line.append(el('small',{},`${range.historical?'Исторические сообщения':'Сообщения'} ${range.start+1}–${range.end+1}`));
            line.append(button('Открыть',()=>{this.e.assert(session);this.editEntry(child,false);}));body.append(line);
        }
        body.append(button('Закрыть',()=>dialog.close()));dialog.onclose=()=>dialog.remove();dialog.showModal();
    }
    decorateMessages() {
        let archive;try{archive=this.e.archive();}catch{return;}
        const c=this.e.host.context(),settings=this.e.settings(),processed=messageLabels(archive.entries,c.chat,this.e.key());
        if(this.rangeChatKey===this.e.key())this.resolveRange();
        const valid=this.rangeChatKey===this.e.key()&&Number.isInteger(this.start)&&Number.isInteger(this.end)&&this.start>=0&&this.end>=this.start&&this.end<c.chat.length;
        for(const node of document.querySelectorAll('#chat .mes[mesid]')) {
            const index=Number(node.getAttribute('mesid')),m=c.chat[index];if(!m)continue;
            const menu=node.querySelector('.extraMesButtons');
            if(menu&&!menu.querySelector('[data-pensieve-edge]')){
                const pair=el('span',{class:'pv-range-actions'});
                for(const [edge,title]of [['start','Начало главы'],['end','Конец главы']]){
                    const b=el('button',{type:'button',class:'mes_button pv-message-action','data-pensieve-edge':edge,title,'aria-label':title});
                    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 28');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
                    const outline=document.createElementNS(svg.namespaceURI,'path');outline.setAttribute('d','M6 3h12a1 1 0 0 1 1 1v21l-7-5-7 5V4a1 1 0 0 1 1-1Z');svg.append(outline);
                    const symbol=document.createElementNS(svg.namespaceURI,'path');symbol.setAttribute('d',edge==='start'?'M12 7 12.9 10.5 15.5 8.5 13.8 11.1 17 12 13.8 12.9 15.5 15.5 12.9 13.8 12 17 11.1 13.8 8.5 15.5 10.2 12.9 7 12 10.2 11.1 8.5 8.5 11.1 10.5Z':'M8.5 12l2.5 2.5 4.5-5');if(edge==='start')symbol.setAttribute('class','pv-bookmark-star');svg.append(symbol);b.append(svg);pair.append(b);
                }
                menu.append(pair);
            }
            const pair=menu?.querySelector('.pv-range-actions');let create=pair?.querySelector('[data-pensieve-create]');
            if(pair&&valid&&settings.enabled&&index===this.end){
                if(!create){create=button('',event=>{event.preventDefault();event.stopPropagation();this.createEpisodeFromChat();});create.className='mes_button pv-message-action';create.dataset.pensieveCreate='true';create.title='Создать главу';create.setAttribute('aria-label','Создать главу');
                    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M12 5C8 2 4 2 2 4v15c3-2 7-2 10 1 3-3 7-3 10-1V4c-4-2-7-2-10 1ZM12 5v15M17 7v7M13.5 10.5h7');svg.append(path);create.append(svg);pair.append(create);}
                create.disabled=!!(this.episodeTask||this.e.busy);create.setAttribute('aria-busy',String(!!this.episodeTask));
            }else create?.remove();
            menu?.querySelectorAll('[data-pensieve-edge]').forEach(b=>b.setAttribute('aria-pressed',String(index===this[b.dataset.pensieveEdge])));
            node.classList.toggle('pensieve-start',settings.enabled&&index===this.start);node.classList.toggle('pensieve-end',settings.enabled&&index===this.end);
            const id=m.extra?.[KEY]?.id,label=id?processed.get(id):null;let badge=node.querySelector('.pv-message-status');
            if(label&&settings.enabled){if(!badge){badge=el('div',{class:'pv-message-status'});(node.querySelector('.mes_block')??node).append(badge);}
                if(badge.dataset.label!==label){badge.dataset.label=label;badge.replaceChildren(el('span',{class:'pv-source-mark','aria-hidden':'true'},'◈'),el('span',{class:'pv-source-label'},label));}
            }else badge?.remove();
            node.classList.toggle('pensieve-collapsed',!!(label&&settings.enabled&&settings.collapse&&m.is_system));
        }
    }
}
