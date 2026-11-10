import {childrenIds} from './hierarchy.js';
/** Resolve narrative positions from current source UUIDs. Never parse story dates or write metadata. */
export function narrativeOrder(entries,allEntries,chat) {
    const sourceIndices=new Map(),byId=new Map(),ranges=new Map();
    for(const [index,message]of (chat??[]).entries()) {
        const id=message.extra?.pensieve?.id;if(!id)continue;
        sourceIndices.set(id,sourceIndices.has(id)?null:index);
    }
    for(const entry of allEntries)byId.set(entry.id,byId.has(entry.id)?null:entry);
    function resolve(entry) {
        if(!entry)return null;
        if(ranges.has(entry.id))return ranges.get(entry.id);
        ranges.set(entry.id,null); // also prevents cycles in malformed legacy links
        let positions,historical=false;
        if(entry.type==='arc'||entry.type==='volume') {
            const ids=childrenIds(entry);if(!Array.isArray(ids)||!ids.length)return null;
            const children=ids.map(id=>resolve(byId.get(id)));
            if(children.some(range=>!range))return null;
            if(children.some(range=>range.historical)&&children.some(range=>!range.historical))return null;
            historical=children.every(range=>range.historical);
            positions=children.flatMap(range=>[range.start,range.end]);
        } else {
            if(!Array.isArray(entry.sources)||!entry.sources.length)return null;
            historical=!!entry.detachedSources;
            positions=entry.sources.map(source=>historical?source.index:sourceIndices.get(source.id));
            if(positions.some(index=>!Number.isInteger(index)))return null;
        }
        const range={start:Infinity,end:-Infinity};
        for(const position of positions){range.start=Math.min(range.start,position);range.end=Math.max(range.end,position);}
        if(historical)range.historical=true;
        ranges.set(entry.id,range);return range;
    }
    const unresolved=entries.filter(entry=>!resolve(entry));
    if(unresolved.length)return {entries:[...entries],ranges,warnings:[`Не удалось однозначно определить исходный порядок: ${unresolved.slice(0,5).map(e=>e.title??e.id).join(', ')}${unresolved.length>5?'…':''}. Сохранён показанный порядок; проверьте его вручную.`]};
    const sorted=[...entries].sort((a,b)=>Number(!!ranges.get(b.id).historical)-Number(!!ranges.get(a.id).historical)||ranges.get(a.id).start-ranges.get(b.id).start);
    for(let i=1;i<sorted.length;i++)if(!!ranges.get(sorted[i-1].id).historical===!!ranges.get(sorted[i].id).historical&&ranges.get(sorted[i-1].id).end>=ranges.get(sorted[i].id).start)
        return {entries:[...entries],ranges,warnings:['Исходные диапазоны пересекаются или чередуются внутри главы или тома. Однозначный порядок не определён: сохранён показанный порядок; проверьте его вручную.']};
    return {entries:sorted,ranges,warnings:[]};
}
