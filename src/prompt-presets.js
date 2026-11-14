import {defaults,clone,fingerprint,MAX_ARCHIVE_BYTES,VOLUME_PROMPT} from './core.js';

const TYPES=['summary','arc','volume'],KEYS={summary:'chapter',arc:'part',volume:'volume'};
const builtin=()=>defaults().prompts;
const fail=()=>Error('Некорректный JSON-пресет: нужны название и три текста — chapter, part, volume.');
const nameOf=value=>{if(typeof value!=='string'||!value.trim()||value.length>2000)throw Error('Укажите название пресета до 2000 символов.');return value.trim();};
const uniqueName=(names,name)=>{let result=name,n=2;while(names.has(result)){const suffix=` (${n++})`;result=name.slice(0,2000-suffix.length)+suffix;}return result;};
const uniqueId=(ids,id)=>{let result=id,n=2;while(ids.has(result))result=`${id}-${n++}`;return result;};
const recordAt=(groups,type,id)=>groups[type].presets.find(p=>p.id===id);
const aligned=groups=>TYPES.every(t=>groups[t]?.presets?.length&&groups[t].selected===groups.summary.selected&&JSON.stringify(groups[t].presets.map(p=>[p.id,p.name]))===JSON.stringify(groups.summary.presets.map(p=>[p.id,p.name])));
const sameTexts=(a,b)=>TYPES.every(t=>a[t].text===b[t].text&&JSON.stringify(a[t].history)===JSON.stringify(b[t].history));

