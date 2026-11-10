/** Additive book levels. Legacy record IDs, titles and prompt keys stay intact. */
export const LEVELS={
    summary:{name:'Эпизод',plural:'Эпизоды',genitive:'эпизода',many:'эпизодов',icon:'fa-bookmark',legacy:'Сводка'},
    arc:{name:'Глава',plural:'Главы',genitive:'главы',many:'глав',icon:'fa-book-open',legacy:'Арка',sourceType:'summary'},
    volume:{name:'Том',plural:'Тома',genitive:'тома',many:'томов',icon:'fa-book',sourceType:'arc'},
};
export const childrenIds=entry=>entry?.type==='volume'?entry.chapterIds??[]:entry?.type==='arc'?entry.summaryIds??[]:[];
export function hierarchyIndex(entries) {
    const byId=new Map(entries.map(e=>[e.id,e])),parents=new Map(),cache=new Map();
    for(const entry of entries)for(const id of childrenIds(entry)){if(!parents.has(id))parents.set(id,[]);parents.get(id).push(entry);}
    const descendants=entry=>{
        if(cache.has(entry.id))return cache.get(entry.id);
        const ids=new Set();cache.set(entry.id,ids);
        for(const id of childrenIds(entry)){ids.add(id);const child=byId.get(id);if(child)for(const nested of descendants(child))ids.add(nested);}
        return ids;
    };
    const ancestors=entry=>{const found=[],seen=new Set([entry.id]),queue=[...(parents.get(entry.id)??[])];for(let i=0;i<queue.length;i++){const parent=queue[i];if(seen.has(parent.id))continue;seen.add(parent.id);found.push(parent);queue.push(...(parents.get(parent.id)??[]));}return found;};
    return {byId,parents,descendants,ancestors};
}
export function entryNumber(entry,allEntries) {
    const level=LEVELS[entry.type],prefix=level.legacy?`(?:${level.name}|${level.legacy})`:level.name;
    return entry.title.match(new RegExp(`^${prefix}\\s*№\\s*(\\d+)`,'i'))?.[1]??String(allEntries.filter(e=>e.type===entry.type).findIndex(e=>e.id===entry.id)+1);
}
export function displayTitle(entry,allEntries) {
    const level=LEVELS[entry.type],prefix=level.legacy?`(?:${level.name}|${level.legacy})`:level.name;
    const matched=entry.title.match(new RegExp(`^${prefix}\\s*№\\s*(\\d+)([\\s\\S]*)$`,'i'));
    return matched?`${level.name} №${matched[1]}${matched[2]}`:`${level.name} №${entryNumber(entry,allEntries)} — ${entry.title}`;
}
export const relationLabel=(parent,allEntries)=>`Входит в ${parent.type==='volume'?'том':'главу'} №${entryNumber(parent,allEntries)}`;
export function nextNumber(type,allEntries) {
    let highest=0;for(const entry of allEntries.filter(e=>e.type===type)){const number=Number(entryNumber(entry,allEntries));if(Number.isSafeInteger(number)&&number>highest)highest=number;}
    return highest+1;
}
