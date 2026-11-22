import test from 'node:test';
import assert from 'node:assert/strict';
import {saveFixture} from './save-fixture.js';
import {clone,KEY,emptyArchive} from '../src/core.js';
import {Engine} from '../src/engine.js';
import {planRestore} from '../src/backup.js';
import {Diagnostics} from '../src/diagnostics.js';
import {entryNumber} from '../src/hierarchy.js';

const save = async (engine,draft) => engine.saveDraft(draft,{title:draft.title,text:draft.text});

test('a deleted chapter is automatically rebuilt with its own number after reload',async()=>{
    const {c,e,host}=saveFixture();
    const first=await save(e,await e.generateSummary(0,1));
    const second=await save(e,await e.generateSummary(2,3));
    const third=await save(e,await e.generateSummary(4,5));
    assert.deepEqual([first.chapterNumber,second.chapterNumber,third.chapterNumber],[1,2,3]);
    const thirdBefore=clone(third);
    await e.deleteChapter(second.id);
    await host.hide(2,3,true);
    const disk=await host.read();
    c.chat=disk.messages;c.chatMetadata=disk.metadata;
    const current=new Engine(host);
    host.generate=async()=> 'Глава 3\nВосстановленная сводка';
    const draft=await current.generateSummary(2,3);
    const restored=await save(current,draft);
    assert.equal(restored.chapterNumber,2);
    assert.notEqual(restored.id,second.id);
    assert.deepEqual(current.archive().entries.find(e=>e.id===third.id),thirdBefore);
    assert.equal(c.chat[2].is_system,false);
    assert.equal(c.chat[3].is_system,false);
    assert.equal(c.chat[3].extra[KEY].exclusion,undefined);
});

test('truncated regeneration can continue without losing the beginning or changing identity',async()=>{
    const {c,e,host}=saveFixture();
    const chapter=await save(e,await e.generateSummary(1,2));
    const chat=clone(c.chat),requests=[];
    host.limits=()=>({context:32000,output:4600});
    host.generate=async (prompt,source,{responseLength})=>{
        requests.push({prompt,source,responseLength});
        if(requests.length===1)return {text:'Начало сводки.\n\nПоследний абзац.',truncated:true,finish:'length'};
        if(requests.length===2)throw new TypeError('Failed to fetch');
        return {text:'Последний абзац.\n\nЗавершение.',finish:'stop'};
    };
    const draft=await e.regenerateChapter(chapter.id,{version:chapter.version});
    assert.equal(requests[0].responseLength,4600);
    assert.match(requests[0].source,/SOURCE 1[\s\S]*SOURCE 2/);
    assert.equal(draft.truncated,true);
    assert.equal(e.archive().entries[0].text,chapter.text);
    await e.continueDraft(draft,draft.text);
    assert.equal(draft.interrupted,true);
    assert.equal(draft.text,'Начало сводки.\n\nПоследний абзац.');
    assert.equal(e.busy,false);
    await e.continueDraft(draft,draft.text);
    assert.match(requests[2].source,/Последний абзац/);
    assert.equal(draft.text,'Начало сводки.\n\nПоследний абзац.\n\nЗавершение.');
    assert.equal(draft.truncated,false);
    const updated=await save(e,draft);
    assert.equal(updated.id,chapter.id);
    assert.equal(updated.chapterNumber,chapter.chapterNumber);
    assert.equal(updated.version,chapter.version+1);
    assert.deepEqual(c.chat,chat);
    assert.equal(e.archive().entries.length,1);
});

test('a range too large for the requested output reserve is processed in ordered segments',async()=>{
    const {c,e,host}=saveFixture(),seen=[];
    e.prompt=()=>({name:'test',text:'Summarize incidents'});
    c.chat.forEach((m,i)=>m.mes=`Message-${i} `+'story '.repeat(85));
    host.limits=()=>({context:1200,output:700});
    host.generate=async (_prompt,source,{responseLength})=>{
        seen.push(...Array.from(source.matchAll(/Message-(\d+)/g),match=>Number(match[1])));
        assert.equal(responseLength,700);
        return `Часть текста ${seen.at(-1)}`;
    };
    const draft=await e.generateSummary(0,7);
    assert.deepEqual(seen,[0,1,2,3,4,5,6,7]);
    assert.match(draft.text,/Часть текста [0-6][\s\S]+Часть текста 7/);
    assert.equal(draft.truncated,false);
});

