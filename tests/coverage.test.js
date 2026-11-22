import test from 'node:test';
import assert from 'node:assert/strict';
import {saveFixture} from './save-fixture.js';
import {Diagnostics} from '../src/diagnostics.js';
import {GenerationView} from '../src/generation-view.js';

const save=(engine,draft)=>engine.saveDraft(draft,{title:draft.title,text:draft.text});
const accepted=JSON.stringify({missing:[]});

test('a technically complete answer can still omit the last significant event',async()=>{
    const {c,e,host}=saveFixture();
    c.chat[0].mes='The expedition left town.';
    c.chat[1].mes='The bridge collapsed.';
    c.chat[1].is_system=true;
    c.chat[2].mes='The party rescued the missing guide.';
    const before=JSON.stringify(c.chat);
    host.generate=async()=>({text:'They left town and lost the bridge.',finish:'stop'});
    let reviews=0;
    host.reviewCoverage=async(_prompt,body)=>{
        reviews++;
        const {source,summary}=JSON.parse(body);
        assert.match(source,/left town[\s\S]*bridge collapsed[\s\S]*rescued the missing guide/);
        assert.doesNotMatch(summary,/guide/);
        return {text:JSON.stringify({missing:[{position:3,kind:'consequence'}]}),finish:'stop'};
    };
    const draft=await e.generateSummary(0,2);
    assert.equal(draft.truncated,false);
    assert.equal(draft.coverage.status,'possible-omission');
    assert.deepEqual(draft.coverage.missing,[{position:3,kind:'consequence'}]);
    assert.equal(reviews,1);
    assert.equal(JSON.stringify(c.chat),before);
    assert.equal(e.archive().entries.length,0);
});

test('a short complete answer passes without requiring a minimum length',async()=>{
    const {e,host}=saveFixture();
    host.generate=async()=>({text:'They came, stayed, and left.',finish:'stop'});
    host.reviewCoverage=async()=>({text:accepted,finish:'stop'});
    const draft=await e.generateSummary(0,2);
    assert.equal(draft.truncated,false);
    assert.equal(draft.coverage.status,'no-omissions-found');
    assert.equal(draft.text,'They came, stayed, and left.');
});

test('a malformed or truncated review stays uncertain and leaves the candidate intact',async()=>{
    const {e,host}=saveFixture();
    host.generate=async()=>({text:'Draft.',finish:'stop'});
    for(const result of [{text:'Everything looks fine.',finish:'stop'},{text:accepted,truncated:true},{text:'{"missing":[{"position":300,"kind":"change"}]}'}]){
        host.reviewCoverage=async()=>result;
        const draft=await e.generateSummary(0,2);
        assert.equal(draft.coverage.status,'unavailable');
        assert.equal(draft.text,'Draft.');
    }
});

test('parts and volumes review their own ordered archive sources',async()=>{
    const {e,host}=saveFixture();
    const requests=[];
    host.generate=async(_prompt,source)=>({text:source.split('\n')[0]+' complete',finish:'stop'});
    host.reviewCoverage=async(_prompt,body)=>{requests.push(JSON.parse(body));return {text:accepted,finish:'stop'};};
    const chapters=[];
    for(let i=0;i<8;i+=2)chapters.push(await save(e,await e.generateSummary(i,i+1)));
    const part1=await save(e,await e.generateArc(chapters.slice(0,2).map(chapter=>chapter.id)));
    const part2=await save(e,await e.generateArc(chapters.slice(2).map(chapter=>chapter.id)));
    const volume=await e.generateVolume([part1.id,part2.id]);
    assert.equal(volume.coverage.status,'no-omissions-found');
    assert.match(requests[4].source,/Глава №1[\s\S]*Глава №2/);
    assert.match(requests[6].source,/Часть №1[\s\S]*Часть №2/);
});

test('the coverage result and original range are exported without source excerpts',async()=>{
    const {e,host}=saveFixture();
    host.diagnostics=new Diagnostics();
    host.generate=async()=>({text:'PRIVATE_CANDIDATE',finish:'stop'});
    host.reviewCoverage=async()=>({text:JSON.stringify({missing:[{position:3,kind:'decision'}]}),finish:'stop'});
    const draft=await e.generateSummary(1,2);
    await save(e,draft);
    const report=host.diagnostics.generationText();
    assert.match(report,/Диапазон сообщений 2–3/);
    assert.match(report,/Возможен пропуск событий/);
    assert.doesNotMatch(report,/PRIVATE_CANDIDATE|SOURCE 1|SOURCE 2/);
});

