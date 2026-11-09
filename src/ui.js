import {KEY,defaults,clone,bytes,WARN_ARCHIVE_BYTES,exportArchive,parseArchive,chronological,captureRange,findOverlaps,inspectSources,fingerprint} from './core.js';
import {memoryViewState,filterArchive,entryDisplayTitle} from './view-state.js';

export const UI_VERSION='1.3.0';

const el=(tag,attrs={},text='')=>{const node=document.createElement(tag);for(const [k,v]of Object.entries(attrs))if(k==='class')node.className=v;else if(k==='checked')node.checked=v;else node.setAttribute(k,String(v));if(text)node.textContent=text;return node;};
const button=(text,fn,primary=false)=>{const b=el('button',{type:'button',class:primary?'pv-primary':''},text);b.addEventListener('click',fn);return b;};
const iconButton=(text,fn,glyph,primary=false)=>{const b=button('',fn,primary);b.append(el('i',{class:'fa-solid '+glyph,'aria-hidden':'true'}),el('span',{},text));return b;};
const row=(...nodes)=>{const r=el('div',{class:'pv-row'});r.append(...nodes);return r;};
const field=(title,node)=>{const l=el('label',{},title);l.append(node);return l;};
const download=(name,text,type='application/json')=>{const url=URL.createObjectURL(new Blob([text],{type}));const a=el('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const readFile=accept=>new Promise(resolve=>{const input=el('input',{type:'file',accept});input.onchange=async()=>resolve(input.files?.[0]?{name:input.files[0].name,text:await input.files[0].text()}:null);input.oncancel=()=>resolve(null);input.click();});
async function copy(text){try{await navigator.clipboard.writeText(text);}catch{const t=el('textarea',{},text);document.body.append(t);t.select();const success=document.execCommand('copy');t.remove();if(!success)throw Error('Браузер запретил копирование. Выделите текст и скопируйте вручную.');}}

export class UI {
    constructor(engine) {this.e=engine;this.tab='memory';this.archiveTab='summary';this.archiveFilter='all';this.archiveSearch='';this.arcOrderManual=false;this.promptTab='summary';this.start=null;this.end=null;this.rangeEdges={start:null,end:null};this.rangeChatKey=null;this.rangeCache=new Map();this.chosen=[];this.expanded=new Set();this.editor=null;this.timer=null;this.renderId=0;}
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
        const tabIcons={home:'fa-house',archive:'fa-box-archive',memory:'fa-brain',prompts:'fa-feather',settings:'fa-gear'};
        this.panel.querySelectorAll('[data-tab]').forEach(b=>{const label=b.textContent.trim();b.replaceChildren(el('i',{class:'fa-solid '+tabIcons[b.dataset.tab],'aria-hidden':'true'}),el('span',{},label));});
        this.panel.querySelector('[data-action="close"]').onclick=()=>this.panel.close();
        // Keep ST's document-wide drawer handlers out of this native modal's click path.
        this.panel.addEventListener('click',event=>event.stopPropagation());
        this.panel.addEventListener('close',()=>{
            const target=this.returnFocus;
            if(target?.isConnected&&target.getClientRects().length)target.focus({preventScroll:true});
            else document.querySelector('#send_textarea')?.focus({preventScroll:true});
        });
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>this.go(b.dataset.tab));
        await this.mountSettingsDrawer();
        // ST creates the wand menu after loading third-party extensions.
        const mountMenu=()=>{const menu=document.querySelector('#extensionsMenu');if(!menu||document.getElementById('pensieve-menu-open'))return;const b=button('Омут памяти',event=>{this.returnFocus=event.currentTarget;this.open();});b.id='pensieve-menu-open';b.classList.add('list-group-item');menu.append(b);};mountMenu();
        document.addEventListener('click',event=>{
            const action=event.target.closest('[data-pensieve-edge]');if(!action)return;
            const id=Number(action.closest('.mes')?.getAttribute('mesid'));if(!Number.isInteger(id))return;
            const edge=action.dataset.pensieveEdge;
            this.rangeWarning=null;
            this.setRangeEdge(edge,id);this.decorateMessages();
            this.e.host.notify('success',`${edge==='start'?'Начало':'Конец'} сводки: сообщение №${id+1}.`);
            if(this.panel.open&&this.tab==='home')this.render();
        });
        const c=this.e.host.context();
        if(c.eventTypes.APP_READY)c.eventSource.on(c.eventTypes.APP_READY,mountMenu);
        c.eventSource.on(c.eventTypes.CHAT_CHANGED,()=>{
            this.e.host.inject('');if(this.e.busy)this.e.cancel();
            this.loadRange();this.chosen=[];this.arcOrderManual=false;this.archiveSearch='';this.expanded.clear();
            if(this.editor){this.editor.close();this.editor.remove();this.editor=null;}
            this.schedule(true);
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
    async mountSettingsDrawer() {
        const {toggleDrawer}=await import('/scripts/utils.js');
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
            ['pensieve-settings-summary','Создать сводку','fa-scroll',()=>this.open('home')],
            ['pensieve-settings-arc','Создать арку','fa-book-open',()=>{this.archiveTab='summary';this.open('archive');}],
            ['pensieve-open','Архив воспоминаний','fa-book-bookmark',()=>this.open('archive')],
            ['pensieve-settings-memory','Активная память','fa-eye',()=>this.open('memory')],
            ['pensieve-settings-prompts','Промпты','fa-feather',()=>this.open('prompts')],
            ['pensieve-settings-options','Настройки','fa-gear',()=>this.open('settings')],
        ];
        for(const [id,label,glyph,action]of items) {
            const control=button('',event=>{
                event.stopPropagation();this.returnFocus=event.currentTarget;action();
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
    open(tab=this.tab) {if(!this.panel.open)this.panel.showModal();this.go(tab);}
    go(tab) {this.tab=tab;this.showNotice('');this.render().catch(error=>this.showNotice(error.message));}
    async refresh(render=false) {
        const tab=this.tab;
        this.panel.dataset.theme=this.e.settings().theme;
        const memory=await this.e.refreshMemory();this.lastMemory=memory;this.decorateMessages();
        if(memory.blocked&&tab!=='memory'){this.memoryNotice=memory.reason;this.showNotice(memory.reason);}
        else if(this.panel.querySelector('.pv-notice').textContent===this.memoryNotice){this.showNotice('');this.memoryNotice=null;}
        if(render&&this.panel.open&&this.tab===tab)await this.render(memory);
    }
    async render(snapshot=null) {
        const stamp=++this.renderId;this.panel.dataset.theme=this.e.settings().theme;
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===this.tab?'page':'false'));
        this.content.replaceChildren(el('p',{class:'pv-muted'},'Загрузка архива…'));
        let session;try{session=this.e.session();}catch{
            this.lastMemory=null;this.viewState=null;this.sourceRanges=null;
            this.panel.querySelector('.pv-chat-name').textContent='Общие настройки · чат не открыт';this.content.replaceChildren();
            if(this.tab==='prompts')this.promptsView();
            else if(this.tab==='settings')this.settingsView(null);
            else this.content.append(el('p',{class:'pv-empty'},'Откройте сохранённый чат, чтобы работать с его памятью.'),row(button('Промпты',()=>this.go('prompts')),button('Общие настройки',()=>this.go('settings'))));
            return;
        }
        const memory=snapshot??await this.e.refreshMemory();if(stamp!==this.renderId)return;this.e.assert(session);
        const archive=this.e.archive(session);this.lastMemory=memory;this.viewState=memoryViewState(archive.entries,memory,this.chosen);this.sourceRanges=this.e.orderEntries(archive.entries).ranges;
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
    }
    home(archive) {
        const home=el('section',{class:'pv-home'}),actions=el('div',{class:'pv-home-actions'});
        const summary=button('Создать сводку',()=>{this.content.querySelector('[name="rangeStart"]')?.focus();});summary.prepend(el('i',{class:'fa-solid fa-scroll','aria-hidden':'true'}));
        const arc=button('Создать арку',()=>{this.archiveTab='summary';this.go('archive');});arc.prepend(el('i',{class:'fa-solid fa-book-open','aria-hidden':'true'}));actions.append(summary,arc);
        const settings=this.e.settings(),memory=this.lastMemory;
        const stats=el('div',{class:'pv-home-stats'},`Сводок: ${archive.entries.filter(e=>e.type==='summary').length} · Арок: ${archive.entries.filter(e=>e.type==='arc').length} · ≈${memory?.tokens??0} токенов`);
        const form=el('section',{class:'pv-summary-form','aria-labelledby':'pv-summary-heading'}),heading=el('div',{class:'pv-section-heading'});
        heading.append(el('h3',{id:'pv-summary-heading'},'Новая сводка'),el('small',{},`Память: ${settings.enabled&&settings.inject?(memory?.blocked?'требует внимания':'включена'):'выключена'}`));
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
                if(overlaps.length){const label=entryDisplayTitle(overlaps[0],archive.entries).match(/^Сводка\s*№\s*\d+/i)[0].replace(/^Сводка/i,'сводке');preview.append(el('p',{class:'pv-overlap-note',title:overlaps.map(e=>e.title).join('; ')},`Уже сохранено в ${label}${overlaps.length>1?` и ещё ${overlaps.length-1}`:''}`));}
            }catch{preview.append(el('span',{class:'pv-muted'},'Укажите начало и конец прямого диапазона.'));}
            const previous=options.value;options.querySelectorAll('[data-replace]').forEach(n=>n.remove());
            for(const e of overlaps)options.append(el('option',{value:e.id,'data-replace':'true'},`Заменить: ${e.title}`));if([...options.options].some(o=>o.value===previous))options.value=previous;
            options.hidden=!overlaps.length;this.decorateMessages();
        };
        start.oninput=end.oninput=()=>{this.rangeWarning=null;update();};update();form.append(options);
        form.append(row(button('Создать сводку',()=>this.act(async()=>{
            if(this.start===null||this.end===null)throw Error('Сначала выберите обе границы.');
            if(overlaps.length&&options.value!=='block'&&!await this.confirm('Повторная обработка','Этот диапазон уже представлен в архиве. Продолжить выбранным способом?'))return;
            await this.generating(()=>this.e.generateSummary(this.start,this.end,{allowOverlap:options.value!=='block',replaceId:['block','version'].includes(options.value)?null:options.value}));
        }),true),button('Сбросить диапазон',()=>{this.clearRange();this.decorateMessages();this.render();})));
        form.append(el('p',{class:'pv-muted'},'После генерации проверьте и сохраните текст. Только затем исходные сообщения будут исключены из контекста.'));
    }
    archiveView(archive) {
        this.content.append(row(button('Сводки',()=>{this.archiveTab='summary';this.render();},this.archiveTab==='summary'),button('Арки',()=>{this.archiveTab='arc';this.render();},this.archiveTab==='arc')));
        const tools=el('div',{class:'pv-archive-tools'}),search=el('input',{type:'search',value:this.archiveSearch,'aria-label':'Поиск воспоминаний',placeholder:'Название или текст…'});
        const filter=el('select',{'aria-label':'Фильтр архива'});for(const [value,title]of [['all','Все'],['active','Активные'],['inactive','Неактивные']])filter.append(el('option',{value},title));filter.value=this.archiveFilter;
        const results=el('div',{class:'pv-archive-results','aria-live':'polite'});
        const update=()=>{if(results.isConnected)this.archiveResults(archive,results);};
        search.oninput=()=>{this.archiveSearch=search.value;clearTimeout(this.searchTimer);this.searchTimer=setTimeout(update,150);};
        filter.onchange=()=>{this.archiveFilter=filter.value;update();};
        tools.append(field('Поиск',search),field('Показывать записи',filter));
        const help=el('details',{class:'pv-archive-help'});help.append(el('summary',{},'Об активности записей'),el('p',{class:'pv-muted'},'Активные — записи в фактически сформированном блоке памяти. Сохранение в архиве само по себе не включает внедрение.'));
        this.content.append(tools,help);
        if(this.archiveTab==='summary') {
            this.chosen=this.chosen.filter(id=>archive.entries.some(e=>e.id===id&&e.type==='summary'));
            if(!this.chosen.length){this.arcOrderManual=false;this.content.append(el('p',{class:'pv-muted pv-archive-hint'},'Отметьте сводки флажками, чтобы создать арку.'));}
            else {
                const selected=this.chosen.map(id=>archive.entries.find(e=>e.id===id)),ordered=this.e.orderEntries(selected);
                if(!this.arcOrderManual)this.chosen=ordered.entries.map(e=>e.id);
                const chosen=el('div',{class:'pv-arc-selection'});chosen.append(el('strong',{},`Для арки выбрано: ${this.chosen.length}`),el('small',{},this.arcOrderManual?'Ручной порядок. Модель получит сводки в показанной последовательности.':'Порядок по исходным сообщениям. Стрелками можно изменить его вручную.'));
                this.chosen.forEach((id,i)=>{
                    const e=archive.entries.find(x=>x.id===id);
                    const up=button('↑',()=>{this.arcOrderManual=true;[this.chosen[i-1],this.chosen[i]]=[id,this.chosen[i-1]];this.render();});up.setAttribute('aria-label','Поднять');up.disabled=i===0;
                    const down=button('↓',()=>{this.arcOrderManual=true;[this.chosen[i+1],this.chosen[i]]=[id,this.chosen[i+1]];this.render();});down.setAttribute('aria-label','Опустить');down.disabled=i===this.chosen.length-1;
                    const line=row(el('span',{},`${i+1}. ${entryDisplayTitle(e,archive.entries)}`),up,down);line.dataset.selectedId=id;chosen.append(line);
                });
                for(const warning of ordered.warnings)chosen.append(el('p',{class:'pv-warning'},warning));
                const linked=archive.entries.filter(e=>e.type==='arc'&&e.summaryIds.some(id=>this.chosen.includes(id)));
                if(linked.length)chosen.append(el('p',{class:'pv-warning'},`Уже входят в арки: ${linked.map(e=>e.title).join('; ')}. Проверьте состав перед созданием новой арки.`));
                const generate=button('Создать арку',()=>this.act(()=>this.generating(()=>this.e.generateArc([...this.chosen]))),true);generate.disabled=this.chosen.length<2;
                chosen.append(row(generate,button('По исходным сообщениям',()=>{this.arcOrderManual=false;this.render();}),button('Снять выбор',()=>{this.chosen=[];this.arcOrderManual=false;this.render();})));
                this.content.append(chosen);
            }
        }
        this.content.append(results);this.archiveResults(archive,results);
    }
    archiveResults(archive,results) {
        const ordered=this.e.orderEntries(chronological(archive.entries.filter(e=>e.type===this.archiveTab)));
        const entries=filterArchive(ordered.entries,this.viewState,this.archiveFilter,this.archiveSearch);
        results.replaceChildren(el('small',{},`Найдено: ${entries.length}`));
        for(const warning of ordered.warnings)results.append(el('p',{class:'pv-warning'},warning));
        if(!entries.length)results.append(el('p',{class:'pv-empty'},archive.entries.length?'Нет записей, подходящих под поиск и фильтр.':'Здесь появятся подтверждённые воспоминания.'));
        for(const e of entries)results.append(this.entryCard(e,archive));
    }
    entryCard(e,archive,activeView=false) {
        const state=this.viewState.byId.get(e.id),card=el('article',{class:'pv-record pv-entry-card','data-entry-id':e.id,'data-memory-state':state.kind}),main=el('div',{class:'pv-entry-main'}),top=el('div',{class:'pv-record-top'});
        const heading=el('div',{class:'pv-entry-title'});
        if(!activeView&&e.type==='summary') {
            const check=el('input',{type:'checkbox',checked:this.chosen.includes(e.id),'aria-label':`Выбрать для арки: ${e.title}`});
            check.onchange=()=>{if(check.checked&&!this.chosen.includes(e.id))this.chosen.push(e.id);else if(!check.checked)this.chosen=this.chosen.filter(id=>id!==e.id);this.render();};const hit=el('label',{class:'pv-record-select'});hit.append(check);top.append(hit);
        }
        const display=entryDisplayTitle(e,archive.entries),number=display.match(/^(?:Сводка|Арка)\s*№\s*\d+/i)?.[0]??display,subtitle=display.slice(number.length).replace(/^\s*[—–\-:·]?\s*/,'');
        const mark=el('div',{class:'pv-record-mark','aria-hidden':'true'});mark.append(el('i',{class:e.type==='arc'?'fa-solid fa-layer-group':'fa-solid fa-book-open'}));
        heading.append(el('h4',{},number),el('span',{class:`pv-memory-status pv-memory-${state.kind}`},state.label));main.append(heading);if(subtitle)main.append(el('p',{class:'pv-record-subtitle'},subtitle));top.append(mark,main);card.append(top);
        if(this.chosen.includes(e.id)&&e.type==='summary')heading.append(el('span',{class:'pv-selection-status'},'Выбрана для арки'));
        const range=this.sourceRanges?.get(e.id),location=range?`Сообщения ${range.start+1}–${range.end+1}`:'Порядок источников требует проверки';
        const status=e.type==='summary'?`${location} · ${e.sources.length} шт.`:`${location} · Сводок: ${e.summaryIds.length}`;
        const metadata=el('small',{class:'pv-entry-meta'},`${status} · Версия ${e.version} · Подсчёт токенов…`);main.append(metadata);
        this.e.host.count(e.text).then(n=>metadata.textContent=`${status} · Версия ${e.version} · ≈${n} токенов`).catch(()=>metadata.textContent=`${status} · Версия ${e.version} · Не удалось посчитать токены`);
        if(state.gate==='blocked')heading.append(el('span',{class:'pv-gate-status'},this.lastMemory.limitExceeded?'Не помещается в лимит':'Не внедряется: блокировка'));
        const details=el('details',{class:'pv-entry-more'}),more=el('summary',{},'Дополнительные действия');details.append(more);
        if(state.note)main.append(el('p',{class:'pv-status-note'},state.note));
        if(e.type==='summary') {
            const inspected=inspectSources(this.e.host.context().chat,e.sources);
            if(inspected.issues.length){heading.append(el('small',{class:'pv-gate-status'},`Требуют проверки источники: ${inspected.issues.length}`));details.append(el('p',{class:'pv-warning'},`Источники изменены, удалены или недоступны: ${inspected.issues.length}. Память требует проверки.`));}
            else if(inspected.matches.some(x=>x.moved))details.append(el('p',{class:'pv-muted'},'Номера сообщений изменились; источники найдены по постоянным ID.'));
        }
        if(e.needsReview){heading.append(el('span',{class:'pv-gate-status'},'Требует проверки'));details.append(el('p',{class:'pv-status-note'},'Требует проверки: исходная сводка или сообщение изменились.'));}
        const toggle=button(e.active?'Убрать из памяти':'Добавить в память',()=>this.act(()=>this.e.toggle(e.id,!e.active)),!e.active&&!state.covering.length);toggle.disabled=!e.active&&state.covering.length>0;
        const actions=row(button('Открыть',()=>this.editEntry(e,false)),button('Изменить',()=>this.editEntry(e,true)),toggle);actions.classList.add('pv-entry-actions');card.append(actions);
        details.append(row(button('Скопировать',()=>this.act(()=>copy(e.text))),button('Экспорт .txt',()=>download(`${e.type}-${e.id}.txt`,`${e.title}\n\n${e.text}`,'text/plain')),button('Перегенерировать',()=>this.act(()=>this.regenerateEntry(e))),button('Удалить',()=>this.act(async()=>{
            if(!await this.confirm('Удаление записи',`Удалить «${e.title}»? История чата останется. Для исходников сводки сначала используйте восстановление.`))return;
            const restore=e.type==='arc'?await this.confirm('Связанные сводки','Вернуть исходные сводки арки в активную память?'):false;
            await this.e.deleteEntry(e.id,restore);
        }))));
        if(e.type==='summary')details.append(button('Восстановить исходные сообщения',()=>this.act(async()=>{
            if(!await this.confirm('Восстановление','Вернуть в контекст исходники, исключённые этой сводкой, и деактивировать сводку? Ранее скрытые сообщения останутся скрытыми.'))return;
            const r=await this.e.restore(e.id);if(r.issues.length)this.showNotice(`Восстановление выполнено частично: ${r.issues.length} источников изменены или недоступны. Их состояние сохранено.`);
        })));
        card.append(details);return card;
    }
    async regenerateEntry(e) {
        if(e.type==='arc')return this.generating(()=>this.e.generateArc(e.summaryIds,{replaceId:e.id}));
        const inspected=inspectSources(this.e.host.context().chat,e.sources);
        if(inspected.issues.length)throw Error('Исходные сообщения изменены или удалены. Выберите новый диапазон вручную.');
        const indices=inspected.matches.map(x=>x.index).sort((a,b)=>a-b);
        if(indices.at(-1)-indices[0]+1!==indices.length)throw Error('Исходники больше не образуют непрерывный диапазон. Выберите новый диапазон вручную.');
        return this.generating(()=>this.e.generateSummary(indices[0],indices.at(-1),{allowOverlap:true,replaceId:e.id}));
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
        overview.append(head,meter,el('p',{class:'pv-memory-caption'},connected?'В модель попадут только записи из блока ниже.':`Выбрано ≈${Number.isFinite(memory.tokens)?memory.tokens.toLocaleString('ru-RU'):'—'} токенов. Сейчас блок не отправляется.`));this.content.append(overview);
        if(!memory.enabled)this.content.append(el('p',{class:'pv-warning'},'Внедрение памяти глобально отключено. Сохранённые записи сейчас не передаются модели.'));
        if(memory.blocked)this.content.append(el('p',{class:'pv-warning'},memory.reason));
        for(const warning of memory.orderWarnings??[])this.content.append(el('p',{class:'pv-warning'},warning));
        const quick=row(iconButton('Посмотреть память',()=>this.textDialog('Итоговый блок памяти',state.actualText||'Память сейчас не внедряется.'),'fa-eye'),iconButton('Скопировать память',()=>this.act(()=>copy(state.actualText)),'fa-copy'),iconButton('Обновить',()=>this.act(()=>this.e.refreshMemory()),'fa-rotate'),iconButton(memory.enabled?'Отключить всю память':'Включить память',()=>this.setMemoryEnabled(!memory.enabled),'fa-power-off',!memory.enabled));quick.classList.add('pv-memory-quick');this.content.append(quick);
        const limit=el('input',{type:'number',min:1,step:100,value:this.e.settings().tokenLimit,'aria-label':'Лимит памяти, токенов'});limit.onchange=()=>{const value=Number(limit.value);if(!Number.isFinite(value)||value<1){limit.value=this.e.settings().tokenLimit;return;}this.e.settings().tokenLimit=Math.floor(value);this.saveSettings();this.act(()=>this.e.refreshMemory());};const limitField=field('Лимит памяти, токенов',limit);limitField.classList.add('pv-memory-limit');this.content.append(limitField);
        const previews=el('div',{class:'pv-memory-previews'}),details=el('details'),summary=el('summary',{},'Итоговый блок памяти целиком');details.append(summary,el('pre',{},state.actualText||'Память сейчас не внедряется.'));previews.append(details);
        if(state.candidateText&&state.candidateText!==state.actualText){const draft=el('details');draft.append(el('summary',{},'Выбранные записи — предварительный просмотр'),el('p',{class:'pv-muted'},'Этот текст сохранён и выбран, но сейчас не внедряется в запрос.'),el('pre',{},state.candidateText),button('Скопировать выбранные записи',()=>this.act(()=>copy(state.candidateText))));previews.append(draft);}
        if(!archive.entries.length)this.content.append(el('p',{class:'pv-empty'},'Сначала создайте сводку.'));
        for(const [name,title,entries]of [['current','Сейчас в памяти модели',state.current],['archive','Только в архиве',this.e.orderEntries(chronological(state.archived)).entries]]){
            const section=el('section',{'data-memory-section':name,class:'pv-memory-section'}),titleRow=el('div',{class:'pv-memory-section-heading'});titleRow.append(el('h3',{},title),el('span',{class:'pv-record-count','aria-label':'Записей: '+entries.length},String(entries.length)));
            section.append(titleRow,el('p',{class:'pv-memory-description'},name==='current'?'Эти записи сейчас отправляются в модель и влияют на её ответы.':'Эти записи не отправляются в модель, но доступны для просмотра и добавления в память.'));
            if(!entries.length)section.append(el('p',{class:'pv-muted'},name==='current'?'В сформированном блоке нет записей.':'Все записи включены в память.'));
            for(const e of entries)section.append(this.entryCard(e,archive,true));this.content.append(section);
        }
        this.content.append(previews);
    }
    promptsView() {
        this.content.append(row(button('Промпт сводки',()=>{this.promptTab='summary';this.render();},this.promptTab==='summary'),button('Промпт арки',()=>{this.promptTab='arc';this.render();},this.promptTab==='arc')));
        const type=this.promptTab,group=this.e.settings().prompts[type],preset=group.presets.find(p=>p.id===group.selected)??group.presets[0];
        const select=el('select',{'aria-label':'Пресет промпта'});group.presets.forEach(p=>select.append(el('option',{value:p.id},p.name)));select.value=preset.id;
        const text=el('textarea',{'aria-label':type==='summary'?'Промпт сводки':'Промпт арки',spellcheck:'false'},preset.text);
        select.onchange=async()=>{if(text.value!==preset.text&&!await this.confirm('Несохранённый промпт','Отбросить изменения и открыть другой пресет?')){select.value=preset.id;return;}group.selected=select.value;this.saveSettings();this.render();};
        this.content.append(field('Пресет',select),field(type==='summary'?'Ваш промпт сводки':'Ваш промпт арки',text),el('p',{class:'pv-muted'},'Текст используется буквально, включая Markdown и {{макросы}}. Расширение не навязывает структуру сводки. Сохраните изменения перед генерацией.'));
        this.content.append(row(button('Сохранить промпт',()=>{preset.history.push(preset.text);preset.text=text.value;this.saveSettings();this.showNotice('Промпт сохранён.');},true),button('Новый пресет',()=>this.act(async()=>{const name=await this.askText('Название нового пресета','');if(!name)return;const p={id:this.e.host.uuid(),name,text:text.value,history:[]};group.presets.push(p);group.selected=p.id;this.saveSettings();})),button('Переименовать',()=>this.act(async()=>{const name=await this.askText('Название пресета',preset.name);if(name){preset.name=name;this.saveSettings();}})),button('Предыдущая версия',()=>this.act(async()=>{if(!preset.history.length)throw Error('Предыдущих версий пока нет.');if(await this.confirm('Восстановление промпта','Восстановить предыдущую сохранённую версию?')){const previous=preset.history.pop();preset.history.push(preset.text);preset.text=previous;this.saveSettings();}}))));
        this.content.append(row(button('Импорт из .txt',async()=>{try{const f=await readFile('.txt,.md,text/plain');if(f){text.value=f.text;this.showNotice('Текст загружен в редактор. Нажмите «Сохранить промпт».');}}catch(error){this.showNotice(error.message);}}),button('Экспорт .txt',()=>download(`pensieve-prompt-${type}.txt`,text.value,'text/plain')),button('Удалить пресет',()=>this.act(async()=>{if(group.presets.length<2)throw Error('Последний пресет удалить нельзя.');if(await this.confirm('Удаление пресета','Удалить выбранный пресет?')){group.presets=group.presets.filter(p=>p.id!==preset.id);group.selected=group.presets[0].id;this.saveSettings();}}))));
    }
    saveSettings() {this.e.host.context().saveSettingsDebounced();this.schedule();}
    settingsView(archive) {
        const settings=this.e.settings();this.content.append(el('h3',{},'Настройки памяти'));
        const group=title=>{const section=el('fieldset',{class:'pv-setting-group'});section.append(el('legend',{},title));this.content.append(section);return section;};
        const memory=group('Внедрение и лимит'),messages=group('Обработанные сообщения'),appearance=group('Отображение и пометка');
        for(const [key,title]of [['enabled','Включить расширение'],['inject','Внедрять активную память'],['exclude','Исключать обработанные сообщения после сохранения'],['collapse','Визуально сворачивать обработанные сообщения'],['pastNoteEnabled','Не акцентировать прошлые события без необходимости']]){
            const check=el('input',{type:'checkbox',checked:settings[key]});check.onchange=()=>{settings[key]=check.checked;this.saveSettings();this.refresh();};const l=el('label');l.append(check,document.createTextNode(title));(['enabled','inject'].includes(key)?memory:['exclude','collapse'].includes(key)?messages:appearance).append(l);
        }
        const limit=el('input',{type:'number',min:1,step:100,value:settings.tokenLimit});limit.onchange=()=>{if(Number.isFinite(Number(limit.value))&&Number(limit.value)>0){settings.tokenLimit=Math.floor(Number(limit.value));this.saveSettings();}else limit.value=settings.tokenLimit;};memory.append(field('Максимальный объём памяти, токенов',limit));
        const position=el('select');for(const [v,t]of [[1,'В истории чата'],[0,'После основного промпта'],[2,'Перед основным промптом']])position.append(el('option',{value:v},t));position.value=settings.position;position.onchange=()=>{settings.position=Number(position.value);this.saveSettings();};
        const depth=el('input',{type:'number',min:0,max:10000,value:settings.depth});depth.onchange=()=>{settings.depth=Math.max(0,Math.min(10000,Number(depth.value)||0));this.saveSettings();};
        memory.append(field('Позиция внедрения',position),field('Глубина в истории чата',depth));
        const note=el('textarea',{class:'pv-short'},settings.pastNote);note.onchange=()=>{settings.pastNote=note.value;this.saveSettings();};appearance.append(field('Редактируемая пометка о прошлых событиях',note));
        const theme=el('select');theme.append(el('option',{value:'dark'},'Полуночный синий'),el('option',{value:'light'},'Светлый пергамент'));theme.value=settings.theme;theme.onchange=()=>{settings.theme=theme.value;this.panel.dataset.theme=theme.value;this.saveSettings();};appearance.append(field('Тема панели',theme));
        this.content.append(el('h3',{},'Резервное копирование'));
        if(archive){this.content.append(el('p',{class:'pv-muted'},`Архив текущего чата: ${(bytes(archive)/1024).toFixed(1)} KiB. Резервная копия содержит личные тексты — храните её у себя.`));
        this.content.append(row(button('Экспорт архива JSON',()=>download('pensieve-archive.json',JSON.stringify(exportArchive(this.e.archive()),null,2))),button('Импорт архива JSON',()=>this.act(async()=>{
            const f=await readFile('.json,application/json');if(!f)return;const incoming=parseArchive(f.text);
            const mode=await this.importMode();if(!mode)return;
            if(mode==='replace'&&!await this.confirm('Замена архива','Заменить текущий архив? Сначала рекомендуется экспорт. Источники импорт не скрывает.'))return;
            await this.e.importArchive(incoming,mode);this.showNotice('Архив импортирован. Состояние исходных сообщений не менялось.');
        }))));
        }else this.content.append(el('p',{class:'pv-muted'},'Откройте сохранённый чат для экспорта, импорта и восстановления его архива. Общие настройки и промпты доступны без чата.'));
        this.content.append(row(button('Экспорт промптов JSON',()=>download('pensieve-prompts.json',JSON.stringify({format:'pensieve-prompts',version:1,prompts:settings.prompts},null,2))),button('Импорт промптов JSON',()=>this.act(async()=>{
            const f=await readFile('.json');if(!f)return;const data=JSON.parse(f.text);if(data.format!=='pensieve-prompts'||data.version!==1)throw Error('Неверный формат файла промптов.');
            const result=defaults().prompts;
            for(const type of ['summary','arc']){const g=data.prompts?.[type];if(!g||!Array.isArray(g.presets)||!g.presets.length||g.presets.length>100)throw Error('Неверный список пресетов.');const ids=new Set();result[type].presets=g.presets.map(p=>{if(typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||typeof p.text!=='string')throw Error('Неверные поля пресета.');ids.add(p.id);return{id:p.id,name:p.name,text:p.text,history:Array.isArray(p.history)?p.history.filter(h=>typeof h==='string'):[]};});result[type].selected=ids.has(g.selected)?g.selected:result[type].presets[0].id;}
            if(await this.confirm('Импорт промптов','Заменить оба набора пресетов содержимым файла?')){settings.prompts=result;this.saveSettings();}
        }))));
        if(!archive)return;
        this.content.append(el('h3',{},'Восстановление'),row(button('Повторить сохранение / завершить',()=>this.act(()=>this.e.recover('complete'))),button('Вернуть исходники незавершённой операции',()=>this.act(()=>this.e.recover('restore')))));
        this.content.append(button('Восстановить все исходники',()=>this.act(async()=>{
            if(!await this.confirm('Восстановление всех исходников','Вернуть исключённые этим расширением сообщения и отключить всю память текущего чата?'))return;
            let issues=0;for(const e of [...this.e.archive().entries])if(e.type==='summary'){const r=await this.e.restore(e.id);issues+=r.issues.length;}
            await this.e.disableAll();this.showNotice(issues?`Не удалось надёжно восстановить источники: ${issues}. Их состояние сохранено.`:'Исходники восстановлены. Архив сохранён.');
        })));
    }
    makeDialog(title) {
        const dialog=el('dialog',{class:'pensieve pv-editor','data-theme':this.e.settings().theme});
        const head=el('header',{class:'pv-header'});head.append(el('h2',{},title));const body=el('div',{class:'pv-content'});dialog.append(head,body);document.body.append(dialog);return {dialog,body};
    }
    confirm(title,message) {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog(title);body.append(el('p',{},message),row(button('Подтвердить',()=>{dialog.returnValue='yes';dialog.close();},true),button('Отмена',()=>dialog.close())));dialog.onclose=()=>{const yes=dialog.returnValue==='yes';dialog.remove();resolve(yes);};dialog.showModal();});
    }
    askText(title,value) {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog(title),input=el('input',{value,'aria-label':title});body.append(input,row(button('Сохранить',()=>{dialog.returnValue='yes';dialog.close();},true),button('Отмена',()=>dialog.close())));dialog.onclose=()=>{const result=dialog.returnValue==='yes'?input.value.trim():null;dialog.remove();resolve(result);};dialog.showModal();input.focus();});
    }
    importMode() {
        return new Promise(resolve=>{const {dialog,body}=this.makeDialog('Импорт архива');body.append(el('p',{},'Объединить с текущим архивом или заменить его? Импорт не исключает сообщения.'),row(button('Объединить',()=>{dialog.returnValue='merge';dialog.close();},true),button('Заменить',()=>{dialog.returnValue='replace';dialog.close();}),button('Отмена',()=>dialog.close())));dialog.onclose=()=>{const mode=['merge','replace'].includes(dialog.returnValue)?dialog.returnValue:null;dialog.remove();resolve(mode);};dialog.showModal();});
    }
    textDialog(title,text) {const {dialog,body}=this.makeDialog(title);const area=el('textarea',{readonly:'true','aria-label':title},text);body.append(area,row(button('Скопировать',()=>this.act(()=>copy(text))),button('Закрыть',()=>dialog.close())));dialog.onclose=()=>dialog.remove();dialog.showModal();}
    async generating(fn) {
        const {dialog,body}=this.makeDialog('Создание воспоминания');body.append(el('p',{},'Запрос к текущей модели. Исходные сообщения остаются в истории и контексте.'),el('progress'),button('Отменить генерацию',()=>this.e.cancel()));dialog.oncancel=event=>{event.preventDefault();this.e.cancel();};dialog.showModal();
        try {const draft=await fn();dialog.close();dialog.remove();this.preview(draft);return draft;}finally{if(dialog.isConnected){dialog.close();dialog.remove();}}
    }
    preview(draft) {
        const {dialog,body}=this.makeDialog(draft.type==='arc'?'Предварительный просмотр арки':'Предварительный просмотр сводки');this.editor=dialog;
        const title=el('input',{value:draft.title,'aria-label':'Название воспоминания'}),text=el('textarea',{'aria-label':'Текст воспоминания'},draft.text);
        body.append(field('Название',title),field('Текст — можно отредактировать перед сохранением',text));
        const notice=el('p',{role:'status'});body.append(notice);
        const save=button('Сохранить',async()=>{
            save.disabled=true;regen.disabled=true;
            try{await this.e.saveDraft(draft,{title:title.value,text:text.value});dialog.close();await this.refresh(true);this.showNotice('Воспоминание сохранено.');}
            catch(error){notice.textContent=error.message;this.e.host.notify('error',error.message);}
            finally{save.disabled=false;regen.disabled=false;}
        },true);
        const regen=button('Повторить генерацию',async()=>{save.disabled=true;regen.disabled=true;try{await this.e.regenerate(draft);text.value=draft.text;}catch(error){notice.textContent=error.message;}finally{save.disabled=false;regen.disabled=false;}});
        body.append(row(save,regen,button('Скопировать',()=>this.act(()=>copy(text.value))),button('Отменить генерацию',()=>this.e.cancel()),button('Отмена',()=>{if(this.e.busy)this.e.cancel();dialog.close();})));
        dialog.oncancel=()=>{if(this.e.busy)this.e.cancel();};dialog.onclose=()=>{dialog.remove();if(this.editor===dialog)this.editor=null;};dialog.showModal();
    }
    editEntry(entry,editable) {
        const {dialog,body}=this.makeDialog(editable?'Редактирование воспоминания':entry.title);this.editor=dialog;
        const title=el('input',{value:entry.title,'aria-label':'Название записи'}),text=el('textarea',{'aria-label':'Текст записи'},entry.text);title.readOnly=text.readOnly=!editable;
        body.append(field('Название',title),field('Текст',text));
        const status=el('p',{role:'status'});body.append(status);
        if(editable)body.append(button('Сохранить изменения',async()=>{try{await this.e.edit(entry.id,{title:title.value,text:text.value});dialog.close();await this.refresh(true);}catch(error){status.textContent=error.message;}},true));
        if(entry.history.length) {
            const versions=el('select',{'aria-label':'Предыдущая версия'});entry.history.forEach((h,i)=>versions.append(el('option',{value:i},`Версия ${h.version} — ${h.title}`)));
            body.append(field('Предыдущие версии',versions),row(button('Посмотреть версию',()=>{const h=entry.history[Number(versions.value)];this.textDialog(`Версия ${h.version}`,h.text);}),button('Восстановить версию',async()=>{if(!await this.confirm('Восстановление версии','Сохранить выбранную предыдущую версию как новую редакцию?'))return;const h=entry.history[Number(versions.value)];try{await this.e.edit(entry.id,{title:h.title,text:h.text});dialog.close();await this.refresh(true);}catch(error){status.textContent=error.message;}})));
        }
        if(entry.needsReview)body.append(button('Проверено — снять отметку',()=>this.act(async()=>{await this.e.change(a=>a.entries.find(e=>e.id===entry.id).needsReview=false);dialog.close();})));
        body.append(row(button('Скопировать',()=>this.act(()=>copy(text.value))),button('Закрыть',()=>dialog.close())));dialog.onclose=()=>{dialog.remove();if(this.editor===dialog)this.editor=null;};dialog.showModal();
    }
    decorateMessages() {
        let archive;try{archive=this.e.archive();}catch{return;}
        const c=this.e.host.context(),settings=this.e.settings(),processed=new Map();
        if(this.rangeChatKey===this.e.key())this.resolveRange();
        for(const e of archive.entries.filter(e=>e.type==='summary'))for(const s of e.sources){if(!processed.has(s.id))processed.set(s.id,[]);processed.get(s.id).push(e.title);}
        for(const node of document.querySelectorAll('#chat .mes[mesid]')) {
            const index=Number(node.getAttribute('mesid')),m=c.chat[index];if(!m)continue;
            const menu=node.querySelector('.extraMesButtons');
            if(menu&&!menu.querySelector('[data-pensieve-edge]')){
                const pair=el('span',{class:'pv-range-actions'});
                for(const [edge,title]of [['start','Начало сводки'],['end','Конец сводки']]){
                    const b=el('button',{type:'button',class:'mes_button pv-message-action','data-pensieve-edge':edge,title,'aria-label':title});
                    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
                    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',`M6 3h12v18l-6-4-6 4V3 ${edge==='start'?'M9 9h6 M12 6v6':'M9 9l2 2 4-4'}`);svg.append(path);b.append(svg);pair.append(b);
                }
                menu.append(pair);
            }
            menu?.querySelectorAll('[data-pensieve-edge]').forEach(b=>b.setAttribute('aria-pressed',String(index===this[b.dataset.pensieveEdge])));
            node.classList.toggle('pensieve-start',settings.enabled&&index===this.start);node.classList.toggle('pensieve-end',settings.enabled&&index===this.end);
            const id=m.extra?.[KEY]?.id,names=id?processed.get(id):null;let badge=node.querySelector('.pv-message-status');
            if(names&&settings.enabled){if(!badge){badge=el('div',{class:'pv-message-status'});(node.querySelector('.mes_block')??node).append(badge);}
                const label=`Омут памяти: ${names.join(', ')} · ${m.is_system?'исключено из контекста':'в контексте'}`;
                if(badge.dataset.label!==label){badge.dataset.label=label;badge.replaceChildren(document.createTextNode(label));const expand=button('Развернуть / свернуть',()=>{this.expanded.has(id)?this.expanded.delete(id):this.expanded.add(id);this.decorateMessages();});expand.classList.add('pv-expand');badge.append(expand);}
            }else badge?.remove();
            node.classList.toggle('pensieve-collapsed',!!(names&&settings.enabled&&settings.collapse&&!this.expanded.has(id)));
        }
    }
}
