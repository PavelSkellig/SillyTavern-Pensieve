import {BUILTIN_PROMPTS} from './builtin-prompts.js';
import {childrenIds,hierarchyIndex,LEVELS} from './hierarchy.js';
import {DEFAULT_INJECTION_TEMPLATE} from './placement.js';
export const KEY = 'pensieve';
export const VOLUME_PROMPT='Объедини выбранные части ролевой истории в единый том долгосрочной памяти. Сохрани последовательность событий, причины и последствия, развитие персонажей и отношений, важные факты, тайны, решения, обещания, предметы и незавершённые сюжетные линии. Покажи актуальное состояние истории на конец тома. Удали повторения, сохраняя значимые сведения. Не копируй части механически, не придумывай событий и дат, не меняй хронологию. Используй только предоставленные тексты частей.';
export const PROMPT_KEY = 'pensieve_active_memory_v1';
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const WARN_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const clone = value => structuredClone(value);
export const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const defaults = () => ({
    enabled: true, inject: true, exclude: true, collapse: false, previewEpisodes:true,
    tokenLimit: 6000, position: 0, depth: 4, role:0, template:DEFAULT_INJECTION_TEMPLATE, theme: 'dark',
    pastNoteEnabled: true,
    pastNote: 'Ниже приведены сведения о ранее произошедших событиях. Учитывай их для последовательности истории и поведения персонажей, но не пересказывай прошлое без необходимости и не разыгрывай завершённые события повторно.',
    prompts: { summary: { selected: 'default', presets: [{id:'default',name:'Основной',text:BUILTIN_PROMPTS.summary,history:[]}] }, arc: { selected:'default',presets:[{id:'default',name:'Основной',text:BUILTIN_PROMPTS.arc,history:[]}] },volume:{selected:'default',presets:[{id:'default',name:'Основной',text:BUILTIN_PROMPTS.volume,history:[]}]} },
});
export const emptyArchive = owner => ({version:1,owner,revision:0,entries:[],pending:null});
// v1.5 imports have unknown provenance; matching UUIDs do not establish ownership.
export const hasDetachedSources = entry => !!(entry?.detachedSources||entry?.imported&&!entry.sourceChat&&!entry.origin?.chat);

/** 128-bit change detector; no original message text or real-world timestamps in the archive. */
export function fingerprint(message) {
    const text = JSON.stringify([message.name, !!message.is_user, message.mes, message.swipe_id ?? null]);
    let a=1779033703,b=3144134277,c=1013904242,d=2773480762;
    for(let i=0;i<text.length;i++) {
        const k=text.charCodeAt(i);
        a=b^Math.imul(a^k,597399067); b=c^Math.imul(b^k,2869860233);
        c=d^Math.imul(c^k,951274213); d=a^Math.imul(d^k,2716044179);
    }
    return [a,b,c,d].map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
}
export function captureRange(chat, start, end) {
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=chat.length) throw Error('Укажите прямой диапазон существующих сообщений. Номера в панели начинаются с 1.');
    return chat.slice(start,end+1).map((m,i)=>({ref:m,index:start+i,id:m.extra?.[KEY]?.id??null,hash:fingerprint(m),name:m.name??'',text:m.mes??'',previousHidden:!!m.is_system}));
}
export const sourceText = range => range.map(s=>`${s.name}:\n${s.text}`).join('\n\n');
export const sourceRecord = s => ({id:s.id,hash:s.hash,index:s.index,previousHidden:s.previousHidden});