test('a normal short result is not treated as truncated and diagnostics contain no prompt or source text',async()=>{
    const {e,host}=saveFixture(),target='08cc67fb-8960-4f66-9519-dcf7630eae31';
    const memory=new Map(),storage={getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value)};
    host.diagnostics=new Diagnostics({storage});
    host.generate=async(_prompt,_source,{responseLength,onRequest})=>{
        onRequest({actualOutput:responseLength,stream:'non-streaming',stopCount:2,private:'SECRET_API_KEY'});
        return {text:'Кратко.',finish:'stop',received:3,reportedInput:1250};
    };
    const draft=await e.generateSummary(0,1);
    assert.equal(draft.truncated,false);
    const record=await save(e,draft);
    host.diagnostics.recordGeneration({id:target,target,kind:'regenerate',level:'summary',number:1,prompt:'PRIVATE_PROMPT'});
    const report=new Diagnostics({storage}).reportText();
    assert.match(report,/запрошено 2000 · параметры SillyTavern 2000 · получено по API 3/);
    assert.match(report,/Завершение: stop .*Сохранение: подтверждено/);
    assert.match(report,new RegExp(target));
    assert.doesNotMatch(report,/Кратко\.|SOURCE 0|SOURCE 1|SECRET_API_KEY|PRIVATE_PROMPT/);
    assert.equal(record.chapterNumber,1);
});

test('a legacy import assigns a free number only to the new conflicting chapter',async()=>{
    const {e}=saveFixture();
    const saved=await save(e,await e.generateSummary(0,1));
    const existing=e.archive();
    const incoming={...emptyArchive('legacy'),entries:[{...clone(saved),id:'old-import',title:'Сводка №1',text:'Старая запись'}]};
    delete incoming.entries[0].chapterNumber;
    const first=planRestore(existing,{archive:incoming,source:{key:'legacy'}},{targetKey:e.key()});
    assert.deepEqual(first.archive.entries.map(entry=>entryNumber(entry,first.archive.entries)),['1','2']);
    assert.deepEqual(first.archive.entries[0],existing.entries[0]);
    assert.equal(first.archive.entries[1].title,'Сводка №1');
    const repeated=planRestore(first.archive,{archive:incoming,source:{key:'legacy'}},{targetKey:e.key()});
    assert.equal(repeated.added,0);
    assert.equal(repeated.archive.entries.length,2);
});

test('API errors and timeouts keep the saved chapter and its original messages',async()=>{
    const {c,e,host}=saveFixture();
    const chapter=await save(e,await e.generateSummary(0,1));
    const archive=clone(e.archive()),chat=clone(c.chat);
    for(const error of [new TypeError('Failed to fetch'),Object.assign(Error('Request timed out'),{name:'TimeoutError'})]){
        host.generate=async()=>{throw error;};
        await assert.rejects(()=>e.regenerateChapter(chapter.id),value=>value===error);
        assert.equal(e.busy,false);
        assert.deepEqual(e.archive(),archive);
        assert.deepEqual(c.chat,chat);
    }
});

test('regenerating a linked chapter keeps the parts and volume connected and flags them for review',async()=>{
    const {c,e,host}=saveFixture(),chapters=[];
    for(let first=0;first<8;first+=2)chapters.push(await save(e,await e.generateSummary(first,first+1)));
    const part1=await save(e,await e.generateArc(chapters.slice(0,2).map(chapter=>chapter.id)));
    const part2=await save(e,await e.generateArc(chapters.slice(2).map(chapter=>chapter.id)));
    const volume=await save(e,await e.generateVolume([part1.id,part2.id]));
    const chat=clone(c.chat);
    host.generate=async()=>({text:'Updated chapter ending.',finish:'stop'});
    const replacement=await save(e,await e.regenerateChapter(chapters[2].id));
    const byId=new Map(e.archive().entries.map(entry=>[entry.id,entry]));
    assert.deepEqual(c.chat,chat);
    assert.equal(replacement.chapterNumber,3);
    assert.equal(replacement.id,chapters[2].id);
    assert.deepEqual(byId.get(part2.id).summaryIds,part2.summaryIds);
    assert.deepEqual(byId.get(volume.id).chapterIds,volume.chapterIds);
    assert.equal(byId.get(part1.id).needsReview,false);
    assert.equal(byId.get(part2.id).needsReview,true);
    assert.equal(byId.get(volume.id).needsReview,true);
    assert.equal(byId.get(volume.id).text,volume.text);
    assert.equal(byId.get(volume.id).active,true);
});

test('default first swipe initialization keeps a legacy source valid, a different swipe does not',async()=>{
    const {c,e,host}=saveFixture();
    const original=await save(e,await e.generateSummary(0,1));
    c.chat[0].swipe_id=0;
    host.normaliseSavedChat=messages=>messages.map((message,i)=>i===0?{...message,swipe_id:0}:message);
    const regenerated=await e.regenerateChapter(original.id);
    const updated=await save(e,regenerated);
    assert.deepEqual(updated.sources,original.sources);
    assert.equal(c.chat[0].is_system,true);
    c.chat[0].swipe_id=1;
    await assert.rejects(()=>e.regenerateChapter(original.id),/исходный диапазон/);
});
