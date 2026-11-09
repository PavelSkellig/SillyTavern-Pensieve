/** Read-only UI projection. The engine alone decides which text is injected. */
export function memoryViewState(entries,memory,selectedIds=[]) {
    const candidates=new Set((memory.entries??[]).map(e=>e.id));
    const transmitted=new Set(memory.enabled&&!memory.blocked?candidates:[]);
    const selected=new Set(selectedIds),arcs=entries.filter(e=>e.type==='arc');
    const arcNumber=entry=>entry.title.match(/^Арка\s*№\s*(\d+)/i)?.[1]??String(arcs.indexOf(entry)+1);
    const byId=new Map(entries.map(entry=>{
        const covering=entry.type==='summary'?arcs.filter(a=>a.active&&a.summaryIds.includes(entry.id)):[];
        const effective=transmitted.has(entry.id);
        const gate=!effective&&candidates.has(entry.id)?(!memory.enabled?'disabled':memory.blocked?'blocked':null):null;
        const label=effective?'Активна':covering.length?`Входит в арку №${covering.map(arcNumber).join(', №')}`:'В архиве';
        const note=gate==='disabled'?'Выбрана для памяти, но внедрение глобально отключено.':gate==='blocked'?memory.reason??'Блок памяти не внедряется.':covering.length?`Отдельно не внедряется. ${covering.map(a=>a.title).join('; ')}.`:'';
        return [entry.id,{effective,label,kind:effective?'active':covering.length?'arc':'archive',gate,note,selectedForArc:entry.type==='summary'&&selected.has(entry.id),covering}];
    }));
    return {byId,current:(memory.entries??[]).filter(e=>transmitted.has(e.id)),archived:entries.filter(e=>!transmitted.has(e.id)),actualText:memory.enabled&&!memory.blocked?memory.text??'':'',candidateText:memory.text??''};
}
export function entryDisplayTitle(entry,allEntries) {
    const type=entry.type==='arc'?'Арка':'Сводка';
    return new RegExp(`^${type}\\s*№\\s*\\d+`,'i').test(entry.title)?entry.title:`${type} №${allEntries.filter(e=>e.type===entry.type).findIndex(e=>e.id===entry.id)+1} — ${entry.title}`;
}
export function filterArchive(entries,state,filter='all',query='') {
    const needle=query.trim().toLocaleLowerCase();
    return entries.filter(e=>(filter==='active'?state.byId.get(e.id)?.effective:filter==='inactive'?!state.byId.get(e.id)?.effective:true)&&(!needle||`${e.title}\n${e.text??''}`.toLocaleLowerCase().includes(needle)));
}