test('long input is merged once, deduplicated, and reviewed through the last original message',async()=>{
    const {c,e,host}=saveFixture();
    e.prompt=()=>({name:'test',text:'Preserve decisions and consequences.'});
    c.chat.forEach((message,i)=>{message.mes=`Source-${i} `+'long dialogue '.repeat(100);});
    c.chat[7].is_system=true;
    host.limits=()=>({context:1450,output:800});
    const passed=[],reviewed=[];
    let syntheses=0;
    host.generate=async(_prompt,source,{phase})=>{
        if(phase==='synthesis'){
            syntheses++;
            assert.equal(source.match(/Repeated detail\./g)?.length,1);
            assert.match(source,/Part 0[\s\S]*Part 7/);
            return {text:'The opening and the middle are described.',finish:'stop'};
        }
        const ids=[...source.matchAll(/Source-(\d+)/g)].map(match=>Number(match[1]));
        passed.push(...ids);
        return 'Repeated detail.\n\n'+ids.map(id=>`Part ${id}`).join('\n\n');
    };
    host.reviewCoverage=async(_prompt,body)=>{
        const {source,summary,last}=JSON.parse(body);
        assert.equal(summary,'The opening and the middle are described.');
        reviewed.push(...[...source.matchAll(/Source-(\d+)/g)].map(match=>Number(match[1])));
        return {text:last===8?'{"missing":[{"position":8,"kind":"final-event"}]}':accepted,finish:'stop'};
    };
    const draft=await e.generateSummary(0,7);
    assert.deepEqual(passed,[0,1,2,3,4,5,6,7]);
    assert.deepEqual(reviewed,[0,1,2,3,4,5,6,7]);
    assert.equal(syntheses,1);
    assert.equal(draft.coverage.status,'possible-omission');
    assert.deepEqual(draft.coverage.missing,[{position:8,kind:'final-event'}]);
    assert.equal(c.chat[7].is_system,true);
});

test('a failed final merge retains intermediate summaries and retries only the merge',async()=>{
    const {c,e,host}=saveFixture();
    e.prompt=()=>({name:'test',text:'Summarize the recorded events.'});
    c.chat.forEach((message,i)=>{message.mes=`Message-${i} `+'fiction '.repeat(170);});
    host.limits=()=>({context:1200,output:700});
    let fragments=0,merges=0,reviews=0;
    host.generate=async(_prompt,source,{phase})=>{
        if(phase!=='synthesis')return `Intermediate ${++fragments}. ${source.match(/Message-\d+/)?.[0]}`;
        if(++merges===1)throw new TypeError('Network failure');
        return {text:'Complete merged draft.',finish:'stop'};
    };
    host.reviewCoverage=async()=>{reviews++;return {text:accepted,finish:'stop'};};
    const draft=await e.generateSummary(0,7);
    const originalFragments=fragments;
    assert.ok(originalFragments>1);
    assert.match(draft.text,/Intermediate 1/);
    assert.equal(draft.truncated,true);
    assert.equal(draft.coverage.status,'skipped-incomplete');
    assert.equal(reviews,0);
    await e.continueDraft(draft,draft.text);
    assert.equal(fragments,originalFragments);
    assert.equal(merges,2);
    assert.equal(draft.text,'Complete merged draft.');
    assert.equal(draft.coverage.status,'no-omissions-found');
});

test('repeating a partial answer verbatim cannot silently complete a draft',async()=>{
    const {e,host}=saveFixture();
    host.generate=async()=>({text:'The old paragraph.',truncated:true,finish:'length'});
    const draft=await e.generateSummary(0,2);
    host.generate=async()=>({text:'The old paragraph.',finish:'stop'});
    await e.continueDraft(draft,draft.text);
    assert.equal(draft.finish,'no-progress');
    assert.equal(draft.truncated,true);
    assert.equal(draft.text,'The old paragraph.');
    assert.equal(e.archive().entries.length,0);
});