export function inspectSources(chat, sources) {
    const byId=new Map();
    chat.forEach((m,index)=>{const id=m.extra?.[KEY]?.id; if(id) {if(!byId.has(id)) byId.set(id,[]); byId.get(id).push({message:m,index});}});
    const matches=[],issues=[];
    for(const s of sources) {
        const found=s.id?byId.get(s.id):null;
        const result=found?.length===1?found[0]:null;
        if(!result) {issues.push({source:s,reason:found?.length>1?'ambiguous':'missing'}); continue;}
        if(fingerprint(result.message)!==s.hash) {issues.push({source:s,reason:'changed'});continue;}
        matches.push({...result,source:s,moved:result.index!==s.index});
    }
    return {matches,issues};
}
export function findOverlaps(entries, range) {
    const ids=new Set(range.map(s=>s.id).filter(Boolean));
    const hashes=new Set(range.map(s=>s.hash));
    return entries.filter(e=>e.type==='summary'&&!hasDetachedSources(e)&&e.sources.some(s=>s.id?ids.has(s.id):hashes.has(s.hash)));
}
export const chronological = entries => [...entries].sort((a,b)=>a.order-b.order||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
export function memoryEntries(entries) {
    const index=hierarchyIndex(entries),active=entries.filter(e=>e.active),replaced=new Set(active.flatMap(e=>[...index.descendants(e)]));
    return chronological(active.filter(e=>!replaced.has(e.id)));
}
export function memoryConflicts(entries,currentChatKey=null) {
    const active=memoryEntries(entries),index=hierarchyIndex(entries),conflicts=[];
    const coverage=e=>{const ids=new Set([e.id,...index.descendants(e)]),keys=new Set([...ids].map(id=>'record:'+id));for(const id of ids){const record=index.byId.get(id),scope=hasDetachedSources(record)&&record?.sourceChat!==currentChatKey?record.sourceChat??record.origin?.chat??'detached':'live';for(const source of record?.sources??[])keys.add('source:'+scope+':'+(source.id||source.hash));}return keys;};
    const covered=new Map(active.map(e=>[e.id,coverage(e)]));
    for(let i=0;i<active.length;i++) for(let j=i+1;j<active.length;j++) {
        const ids=covered.get(active[i].id);if([...covered.get(active[j].id)].some(id=>ids.has(id)))conflicts.push([active[i].id,active[j].id]);
    }
    return conflicts;
}
export function importedSourceConflicts(entries,chat) {
    const index=hierarchyIndex(entries),ids=new Set(memoryEntries(entries).flatMap(e=>[e.id,...index.descendants(e)])),conflicts=[];let hashes;
    for(const id of ids){
        const entry=index.byId.get(id);if(entry?.type!=='summary')continue;
        // UUID matches catch partial overlap, including native records reactivated by merge.
        const inspected=inspectSources(chat,entry.sources),visible=inspected.matches.filter(match=>!match.message.is_system);
        if(visible.length){for(const match of visible)conflicts.push({entryId:id,sourceId:match.source.id});continue;}
        // Fingerprints detect a copied transcript after UUIDs were stripped. Compare a whole
        // episode sequence, not isolated common phrases. This never creates source bindings.
        if(entry.sources.length&&entry.sources.length<=chat.length&&(hasDetachedSources(entry)||inspected.issues.length)){hashes??=chat.map(fingerprint);for(let start=0;start<=chat.length-entry.sources.length;start++)if(entry.sources.every((source,i)=>source.hash===hashes[start+i])&&entry.sources.some((_,i)=>!chat[start+i].is_system)){
            conflicts.push({entryId:id,sourceId:entry.sources[0].id});break;
        }}
    }
    return conflicts;
}
export function memoryText(entries,settings,orderedEntries=null) {
    const active=orderedEntries??memoryEntries(entries);
    if(!active.length)return '';
    return [settings.pastNoteEnabled?settings.pastNote:'',...active.map(e=>`[${LEVELS[e.type].name}: ${e.title}]\n${e.text}`)].filter(Boolean).join('\n\n');
}
export function reviseEntry(entries,id,patch) {
    const entry=entries.find(e=>e.id===id); if(!entry)throw Error('Запись не найдена.');
    if(typeof patch.text!=='string'||!patch.text.trim()||typeof patch.title!=='string'||!patch.title.trim())throw Error('Название и текст не должны быть пустыми.');
    entry.history.push({version:entry.version,title:entry.title,text:entry.text,updatedAt:entry.updatedAt});
    entry.title=patch.title;entry.text=patch.text;entry.version++;entry.updatedAt=new Date().toISOString();
    for(const parent of hierarchyIndex(entries).ancestors(entry))parent.needsReview=true;
    return entry;
}
export const exportArchive = archive => ({format:'pensieve',version:1,exportedAt:new Date().toISOString(),archive:clone(archive)});
const requireText=(x,label,limit=MAX_ARCHIVE_BYTES)=>{if(typeof x!=='string'||!x.trim()||x.length>limit)throw Error(`Некорректное поле: ${label}.`);return x;};
export function validateArchive(input) {
    if(!input||input.version!==1||!Array.isArray(input.entries)||input.entries.length>10000)throw Error('Неподдерживаемый формат архива.');
    const archive=emptyArchive(typeof input.owner==='string'?input.owner:'');
    const ids=new Set();
    archive.entries=input.entries.map(e=>{
        if(!e||!Object.hasOwn(LEVELS,e.type)||ids.has(e.id))throw Error('Некорректный тип или повторяющийся ID записи.');
        const id=requireText(e.id,'id',200);ids.add(id);
        if(e.origin!==undefined&&(!e.origin||typeof e.origin!=='object'||Array.isArray(e.origin)||typeof e.origin.chat!=='string'||!e.origin.chat||e.origin.chat.length>10000||typeof e.origin.id!=='string'||!e.origin.id||e.origin.id.length>200))throw Error('Повреждено происхождение записи.');
        if(e.sourceChat!==undefined&&(typeof e.sourceChat!=='string'||!e.sourceChat||e.sourceChat.length>10000)||e.detachedSources!==undefined&&typeof e.detachedSources!=='boolean'||e.backupActive!==undefined&&typeof e.backupActive!=='boolean')throw Error('Повреждены сведения об источнике записи.');
        if(!Number.isFinite(e.order)||!Number.isInteger(e.version)||e.version<1||typeof e.active!=='boolean'||!Array.isArray(e.sources)||!Array.isArray(e.summaryIds)||!Array.isArray(e.history))throw Error('Некорректные поля записи.');
        const sources=e.sources.map(s=>{
            if(!s||typeof s.id!=='string'||!s.id||typeof s.hash!=='string'||!/^[a-f0-9]{32}$/.test(s.hash)||!Number.isInteger(s.index)||s.index<0||typeof s.previousHidden!=='boolean')throw Error('Некорректные источники записи.');
            return {id:s.id,hash:s.hash,index:s.index,previousHidden:s.previousHidden};
        });
        if(e.type==='summary'&&e.summaryIds.length||e.type==='arc'&&(e.sources.length||e.summaryIds.length<2)||e.type!=='volume'&&e.chapterIds?.length||e.type==='volume'&&(e.sources.length||e.summaryIds.length||!Array.isArray(e.chapterIds)||e.chapterIds.length<2))throw Error('Неверные связи записи.');
        return {id,type:e.type,title:requireText(e.title,'title',2000),text:requireText(e.text,'text'),order:e.order,active:e.active,version:e.version,
            createdAt:requireText(e.createdAt,'createdAt',100),updatedAt:requireText(e.updatedAt??e.createdAt,'updatedAt',100),sources,
            summaryIds:e.summaryIds.map(id=>requireText(id,'summaryId',200)),
            ...(e.type==='volume'?{chapterIds:e.chapterIds.map(id=>requireText(id,'chapterId',200))}:{}),
            history:e.history.map(h=>({version:Number(h.version)||1,title:requireText(h.title,'history title',2000),text:requireText(h.text,'history text'),updatedAt:typeof h.updatedAt==='string'?h.updatedAt:e.createdAt})),
            needsReview:!!e.needsReview,restored:!!e.restored,imported:!!e.imported,preset:typeof e.preset==='string'?e.preset:'',
            ...(e.origin?{origin:clone(e.origin)}:{}),...(e.sourceChat!==undefined?{sourceChat:e.sourceChat}:{}),...(e.detachedSources!==undefined?{detachedSources:e.detachedSources}:{}),...(e.backupActive!==undefined?{backupActive:e.backupActive}:{}),
        };
    });
    const byId=new Map(archive.entries.map(e=>[e.id,e]));
    for(const e of archive.entries)if(e.type!=='summary'){const links=childrenIds(e);if(new Set(links).size!==links.length||links.some(id=>byId.get(id)?.type!==LEVELS[e.type].sourceType))throw Error('Неверные, отсутствующие или повторяющиеся источники части или тома.');}
    archive.revision=Number.isInteger(input.revision)?input.revision:0;
    if(bytes(archive)>MAX_ARCHIVE_BYTES)throw Error('Архив превышает безопасный предел 20 MiB. Разделите резервную копию.');
    return archive;
}
export function parseArchive(text) {
    if(new TextEncoder().encode(text).length>MAX_ARCHIVE_BYTES*4)throw Error('Файл превышает предел импорта 80 MiB.');
    const file=JSON.parse(text);
    if(file?.format!=='pensieve'||file.version!==1)throw Error('Это не архив «Омута памяти» версии 1.');
    const result=validateArchive(file.archive);
    result.entries.forEach(e=>e.imported=true);
    return result;
}
export function mergeArchives(original,incoming,uuid) {
    const result=clone(original), map=new Map(incoming.entries.map(e=>[e.id,uuid()]));
    result.entries.push(...clone(incoming.entries).map(e=>({...e,id:map.get(e.id),summaryIds:e.summaryIds.map(id=>map.get(id)),...(e.type==='volume'?{chapterIds:e.chapterIds.map(id=>map.get(id))}:{}),imported:true})));
    return result;
}