/** Migrate old independent lists by identity; never zip unrelated presets by array index. */
export function normalisePromptPresets(settings){
    const groups=settings.prompts??builtin();
    if(settings.promptSetsVersion===1&&aligned(groups)&&groups.summary.presets.some(p=>p.id===groups.summary.selected)&&recordAt(groups,'summary','default'))return false;
    const base=builtin(),selected=Object.fromEntries(TYPES.map(t=>[t,groups[t]?.presets?.find(p=>p.id===groups[t].selected)??groups[t]?.presets?.[0]??base[t].presets[0]]));
    const allIds=[...new Set(TYPES.flatMap(t=>(groups[t]?.presets??[]).map(p=>p.id)))],ids=new Set(),names=new Set(),bundles=[],mapping=new Map();
    const append=(id,name,records)=>{id=uniqueId(ids,id);name=uniqueName(names,name);ids.add(id);names.add(name);bundles.push({id,name,records});return id;};
    const legacyDefault=TYPES.every(t=>recordAt(groups,t,'default')?.name==='Основной');
    const oldFactory={summary:'',arc:'',volume:VOLUME_PROMPT};
    const mainRecords=Object.fromEntries(TYPES.map(t=>{const previous=legacyDefault?recordAt(groups,t,'default'):null,original=base[t].presets[0];return [t,previous?(!previous.history.length&&previous.text===oldFactory[t]?{...previous,text:original.text}:previous):original];}));
    append('default','Основной',mainRecords);
    if(legacyDefault)mapping.set('default','default');
    for(const id of allIds){
        if(id==='default'&&legacyDefault)continue;
        const records=Object.fromEntries(TYPES.map(t=>[t,recordAt(groups,t,id)??selected[t]])),sourceNames=[...new Set(TYPES.map(t=>recordAt(groups,t,id)?.name).filter(Boolean))];
        mapping.set(id,append(id==='default'?'legacy-default':id,sourceNames.join(' / ').slice(0,2000)||'Сохранённый пресет',records));
    }
    const chosenIds=TYPES.map(t=>selected[t].id);let chosen;
    if(chosenIds.every(id=>id===chosenIds[0])&&mapping.has(chosenIds[0]))chosen=mapping.get(chosenIds[0]);
    else chosen=append('legacy-selected','Текущие промпты',selected);
    settings.prompts=Object.fromEntries(TYPES.map(t=>[t,{selected:chosen,presets:bundles.map(b=>({...clone(b.records[t]),id:b.id,name:b.name}))}]));
    settings.promptSetsVersion=1;return true;
}
export function presetList(settings){normalisePromptPresets(settings);return settings.prompts.summary.presets.map(({id,name})=>({id,name}));}
export function selectPreset(settings,id){normalisePromptPresets(settings);if(!recordAt(settings.prompts,'summary',id))throw Error('Пресет не найден.');for(const t of TYPES)settings.prompts[t].selected=id;}
export function createPreset(settings,name,uuid){
    normalisePromptPresets(settings);name=uniqueName(new Set(presetList(settings).map(p=>p.name)),nameOf(name));
    const id=uniqueId(new Set(presetList(settings).map(p=>p.id)),uuid()),chosen=settings.prompts.summary.selected;
    for(const t of TYPES)settings.prompts[t].presets.push({id,name,text:recordAt(settings.prompts,t,chosen).text,history:[]});
    selectPreset(settings,id);return {id,name};
}
export function renamePreset(settings,id,name){
    normalisePromptPresets(settings);if(id==='default')throw Error('Встроенный «Основной» нельзя переименовать.');
    if(!recordAt(settings.prompts,'summary',id))throw Error('Пресет не найден.');
    name=uniqueName(new Set(presetList(settings).filter(p=>p.id!==id).map(p=>p.name)),nameOf(name));for(const t of TYPES)recordAt(settings.prompts,t,id).name=name;
}
export function deletePreset(settings,id){
    normalisePromptPresets(settings);if(id==='default')throw Error('Встроенный «Основной» нельзя удалить.');
    for(const t of TYPES)settings.prompts[t].presets=settings.prompts[t].presets.filter(p=>p.id!==id);
    if(settings.prompts.summary.selected===id)selectPreset(settings,'default');
}
export function restoreBuiltin(settings){
    normalisePromptPresets(settings);const base=builtin();for(const t of TYPES){const p=recordAt(settings.prompts,t,'default'),text=base[t].presets[0].text;if(p.text!==text){p.history.push(p.text);p.text=text;}}selectPreset(settings,'default');
}
export function exportPreset(settings,id){
    normalisePromptPresets(settings);id??=settings.prompts.summary.selected;const p=recordAt(settings.prompts,'summary',id);if(!p)throw Error('Пресет не найден.');
    return {format:'pensieve-prompt-preset',version:1,name:p.name,prompts:Object.fromEntries(TYPES.map(t=>[KEYS[t],recordAt(settings.prompts,t,id).text]))};
}
export function importPreset(settings,text,uuid){
    if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_ARCHIVE_BYTES*4)throw fail();
    let data;try{data=JSON.parse(text);}catch{throw fail();}
    if(data?.format!=='pensieve-prompt-preset'||data.version!==1||!data.prompts||Array.isArray(data.prompts))throw fail();
    const name=nameOf(data.name),values={};for(const t of TYPES){const value=data.prompts[KEYS[t]];if(typeof value!=='string'||value.length>MAX_ARCHIVE_BYTES)throw fail();values[t]=value;}
    const next=clone(settings),p=createPreset(next,name,uuid);for(const t of TYPES)recordAt(next.prompts,t,p.id).text=values[t];
    settings.prompts=next.prompts;settings.promptSetsVersion=1;return p;
}
/** Merge complete bundles for full backups; deterministic collision IDs make repeats idempotent. */
export function mergePromptGroups(current,incoming){
    const target={prompts:clone(current)},source={prompts:clone(incoming)};normalisePromptPresets(target);normalisePromptPresets(source);
    const groups=target.prompts,map=new Map(),ids=new Set(presetList(target).map(p=>p.id)),names=new Set(presetList(target).map(p=>p.name));
    for(const p of presetList(source)){
        const values=Object.fromEntries(TYPES.map(t=>[t,recordAt(source.prompts,t,p.id)])),existing=recordAt(groups,'summary',p.id);
        const equivalent=groups.summary.presets.find(local=>local.name===p.name&&sameTexts(Object.fromEntries(TYPES.map(t=>[t,recordAt(groups,t,local.id)])),values));
        if(equivalent){map.set(p.id,equivalent.id);continue;}
        if(existing&&sameTexts(Object.fromEntries(TYPES.map(t=>[t,recordAt(groups,t,p.id)])),values)){map.set(p.id,p.id);continue;}
        let id=p.id;
        if(existing)id='restored-'+fingerprint({name:p.id,mes:JSON.stringify(TYPES.map(t=>[values[t].text,values[t].history]))});
        const stem=id;let suffix=2,duplicate=false;while(ids.has(id)){if(sameTexts(Object.fromEntries(TYPES.map(t=>[t,recordAt(groups,t,id)])),values)){duplicate=true;break;}id=`${stem}-${suffix++}`;}
        if(duplicate){map.set(p.id,id);continue;}
        const name=uniqueName(names,p.name);ids.add(id);names.add(name);for(const t of TYPES)groups[t].presets.push({...clone(values[t]),id,name});map.set(p.id,id);
    }
    selectPreset(target,map.get(source.prompts.summary.selected));return target.prompts;
}