test('coverage warnings require confirmation even when chapter preview is disabled',async()=>{
    for(const status of ['possible-omission','unavailable','no-omissions-found']){
        const engine={settings:()=>({previewEpisodes:false}),host:{}};
        const view=new GenerationView(engine,{onSaved:async()=>{}});
        let previews=0,saves=0;
        view.paint=()=>{};
        view.showPreview=()=>{previews++;};
        view.save=async()=>{saves++;};
        view.clear=()=>{};
        const draft={type:'summary',text:'Checked draft',coverage:{status}};
        const job={status:'new',phase:'generate',fn:async()=>draft};
        view.job=job;
        await view.run(job);
        assert.equal(saves,status==='no-omissions-found'?1:0);
        assert.equal(previews,status==='no-omissions-found'?0:1);
    }
});

test('a lost response after saving a reviewed regeneration still commits once to the original ID',async()=>{
    const {c,e,host}=saveFixture();
    const entry=await save(e,await e.generateSummary(0,1));
    const visibility=c.chat.map(message=>message.is_system);
    host.generate=async()=>({text:'Replacement summary.',finish:'stop'});
    host.reviewCoverage=async()=>({text:accepted,finish:'stop'});
    const draft=await e.regenerateChapter(entry.id);
    const saveNative=host.save;
    let writes=0;
    host.save=async()=>{writes++;await saveNative();throw new TypeError('Lost connection after write');};
    const saved=await save(e,draft);
    assert.equal(writes,1);
    assert.equal(saved.id,entry.id);
    assert.equal(saved.version,entry.version+1);
    assert.equal(saved.chapterNumber,entry.chapterNumber);
    assert.equal(e.archive().entries.length,1);
    assert.equal(e.busy,false);
    assert.deepEqual(c.chat.map(message=>message.is_system),visibility);
});

test('very large intermediate summaries are reduced before final synthesis',async()=>{
    const {c,e,host}=saveFixture();
    e.prompt=()=>({name:'test',text:'Keep significant events.'});
    c.chat.forEach((message,i)=>{message.mes=`Original-${i} `+'context '.repeat(180);});
    host.limits=()=>({context:1100,output:550});
    const phases=[];
    host.generate=async(_prompt,source,{phase,responseLength})=>{
        phases.push(phase);
        if(phase==='draft')return `Intermediate ${phases.length} `+'detail '.repeat(230);
        if(phase==='reduce'){
            assert.ok(responseLength<=137);
            return `Reduced summary ${phases.length}.`;
        }
        assert.match(source,/Reduced summary/);
        return 'Final summary after bounded reduction.';
    };
    host.reviewCoverage=async()=>({text:accepted,finish:'stop'});
    const draft=await e.generateSummary(0,7);
    assert.ok(phases.includes('reduce'));
    assert.equal(phases.at(-1),'synthesis');
    assert.equal(draft.synthesisFailed,false);
    assert.equal(draft.text,'Final summary after bounded reduction.');
    assert.equal(draft.coverage.status,'no-omissions-found');
});

test('a connection failure during coverage preserves the generated text',async()=>{
    const {e,host}=saveFixture();
    host.generate=async()=>({text:'Generated summary.',finish:'stop'});
    host.reviewCoverage=async()=>{throw new TypeError('Connection lost during review');};
    const draft=await e.generateSummary(0,2);
    assert.equal(draft.text,'Generated summary.');
    assert.equal(draft.truncated,false);
    assert.equal(draft.coverage.status,'unavailable');
    assert.equal(e.busy,false);
    assert.equal(e.archive().entries.length,0);
});

test('canceling a request releases the operation without replacing an archived chapter',async()=>{
    const {c,e,host}=saveFixture();
    const entry=await save(e,await e.generateSummary(0,1));
    const before=JSON.stringify(c.chat),archive=JSON.stringify(e.archive());
    let started,respond;
    const invoked=new Promise(resolve=>started=resolve);
    host.generate=()=>{started();return new Promise(resolve=>respond=resolve);};
    const regeneration=e.regenerateChapter(entry.id);
    await invoked;
    e.cancel();
    respond({text:'Late response after cancel.',finish:'stop'});
    await assert.rejects(regeneration,/отменена/);
    assert.equal(e.busy,false);
    assert.equal(e.operation.state,'canceled');
    assert.equal(JSON.stringify(e.archive()),archive);
    assert.equal(JSON.stringify(c.chat),before);
});
