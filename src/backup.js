import {clone,bytes,validateArchive,MAX_ARCHIVE_BYTES,fingerprint,inspectSources,memoryEntries,hasDetachedSources} from './core.js';
import {childrenIds,hierarchyIndex} from './hierarchy.js';

const ownObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const requireString=(value,label,max=MAX_ARCHIVE_BYTES)=>{if(typeof value!=='string'||value.length>max)throw Error(`Некорректное поле резервной копии: ${label}.`);return value;};
export function validatePromptGroups(value) {
    if(!ownObject(value))throw Error('В копии отсутствуют пользовательские промпты.');
    const result={};
    for(const type of ['summary','arc','volume']){
        const group=value[type];if(!ownObject(group)||!Array.isArray(group.presets)||!group.presets.length||group.presets.length>500)throw Error('Неверный список пресетов в резервной копии.');
        const ids=new Set(),presets=group.presets.map(p=>{
            if(!ownObject(p)||typeof p.id!=='string'||!p.id||p.id.length>200||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>2000||!Array.isArray(p.history)||p.history.length>10000)throw Error('Повреждён пресет промпта в резервной копии.');
            ids.add(p.id);return {id:p.id,name:p.name,text:requireString(p.text,'текст промпта'),history:p.history.map(h=>requireString(h,'версия промпта'))};
        });
        if(!ids.has(group.selected))throw Error('В копии выбран отсутствующий пресет.');result[type]={selected:group.selected,presets};
    }return result;
}
const booleanSettings=['enabled','inject','exclude','collapse','pastNoteEnabled','previewEpisodes'];
export function validateBackupSettings(value) {
    if(!ownObject(value))throw Error('В копии отсутствуют настройки памяти.');const result={};
    for(const key of booleanSettings){if(typeof value[key]!=='boolean')throw Error('Повреждена настройка памяти: '+key);result[key]=value[key];}
    if(!Number.isSafeInteger(value.tokenLimit)||value.tokenLimit<1||!Number.isInteger(value.depth)||value.depth<0||value.depth>10000||![-1,0,1,2].includes(value.position)||!['dark','light'].includes(value.theme))throw Error('Неверные лимит, позиция или тема памяти.');
    Object.assign(result,{tokenLimit:value.tokenLimit,depth:value.depth,position:value.position,theme:value.theme,pastNote:requireString(value.pastNote,'пометка о прошлом')});
    if(value.role!==undefined&&![0,1,2].includes(value.role))throw Error('Некорректная роль памяти.');
    Object.assign(result,{role:value.role??0,template:value.template===undefined?'':requireString(value.template,'шаблон инжекта')});
    if(value.ui!==undefined){if(!ownObject(value.ui)||typeof value.ui.drawerExpanded!=='boolean')throw Error('Повреждены настройки интерфейса.');result.ui={drawerExpanded:value.ui.drawerExpanded};}
    return result;
}
const UNKNOWN_SOURCE='pensieve:unknown-import';
const originOf=(entry,chat)=>entry.origin??{chat:entry.imported&&!entry.sourceChat?UNKNOWN_SOURCE:entry.sourceChat??chat,id:entry.id};
const detachLegacy=entry=>{if(entry.imported&&!entry.origin?.chat&&!entry.sourceChat){entry.detachedSources=true;entry.origin={chat:UNKNOWN_SOURCE,id:entry.id};entry.sourceChat=UNKNOWN_SOURCE;}return entry;};
const strictHistories=archive=>{if(!Array.isArray(archive?.entries))return;for(const entry of archive.entries)if(Array.isArray(entry?.history))for(const h of entry.history)if(!ownObject(h)||!Number.isSafeInteger(h.version)||h.version<1||typeof h.updatedAt!=='string'||!h.updatedAt.trim()||h.updatedAt.length>100)throw Error('Повреждена история версий записи в резервной копии.');};
export function createBackup(archive,settings,source) {
    if(!ownObject(source)||typeof source.key!=='string'||!source.key)throw Error('Не удалось определить исходный чат резервной копии.');
    const data=validateArchive(archive),configuration={...settings,previewEpisodes:settings.previewEpisodes??true};
    data.entries.forEach(e=>{detachLegacy(e);e.origin??=originOf(e,source.key);e.sourceChat??=e.origin.chat;});
    const result={format:'pensieve-backup',version:1,exportedAt:new Date().toISOString(),source:{key:source.key,name:typeof source.name==='string'?source.name:'',hadPendingOperation:!!archive.pending},archive:data,prompts:validatePromptGroups(settings.prompts),settings:validateBackupSettings(configuration)};
    if(bytes(result)>MAX_ARCHIVE_BYTES*4)throw Error('Полная резервная копия превышает предел 80 MiB.');return result;
}
export function parseBackup(text) {
    if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_ARCHIVE_BYTES*4)throw Error('Файл превышает предел резервной копии 80 MiB.');
    let file;try{file=JSON.parse(text);}catch{throw Error('Не удалось прочитать JSON резервной копии.');}
    if(file?.format==='pensieve'&&file.version===1){const archive=validateArchive(file.archive),key=archive.owner||'legacy:'+fingerprint({name:'archive',mes:JSON.stringify(archive.entries.map(e=>[e.id,e.sources]))});return {format:'pensieve-backup',version:1,source:{key,name:'Прежний архив',hadPendingOperation:!!file.archive.pending},archive,prompts:null,settings:null,legacy:true};}
    if(file?.format!=='pensieve-backup'||file.version!==1)throw Error('Неподдерживаемый формат резервной копии «Омута памяти».');
    if(!ownObject(file.source)||!requireString(file.source.key,'исходный чат',10000))throw Error('В копии отсутствует исходный чат.');
    const source={key:file.source.key,name:requireString(file.source.name??'','название чата',2000),hadPendingOperation:!!file.source.hadPendingOperation};
    strictHistories(file.archive);const archive=validateArchive(file.archive),origins=new Set();for(const entry of archive.entries){const key=JSON.stringify([entry.origin?.chat??source.key,entry.origin?.id??entry.id]);if(origins.has(key))throw Error('В копии повторяется происхождение разных записей. Восстановление отменено.');origins.add(key);}
    return {format:'pensieve-backup',version:1,exportedAt:requireString(file.exportedAt,'дата копии',100),source,archive,prompts:validatePromptGroups(file.prompts),settings:validateBackupSettings(file.settings)};
}
const identity=(entry,chat)=>JSON.stringify([originOf(entry,chat).chat,originOf(entry,chat).id]);
const content=(entry,entries,chat)=>JSON.stringify([entry.type,entry.title,entry.text,entry.version,entry.sources.map(s=>[s.id,s.hash,s.index,s.previousHidden]),entry.history.map(h=>[h.version,h.title,h.text,h.updatedAt]),childrenIds(entry).map(id=>{const child=entries.find(e=>e.id===id);return child?identity(child,chat):id;})]);
export function planRestore(current,backup,{targetKey,mode='merge',activate=false,uuid,chat=[]}={}) {
    if(!['merge','replace'].includes(mode)||typeof targetKey!=='string'||!targetKey)throw Error('Некорректный способ восстановления.');
    const incoming=validateArchive(backup.archive),archive=mode==='replace'?{...clone(current),entries:[],pending:null}:clone(current),byOrigin=new Map(archive.entries.map(detachLegacy).map(e=>[identity(e,targetKey),e])),used=new Set(archive.entries.map(e=>e.id)),map=new Map(),add=[],matched=[];
    let skipped=0,conflicts=0,detached=0;
    for(const entry of incoming.entries){
        const origin=originOf(entry,backup.source.key),key=JSON.stringify([origin.chat,origin.id]),existing=byOrigin.get(key);
        if(existing){if(existing.type!==entry.type)throw Error('Копия меняет уровень уже существующей записи.');map.set(entry.id,existing.id);skipped++;if(content(existing,archive.entries,targetKey)!==content(entry,incoming.entries,backup.source.key))conflicts++;matched.push([existing,entry]);continue;}
        let id=entry.id;if(used.has(id)){if(typeof uuid!=='function')throw Error('Не удалось переназначить ID.');let attempts=0;do{id=uuid();if(++attempts>100)throw Error('Не удалось получить уникальный ID.');}while(used.has(id));}
        if(typeof id!=='string'||!id)throw Error('Некорректный новый ID записи.');used.add(id);map.set(entry.id,id);
        const sourceChat=entry.sourceChat??origin.chat,foreign=hasDetachedSources(entry)||sourceChat!==targetKey||entry.type==='summary'&&inspectSources(chat,entry.sources).issues.length>0;
        const copy={...clone(entry),id,origin:clone(origin),sourceChat,detachedSources:foreign,backupActive:entry.backupActive??entry.active,active:false,imported:true};if(foreign)detached++;add.push(copy);byOrigin.set(key,copy);matched.push([copy,entry]);
    }
    for(const entry of add){const original=incoming.entries.find(e=>map.get(e.id)===entry.id);entry.summaryIds=original.summaryIds.map(id=>map.get(id));if(entry.type==='volume')entry.chapterIds=original.chapterIds.map(id=>map.get(id));}
    archive.entries.push(...add);archive.pending=null;
    if(activate){if(backup.source.hadPendingOperation)throw Error('Копия содержит незавершённую операцию. Сначала восстановите записи без активности.');const roots=new Set(memoryEntries(incoming.entries).map(e=>e.id));for(const [target,source]of matched)if(roots.has(source.id))target.active=true;const index=hierarchyIndex(archive.entries);for(const parent of archive.entries.filter(e=>e.active))for(const id of index.descendants(parent)){const child=index.byId.get(id);if(child)child.active=false;}}
    validateArchive(archive);return {archive,added:add.length,skipped,conflicts,detached,map};
}
