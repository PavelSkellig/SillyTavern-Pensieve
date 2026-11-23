import test from 'node:test';
import assert from 'node:assert/strict';
import * as links from '../src/source-links.js';
import {saveFixture} from './save-fixture.js';

const save=(engine,draft)=>engine.saveDraft(draft,{title:draft.title,text:draft.text});

test('a volume includes both archived chapters inside their part and keeps a loose chapter in the tree',async()=>{
    const {c,e}=saveFixture(),chapters=[];
    for(let i=0;i<5;i++)chapters.push(await save(e,await e.generateSummary(i,i)));
    const part1=await save(e,await e.generateArc([chapters[2].id,chapters[1].id]));
    const part2=await save(e,await e.generateArc([chapters[3].id,chapters[4].id]));
    const volume=await save(e,await e.generateVolume([part2.id,part1.id]));
    const archive=e.archive(),before=JSON.stringify([archive,c.chat]);
    const ranges=links.contentsRanges(archive.entries,c.chat,e.key());
    const tree=links.contentsTree(archive.entries,ranges);
    assert.deepEqual(tree.map(node=>node.entry.id),[chapters[0].id,volume.id]);
    const parts=tree[1].children;
    assert.deepEqual(parts.map(node=>node.entry.id),[part1.id,part2.id]);
    assert.deepEqual(parts[0].children.map(node=>node.entry.id),[chapters[1].id,chapters[2].id]);
    assert.ok(parts.flatMap(node=>node.children).every(node=>node.entry.active===false));
    assert.deepEqual(ranges.get(parts[0].entry.id),{start:1,end:2});
    assert.deepEqual(ranges.get(volume.id),{start:1,end:4});
    assert.equal(JSON.stringify([archive,c.chat]),before);
});

test('missing ranges and independent or shared records are all retained',()=>{
    const entries=[
        {id:'missing',type:'summary'},
        {id:'late',type:'summary'},
        {id:'p2',type:'arc',summaryIds:['shared','late']},
        {id:'shared',type:'summary'},
        {id:'p1',type:'arc',summaryIds:['shared','unavailable-child']},
        {id:'missing-parent',type:'volume',chapterIds:['gone']},
        {id:'early',type:'summary'},
        {id:'unavailable-child',type:'summary'},
    ];
    const ranges=new Map([['p2',{start:5,end:9}],['late',{start:9,end:9}],['shared',{start:5,end:5}],['early',{start:1,end:1}]]);
    const roots=links.contentsTree(entries,ranges);
    assert.deepEqual(roots.map(node=>node.entry.id),['early','p2','missing','p1','missing-parent']);
    assert.deepEqual(roots[1].children.map(node=>node.entry.id),['shared','late']);
    assert.deepEqual(roots[3].children.map(node=>node.entry.id),['shared','unavailable-child']);
    assert.deepEqual(roots[4].children,[]);
});
