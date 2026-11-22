import {guardAction,setErrorSink} from './diagnostics-view.js';
import {describeError,tagError,trace,errorMeta} from './diagnostics.js';
import {VERSION as UI_VERSION} from './version.js';
import {presetList,selectPreset,createPreset,renamePreset,deletePreset,restoreBuiltin,exportPreset,importPreset,mergePromptGroups} from './prompt-presets.js';
import {KEY,defaults,clone,bytes,WARN_ARCHIVE_BYTES,exportArchive,chronological,captureRange,findOverlaps,inspectSources,fingerprint,hasDetachedSources} from './core.js';
import {memoryViewState,filterArchive,entryDisplayTitle} from './view-state.js';
import {LEVELS,childrenIds,hierarchyIndex,entryNumber,relationLabel} from './hierarchy.js';
import {createBackup,parseBackup,planRestore} from './backup.js';
import {bounded} from './save-recovery.js';
import {GenerationView,operationLabel} from './generation-view.js';
import {validateCompression,compressionValues} from './compression.js';
import {messageLabels} from './source-links.js';

export {UI_VERSION};

const editorDisplay=text=>text.replace(/\r\n?/g,'\n');
const el=(tag,attrs={},text='')=>{const node=document.createElement(tag);for(const [k,v]of Object.entries(attrs))if(k==='class')node.className=v;else if(k==='checked')node.checked=v;else node.setAttribute(k,String(v));if(text)node.textContent=text;return node;};
const button=(text,fn,primary=false)=>{const b=el('button',{type:'button',class:primary?'pv-primary':''},text);b.addEventListener('click',guardAction(fn,{stage:'handler',operation:'ui',severity:'warning'}));return b;};
const iconButton=(text,fn,glyph,primary=false)=>{const b=button('',fn,primary);b.append(el('i',{class:'fa-solid '+glyph,'aria-hidden':'true'}),el('span',{},text));return b;};
const row=(...nodes)=>{const r=el('div',{class:'pv-row'});r.append(...nodes);return r;};
const field=(title,node)=>{const l=el('label',{},title);l.append(node);return l;};
const download=(name,text,type='application/json')=>{const url=URL.createObjectURL(new Blob([text],{type}));const a=el('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const readFile=accept=>new Promise((resolve,reject)=>{const input=el('input',{type:'file',accept});input.onchange=async()=>{try{resolve(input.files?.[0]?{name:input.files[0].name,text:await input.files[0].text()}:null);}catch(error){reject(error);}};input.oncancel=()=>resolve(null);input.click();});
const fileTrace=(operation,fn)=>trace({code:operation.endsWith('export')?'DATA-008':'DATA-007',stage:operation.endsWith('export')?'export':'import',operation},fn);
async function copy(text){try{await navigator.clipboard.writeText(text);}catch{const t=el('textarea',{},text);document.body.append(t);t.select();const success=document.execCommand('copy');t.remove();if(!success)throw Error('Браузер запретил копирование. Выделите текст и скопируйте вручную.');}}

export class UI {
    constructor(engine) {this.e=engine;this.tab='memory';this.archiveTab='summary';this.archiveFilter='all';this.archiveSearch='';this.arcOrderManual=false;this.volumeOrderManual=false;this.promptTab='summary';this.start=null;this.end=null;this.rangeEdges={start:null,end:null};this.rangeChatKey=null;this.rangeCache=new Map();this.chosen=[];this.chaptersChosen=[];this.editor=null;this.timer=null;this.renderId=0;this.windowState='closed';this.resumeDirty=false;setErrorSink((error,meta)=>this.issue(error,meta));}
    async mount(html) {
        const template=el('template');template.innerHTML=html;document.body.append(template.content);
        this.panel=document.querySelector('#pensieve-panel');this.content=this.panel.querySelector('.pv-content');
        // Report the code that actually loaded, even if a newer manifest is already available.
        const version=el('span',{class:'pv-version','aria-label':'Версия интерфейса'},`v${UI_VERSION}`);
        const caption=this.panel.querySelector('.pv-caption')??this.panel.querySelector('.pv-header p');
        if(caption){caption.classList.add('pv-caption');caption.parentElement.classList.add('pv-brand');caption.append(document.createTextNode(' · '),version);}
        else this.panel.querySelector('.pv-header').append(version);
        const head=this.panel.querySelector('.pv-header');
        if(!head.querySelector('.pv-brand-mark')){head.querySelector('h2 i')?.remove();const mark=el('div',{class:'pv-brand-mark','aria-hidden':'true'});mark.append(el('i',{class:'fa-solid fa-book-open'}));head.prepend(mark);}
        const tabIcons={home:'fa-house',archive:'fa-box-archive',memory:'fa-brain',prompts:'fa-file-lines',settings:'fa-gear'};this.panel.querySelectorAll('[data-tab]').forEach(b=>{const label=({home:'Главная',archive:'Архив',memory:'Память',prompts:'Промпты',settings:'Настройки'})[b.dataset.tab];b.setAttribute('aria-label',label);b.replaceChildren(el('i',{class:'fa-solid pv-tab-icon '+tabIcons[b.dataset.tab],'aria-hidden':'true'}),el('span',{class:'pv-tab-full'},label));});
        // Also upgrade a cached older panel template without requiring a hard reload.
        let minimize=this.panel.querySelector('[data-action="minimize"]');
        if(!minimize){minimize=button('−',()=>this.minimize());minimize.dataset.action='minimize';minimize.classList.add('pv-icon');minimize.setAttribute('aria-label','Свернуть окно');this.panel.querySelector('[data-action="close"]').before(minimize);}
        minimize.onclick=()=>this.minimize();
        this.panel.querySelector('[data-action="close"]').onclick=()=>this.close();
        this.restoreDock=el('div',{id:'pensieve-restore-dock',hidden:'true'});
        const restore=iconButton('Омут памяти',()=>this.restore(),'fa-book-open');restore.setAttribute('aria-label','Восстановить Омут памяти');this.restoreDock.append(restore);
        this.restoreButton=restore;this.operationBanner=el('div',{class:'pv-operation-banner',role:'status',hidden:'true'});this.panel.querySelector('.pv-notice').before(this.operationBanner);
        this.operationSnapshot={...this.e.operation};this.operationUnsubscribe=this.e.subscribeOperation?.(snapshot=>{this.operationSnapshot=snapshot;this.syncOperationDock();if(snapshot.state==='saved'&&!this.e.busy&&this.panel.open&&this.tab==='home'&&this.isCurrentSession()&&snapshot.scope===this.e.recovery.key(this.renderSession.key))this.schedule(true);});
        const composer=document.getElementById('send_form');
        if(composer)composer.before(this.restoreDock);else this.panel.before(this.restoreDock);
        if(composer&&typeof ResizeObserver==='function'){
            const updateComposer=()=>this.panel.style.setProperty('--pv-composer-height',Math.ceil(composer.getBoundingClientRect().height)+'px');
            this.composerObserver=new ResizeObserver(updateComposer);this.composerObserver.observe(composer);updateComposer();
        }
        let artwork=head.querySelector('.pv-header-art');if(!artwork){artwork=el('img',{class:'pv-header-art',alt:'Серебряная чаша Омута памяти с голубым водоворотом',width:1672,height:941});head.prepend(artwork);}artwork.src=new URL('../assets/pensieve-header.png',import.meta.url).href;
        head.classList.add('pv-hero');const overlay=head.querySelector('.pv-hero-overlay')??el('div',{class:'pv-hero-overlay'}),controls=head.querySelector('.pv-header-controls')??el('div',{class:'pv-header-controls'});for(const control of head.querySelectorAll('[data-action="minimize"],[data-action="close"]'))controls.append(control);overlay.append(head.querySelector('.pv-brand-mark'),head.querySelector('.pv-brand'),controls);if(!overlay.isConnected)head.append(overlay);
        // Keep ST's document-wide drawer handlers out of this window's click path.
        this.watchKeyboard();
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
            this.resolveRange();
            const cleared=this.rangeChatKey===this.e.key()&&this[edge]===id;
            this.setRangeEdge(edge,cleared?null:id);this.decorateMessages();
            this.e.host.notify('success',cleared?'Отметка снята.':`${edge==='start'?'Начало':'Конец'} главы: сообщение №${id+1}.`);
            if(this.start!==null&&this.end!==null&&this.end<this.start)this.e.host.notify('warning','Конец главы выбран раньше начала. Измените одну из границ.');
            else if(this.start!==null&&this.end!==null){
                const session=this.e.session(),range=captureRange(session.chat,this.start,this.end);
                if(findOverlaps(this.e.archive(session).entries,range).length)this.e.host.notify('warning','Диапазон пересекается с сохранённой главой. При создании можно выбрать отдельную версию или доступную замену.');
            }
            if(this.panel.open&&this.tab==='home')this.render();
        });
        const c=this.e.host.context();
        if(c.eventTypes.APP_READY)c.eventSource.on(c.eventTypes.APP_READY,guardAction(mountMenu,{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'}));
        c.eventSource.on(c.eventTypes.CHAT_CHANGED,guardAction(()=>{
            try{if(this.e.busy)this.e.cancel('chat-changed');}catch(error){this.issue(error,{code:'INT-004',stage:'unlock'});}finally{this.generationView?.clear();}
            try{this.e.host.inject('');}catch(error){this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'});}
            this.loadRange();this.chosen=[];this.chaptersChosen=[];this.arcOrderManual=false;this.volumeOrderManual=false;this.archiveSearch='';
            this.resumeDirty=true;
            this.panel.querySelector('.pv-chat-name').textContent=this.e.host.context().chatId?`Чат: ${this.e.host.context().chatId}`:'Общие настройки · чат не открыт';
            if(this.editor){this.editor.close();this.editor.remove();this.editor=null;}
            for(const dialog of document.querySelectorAll('.pv-editor[data-chat-scoped]')){dialog.close();dialog.remove();}
            // Prompts are global: a chat event must never replace their unsaved DOM.
            if(this.tab!=='prompts'&&this.panel.open){this.rememberView();this.content.dataset.ready='false';this.content.replaceChildren(el('p',{class:'pv-muted'},'Загрузка архива…'));}
            this.schedule(this.tab!=='prompts');
        },{code:'UI-001',stage:'ui',operation:'ui',severity:'warning'}));
        for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SENT','MESSAGE_RECEIVED','MORE_MESSAGES_LOADED','USER_MESSAGE_RENDERED','CHARACTER_MESSAGE_RENDERED'])if(c.eventTypes[name])c.eventSource.on(c.eventTypes[name],()=>this.schedule());
        const chat=document.querySelector('#chat');if(chat)new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('.mes')||n.querySelector?.('.mes')))))this.schedule();}).observe(chat,{childList:true,subtree:true});
        this.loadRange();this.syncOperationDock();await this.refresh().catch(error=>this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'}));
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
    watchKeyboard(){
        const viewport=window.visualViewport;if(!viewport)return;
        const update=()=>{
            const dialog=document.activeElement?.closest?.('dialog.pensieve');
            const focused=document.activeElement?.matches?.('textarea,input:not([type=checkbox]):not([type=radio]),[contenteditable=true]');
            const keyboard=focused&&viewport.scale===1&&Math.max(window.innerHeight,document.documentElement.clientHeight)-viewport.height>100;
            if(this.keyboardDialog&&(!keyboard||this.keyboardDialog!==dialog)){
                this.keyboardDialog.classList.remove('pv-keyboard-open');this.keyboardDialog=null;
            }
            if(!dialog||!keyboard)return;
            this.keyboardDialog=dialog;dialog.classList.add('pv-keyboard-open');
            dialog.style.setProperty('--pv-visible-height',Math.round(viewport.height)+'px');
            dialog.style.setProperty('--pv-visible-top',Math.round(viewport.offsetTop)+'px');
        };
        viewport.addEventListener('resize',update);
        viewport.addEventListener('scroll',update);
        document.addEventListener('focusin',update);
        document.addEventListener('focusout',()=>requestAnimationFrame(update));
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
            if(!Number.isInteger(this.start)||!Number.isInteger(this.end)||this.start>this.end){this.e.host.notify('warning','Отметьте начало и конец главы в правильном порядке.');return;}
            const archive=this.e.archive(session),range=captureRange(session.chat,this.start,this.end),overlaps=findOverlaps(archive.entries,range);
            const slots=this.e.chapterSlotsForRange(archive,range,session.chat);
            const options=overlaps.length||slots.length?await this.chooseChapterRange(range,archive,overlaps,slots):{};
            if(!options)return;this.e.assert(session);
            const end=this.end,node=[...document.querySelectorAll('#chat .mes[mesid]')].find(n=>Number(n.getAttribute('mesid'))===end);
            progress=el('div',{class:'pv-chat-progress',role:'status'},'Создаётся глава…');(node?.querySelector('.mes_block')??node)?.append(progress);this.decorateMessages();
            return this.generating(()=>this.generateCapturedRange(session,range,options),{inline:!options.replaceId,episode:!options.replaceId,waitForPreview:true,type:'summary'});
        });}finally{progress?.remove();this.episodeTask=false;this.decorateMessages();}
    }
    chooseChapterRange(range,archive,overlaps,slots){
        return new Promise(resolve=>{
            const {dialog,body}=this.makeDialog(overlaps.length?'Диапазон пересекается с главой':'Прежнее место главы',true);
            let choice=null;
            const decide=value=>{choice=value;dialog.close();};
            if(overlaps.length)body.append(el('p',{},'Выбранные сообщения уже входят в главы: '+overlaps.map(entry=>entryDisplayTitle(entry,archive.entries)).join(', ')+'.'));
            if(slots.length)body.append(el('p',{},'Этот диапазон совпадает с исходниками удалённой главы. Можно создать новую сводку под прежним номером.'));
            if(slots.some(slot=>slot.ambiguous))body.append(el('p',{class:'pv-warning'},'По соседним главам не удалось однозначно подтвердить хронологический номер. Проверьте его перед сохранением.'));
            const actions=row();
            for(const {number} of slots)actions.append(button(`Воссоздать главу №${number}`,()=>decide({allowOverlap:!!overlaps.length,restoreNumber:number}),true));
            actions.append(button(overlaps.length?'Создать отдельную версию':'Создать с новым номером',()=>decide({allowOverlap:!!overlaps.length}),!slots.length));
            for(const entry of overlaps){
                if(hasDetachedSources(entry)||entry.sources.length!==range.length||!entry.sources.every((source,i)=>source.id===range[i].id&&source.hash===range[i].hash))continue;
                actions.append(button('Заменить '+entryDisplayTitle(entry,archive.entries),()=>decide({allowOverlap:true,replaceId:entry.id,replaceVersion:entry.version})));
            }
            actions.append(button('Снять отметки',()=>{this.clearRange();this.decorateMessages();decide(null);}),button('Отмена',()=>decide(null)));
            body.append(actions);dialog.onclose=()=>{dialog.remove();resolve(choice);};dialog.showModal();
        });
    }
    async episodeSaved(draft) {
        try{if(draft.type==='summary'&&this.rangeChatKey===draft.session.key&&this.rangeEdges.start?.ref===draft.range[0]?.ref&&this.rangeEdges.end?.ref===draft.range.at(-1)?.ref)this.clearRange();this.decorateMessages();}catch(error){this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'});}
        try{this.e.host.notify('success',({summary:'Глава сохранена',arc:'Часть сохранена',volume:'Том сохранён'})[draft.type]+' в памяти текущего чата.');}catch(error){this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'});}
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
    schedule(render=false) {const tab=this.tab,update=render||(this.panel?.open&&['archive','memory'].includes(tab));clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh(update&&this.tab===tab).catch(error=>this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'})),100);}
    issue(error,meta={}) {const record=this.e.host.report?.(error,{code:['TypeError','ReferenceError','RangeError','SyntaxError'].includes(error?.name)?'INT-001':'INT-002',stage:'handler',operation:'ui',severity:'error',...meta});const text=record?describeError(record).brief:error?.message??'Не удалось определить причину сбоя.';if(record&&meta.notify!==false&&!this.diagnosticsView?.visible)this.diagnosticsView?.show(record);return text;}
    collapseErrorViews(entry){
        if(entry.severity!=='error'&&entry.status!=='blocked'&&this.generationView?.job?.status!=='error')return null;
        this.diagnosticOperationDismissed=true;this.lastMinimizedOperation=false;this.showNotice('');
        const job=this.generationView?.job;
        if(job){job.noticeCovered=true;this.generationView.minimize(job);const reopen=()=>this.generationView.restore(job);reopen.target=job;return reopen;}
        return this.backupDialog?.isConnected?this.backupDialog.pensieveMinimizeForError?.():null;
    }
    showNotice(text) {const n=this.panel?.querySelector('.pv-notice');if(!n)return;n.hidden=!text;n.textContent=text;}
    async act(fn,meta={}) {
        try {const result=await trace(meta,fn);await this.refresh(true);return result;}
        catch(error){this.issue(error);await this.refresh(false).catch(()=>{});return null;}
    }
    open(tab=this.tab) {
        const force=this.windowState==='closed'||this.windowState==='minimized'&&tab!=='prompts';
        this.windowState='open';this.lastMinimizedOperation=false;this.restoreDock.hidden=true;
        if(!this.panel.open)this.panel.show();
        // ST replaces chat metadata before emitting CHAT_CHANGED. Check the live
        // session synchronously, including during a pending chat network request.
        this.go(tab,force);
        this.syncOperationDock();
        this.resumeDirty=false;
    }
    minimize() {if(!this.panel.open)return;this.windowState='minimized';this.panel.close();this.syncOperationDock();}
    restore() {this.open();}
    close() {this.windowState='closed';this.restoreDock.hidden=true;this.panel.close();}
    syncOperationDock(){
        if(!this.restoreDock)return;let op=this.operationSnapshot;
        try{if(op?.scope&&op.scope!==this.e.recovery.key(this.e.key()))op=null;}catch{op=null;}
        const visible=op&&op.state!=='idle',label=visible?operationLabel(op):'Омут памяти';
        const failed=visible&&['waiting','error'].includes(op.state);if(visible&&!failed)this.diagnosticOperationDismissed=false;
        if(visible&&!this.panel.open&&!this.generationView?.job&&!this.diagnosticOperationDismissed&&['saving','confirming','recovering','waiting','error'].includes(op.state))this.lastMinimizedOperation=true;
        this.operationBanner.hidden=!visible;this.operationBanner.textContent=visible?label+(op.lastCheck?` · Последняя проверка: ${new Date(op.lastCheck).toLocaleTimeString()}`:''):'';
        this.restoreButton.querySelector('span').textContent=`Омут памяти · ${label==='Омут памяти'?'':label+' · '}Развернуть`;
        this.restoreDock.hidden=this.diagnosticsNoticeActive||failed&&this.diagnosticOperationDismissed||!!this.generationView?.isMinimized||!(this.windowState==='minimized'||this.lastMinimizedOperation&&visible);
        this.restoreDock.setAttribute('aria-busy',String(!!this.e.busy));
    }
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
            if(editor.node.value===(editor.displayBase??editorDisplay(editor.base)))this.promptDrafts.delete(editor.key);
            else this.promptDrafts.set(editor.key,{base:editor.base,text:editor.node.value});
        }
        this.workspaceViews??=new Map();
        this.workspaceViews.set(JSON.stringify([this.renderSession?.key??null,this.content.dataset.view]),{
            scroll:this.content.scrollTop,overlap:this.content.querySelector('[aria-label="Повторная обработка"]')?.value,
            preview:!!this.content.querySelector('.pv-preview-details[open]'),help:!!this.content.querySelector('.pv-archive-help[open]'),
            openEntries:[...this.content.querySelectorAll('[data-entry-id] .pv-entry-more[open]')].map(n=>n.closest('[data-entry-id]').dataset.entryId),
            openTree:[...this.content.querySelectorAll('[data-parent-entry][open]')].map(n=>n.dataset.parentEntry),maintenance:!!this.content.querySelector('.pv-maintenance[open]'),
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
        const maintenance=this.content.querySelector('.pv-maintenance');if(maintenance)maintenance.open=!!saved.maintenance;
        this.content.scrollTop=saved.scroll;
    }
    go(tab,force=false) {if(!force&&this.canReuseView(tab))return;this.tab=tab;this.showNotice('');this.render().catch(error=>this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'}));}
    memorySnapshot(){return trace({code:'MEM-005',stage:'tokens'},()=>bounded(()=>this.e.refreshMemory(),this.e.policy().tokensTimeout));}
    postSaveRefresh(){this.refresh(true,this.e.peekMemory?.()).catch(error=>this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'}));}
    async refresh(render=false,snapshot=null) {
        if(render)clearTimeout(this.timer);
        if(this.windowState!=='open')this.resumeDirty=true;
        const tab=this.tab;
        this.panel.dataset.theme=this.e.settings().theme;
        const memory=snapshot??await this.memorySnapshot();this.lastMemory=memory;try{this.decorateMessages();}catch(error){this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'});}
        if(memory.blocked&&tab!=='memory'&&!this.diagnosticsView?.visible&&!this.diagnosticOperationDismissed){this.memoryNotice=memory.reason;this.showNotice(memory.reason);}
        else if(this.panel.querySelector('.pv-notice').textContent===this.memoryNotice){this.showNotice('');this.memoryNotice=null;}
        if(render&&this.panel.open&&this.tab===tab)await this.render(memory);
    }
    async render(snapshot=null) {
        const stamp=++this.renderId;this.panel.dataset.theme=this.e.settings().theme;
        this.rememberView();this.content.dataset.ready='false';
        this.content.dataset.view=this.tab;
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===this.tab?'page':'false'));
        this.content.replaceChildren(el('p',{class:'pv-muted'},'Загрузка архива…'));
        let session;try{session=this.e.session();}catch(error){
            if(errorMeta(error).reason!=='no-chat')this.issue(error,{code:'MEM-001',stage:'chat'});
            this.renderSession=null;
            this.lastMemory=null;this.viewState=null;this.sourceRanges=null;
            this.panel.querySelector('.pv-chat-name').textContent='Общие настройки · чат не открыт';this.content.replaceChildren();
            if(this.tab==='prompts')this.promptsView();
            else if(this.tab==='settings')this.settingsView(null);
            else this.content.append(el('p',{class:'pv-empty'},'Откройте сохранённый чат, чтобы работать с его памятью.'),row(button('Промпты',()=>this.go('prompts')),button('Общие настройки',()=>this.go('settings'))));
            this.restoreView();return;
        }
        this.renderSession=session;
        if(this.tab==='settings'){
            this.content.replaceChildren();let archive=null;try{archive=this.e.archive(session);}catch(error){this.issue(error,{code:'MEM-002',stage:'active'});}
            try{this.settingsView(archive);}catch(error){this.issue(error,{code:'UI-001',stage:'ui',severity:'warning'});if(!this.content.querySelector('.pv-diagnostics'))this.diagnosticsView?.settings(this.content);}
            this.restoreView();return;
        }
        const memory=snapshot??await this.memorySnapshot();if(stamp!==this.renderId)return;this.e.assert(session);
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
    async macroNote(node,pill,position){
        let configuration,owner,info;try{configuration=this.e.host.configuration?.();owner=this.e.key();info=await bounded(()=>this.e.host.macroPresence(),2000);}catch{info={status:'unknown'};}
        if(!node.isConnected)return;try{if(owner&&owner!==this.e.key()||configuration!==undefined&&configuration!==this.e.host.configuration?.()){node.textContent='Настройки промпта изменились. Обновите просмотр памяти.';return;}}catch{return;}
        if(info?.status==='present'){pill.textContent='Через макрос';node.className='pv-muted pv-macro-status';node.textContent='{{memory_echo}} найден во включённом тексте пресета и имеет приоритет над автоматической вставкой. Окончательная подстановка определяется при сборке запроса.';}
        else if(position!==-1){node.className='pv-muted pv-macro-status';node.textContent='Выбрана автоматическая подстановка. Если {{memory_echo}} появится в полном запросе, он получит приоритет.';}
        else{pill.textContent='Проверьте макрос';node.className='pv-warning pv-macro-status';node.textContent=info?.status==='missing'?'Во включённых текстах пресета {{memory_echo}} не найден. Добавьте его в используемый промпт SillyTavern. Динамические вставки проверяются при отправке.':'Наличие {{memory_echo}} ещё не подтверждено. Проверьте используемый пресет SillyTavern; в текст ролевого чата макрос вставлять не нужно.';}
    }
    memoryUsage(memory=this.lastMemory) {
        const settings=this.e.settings(),section=el('section',{class:'pv-memory-overview','aria-label':'Использование Memory Echo'}),tokens=Number.isFinite(memory?.tokens)?memory.tokens:null,limit=Number(settings.tokenLimit),hasLimit=Number.isFinite(limit)&&limit>0,enabled=!!memory?.enabled,position=Number(settings.position),mode=({'-1':'Через макрос','0':'После промпта','1':'Внутри чата','2':'Перед промптом'})[position]??'Не определён';
        const title=el('div',{class:'pv-memory-overview-head'}),amount=el('div',{class:'pv-memory-total'}),pill=el('span',{class:'pv-delivery-mode',title:'Выбранный режим: '+mode},enabled?mode:'Передача выключена');amount.append(el('i',{class:'fa-solid fa-database','aria-hidden':'true'}),el('p',{class:'pv-memory-amount'},tokens===null?'Статистика недоступна':`≈ ${tokens.toLocaleString('ru-RU')}${hasLimit?' / '+limit.toLocaleString('ru-RU'):''} токенов`));title.append(amount,pill);section.append(title);
        if(hasLimit&&tokens!==null){const ratio=100*tokens/limit,meter=el('div',{class:'pv-memory-meter',role:'progressbar','aria-label':'Использование лимита Memory Echo','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(Math.min(100,Math.max(0,ratio)))}),fill=el('span');fill.style.width=`${Math.min(100,Math.max(0,ratio))}%`;meter.append(fill);const footer=el('div',{class:'pv-memory-usage-footer'});footer.append(el('span',{},`${ratio.toLocaleString('ru-RU',{maximumFractionDigits:1})}% лимита`),el('span',{},`${tokens<=limit?'Осталось: ':'Превышение: '}${Math.abs(limit-tokens).toLocaleString('ru-RU')}`));section.append(meter,footer);}
        section.append(el('p',{class:'pv-memory-caption'},'Токены фактически сформированного блока Memory Echo.'));
        if(!enabled)section.append(el('p',{class:'pv-warning'},'Передача памяти выключена. Этот блок сейчас не отправляется.'));
        else if(memory.blocked)section.append(el('p',{class:'pv-warning'},memory.reason));
        if(enabled){const warning=el('p',{class:'pv-muted pv-macro-status'},'Проверка макроса в используемом пресете…');section.append(warning);this.macroNote(warning,pill,position);}
        return section;
    }
    recentReductions(archive){
        const section=el('section',{class:'pv-recent-reductions','aria-label':'Последние сокращения'}),heading=el('h3');heading.append(el('i',{class:'fa-solid fa-chart-simple','aria-hidden':'true'}),document.createTextNode('Последние сокращения'));section.append(heading);
        let op=this.operationSnapshot;try{if(op?.scope&&op.scope!==this.e.recovery.key(this.e.key()))op=null;}catch{op=null;}
        if(archive.pending?.type==='backup'||op?.state==='waiting'){section.append(el('p',{class:'pv-muted'},'Список обновится после подтверждения незавершённого сохранения.'));return section;}
        const date=e=>{const n=Date.parse(e.compression?.updatedAt??e.updatedAt??e.createdAt);return Number.isFinite(n)?n:0;},entries=archive.entries.map((entry,index)=>({entry,index})).filter(({entry})=>entry.id!==archive.pending?.entryId).sort((a,b)=>date(b.entry)-date(a.entry)||b.index-a.index).slice(0,3);
        if(!entries.length)section.append(el('p',{class:'pv-muted'},'Здесь появятся последние сохранённые главы, части и тома.'));
        for(const {entry}of entries){const row=el('article',{class:'pv-reduction-row','data-recent-entry':entry.id}),name=button(entryDisplayTitle(entry,archive.entries),()=>this.editEntry(entry,false)),kind=el('span',{class:'pv-level-pill pv-level-'+entry.type},LEVELS[entry.type].name),values=this.recordCompression(entry)?.values;name.className='pv-reduction-name';name.title=entryDisplayTitle(entry,archive.entries);row.append(name,kind);
            if(!values)row.append(el('span',{class:'pv-reduction-unavailable'},'Статистика недоступна'));
            else{const prefix=values.approximate?'≈ ':'',growing=values.saved<0,sign=values.saved>0?'−':growing?'+':'',amount=Math.abs(values.saved).toLocaleString('ru-RU'),percent=values.percent===null?'':` (${sign}${Math.abs(values.percent).toLocaleString('ru-RU',{maximumFractionDigits:0})}%)`;row.append(el('span',{class:'pv-reduction-tokens'},`${prefix}${values.before.toLocaleString('ru-RU')} → ${values.after.toLocaleString('ru-RU')}`),el('span',{class:'pv-reduction-delta '+(growing?'pv-reduction-growth':'pv-reduction-saving'),'aria-label':(growing?'Увеличение объёма: ':'Сокращение: ')+amount+' токенов'},`${prefix}${sign}${amount}${percent}`));}section.append(row);
        }
        return section;
    }
    home(archive) {
        const home=el('section',{class:'pv-home'}),heading=el('div',{class:'pv-home-heading'});heading.append(el('h3',{},'Главная'),el('p',{class:'pv-muted'},'Быстрый доступ к основным операциям'));
        const actions=el('div',{class:'pv-home-actions'}),select=type=>{this.archiveTab=type;this.archiveFilter='all';this.archiveSearch='';this.go('archive',true);};
        for(const [type,title,subtitle,glyph]of [['summary','Создать часть','Из выбранных глав','fa-layer-group'],['arc','Создать том','Из выбранных частей','fa-book-open']]){const tile=button('',()=>select(type)),label=el('span',{class:'pv-creation-label'});label.append(el('strong',{},title),el('small',{},subtitle));tile.className='pv-creation-card';tile.append(el('i',{class:'fa-solid '+glyph,'aria-hidden':'true'}),label,el('i',{class:'fa-solid fa-arrow-right pv-creation-arrow','aria-hidden':'true'}));actions.append(tile);}
        const hint=el('p',{class:'pv-home-hint'});hint.append(el('i',{class:'fa-regular fa-circle-info','aria-hidden':'true'}),document.createTextNode('Главы создаются непосредственно в чате: отметьте начало и конец диапазона.'));
        const state=el('section',{class:'pv-home-state'}),stateHead=el('div',{class:'pv-home-state-heading'}),enabled=!!(this.e.settings().enabled&&this.e.settings().inject);stateHead.append(el('h3',{},'Состояние памяти'),el('span',{class:'pv-enabled-pill '+(enabled?'pv-is-enabled':'')},enabled?'Включена':'Выключена'));
        const counts=el('div',{class:'pv-home-counts'}),plural=(n,forms)=>n%100>=11&&n%100<=14?forms[2]:n%10===1?forms[0]:n%10>=2&&n%10<=4?forms[1]:forms[2];
        for(const [type,forms,glyph]of [['summary',['Глава','Главы','Глав'],'fa-book-open'],['arc',['Часть','Части','Частей'],'fa-layer-group'],['volume',['Том','Тома','Томов'],'fa-book']]){const n=archive.entries.filter(e=>e.type===type).length,card=el('div',{class:'pv-count-card'}),label=el('div');label.append(el('strong',{},n.toLocaleString('ru-RU')),el('span',{},plural(n,forms)));card.append(el('i',{class:'fa-solid '+glyph,'aria-hidden':'true'}),label);counts.append(card);}
        const view=iconButton('Посмотреть активную память',()=>this.go('memory'),'fa-eye');view.className='pv-active-memory-link';state.append(stateHead,counts,this.memoryUsage(),view);home.append(heading,actions,hint,state,this.recentReductions(archive));this.content.append(home);
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
                const chosen=el('div',{class:'pv-arc-selection','data-target-level':target});chosen.append(el('strong',{},`${type==='summary'?'Глав':'Частей'} выбрано: ${this[key].length}`),el('small',{},this[manual]?'Ручной порядок. Модель получит записи в показанной последовательности.':'Порядок по исходным сообщениям. Стрелками можно изменить его вручную.'));
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
        const output=this.recordCompression(e)?.values?.after,metadata=el('small',{class:'pv-entry-meta'},`${status} · Версия ${e.version} · ${output===undefined?'Статистика недоступна':'≈ '+output.toLocaleString('ru-RU')+' токенов'}`);main.append(metadata);
        if(state.gate==='blocked')heading.append(el('span',{class:'pv-gate-status'},this.lastMemory.limitExceeded?'Не помещается в лимит':'Не внедряется: блокировка'));
        const details=el('details',{class:'pv-entry-more'}),more=el('summary',{'aria-label':`Дополнительные действия: ${display}`},activeView?'Дополнительно':'···');details.append(more);
        if(state.note)details.append(el('p',{class:'pv-status-note'},state.note));
        const compression=this.compressionDetails(e);if(activeView)card.append(compression);else details.append(compression);
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
        details.append(row(button('Скопировать',()=>this.act(()=>copy(e.text))),button('Экспорт .txt',()=>download(`${e.type}-${e.id}.txt`,`${e.title}\n\n${e.text}`,'text/plain')),button('Перегенерировать',()=>this.act(()=>this.regenerateEntry(e))),button(e.type==='summary'?'Удалить главу':'Удалить',()=>this.act(async()=>{
            if(e.type==='summary')return this.deleteChapterFromArchive(session,e.id);
            if(parents.some(p=>childrenIds(p).length<3)){this.textDialog('Связанные записи',`Эта запись входит в: ${parents.map(p=>entryDisplayTitle(p,archive.entries)).join('; ')}. После удаления у каждого родителя должны оставаться минимум две исходные записи. Сохранённые родительские тексты не изменены; сначала пересоберите или удалите родителя.`);return;}
            const warning=parents.length?` Связи с ${parents.map(p=>entryDisplayTitle(p,archive.entries)).join('; ')} будут убраны. Их тексты сохранятся и получат отметку «Требует проверки».`:'';
            if(!await this.confirm('Удаление записи',`Удалить «${entryDisplayTitle(e,archive.entries)}»? Дочерние записи и история чата останутся.${warning}`,session))return;
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
    async deleteChapterFromArchive(session,id){
        this.e.assert(session);
        const archive=this.e.archive(session),index=hierarchyIndex(archive.entries),chapter=index.byId.get(id);
        if(chapter?.type!=='summary')return;
        const parents=index.parents.get(id)??[];
        if(parents.length){
            const {dialog,body}=this.makeDialog('Глава входит в части',true);
            body.append(el('p',{},'Сначала исключите главу из связанных частей. Текст части и тома обновляется отдельно при перегенерации.'));
            for(const part of parents){
                const title=entryDisplayTitle(part,archive.entries);
                body.append(el('p',{},title));
                if(part.summaryIds.length<=2){
                    body.append(el('p',{class:'pv-muted'},'В части останется только одна глава. Сначала пересоберите эту часть с другим составом или удалите её вручную.'));
                    continue;
                }
                body.append(button('Исключить из '+title,async()=>{
                    if(!await this.confirm('Исключить главу из части?',`Связь с «${title}» будет устранена. Часть и связанные тома получат отметку «Требует проверки».`,session,'Исключить',this.chapterBackupButton(session)))return;
                    this.e.assert(session);
                    await this.e.unlinkChapter(part.id,id);
                    dialog.close();await this.refresh(true);
                }));
            }
            body.append(button('Закрыть',()=>dialog.close()));dialog.onclose=()=>dialog.remove();dialog.showModal();return;
        }
        const number=entryNumber(chapter,archive.entries),version=chapter.version;
        if(!await this.confirm(`Удалить главу №${number}?`,'Сохранённая сводка будет удалена. Исходные сообщения останутся в чате. Если они скрыты, ты сможешь раскрыть их вручную.',session,'Удалить',this.chapterBackupButton(session)))return;
        this.e.assert(session);
        if((await this.e.deleteChapter(id,{session,version})).status==='saved')this.e.host.notify('success',`Глава №${number} удалена.`);
    }
    async regenerateEntry(e) {
        const session=this.e.session();
        if(e.type==='volume'){const ids=[...e.chapterIds];return this.generating(()=>{this.e.assert(session);return this.e.generateVolume(ids,{replaceId:e.id});},{type:'volume'});}
        if(e.type==='arc'){const ids=[...e.summaryIds];return this.generating(()=>{this.e.assert(session);return this.e.generateArc(ids,{replaceId:e.id});},{type:'arc'});}
        const {id,version}=e;
        return this.generating(()=>this.e.regenerateChapter(id,{session,version}),{type:'summary'});
    }
    setMemoryEnabled(enabled) {
        return this.act(()=>{const settings=this.e.settings();settings.inject=enabled;if(enabled)settings.enabled=true;this.e.host.context().saveSettingsDebounced();});
    }
    recordCompression(entry){
        this.statisticsCache??=new WeakMap();const previous=this.statisticsCache.get(entry),signature=JSON.stringify(entry.compression??null);if(previous?.text===entry.text&&previous.signature===signature)return previous.value;
        let value=null;try{if(entry.compression){const stats=validateCompression(entry.compression),current=stats.resultHash===fingerprint({name:'compression-result',mes:entry.text});value={stats,current,values:current?compressionValues(stats):null};}}catch{}
        this.statisticsCache.set(entry,{text:entry.text,signature,value});return value;
    }
    compressionDetails(entry){
        const details=el('details',{class:'pv-compression','data-statistics-entry':entry.id}),record=this.recordCompression(entry),values=record?.values;
        details.append(el('summary',{},!values?'Статистика недоступна':`${values.saved<0?'Увеличение объёма':'Сжатие'}: ${values.approximate?'≈ ':''}${values.before.toLocaleString('ru-RU')} → ${values.after.toLocaleString('ru-RU')} токенов`));
        if(!values){details.append(el('p',{class:'pv-muted'},record&&!record.current?'Текст изменён вне редактора. Сохранённая статистика относится к прежнему тексту.':'Исходный объём для этой записи не сохранялся. Пересчёт старой переписки автоматически не выполняется.'));return details;}
        const table=el('table'),body=el('tbody'),prefix=values.approximate?'≈ ':'';
        for(const [title,value]of [['До сжатия',prefix+values.before.toLocaleString('ru-RU')],['После сжатия',prefix+values.after.toLocaleString('ru-RU')],[values.saved<0?'Увеличение объёма':'Сэкономлено',prefix+Math.abs(values.saved).toLocaleString('ru-RU')],[values.saved<0?'Рост':'Сокращение',values.percent===null?'Статистика недоступна':prefix+Math.abs(values.percent).toLocaleString('ru-RU',{maximumFractionDigits:1})+'%']]){const tr=el('tr');tr.append(el('th',{scope:'row'},title),el('td',{},value));body.append(tr);}table.append(body);details.append(table);
        const counter=record.stats.counter;details.append(el('p',{class:'pv-muted'},counter.kind==='estimate'?'Оценка: один токен на четыре символа, одинаковый метод для источника и результата.':`Токенизатор: ${counter.kind==='server'?counter.tokenizer+(counter.model?' · '+counter.model:''):'SillyTavern, выбранная модель'}. Значения обозначены как приблизительные.`));
        if(values.fallback)details.append(el('p',{class:'pv-muted'},`Исходный токенизатор недоступен. Показана одинаковая оценка источника и результата по длине текста. Первоначальный подсчёт источника сохранён: ≈ ${record.stats.sourceTokens.toLocaleString('ru-RU')} токенов.`));
        return details;
    }
    async memoryView(archive,stamp) {
        const memory=this.lastMemory,state=this.viewState;if(stamp!==this.renderId)return;
        this.content.append(this.memoryUsage(memory));
        for(const warning of memory.orderWarnings??[])this.content.append(el('p',{class:'pv-warning'},warning));
        const quick=row(iconButton('Посмотреть Memory Echo',()=>this.textDialog('Сформированный блок Memory Echo',memory.text||'Блок памяти пуст.'),'fa-book-open'),iconButton('Скопировать',()=>this.act(()=>copy(memory.text||'')),'fa-copy'),iconButton('Обновить',()=>this.act(()=>this.e.refreshMemory()),'fa-rotate'));quick.classList.add('pv-memory-quick');this.content.append(quick);
        const previews=el('details',{class:'pv-memory-preview'});previews.append(el('summary',{},'Предпросмотр Memory Echo'),el('pre',{},memory.text||'Блок памяти пуст.'));this.content.append(previews);
        const index=hierarchyIndex(archive.entries),covered=new Set(state.current.flatMap(e=>[e.id,...index.descendants(e)])),archived=archive.entries.filter(e=>!covered.has(e.id)),eligible=new Set(archived.map(e=>e.id)),roots=archived.filter(e=>!(index.parents.get(e.id)??[]).some(parent=>eligible.has(parent.id))),displayed=new Set();
        const saved=this.workspaceViews?.get(JSON.stringify([this.renderSession?.key??null,'memory'])),openTree=new Set(saved?.openTree??[]);
        const nodeFor=entry=>{
            if(displayed.has(entry.id)){const reference=iconButton(entryDisplayTitle(entry,archive.entries)+' · связанная запись',()=>this.editEntry(entry,false),'fa-link');reference.classList.add('pv-tree-reference');return reference;}
            displayed.add(entry.id);const node=el('div',{class:'pv-memory-node','data-level':entry.type});node.append(this.entryCard(entry,archive,true));
            const children=childrenIds(entry).map(id=>index.byId.get(id)).filter(Boolean);
            if(children.length){const branch=el('details',{class:'pv-memory-children','data-parent-entry':entry.id}),label=entry.type==='volume'?'Входящие части':'Входящие главы',content=el('div',{class:'pv-memory-branches'});branch.append(el('summary',{},`${label}: ${children.length}`),content);let populated=false;branch.addEventListener('toggle',()=>{if(branch.open&&!populated){populated=true;for(const child of children)content.append(nodeFor(child));}});branch.open=openTree.has(entry.id);node.append(branch);}
            return node;
        };
        for(const [name,title,entries]of [['current',Number(this.e.settings().position)===-1?'Доступно через Memory Echo':'Активная память',state.current],['archive','Только в архиве',this.e.orderEntries(chronological(roots)).entries]]){
            const section=el('section',{class:'pv-memory-section','data-memory-section':name});section.append(el('h3',{},title),el('p',{class:'pv-memory-description'},name==='current'?'В блок входят только активные верхние записи. Вложенные части и главы доступны для просмотра и отдельно повторно не подставляются.':'Сохранённые записи, которые сейчас не участвуют в передаче модели. Статистика каждого уровня хранится отдельно.'));
            if(!entries.length)section.append(el('p',{class:'pv-muted'},name==='current'?'В передаваемом блоке нет активных записей.':'Отдельных архивных записей нет.'));
            for(const entry of entries)section.append(nodeFor(entry));this.content.append(section);
        }
    }
    async confirmPromptDrafts(types,action){
        this.rememberView();
        const settings=this.e.settings(),id=settings.prompts.summary.selected;
        const changed=types.flatMap(type=>{
            const key=JSON.stringify([type,id]),draft=this.promptDrafts?.get(key),preset=settings.prompts[type].presets.find(item=>item.id===id);
            return draft&&preset&&editorDisplay(preset.text)!==draft.text?[{type,key,draft,preset}]:[];
        });
        if(!changed.length)return true;
        const choice=await new Promise(resolve=>{
            const {dialog,body}=this.makeDialog('Есть несохранённые изменения');
            let result='cancel';
            const choose=value=>{result=value;dialog.close();};
            body.append(el('p',{},`Перед ${action} выберите, какую версию использовать. Изменены промпты: ${changed.map(item=>LEVELS[item.type].genitive).join(', ')}.`),
                row(button('Сохранить и продолжить',()=>choose('save'),true),button('Использовать сохранённую версию',()=>choose('saved')),button('Отмена',()=>choose('cancel'))));
            dialog.onclose=()=>{dialog.remove();resolve(result);};dialog.showModal();
        });
        if(choice==='cancel')return false;
        if(choice==='saved')return true;
        if(settings.prompts.summary.selected!==id||changed.some(({type,preset,draft})=>settings.prompts[type].presets.find(item=>item.id===id)!==preset||preset.text!==draft.base)){
            this.e.host.notify('warning','Сохранённый промпт изменился. Откройте редактор и сравните версии.');return false;
        }
        for(const {key,draft,preset} of changed){
            preset.history.push(preset.text);preset.text=draft.text;this.promptDrafts.delete(key);
            if(this.promptEditor?.key===key){this.promptEditor.base=preset.text;this.promptEditor.displayBase=editorDisplay(preset.text);this.promptEditor.indicator.hidden=true;}
        }
        this.saveSettings();return true;
    }
    promptsView() {
        const settings=this.e.settings(),type=this.promptTab,id=settings.prompts.summary.selected,group=settings.prompts[type],preset=group.presets.find(p=>p.id===id);
        const select=el('select',{'aria-label':'Пресет промпта'});presetList(settings).forEach(p=>select.append(el('option',{value:p.id},p.name)));select.value=id;
        const key=JSON.stringify([type,id]),draft=this.promptDrafts?.get(key);
        const text=el('textarea',{'aria-label':`Промпт ${LEVELS[type].genitive}`,spellcheck:'false'},draft?.text??preset.text);
        const indicator=el('small',{class:'pv-draft-indicator',role:'status'},'Есть несохранённые изменения');
        const editor=this.promptEditor={node:text,key,base:preset.text,displayBase:editorDisplay(preset.text),indicator};
        const updateDraft=()=>{indicator.hidden=text.value===editor.displayBase;};text.addEventListener('input',updateDraft);updateDraft();
        select.onchange=()=>{this.rememberView();selectPreset(settings,select.value);this.saveSettings();this.render();};
        const controls=row(iconButton('Создать пресет',()=>this.act(async()=>{const name=await this.askText('Название нового пресета','');if(name){createPreset(settings,name,()=>this.e.host.uuid());this.saveSettings();}}),'fa-plus'),iconButton('Импорт пресета',async()=>{try{const f=await readFile('.json,application/json');if(f)await this.act(()=>{importPreset(settings,f.text,()=>this.e.host.uuid());this.saveSettings();this.showNotice('Импортирован набор из трёх промптов.');},{code:'DATA-007',stage:'import',operation:'prompt-import'});}catch(error){this.issue(error,{code:'DATA-007',stage:'import',operation:'prompt-import'});}},'fa-file-import'),iconButton('Экспорт пресета',async()=>{if(await this.confirmPromptDrafts(Object.keys(LEVELS),'экспортом'))return fileTrace('prompt-export',()=>download('pensieve-prompt-preset.json',JSON.stringify(exportPreset(settings),null,2)));},'fa-file-export'));controls.classList.add('pv-preset-actions');
        const toolbar=el('div',{class:'pv-preset-toolbar'});toolbar.append(field('Пресет',select),controls);this.content.append(toolbar);
        const segments=row(...Object.entries(LEVELS).map(([t,level])=>button(`Промпт ${level.genitive}`,()=>{this.promptTab=t;this.render();},this.promptTab===t)));segments.classList.add('pv-level-tabs');this.content.append(segments);
        text.classList.add('pv-prompt-text');
        const editorHead=el('div',{class:'pv-prompt-heading'});editorHead.append(el('span',{},'Ваш промпт'),iconButton('Развернуть редактор',()=>this.expandPrompt(text),'fa-expand'));
        this.content.append(editorHead,indicator,field(`Ваш промпт ${LEVELS[type].genitive}`,text),el('p',{class:'pv-muted'},'Один пресет содержит промпты главы, части и тома. Текст используется буквально, включая Markdown и {{макросы}}. Сохраните изменения перед генерацией или экспортом.'));
        this.content.append(row(button('Сохранить промпт',()=>{if(text.value!==editor.displayBase){preset.history.push(preset.text);preset.text=text.value;}editor.base=preset.text;editor.displayBase=editorDisplay(preset.text);this.promptDrafts?.delete(key);updateDraft();this.saveSettings();this.showNotice('Промпт сохранён в выбранном пресете.');},true),button('Предыдущая версия',()=>this.act(async()=>{if(!preset.history.length)throw Error('Предыдущих версий пока нет.');if(await this.confirm('Восстановление промпта','Восстановить предыдущую сохранённую версию?')){const previous=preset.history.pop();preset.history.push(preset.text);preset.text=previous;text.value=previous;editor.base=previous;editor.displayBase=editorDisplay(previous);this.promptDrafts?.delete(key);updateDraft();this.saveSettings();}}))));
        const more=el('details',{class:'pv-preset-more'});more.append(el('summary',{},'Действия с пресетом'));
        const rename=button('Переименовать',()=>this.act(async()=>{const name=await this.askText('Название пресета',preset.name);if(name){renamePreset(settings,id,name);this.saveSettings();}})),remove=button('Удалить пресет',()=>this.act(async()=>{if(await this.confirm('Удаление пресета','Удалить весь набор из трёх промптов?')){deletePreset(settings,id);text.value=editor.displayBase;for(const t of Object.keys(LEVELS))this.promptDrafts?.delete(JSON.stringify([t,id]));this.saveSettings();}}));rename.disabled=remove.disabled=id==='default';
        more.append(row(rename,remove,button('Восстановить «Основной»',()=>this.act(async()=>{if(await this.confirm('Встроенный пресет','Восстановить три исходных промпта «Основного»? Сохранённые изменения останутся в истории версий; другие пресеты сохранятся.')){restoreBuiltin(settings);for(const t of Object.keys(LEVELS))this.promptDrafts?.delete(JSON.stringify([t,'default']));if(id==='default'){text.value=settings.prompts[type].presets.find(p=>p.id==='default').text;editor.base=settings.prompts[type].presets.find(p=>p.id==='default').text;editor.displayBase=editorDisplay(editor.base);}this.saveSettings();}}))));
        more.append(el('p',{class:'pv-muted'},'«Основной» нельзя удалить или переименовать. Для отдельного варианта создайте свой пресет.'),row(button('Импорт из .txt',async()=>{try{const f=await readFile('.txt,.md,text/plain');if(f){text.value=f.text;updateDraft();this.showNotice('Текст загружен в текущий редактор. Нажмите «Сохранить промпт».');}}catch(error){this.issue(error,{code:'DATA-007',stage:'import',operation:'prompt-import'});}}),button('Экспорт .txt',async()=>{if(await this.confirmPromptDrafts([type],'экспортом'))return fileTrace('prompt-export',()=>download(`pensieve-prompt-${type}.txt`,preset.text,'text/plain'));})));this.content.append(more);
    }

    expandPrompt(text) {
        const {dialog,body}=this.makeDialog('Редактор промпта');dialog.classList.add('pv-prompt-expanded');
        const area=el('textarea',{'aria-label':'Полный редактор промпта',spellcheck:'false'},text.value);
        body.append(area,button('Вернуться к промпту',()=>dialog.close(),true));
        dialog.onclose=()=>{text.value=area.value;text.dispatchEvent(new Event('input'));dialog.remove();};dialog.showModal();area.focus();
    }
    saveSettings() {this.e.host.context().saveSettingsDebounced();this.schedule();}
    memoryPlacementView(section,settings) {
        section.classList.add('pv-memory-placement');
        const modes=[
            [-1,'Никуда — только макрос'],
            [2,'Перед основным промптом'],
            [0,'После основного промпта'],
            [1,'Внутри чата'],
        ];
        const options=el('div',{class:'pv-placement-options',role:'radiogroup','aria-labelledby':'pv-placement-label'});
        const macro=el('div',{class:'pv-placement-card pv-placement-macro'});
        const automatic=el('div',{class:'pv-placement-card'});
        const inChat=el('div',{class:'pv-placement-card'});
        const automaticIcon=el('i',{'aria-hidden':'true'});
        const automaticHeading=el('h4');
        const automaticHelp=el('p',{class:'pv-muted'});
        const caption=el('div',{class:'pv-placement-caption'});
        caption.append(automaticIcon,el('span',{},'Автоматическая подстановка'));
        automatic.append(caption,automaticHeading,automaticHelp,
            el('p',{class:'pv-muted'},'Для этого режима макрос и настройка шаблона не нужны.'));

        const copyStatus=el('small',{role:'status'});
        const macroText='{{memory_echo}}';
        const copyButton=iconButton('Копировать',async()=>{
            await copy(macroText);
            if(!macro.hidden)copyStatus.textContent='Макрос скопирован.';
        },'fa-copy');
        const macroRow=el('div',{class:'pv-placement-macro-row'});
        macroRow.append(el('code',{},macroText),copyButton);
        macro.append(el('h4',{},'Макрос для пресета SillyTavern'),macroRow,
            el('p',{class:'pv-muted'},'Вставь макрос в свой пресет SillyTavern. Автоматической подстановки в этом режиме нет.'),copyStatus);

        const update=()=>{
            const position=Number(settings.position);
            macro.hidden=position!==-1;
            inChat.hidden=position!==1;
            automatic.hidden=position!==2&&position!==0;
            copyStatus.textContent='';
            if(!automatic.hidden){
                const before=position===2;
                automaticIcon.className='fa-solid '+(before?'fa-arrow-up':'fa-arrow-down');
                automaticHeading.textContent=modes.find(([value])=>value===position)[1];
                automaticHelp.textContent=before
                    ? 'Воспоминания автоматически добавляются перед основным промптом.'
                    : 'Воспоминания автоматически добавляются после основного промпта.';
            }
        };
        for(const [value,title] of modes){
            const radio=el('input',{type:'radio',name:'pensieve-memory-position',value,'aria-label':title});
            radio.checked=Number(settings.position)===value;
            radio.onchange=()=>{
                if(!radio.checked)return;
                settings.position=value;
                update();
                this.saveSettings();
            };
            const label=el('label');label.append(radio,el('span',{},title));options.append(label);
        }
        const depth=el('input',{id:'pv-placement-depth',type:'number',min:0,max:10000,step:1,value:settings.depth,'aria-describedby':'pv-placement-depth-help'});
        const depthHelp=el('p',{id:'pv-placement-depth-help',class:'pv-muted'},'Глубина 0 — после последнего сообщения, 1 — перед последним.');
        const depthStatus=el('small',{role:'status'});
        depth.onchange=()=>{
            const value=depth.valueAsNumber;
            if(!Number.isInteger(value)||value<0||value>10000){
                depth.value=settings.depth;
                depthStatus.textContent='Введите целое число от 0 до 10 000.';
                return;
            }
            depthStatus.textContent='';
            if(Number(settings.depth)===value)return;
            settings.depth=value;
            this.saveSettings();
        };
        const step=(sign,label,delta)=>{
            const control=button(sign,()=>{
                const value=Math.max(0,Math.min(10000,Number(settings.depth)+delta));
                if(!Number.isFinite(value))return;
                depth.value=String(value);
                depth.onchange();
            });
            control.setAttribute('aria-label',label);
            return control;
        };
        const depthControl=el('div',{class:'pv-placement-number'});
        depthControl.append(depth,step('−','Уменьшить глубину',-1),step('+','Увеличить глубину',1));
        const depthField=el('div');
        depthField.append(el('label',{for:'pv-placement-depth'},'Глубина'),depthControl);
        const role=el('select',{id:'pv-placement-role'});
        for(const [value,title] of [[0,'Система'],[1,'Пользователь'],[2,'Ассистент']])role.append(el('option',{value},title));
        role.value=settings.role;role.onchange=()=>{settings.role=Number(role.value);this.saveSettings();};
        const roleField=el('div');
        roleField.append(el('label',{for:'pv-placement-role'},'Роль сообщения'),role);
        const fields=el('div',{class:'pv-placement-fields'});
        fields.append(depthField,roleField);
        inChat.append(el('h4',{},'Параметры вставки в чат'),fields,depthHelp,depthStatus);
        update();
        section.append(el('p',{id:'pv-placement-label',class:'pv-placement-label'},'Куда вставлять память'),options,macro,automatic,inChat);
    }
    settingsView(archive) {
        const settings=this.e.settings();this.content.append(el('h3',{class:'pv-view-heading'},'Настройки'));
        const group=(title,target=this.content)=>{const section=el('fieldset',{class:'pv-setting-group'});section.append(el('legend',{},title));target.append(section);return section;};
        const basic=group('Основные настройки'),memory=el('div',{class:'pv-basic-options'}),messages=el('div',{class:'pv-basic-options'}),appearance=el('div',{class:'pv-basic-options'});messages.append(el('h4',{},'Создание глав'));appearance.append(el('h4',{},'Интерфейс'));basic.append(memory,messages,appearance);const placement=group('Подстановка памяти'),maintenance=el('details',{class:'pv-maintenance'});maintenance.append(el('summary',{},'Обслуживание'));this.content.append(maintenance);const archiveGroup=group('Резервные копии',maintenance);
        this.memoryPlacementView(placement,settings);
        const preview=el('input',{type:'checkbox',checked:settings.previewEpisodes,'aria-label':'Предпросмотр глав'});preview.onchange=()=>{settings.previewEpisodes=preview.checked;this.saveSettings();};const previewLabel=el('label');previewLabel.append(preview,document.createTextNode('Предпросмотр глав'));messages.append(previewLabel,el('p',{class:'pv-muted'},'Показывать готовую главу перед сохранением. Если выключено, успешный результат ручной генерации сохраняется сразу.'));
        for(const [key,title]of [['enabled','Включить расширение'],['inject','Внедрять активную память'],['exclude','Исключать обработанные сообщения после сохранения'],['collapse','Визуально сворачивать обработанные сообщения'],['showMessageLabels','Метки глав, частей и томов под сообщениями'],['pastNoteEnabled','Не акцентировать прошлые события без необходимости']]){
            const check=el('input',{type:'checkbox',checked:settings[key]});check.onchange=()=>{settings[key]=check.checked;this.saveSettings();this.refresh();};const l=el('label');l.append(check,document.createTextNode(title));(['enabled','inject'].includes(key)?memory:['exclude','collapse','showMessageLabels'].includes(key)?messages:appearance).append(l);
        }
        const limit=el('input',{type:'number',min:1,step:100,value:settings.tokenLimit});limit.onchange=()=>{if(Number.isFinite(Number(limit.value))&&Number(limit.value)>0){settings.tokenLimit=Math.floor(Number(limit.value));this.saveSettings();}else limit.value=settings.tokenLimit;};memory.append(field('Максимальный объём памяти, токенов',limit));
        const note=el('textarea',{class:'pv-short'},settings.pastNote);note.onchange=()=>{settings.pastNote=note.value;this.saveSettings();};appearance.append(field('Редактируемая пометка о прошлых событиях',note));
        const theme=el('select');theme.append(el('option',{value:'dark'},'Полуночный синий'),el('option',{value:'light'},'Светлый пергамент'));theme.value=settings.theme;theme.onchange=()=>{settings.theme=theme.value;this.panel.dataset.theme=theme.value;this.saveSettings();};appearance.append(field('Тема панели',theme));
        archiveGroup.append(el('p',{class:'pv-muted'},'Перед обновлением скачайте полную резервную копию памяти. Она включает архив, промпты и настройки.'));
        if(archive){const complete=el('section',{class:'pv-complete-backup'});complete.append(el('h4',{},'Резервная копия памяти'),el('p',{class:'pv-muted'},'Один JSON: все главы, части, тома, их связи, промпты и настройки. Копия восстанавливает память, а не удалённую переписку.'),row(iconButton('Экспортировать всё',()=>this.act(()=>this.exportFullBackup()),'fa-download',true),iconButton('Восстановить из копии',()=>this.readFullBackup(),'fa-upload')));archiveGroup.append(complete,el('p',{class:'pv-muted'},`Архив текущего чата: ${(bytes(archive)/1024).toFixed(1)} KiB. Резервная копия содержит личные тексты — храните её у себя.`));
        archiveGroup.append(row(button('Экспорт архива JSON',()=>fileTrace('backup-export',()=>download('pensieve-archive.json',JSON.stringify(exportArchive(this.e.archive()),null,2)))),button('Импорт архива JSON',()=>this.readFullBackup())));
        }else archiveGroup.append(el('p',{class:'pv-muted'},'Откройте сохранённый чат для экспорта, импорта и восстановления его архива. Общие настройки и промпты доступны без чата.'));
        archiveGroup.append(row(button('Экспорт промптов JSON',async()=>{if(await this.confirmPromptDrafts(Object.keys(LEVELS),'экспортом'))return fileTrace('prompt-export',()=>download('pensieve-prompts.json',JSON.stringify({format:'pensieve-prompts',version:1,prompts:settings.prompts},null,2)));}),button('Импорт промптов JSON',()=>this.act(async()=>{
            const f=await readFile('.json');if(!f)return;const data=JSON.parse(f.text);if(data.format!=='pensieve-prompts'||data.version!==1)throw Error('Неверный формат файла промптов.');
            const result=clone(settings.prompts);
            for(const type of ['summary','arc','volume']){const g=data.prompts?.[type];if(type==='volume'&&!g)continue;if(!g||!Array.isArray(g.presets)||!g.presets.length||g.presets.length>100)throw Error('Неверный список пресетов.');const ids=new Set();result[type].presets=g.presets.map(p=>{if(typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||typeof p.text!=='string')throw Error('Неверные поля пресета.');ids.add(p.id);return{id:p.id,name:p.name,text:p.text,history:Array.isArray(p.history)?p.history.filter(h=>typeof h==='string'):[]};});result[type].selected=ids.has(g.selected)?g.selected:result[type].presets[0].id;}
            if(await this.confirm('Импорт промптов','Добавить наборы пресетов из файла? Существующие варианты сохранятся; точные совпадения объединятся. Если промпта тома в старой копии нет, текущий промпт тома сохранится.')){settings.prompts=mergePromptGroups(settings.prompts,result);this.saveSettings();}
        },{code:'DATA-007',stage:'import',operation:'prompt-import'}))));
        if(!archive){this.diagnosticsView?.settings(maintenance);return;}
        const recovery=el('details',{class:'pv-recovery'});recovery.append(el('summary',{},'Восстановление'));archiveGroup.append(recovery);
        if(archive.pending?.type==='backup')recovery.append(el('p',{class:'pv-muted'},'Завершение повторно проверит целую копию и выбранные промпты/настройки. «Оставить копию в архиве без активности» сохранит её тексты, отключит все записи и вернёт выбранные общие разделы в состояние до восстановления. Прежний архив после подтверждённой замены это действие не возвращает.'));
        recovery.append(button('Посмотреть незавершённый результат',()=>this.act(async()=>{const session=this.e.session(),note=await this.e.pendingReceipt(session);if(!note){this.showNotice('Незавершённого результата нет.');return;}if(note.intent==='delete'){this.showNotice('Удаление главы ожидает проверки сервера. Используйте «Повторить сохранение / завершить».');return;}const entry=note.archive.entries.find(e=>e.id===note.entryId);this.textDialog('Незавершённый результат',entry.title+'\n\n'+entry.text);})));
        const retry=button('Повторить сохранение / завершить',()=>this.act(()=>this.e.recover('complete')));
        const cancel=button(archive.pending?.type==='backup'?'Оставить копию в архиве без активности':'Вернуть исходники незавершённой операции',()=>this.act(async()=>{
            const result=await this.e.recover('restore');
            if(result?.status==='canceled')this.showNotice(cancel.dataset.deletion==='true'?'Удаление отменено. Глава сохранена.':'Неподтверждённое изменение главы отменено.');
            else if(cancel.dataset.deletion==='true'&&result?.status==='saved')this.showNotice('Сервер уже подтвердил удаление главы.');
            else if(cancel.dataset.chapterEdit==='true'&&result?.status==='saved')this.showNotice('Сервер уже подтвердил сохранение главы.');
        }));
        recovery.append(row(retry,cancel));
        const session=this.e.optionalSession();
        if(session)this.e.pendingReceipt(session).then(note=>{
            if(!recovery.isConnected)return;
            if(note?.intent==='delete'){
                retry.textContent='Проверить и завершить удаление главы';
                cancel.textContent='Проверить и отменить удаление';
                cancel.dataset.deletion='true';
            }else if(this.e.isChapterEditReceipt(note)){
                retry.textContent='Проверить и завершить сохранение главы';
                cancel.textContent='Проверить и отменить изменение главы';
                cancel.dataset.chapterEdit='true';
            }
        }).catch(()=>{});
        this.diagnosticsView?.settings(maintenance);
    }
    chapterBackupButton(session){
        return button('Скачать резервную копию',()=>this.act(()=>this.exportFullBackup({session,includePromptDrafts:false})));
    }
    async exportFullBackup({session=this.e.session(),includePromptDrafts=true}={}) {
        if(includePromptDrafts&&!await this.confirmPromptDrafts(Object.keys(LEVELS),'экспортом копии'))return;this.e.assert(session);const file=createBackup(this.e.archive(session),this.e.settings(),{key:session.key,name:String(this.e.host.context().chatId)}),date=new Date(),stamp=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
        download(`Omut_Pamyati_${stamp}.json`,JSON.stringify(file,null,2));
    }
    async readFullBackup() {
        return this.act(async()=>{const session=this.e.session(),file=await readFile('.json,application/json');if(!file)return;this.e.assert(session);this.restoreBackupDialog(parseBackup(file.text),session);},{code:'DATA-007',stage:'import',operation:'backup-import'});
    }
    restoreBackupDialog(file,session) {
        this.e.assert(session);const {dialog,body}=this.makeDialog('Восстановление памяти',true);dialog.classList.add('pv-backup-dialog');
        this.backupDialog=dialog;dialog.pensieveMinimizeForError=()=>{dialog.pensieveRetained=true;if(dialog.open)dialog.close();const reopen=()=>{if(dialog.isConnected&&!dialog.open)dialog.showModal();};reopen.target=dialog;return reopen;};
        const counts=Object.entries(LEVELS).map(([type,level])=>`${level.plural}: ${file.archive.entries.filter(e=>e.type===type).length}`).join(' · '),preview=el('p',{class:'pv-muted'});
        body.append(el('h3',{},'Найдено: '+counts),preview,el('p',{class:'pv-muted'},'Копия не восстанавливает исходную переписку. Чужие диапазоны останутся историческими сведениями и не будут управлять сообщениями этого чата.'));
        const mode=el('select',{'aria-label':'Способ восстановления'});mode.append(el('option',{value:'merge'},'Объединить с существующими'),el('option',{value:'replace'},'Заменить архив из резервной копии'));body.append(field('Способ восстановления',mode));
        const check=(name,disabled=false)=>{const input=el('input',{type:'checkbox','aria-label':name});input.dataset.unavailable=String(disabled);input.disabled=disabled;const label=el('label');label.append(input,document.createTextNode(name));body.append(label);return input;};
        const active=check('Восстановить активные записи',!!file.source.hadPendingOperation),prompts=check('Восстановить промпты из копии',!file.prompts),settings=check('Восстановить общие настройки из копии',!file.settings);
        body.append(el('p',{class:'pv-muted'},'По умолчанию новые записи останутся в архиве. Активность проверяется по пересечениям и лимиту. Промпты и общие настройки используются и другими чатами — они изменятся только при выбранных флажках.'));
        if(file.source.hadPendingOperation)body.append(el('p',{class:'pv-warning'},'Копия сделана при незавершённой операции. Сначала восстановите её без активности.'));
        const replacement=el('div',{class:'pv-warning',hidden:'true'}),ack=el('input',{type:'checkbox','aria-label':'Подтверждаю замену текущего архива'}),ackLabel=el('label'),exportCurrent=button('Сохранить текущую копию',()=>this.act(()=>{this.e.assert(session);return this.exportFullBackup();}));ackLabel.append(ack,document.createTextNode('Подтверждаю замену текущего архива'));replacement.append(el('p',{},'Замена удалит текущие записи из архива этого чата. Сначала можно сохранить их отдельную копию.'),exportCurrent,ackLabel);body.append(replacement);
        const status=el('p',{role:'status'}),cancel=button('Отмена',()=>{if(!applying){dialog.pensieveRetained=false;dialog.close();}}),close=dialog.querySelector('.pv-header button');body.append(status);let applying=false,planError=false;
        const save=button('Восстановить память',async()=>{
            if(applying||planError||mode.value==='replace'&&!ack.checked)return;
            const options={mode:mode.value,activate:active.checked,restorePrompts:prompts.checked,restoreSettings:settings.checked};
            applying=true;update();status.textContent='Проверка и восстановление… Дождитесь завершения; окно можно закрыть после результата.';
            try{this.e.assert(session);const result=await this.e.restoreBackup(file,options,session);dialog.pensieveRetained=false;dialog.close();this.e.host.notify('success',`Память восстановлена. Новых записей: ${result.added}; уже существовали: ${result.skipped}.`);await this.refresh(true);}
            catch(error){status.textContent=this.issue(error,{code:'DATA-009',stage:'restore',operation:'backup-restore',severity:'error'});save.textContent='Повторить проверку и восстановить';}
            finally{applying=false;update();}
        },true);
        const update=()=>{
            replacement.hidden=mode.value!=='replace';save.disabled=applying||planError||mode.value==='replace'&&!ack.checked;
            for(const control of [mode,ack,cancel,close,exportCurrent])control.disabled=applying;
            for(const control of [active,prompts,settings])control.disabled=applying||control.dataset.unavailable==='true';
        };
        const planMode=()=>{
            try{const plan=planRestore(this.e.archive(session),file,{targetKey:session.key,mode:mode.value,uuid:()=>this.e.host.uuid(),chat:this.e.host.context().chat});preview.textContent=`Новых: ${plan.added} · Уже есть: ${plan.skipped} · Отличаются от текущих: ${plan.conflicts}. При объединении существующие тексты сохраняются.`;planError=false;}
            catch(error){preview.textContent=this.issue(error,{code:'DATA-009',stage:'restore',operation:'backup-restore'});planError=true;}
            update();
        };
        mode.onchange=planMode;ack.onchange=update;body.append(row(save,cancel));dialog.oncancel=event=>{if(applying)event.preventDefault();else dialog.pensieveRetained=false;};dialog.onclose=()=>{if(!dialog.open&&!dialog.pensieveRetained){dialog.remove();this.diagnosticsView?.forgetOperation(dialog);if(this.backupDialog===dialog)this.backupDialog=null;}};planMode();dialog.showModal();
    }
    makeDialog(title,chatScoped=false) {
        const dialog=el('dialog',{class:'pensieve pv-editor','data-theme':this.e.settings().theme});
        if(chatScoped)dialog.dataset.chatScoped='true';
        const head=el('header',{class:'pv-header'}),close=button('×',()=>{if(dialog.dispatchEvent(new Event('cancel',{cancelable:true})))dialog.close();});close.classList.add('pv-icon');close.setAttribute('aria-label','Закрыть окно');head.append(el('h2',{},title),close);dialog.setAttribute('aria-label',title);const body=el('div',{class:'pv-content'});dialog.append(head,body);document.body.append(dialog);return {dialog,body};
    }
    confirm(title,message,session=null,confirmLabel='Подтвердить',extraAction=null) {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog(title,!!session);body.append(el('p',{},message));if(extraAction)body.append(extraAction);body.append(row(button('Отмена',()=>dialog.close()),button(confirmLabel,()=>{dialog.returnValue='yes';dialog.close();},true)));dialog.onclose=()=>{const yes=dialog.returnValue==='yes';dialog.remove();resolve(yes);};dialog.showModal();});
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
        const session=this.e.session();if(!await this.confirmPromptDrafts([options.type??'summary'],'генерацией'))return null;this.e.assert(session);
        this.generationView??=new GenerationView(this.e,{
            makeDialog:(...args)=>this.makeDialog(...args),preview:draft=>{const done=this.preview(draft);return {done,dialog:this.editor};},
            onSaved:async draft=>{await this.episodeSaved(draft);this.postSaveRefresh();},
            onError:record=>{if(record)this.diagnosticsView?.show(record);},
            onMinimize:(explicit=true)=>{if(explicit&&this.panel?.open)this.minimize();if(this.restoreDock&&this.windowState==='minimized')this.restoreDock.hidden=true;},
            onClear:job=>{this.diagnosticsView?.forgetOperation(job);this.lastMinimizedOperation=!!job.windowHidden;this.syncOperationDock();},
        });
        return this.generationView.generate(fn,options);
    }
    preview(draft) {
        return new Promise(resolve=>{
        const replacement=draft.type==='summary'&&!!draft.replaceId;
        const heading=replacement?`Перегенерация главы №${draft.chapterNumber}`:draft.restoreNumber!=null?`Воссоздание главы №${draft.restoreNumber}`:`Предварительный просмотр ${LEVELS[draft.type].genitive}`;
        const {dialog,body}=this.makeDialog(heading,true);this.editor=dialog;
        if(replacement){
            const index=hierarchyIndex(this.e.archive(draft.session).entries),entry=index.byId.get(draft.replaceId);
            if(entry&&index.ancestors(entry).length)body.append(el('p',{class:'pv-warning'},'Связанные части и тома получат отметку «Требует проверки». Их тексты останутся прежними.'));
        }
        if(draft.ambiguousChapterSlot)body.append(el('p',{class:'pv-warning'},`Порядок относительно других глав неоднозначен. Сохранение подтвердит прежний номер ${draft.restoreNumber}.`));
        const title=el('input',{value:draft.title,'aria-label':'Название воспоминания'}),text=el('textarea',{'aria-label':'Текст воспоминания'},draft.text);
        body.append(field('Название',title),field('Текст — можно отредактировать перед сохранением',text));
        const warning=el('p',{class:'pv-warning',role:'status'});
        const updateWarning=()=>{warning.textContent=[draft.interrupted?'Генерация прервана. Полученный текст может быть неполным.':draft.truncated?'Ответ модели был обрезан. Проверьте текст перед сохранением.':'',draft.reasoningAmbiguous?'В ответе есть неоднозначная разметка рассуждений. Проверьте её и при необходимости отредактируйте текст.':''].filter(Boolean).join(' ');warning.hidden=!warning.textContent;};
        updateWarning();body.prepend(warning);
        const notice=el('p',{role:'status'});body.append(notice);let saving=false,finished=false;
        const owned=()=>this.generationView?.job?.draft===draft?this.generationView.job:null;const previewJob=owned();if(previewJob)previewJob.previewStatus=notice;
        const finish=()=>{if(finished)return;finished=true;dialog.remove();if(this.editor===dialog)this.editor=null;resolve(dialog.savedEntry??null);};
        const minimize=button('−',()=>{const job=owned();if(job)this.generationView.minimize(job);});minimize.className='pv-icon';minimize.setAttribute('aria-label','Свернуть окно воспоминания');dialog.querySelector('.pv-header button').before(minimize);
        const save=button(replacement?'Заменить сводку':draft.restoreNumber!=null?`Сохранить главу №${draft.restoreNumber}`:'Сохранить',async()=>{
            if(saving)return;
            saving=true;save.disabled=true;regen.disabled=true;const job=owned();if(job){job.previewError='';job.previewSaving=true;this.generationView.paint(job);}
            try{const saved=await this.e.saveDraft(draft,{title:title.value,text:text.value});await this.episodeSaved(draft);dialog.savedEntry=saved;if(dialog.open)dialog.close();else finish();this.postSaveRefresh();this.showNotice('Воспоминание сохранено.');}
            catch(error){notice.textContent=this.issue(error,{severity:'error'});if(job)job.previewError=notice.textContent;}
            finally{saving=false;save.disabled=false;if(draft.commitId&&!finished)save.textContent='Повторить проверку сохранения';regen.disabled=!!draft.commitId;if(job){job.previewSaving=false;this.generationView.paint(job);}}
        },true);
        const regen=button('Повторить генерацию',async()=>{save.disabled=true;regen.disabled=true;try{if(await this.confirmPromptDrafts([draft.type],'повторной генерацией')){await this.e.regenerate(draft);text.value=draft.text;updateWarning();}}catch(error){notice.textContent=this.issue(error,{severity:'error'});}finally{save.disabled=false;regen.disabled=false;}});
        const actions=row(save,regen,button('Скопировать',()=>this.act(()=>copy(text.value))),button('Отменить генерацию',()=>{if(!saving)this.e.cancel();}),button('Отмена',()=>{if(saving){minimize.click();return;}if(this.e.busy)this.e.cancel();dialog.close();}));
        if(replacement||draft.restoreNumber!=null)actions.append(this.chapterBackupButton(draft.session));
        body.append(actions);
        dialog.oncancel=event=>{if(saving){event.preventDefault();minimize.click();}else if(this.e.busy)this.e.cancel();};dialog.onclose=()=>{if(dialog.pensieveMinimizeClosures){dialog.pensieveMinimizeClosures--;return;}finish();};dialog.showModal();
        });
    }
    openRecordPage(title,key,render){
        const session=this.e.session();
        let viewer=this.recordViewer;
        if(!viewer?.dialog.open){
            const {dialog,body}=this.makeDialog(title,true);
            viewer={dialog,body,session,pages:[],frames:new Map()};this.recordViewer=viewer;
            dialog.onclose=()=>{dialog.remove();if(this.recordViewer===viewer)this.recordViewer=null;};
            dialog.showModal();
        }
        this.e.assert(viewer.session);
        const current=viewer.pages.at(-1);
        if(current?.key===key)return viewer;
        if(current)current.scroll=viewer.body.scrollTop;
        let frame=viewer.frames.get(key),previous=viewer.pages.indexOf(frame);
        if(previous>=0)viewer.pages.length=previous+1;
        else{
            if(!frame){const content=el('div',{class:'pv-record-page'});frame={key,title,content,scroll:0};viewer.frames.set(key,frame);render(viewer.dialog,content);}
            viewer.pages.push(frame);
        }
        this.paintRecordPage(viewer);
        return viewer;
    }
    paintRecordPage(viewer){
        const page=viewer.pages.at(-1);
        viewer.dialog.querySelector('.pv-header h2').textContent=page.title;
        viewer.dialog.setAttribute('aria-label',page.title);
        viewer.body.replaceChildren();
        if(viewer.pages.length>1)viewer.body.append(button('← Назад',()=>{page.scroll=viewer.body.scrollTop;viewer.pages.pop();this.paintRecordPage(viewer);}));
        viewer.body.append(page.content);viewer.body.scrollTop=page.scroll;
    }
    editEntry(entry,editable) {
        const session=this.e.session(),archive=this.e.archive(session);
        return this.openRecordPage(editable?'Редактирование воспоминания':entryDisplayTitle(entry,archive.entries),`entry:${entry.id}:${editable}`,(dialog,body)=>{
        const title=el('input',{value:entry.title,'aria-label':'Название записи'}),text=el('textarea',{'aria-label':'Текст записи'},entry.text);title.readOnly=text.readOnly=!editable;
        body.append(field('Название',title),field('Текст',text));
        const range=this.sourceRanges?.get(entry.id),details=el('div',{class:'pv-record-info'}),state=this.viewState?.byId.get(entry.id);
        const info=el('p',{class:'pv-muted'},`${range?`${range.historical?'Исторические сообщения':'Сообщения'} ${range.start+1}–${range.end+1}`:'Порядок источников требует проверки'} · Версия ${entry.version}`);details.append(info);
        if(hasDetachedSources(entry))details.append(el('p',{class:'pv-muted'},'Исторический диапазон из резервной копии. Исходники не привязаны к текущему чату.'));
        this.e.host.count(entry.text).then(n=>info.append(document.createTextNode(` · ≈${n} токенов`))).catch(()=>{});
        if(state)details.append(el('p',{class:'pv-status-note'},[state.label,state.note].filter(Boolean).join(' · ')));body.prepend(details);
        if(entry.type==='summary')body.append(button('Перегенерировать главу',()=>this.act(()=>this.regenerateEntry(entry))));
        if(entry.type!=='summary')body.append(button('Показать содержимое',()=>{this.e.assert(session);this.showContents(entry);}));
        for(const parent of state?.ancestors??[])body.append(button(relationLabel(parent,archive.entries),()=>{this.e.assert(session);this.editEntry(parent,false);}));
        const status=el('p',{role:'status'});body.append(status);
        if(editable)body.append(button('Сохранить изменения',async()=>{try{this.e.assert(session);await this.e.edit(entry.id,{title:title.value,text:text.value});dialog.close();await this.refresh(true);}catch(error){status.textContent=this.issue(error,{severity:'error'});}},true));
        if(entry.history.length) {
            const versions=el('select',{'aria-label':'Предыдущая версия'});entry.history.forEach((h,i)=>versions.append(el('option',{value:i},`Версия ${h.version} — ${h.title}`)));
            const historyActions=row(button('Посмотреть версию',()=>{const h=entry.history[Number(versions.value)];this.openRecordPage(`Версия ${h.version}`,`history:${entry.id}:${h.version}`,(historyDialog,historyBody)=>historyBody.append(el('pre',{},h.text),button('Скопировать',()=>copy(h.text)),button('Закрыть',()=>historyDialog.close())));}));
            if(editable)historyActions.append(button('Восстановить версию',async()=>{if(!await this.confirm('Восстановление версии','Сохранить выбранную предыдущую версию как новую редакцию?',session))return;const h=entry.history[Number(versions.value)];try{this.e.assert(session);await this.e.edit(entry.id,{title:h.title,text:h.text});dialog.close();await this.refresh(true);}catch(error){status.textContent=this.issue(error,{severity:'error'});}}));
            body.append(field('Предыдущие версии',versions),historyActions);
        }
        if(editable&&entry.needsReview)body.append(button('Проверено — снять отметку',()=>this.act(async()=>{this.e.assert(session);await this.e.change(a=>a.entries.find(e=>e.id===entry.id).needsReview=false);dialog.close();})));
        body.append(row(button('Скопировать',()=>this.act(()=>copy(text.value))),button('Закрыть',()=>dialog.close())));});
    }
    showContents(entry) {
        const session=this.e.session(),archive=this.e.archive(session),index=hierarchyIndex(archive.entries),current=index.byId.get(entry.id);
        if(!current)return;
        return this.openRecordPage(`Содержимое: ${entryDisplayTitle(current,archive.entries)}`,`contents:${current.id}`,(dialog,body)=>{
        body.append(el('p',{class:'pv-muted'},'Исходные записи остаются в архиве. Открытие не меняет их активность или текст.'));
        for(const id of childrenIds(current)){
            const child=index.byId.get(id),line=el('article',{class:'pv-source-item','data-source-id':id});
            if(!child){line.append(el('p',{class:'pv-warning'},'Исходная запись недоступна. Сохранённый текст родительской записи не изменён.'));body.append(line);continue;}
            const range=this.sourceRanges?.get(id);line.append(el('strong',{},entryDisplayTitle(child,archive.entries)));
            if(range)line.append(el('small',{},`${range.historical?'Исторические сообщения':'Сообщения'} ${range.start+1}–${range.end+1}`));
            line.append(button('Открыть',()=>{this.e.assert(session);this.editEntry(child,false);}));body.append(line);
        }
        body.append(button('Закрыть',()=>dialog.close()));});
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
            if(label&&settings.enabled&&settings.showMessageLabels!==false){if(!badge){badge=el('div',{class:'pv-message-status'});(node.querySelector('.mes_block')??node).append(badge);}
                if(badge.dataset.label!==label){badge.dataset.label=label;badge.replaceChildren(el('span',{class:'pv-source-mark','aria-hidden':'true'},'◈'),el('span',{class:'pv-source-label'},label));}
            }else badge?.remove();
            node.classList.toggle('pensieve-collapsed',!!(label&&settings.enabled&&settings.collapse&&m.is_system));
        }
    }
}

for(const [name,meta]of Object.entries({readFullBackup:{code:'DATA-007',stage:'import',operation:'backup-import'},exportFullBackup:{code:'DATA-008',stage:'export',operation:'backup-export'}})){const original=UI.prototype[name];UI.prototype[name]=function(...args){return trace(meta,()=>original.apply(this,args));};}
