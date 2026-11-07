import {KEY,defaults,clone,bytes,WARN_ARCHIVE_BYTES,exportArchive,parseArchive,chronological,captureRange,findOverlaps,inspectSources,memoryEntries} from './core.js';

const el=(tag,attrs={},text='')=>{const node=document.createElement(tag);for(const [k,v]of Object.entries(attrs))if(k==='class')node.className=v;else if(k==='checked')node.checked=v;else node.setAttribute(k,String(v));if(text)node.textContent=text;return node;};
const button=(text,fn,primary=false)=>{const b=el('button',{type:'button',class:primary?'pv-primary':''},text);b.addEventListener('click',fn);return b;};
const row=(...nodes)=>{const r=el('div',{class:'pv-row'});r.append(...nodes);return r;};
const field=(title,node)=>{const l=el('label',{},title);l.append(node);return l;};
const download=(name,text,type='application/json')=>{const url=URL.createObjectURL(new Blob([text],{type}));const a=el('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const readFile=accept=>new Promise(resolve=>{const input=el('input',{type:'file',accept});input.onchange=async()=>resolve(input.files?.[0]?{name:input.files[0].name,text:await input.files[0].text()}:null);input.oncancel=()=>resolve(null);input.click();});
async function copy(text){try{await navigator.clipboard.writeText(text);}catch{const t=el('textarea',{},text);document.body.append(t);t.select();const success=document.execCommand('copy');t.remove();if(!success)throw Error('Браузер запретил копирование. Выделите текст и скопируйте вручную.');}}

export class UI {
    constructor(engine) {this.e=engine;this.tab='home';this.archiveTab='summary';this.promptTab='summary';this.start=null;this.end=null;this.chosen=[];this.expanded=new Set();this.editor=null;this.timer=null;this.renderId=0;}
    async mount(html) {
        const template=el('template');template.innerHTML=html;document.body.append(template.content);
        this.panel=document.querySelector('#pensieve-panel');this.content=this.panel.querySelector('.pv-content');
        this.panel.querySelector('[data-action="close"]').onclick=()=>this.panel.close();
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>this.go(b.dataset.tab));
        this.mountSettingsDrawer();
        const menu=document.querySelector('#extensionsMenu');if(menu){const b=button('Омут памяти',()=>this.open());b.classList.add('list-group-item');menu.append(b);}
        document.addEventListener('click',event=>{
            const action=event.target.closest('[data-pensieve-edge]');if(!action)return;
            const id=Number(action.closest('.mes')?.getAttribute('mesid'));if(!Number.isInteger(id))return;
            if(action.dataset.pensieveEdge==='start')this.start=id;else this.end=id;
            this.open('home');this.decorateMessages();
        });
        const c=this.e.host.context();
        c.eventSource.on(c.eventTypes.CHAT_CHANGED,()=>{
            this.e.host.inject('');if(this.e.busy)this.e.cancel();
            this.start=null;this.end=null;this.chosen=[];this.expanded.clear();
            if(this.editor){this.editor.close();this.editor.remove();this.editor=null;}
            this.schedule(true);
        });
        for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SENT','MESSAGE_RECEIVED','MORE_MESSAGES_LOADED','USER_MESSAGE_RENDERED','CHARACTER_MESSAGE_RENDERED'])if(c.eventTypes[name])c.eventSource.on(c.eventTypes[name],()=>this.schedule());
        const chat=document.querySelector('#chat');if(chat)new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('.mes')||n.querySelector?.('.mes')))))this.schedule();}).observe(chat,{childList:true,subtree:true});
        await this.refresh();
    }
    mountSettingsDrawer() {
        const container=document.getElementById('extensions_settings2')??document.getElementById('extensions_settings');
        if(!container)throw Error('Не удалось найти панель настроек расширений SillyTavern.');
        // A dedicated outer wrapper keeps this drawer a full-width sibling of other extensions.
        const root=el('div',{id:'pensieve-settings',class:'pensieve-settings'});
        const drawer=el('div',{class:'inline-drawer'});
        const header=el('div',{
            id:'pensieve-settings-toggle',class:'inline-drawer-toggle inline-drawer-header pv-settings-header',
            role:'button',tabindex:0,'aria-expanded':'false','aria-controls':'pensieve-settings-content',
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
            const control=button('',action);control.id=id;control.className='pv-settings-action';
            control.append(el('i',{class:`fa-solid ${glyph}`,'aria-hidden':'true'}),el('span',{},label));
            actions.append(control);
        }
        content.append(actions);drawer.append(header,content);root.append(drawer);container.append(root);
        // SillyTavern owns click handling, animation and chevron state; only mirror it for accessibility.
        const syncExpanded=()=>header.setAttribute('aria-expanded',String(icon.classList.contains('up')));
        new MutationObserver(syncExpanded).observe(icon,{attributes:true,attributeFilter:['class']});
        header.addEventListener('keydown',event=>{
            if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();header.click();}
        });
    }
    schedule(render=false) {clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh(render).catch(error=>console.warn('[Pensieve]',error.message)),100);}
    showNotice(text) {const n=this.panel.querySelector('.pv-notice');n.hidden=!text;n.textContent=text;}
    async act(fn) {
        try {const result=await fn();await this.refresh(true);return result;}
        catch(error){this.showNotice(error.message);this.e.host.notify('error',error.message);await this.refresh(false).catch(()=>{});return null;}
    }
    open(tab=this.tab) {if(!this.panel.open)this.panel.showModal();this.go(tab);}
    go(tab) {this.tab=tab;this.showNotice('');this.render().catch(error=>this.showNotice(error.message));}
    async refresh(render=false) {
        this.panel.dataset.theme=this.e.settings().theme;
        const memory=await this.e.refreshMemory();this.lastMemory=memory;this.decorateMessages();
        if(memory.blocked)this.showNotice(memory.reason);
        if(render&&this.panel.open)await this.render();
    }
    async render() {
        const stamp=++this.renderId;this.panel.dataset.theme=this.e.settings().theme;
        this.panel.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===this.tab?'page':'false'));
        this.content.replaceChildren();
        let archive;try{archive=this.e.archive();}catch{this.content.append(el('p',{class:'pv-empty'},'Откройте сохранённый чат, чтобы работать с его памятью.'));return;}
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
        const grid=el('div',{class:'pv-grid'});
        const summary=button('Создать сводку',()=>{this.content.querySelector('[name="rangeStart"]')?.focus();});summary.classList.add('pv-big');summary.prepend(el('i',{class:'fa-solid fa-scroll','aria-hidden':'true'}));
        const arc=button('Создать арку',()=>{this.archiveTab='summary';this.go('archive');});arc.classList.add('pv-big');arc.prepend(el('i',{class:'fa-solid fa-book-open','aria-hidden':'true'}));grid.append(summary,arc);
        const settings=this.e.settings(),memory=this.lastMemory;
        const stats=el('div',{class:'pv-stats'},`Сводок: ${archive.entries.filter(e=>e.type==='summary').length} · Арок: ${archive.entries.filter(e=>e.type==='arc').length} · Память: ${settings.enabled&&settings.inject?(memory?.blocked?'требует внимания':'включена'):'выключена'} · ≈${memory?.tokens??0} токенов`);
        this.content.append(grid,stats,el('h3',{},'Новая сводка'),el('p',{class:'pv-muted'},'Отметьте границы в меню сообщений или укажите номера ниже. Первое сообщение имеет номер 1.'));
        const start=el('input',{type:'number',min:1,max:this.e.host.context().chat.length,name:'rangeStart',value:this.start===null?'':this.start+1});
        const end=el('input',{type:'number',min:1,max:this.e.host.context().chat.length,name:'rangeEnd',value:this.end===null?'':this.end+1});
        const range=el('div',{class:'pv-range'});range.append(field('Первое сообщение',start),field('Последнее сообщение',end));this.content.append(range);
        const preview=el('div',{class:'pv-card'});this.content.append(preview);
        let overlaps=[];
        const options=el('select',{'aria-label':'Повторная обработка'});options.append(el('option',{value:'block'},'Не обрабатывать повторно'),el('option',{value:'version'},'Разрешить отдельную версию'));
        const update=()=>{
            this.start=start.value===''?null:Number(start.value)-1;this.end=end.value===''?null:Number(end.value)-1;
            preview.replaceChildren();overlaps=[];
            try{const r=captureRange(this.e.host.context().chat,this.start,this.end);overlaps=findOverlaps(archive.entries,r);
                preview.append(el('strong',{},`Сообщения ${this.start+1}–${this.end+1} · ${r.length} шт.`),el('p',{},`${r[0].name}: ${r[0].text.slice(0,200)}`),el('p',{},`${r.at(-1).name}: ${r.at(-1).text.slice(0,200)}`));
                if(overlaps.length)preview.append(el('p',{class:'pv-warning'},`Уже обработано: ${overlaps.map(e=>e.title).join(', ')}`));
            }catch{preview.append(el('span',{class:'pv-muted'},'Укажите начало и конец прямого диапазона.'));}
            const previous=options.value;options.querySelectorAll('[data-replace]').forEach(n=>n.remove());
            for(const e of overlaps)options.append(el('option',{value:e.id,'data-replace':'true'},`Заменить: ${e.title}`));if([...options.options].some(o=>o.value===previous))options.value=previous;
            options.hidden=!overlaps.length;this.decorateMessages();
        };
        start.oninput=end.oninput=update;update();this.content.append(options);
        this.content.append(row(button('Создать сводку',()=>this.act(async()=>{
            if(this.start===null||this.end===null)throw Error('Сначала выберите обе границы.');
            if(overlaps.length&&options.value!=='block'&&!await this.confirm('Повторная обработка','Этот диапазон уже представлен в архиве. Продолжить выбранным способом?'))return;
            await this.generating(()=>this.e.generateSummary(this.start,this.end,{allowOverlap:options.value!=='block',replaceId:['block','version'].includes(options.value)?null:options.value}));
        }),true),button('Отмена выделения',()=>{this.start=null;this.end=null;this.decorateMessages();this.render();})));
        this.content.append(el('p',{class:'pv-muted'},'После генерации проверьте и сохраните текст. Только затем исходные сообщения будут исключены из контекста.'));
    }
    archiveView(archive) {
        this.content.append(row(button('Сводки',()=>{this.archiveTab='summary';this.render();},this.archiveTab==='summary'),button('Арки',()=>{this.archiveTab='arc';this.render();},this.archiveTab==='arc')));
        if(this.archiveTab==='summary') {
            this.chosen=this.chosen.filter(id=>archive.entries.some(e=>e.id===id&&e.type==='summary'));
            const chosen=el('div',{class:'pv-card'});chosen.append(el('strong',{},`Для арки выбрано: ${this.chosen.length}`));
            this.chosen.forEach((id,i)=>{
                const e=archive.entries.find(x=>x.id===id);
                chosen.append(row(el('span',{},`${i+1}. ${e.title}`),button('↑',()=>{if(i){[this.chosen[i-1],this.chosen[i]]=[id,this.chosen[i-1]];this.render();}}),button('↓',()=>{if(i<this.chosen.length-1){[this.chosen[i+1],this.chosen[i]]=[id,this.chosen[i+1]];this.render();}})));
            });
            const selected=archive.entries.filter(e=>this.chosen.includes(e.id));
            if(selected.some((e,i)=>findOverlaps(selected.slice(i+1),e.sources).length))chosen.append(el('p',{class:'pv-warning'},'Выбранные сводки содержат пересекающиеся источники. Проверьте состав арки перед генерацией.'));
            chosen.append(row(button('Создать арку',()=>this.act(async()=>{
                const d=await this.generating(()=>this.e.generateArc(this.chosen));return d;
            }),true),button('По хронологии',()=>{this.chosen=chronological(selected).map(e=>e.id);this.render();}),button('Снять выбор',()=>{this.chosen=[];this.render();})));
            this.content.append(chosen);
        }
        const entries=chronological(archive.entries.filter(e=>e.type===this.archiveTab));
        if(!entries.length)this.content.append(el('p',{class:'pv-empty'},'Здесь появятся подтверждённые воспоминания.'));
        for(const e of entries)this.content.append(this.entryCard(e,archive));
    }
    entryCard(e,archive,activeView=false) {
        const card=el('article',{class:'pv-card','data-entry-id':e.id});
        const heading=el('div',{class:'pv-entry-title'}),check=el('input',{type:'checkbox',checked:activeView?e.active:this.chosen.includes(e.id),'aria-label':activeView?`Активность: ${e.title}`:`Выбрать для арки: ${e.title}`});
        if(activeView||e.type==='summary') {check.onchange=()=>activeView?this.act(()=>this.e.toggle(e.id,check.checked)):(check.checked?this.chosen.push(e.id):this.chosen=this.chosen.filter(id=>id!==e.id),this.render());heading.append(check);}
        heading.append(el('h4',{},e.title));card.append(heading);
        const status=e.type==='summary'?`Сообщения ${e.sources[0]?.index+1||'?'}–${e.sources.at(-1)?.index+1||'?'} · ${e.sources.length} шт.`:`Объединено сводок: ${e.summaryIds.length}`;
        card.append(el('small',{},`${status} · Версия ${e.version} · ${e.active?'активна':'неактивна'}`));
        if(e.type==='summary') {
            const inspected=inspectSources(this.e.host.context().chat,e.sources);
            if(inspected.issues.length)card.append(el('p',{class:'pv-warning'},`Источники изменены, удалены или недоступны: ${inspected.issues.length}. Память требует проверки.`));
            else if(inspected.matches.some(x=>x.moved))card.append(el('p',{class:'pv-muted'},'Номера сообщений изменились; источники найдены по постоянным ID.'));
        }
        if(e.needsReview)card.append(el('p',{class:'pv-warning'},'Требует проверки: исходная сводка или сообщение изменились.'));
        if(e.type==='summary'&&archive.entries.some(a=>a.type==='arc'&&a.active&&a.summaryIds.includes(e.id)))card.append(el('p',{class:'pv-muted'},'Отдельно не внедряется: представлена активной аркой.'));
        const tokens=el('small',{},'Подсчёт токенов…');card.append(tokens);
        this.e.host.count(e.text).then(n=>tokens.textContent=`≈${n} токенов`).catch(()=>tokens.textContent='Не удалось посчитать токены');
        card.append(row(button('Открыть',()=>this.editEntry(e,false)),button('Изменить',()=>this.editEntry(e,true)),button(e.active?'Деактивировать':'Активировать',()=>this.act(()=>this.e.toggle(e.id,!e.active)))));
        const details=el('details'),more=el('summary',{},'Дополнительные действия');details.append(more);
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
    async memoryView(archive,stamp) {
        const memory=await this.e.refreshMemory();if(stamp!==this.renderId)return;
        this.content.append(el('h3',{},'Активная память'),el('p',{class:'pv-muted'},`≈${memory.tokens} / ${this.e.settings().tokenLimit} токенов · ${memory.enabled&&!memory.blocked?'подключена':'не внедряется'}`));
        if(memory.blocked)this.content.append(el('p',{class:'pv-warning'},memory.reason));
        this.content.append(row(button('Посмотреть память',()=>this.textDialog('Память для модели',memory.text||'Активных записей нет.')),button('Скопировать память',()=>this.act(()=>copy(memory.text))),button('Обновить',()=>this.act(()=>this.e.refreshMemory())),button('Отключить всю память',()=>this.act(()=>this.e.disableAll()))));
        const details=el('details'),summary=el('summary',{},'Итоговый блок памяти целиком');details.append(summary,el('pre',{},memory.text||'Активных записей нет.'));this.content.append(details);
        if(!archive.entries.length)this.content.append(el('p',{class:'pv-empty'},'Сначала создайте сводку.'));
        for(const e of chronological(archive.entries))this.content.append(this.entryCard(e,archive,true));
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
        for(const [key,title]of [['enabled','Включить расширение'],['inject','Внедрять активную память'],['exclude','Исключать обработанные сообщения после сохранения'],['collapse','Визуально сворачивать обработанные сообщения'],['pastNoteEnabled','Не акцентировать прошлые события без необходимости']]){
            const check=el('input',{type:'checkbox',checked:settings[key]});check.onchange=()=>{settings[key]=check.checked;this.saveSettings();this.refresh();};const l=el('label');l.append(check,document.createTextNode(title));this.content.append(l);
        }
        const limit=el('input',{type:'number',min:1,step:100,value:settings.tokenLimit});limit.onchange=()=>{if(Number.isFinite(Number(limit.value))&&Number(limit.value)>0){settings.tokenLimit=Math.floor(Number(limit.value));this.saveSettings();}else limit.value=settings.tokenLimit;};this.content.append(field('Максимальный объём памяти, токенов',limit));
        const position=el('select');for(const [v,t]of [[1,'В истории чата'],[0,'После основного промпта'],[2,'Перед основным промптом']])position.append(el('option',{value:v},t));position.value=settings.position;position.onchange=()=>{settings.position=Number(position.value);this.saveSettings();};
        const depth=el('input',{type:'number',min:0,max:10000,value:settings.depth});depth.onchange=()=>{settings.depth=Math.max(0,Math.min(10000,Number(depth.value)||0));this.saveSettings();};
        this.content.append(field('Позиция внедрения',position),field('Глубина в истории чата',depth));
        const note=el('textarea',{class:'pv-short'},settings.pastNote);note.onchange=()=>{settings.pastNote=note.value;this.saveSettings();};this.content.append(field('Редактируемая пометка о прошлых событиях',note));
        const theme=el('select');theme.append(el('option',{value:'dark'},'Полуночный синий'),el('option',{value:'light'},'Светлый пергамент'));theme.value=settings.theme;theme.onchange=()=>{settings.theme=theme.value;this.panel.dataset.theme=theme.value;this.saveSettings();};this.content.append(field('Тема панели',theme));
        this.content.append(el('h3',{},'Резервное копирование'),el('p',{class:'pv-muted'},`Архив текущего чата: ${(bytes(archive)/1024).toFixed(1)} KiB. Резервная копия содержит личные тексты — храните её у себя.`));
        this.content.append(row(button('Экспорт архива JSON',()=>download('pensieve-archive.json',JSON.stringify(exportArchive(this.e.archive()),null,2))),button('Импорт архива JSON',()=>this.act(async()=>{
            const f=await readFile('.json,application/json');if(!f)return;const incoming=parseArchive(f.text);
            const mode=await this.importMode();if(!mode)return;
            if(mode==='replace'&&!await this.confirm('Замена архива','Заменить текущий архив? Сначала рекомендуется экспорт. Источники импорт не скрывает.'))return;
            await this.e.importArchive(incoming,mode);this.showNotice('Архив импортирован. Состояние исходных сообщений не менялось.');
        }))));
        this.content.append(row(button('Экспорт промптов JSON',()=>download('pensieve-prompts.json',JSON.stringify({format:'pensieve-prompts',version:1,prompts:settings.prompts},null,2))),button('Импорт промптов JSON',()=>this.act(async()=>{
            const f=await readFile('.json');if(!f)return;const data=JSON.parse(f.text);if(data.format!=='pensieve-prompts'||data.version!==1)throw Error('Неверный формат файла промптов.');
            const result=defaults().prompts;
            for(const type of ['summary','arc']){const g=data.prompts?.[type];if(!g||!Array.isArray(g.presets)||!g.presets.length||g.presets.length>100)throw Error('Неверный список пресетов.');const ids=new Set();result[type].presets=g.presets.map(p=>{if(typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||typeof p.text!=='string')throw Error('Неверные поля пресета.');ids.add(p.id);return{id:p.id,name:p.name,text:p.text,history:Array.isArray(p.history)?p.history.filter(h=>typeof h==='string'):[]};});result[type].selected=ids.has(g.selected)?g.selected:result[type].presets[0].id;}
            if(await this.confirm('Импорт промптов','Заменить оба набора пресетов содержимым файла?')){settings.prompts=result;this.saveSettings();}
        }))));
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
        for(const e of archive.entries.filter(e=>e.type==='summary'))for(const s of e.sources){if(!processed.has(s.id))processed.set(s.id,[]);processed.get(s.id).push(e.title);}
        for(const node of document.querySelectorAll('#chat .mes[mesid]')) {
            const index=Number(node.getAttribute('mesid')),m=c.chat[index];if(!m)continue;
            const menu=node.querySelector('.extraMesButtons');
            if(menu&&!menu.querySelector('[data-pensieve-edge]'))for(const [edge,title,icon]of [['start','Начало сводки','fa-bookmark'],['end','Конец сводки','fa-bookmark']]){
                const b=el('button',{type:'button',class:'mes_button pv-message-action','data-pensieve-edge':edge,title,'aria-label':title});b.append(el('i',{class:`fa-solid ${icon}`,'aria-hidden':'true'}),el('span',{},edge==='start'?'Начало сводки +':'Конец сводки ✓'));menu.append(b);
            }
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
