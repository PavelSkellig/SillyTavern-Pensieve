import {KEY,fingerprint,hasDetachedSources,memoryEntries} from './core.js';
import {hierarchyIndex,LEVELS,entryNumber} from './hierarchy.js';

// Original source identity is checked against live, unformatted messages, never prompt indices.
function localEpisodes(entries,chat,key) {
    const messages=new Map(),hashes=new Map(),episodes=new Map();
    for(const message of chat){const id=message.extra?.[KEY]?.id;if(id)messages.set(id,messages.has(id)?null:message);}
    for(const entry of entries){
        const sourceChat=entry.sourceChat??entry.origin?.chat;
        if(entry.type!=='summary'||hasDetachedSources(entry)||sourceChat&&sourceChat!==key)continue;
        const matches=[];
        for(const source of entry.sources){
            const message=messages.get(source.id);if(!message)continue;
            if(!hashes.has(message))hashes.set(message,fingerprint(message));
            if(hashes.get(message)===source.hash)matches.push(source.id);
        }
        episodes.set(entry.id,{entry,matches,complete:matches.length===entry.sources.length});
    }
    return episodes;
}

export function memorySources(entries,chat,key,roots=memoryEntries(entries)) {
    const index=hierarchyIndex(entries),covered=new Set(roots.flatMap(e=>[e.id,...index.descendants(e)])),ids=new Set(),episodes=new Set();
    for(const [id,source] of localEpisodes(entries,chat,key))if(covered.has(id)&&source.complete){episodes.add(id);for(const id of source.matches)ids.add(id);}
    return {ids,episodes};
}

export function stripMemorySources(request,liveChat,ids) {
    if(!Array.isArray(request)||request===liveChat)throw Error('Для формирования контекста требуется отдельная копия сообщений.');
    for(let i=request.length-1;i>=0;i--)if(ids.has(request[i]?.extra?.[KEY]?.id))request.splice(i,1);
}

export function messageLabels(entries,chat,key) {
    const index=hierarchyIndex(entries),labels=new Map();
    const parents=(entry,type)=>(index.parents.get(entry.id)??[]).filter(e=>e.type===type);
    const name=entry=>`${LEVELS[entry.type].name} №${entryNumber(entry,entries)}`;
    for(const {entry,matches} of localEpisodes(entries,chat,key).values()){
        const chapters=parents(entry,'arc');
        const paths=chapters.length?chapters.flatMap(chapter=>{
            const volumes=parents(chapter,'volume');return volumes.length?volumes.map(volume=>[entry,chapter,volume]):[[entry,chapter]];
        }):[[entry]];
        const chains=paths.map(path=>path.map(name).join(' → '));
        for(const id of matches){if(!labels.has(id))labels.set(id,new Set());for(const chain of chains)labels.get(id).add(chain);}
    }
    return new Map([...labels].map(([id,chains])=>[id,'Омут памяти · '+[...chains].join(' · ')]));
}
