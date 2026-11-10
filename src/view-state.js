import {hierarchyIndex,displayTitle} from './hierarchy.js';
/** Read-only UI projection. The engine alone decides which text is injected. */
export function memoryViewState(entries,memory,selectedIds=[]) {
    const candidates=new Set((memory.entries??[]).map(e=>e.id));
    const transmitted=new Set(memory.enabled&&!memory.blocked?candidates:[]);
    const selected=new Set(selectedIds),index=hierarchyIndex(entries);
    const byId=new Map(entries.map(entry=>{
        const parents=index.parents.get(entry.id)??[],ancestors=index.ancestors(entry),covering=ancestors.filter(a=>a.active);
        const effective=transmitted.has(entry.id);
        const gate=!effective&&candidates.has(entry.id)?(!memory.enabled?'disabled':memory.blocked?'blocked':null):null;
        const label=effective?'Активна':'В архиве';
        const note=gate==='disabled'?'Выбрана для памяти, но внедрение глобально отключено.':gate==='blocked'?memory.reason??'Блок памяти не внедряется.':covering.length?`Отдельно не внедряется. ${covering.map(a=>displayTitle(a,entries)).join('; ')}.`:'';
        return [entry.id,{effective,label,kind:effective?'active':'archive',gate,note,selectedForArc:entry.type==='summary'&&selected.has(entry.id),selectedForVolume:entry.type==='arc'&&selected.has(entry.id),covering,parents,ancestors}];
    }));
    return {byId,current:(memory.entries??[]).filter(e=>transmitted.has(e.id)),archived:entries.filter(e=>!transmitted.has(e.id)),actualText:memory.enabled&&!memory.blocked?memory.text??'':'',candidateText:memory.text??''};
}
export function entryDisplayTitle(entry,allEntries) {
    return displayTitle(entry,allEntries);
}
export function filterArchive(entries,state,filter='all',query='',allEntries=entries) {
    const needle=query.trim().toLocaleLowerCase();
    return entries.filter(e=>(filter==='active'?state.byId.get(e.id)?.effective:filter==='inactive'?!state.byId.get(e.id)?.effective:true)&&(!needle||`${displayTitle(e,allEntries)}\n${e.title}\n${e.text??''}`.toLocaleLowerCase().includes(needle)));
}
