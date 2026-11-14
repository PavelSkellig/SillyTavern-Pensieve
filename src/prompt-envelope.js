import {MEMORY_ECHO} from './placement.js';

const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const invalid=()=>Error('SillyTavern изменил служебные границы памяти при сборке промпта. Запрос не отправлен; повторите сборку.');

/** Request-local envelopes never touch saved messages, memories or prompt settings. */
export class PromptEnvelope {
    constructor(id){this.prefix=`<!--pv${String(id).replace(/\W/g,'')}:`;this.blocks=new Map();}
    wrap(kind,text,meta={}) {
        const id=this.blocks.size,open=`${this.prefix}${id}:open-->`,close=`${this.prefix}${id}:close-->`;
        this.blocks.set(String(id),{kind,meta,open,close});return open+text+close;
    }
    parse(text) {
        const nodes=[],pattern=new RegExp(escape(this.prefix)+'(\\d+):open-->','g');let offset=0,match;
        const plain=value=>{
            if(value.includes(this.prefix))throw invalid();
            let start=0,m;const echo=new RegExp(MEMORY_ECHO.source,'gi');
            while((m=echo.exec(value))){if(m.index>start)nodes.push({kind:'text',text:value.slice(start,m.index)});nodes.push({kind:'macro'});start=echo.lastIndex;}
            if(start<value.length)nodes.push({kind:'text',text:value.slice(start)});
        };
        while((match=pattern.exec(text))){
            plain(text.slice(offset,match.index));const block=this.blocks.get(match[1]);if(!block)throw invalid();
            const end=text.indexOf(block.close,pattern.lastIndex);if(end<0)throw invalid();
            const inner=text.slice(pattern.lastIndex,end),children=['auto','source'].includes(block.kind)?this.parse(inner):[];
            nodes.push({...block,children});offset=end+block.close.length;pattern.lastIndex=offset;
        }
        plain(text.slice(offset));return nodes;
    }
    resolve(prompt,memory,automatic) {
        const list=typeof prompt==='string'?[{content:prompt}]:prompt;
        if(!Array.isArray(list))throw invalid();
        const views=list.map(message=>({message,parts:typeof message.content==='string'?[{tree:this.parse(message.content)}]:Array.isArray(message.content)?message.content.map(part=>part?.type==='text'&&typeof part.text==='string'?{part,tree:this.parse(part.text)}:{part}):[]}));
        const macros=[],autos=[];
        const collect=nodes=>{for(const node of nodes){if(node.kind==='macro')macros.push(node);else if(node.kind==='auto')autos.push(node);else if(node.kind==='source')collect(node.children);}};
        for(const view of views)for(const part of view.parts)if(part.tree)collect(part.tree);
        const selected=macros[0]??(automatic?autos[0]:null),requested=macros.length>0||automatic;
        if(requested&&memory.enabled&&memory.blocked)throw Error(memory.reason||'Блок памяти недоступен.');
        const available=!!(memory.enabled&&!memory.blocked&&memory.text);
        if(automatic&&available&&!selected)throw Error('SillyTavern не включил автоматическую вставку памяти в промпт. Проверьте позицию и глубину или используйте {{memory_echo}}.');
        const delivered=!!(available&&selected),ids=memory.sourceIds??new Set();let bodyUsed=false;
        const render=(nodes,{auto=false,onlySlots=false}={})=>nodes.map(node=>{
            if(node.kind==='text')return onlySlots?'':node.text;
            if(node.kind==='macro')return delivered&&node===selected?memory.text:'';
            if(node.kind==='body'){if(!auto||bodyUsed)return '';bodyUsed=true;return memory.text;}
            if(node.kind==='auto')return delivered&&node===selected?render(node.children,{auto:true}):'';
            if(node.kind==='source')return render(node.children,{auto,onlySlots:onlySlots||delivered&&ids.has(node.meta.id)});
            return '';
        }).join('');
        const result=[];
        for(const {message,parts}of views){
            const sources=[];let outside='';
            for(const part of parts)if(part.tree)for(const node of part.tree){if(node.kind==='source')sources.push(node);else if(node.kind==='text')outside+=node.text;}
            const sourceOnly=delivered&&sources.length>0&&sources.every(s=>ids.has(s.meta.id))&&(!outside.trim()||sources.some(s=>outside.trim()===s.meta.name+':'));
            const rendered=parts.flatMap(({tree,part})=>{
                if(!tree)return sourceOnly?[]:[part];
                const nodes=sourceOnly?tree.filter(n=>n.kind!=='text'):tree,text=render(nodes);
                return part?(text.trim()?[{...part,text}]:[]):[text];
            });
            const content=typeof message.content==='string'?rendered[0]??'':rendered;
            const hasContent=typeof content==='string'?content.trim().length>0:content.some(p=>p?.type!=='text'||p.text.trim());
            if(hasContent||message.tool_calls)result.push({...message,content});
        }
        const output=typeof prompt==='string'?result[0]?.content??'':result;
        if(JSON.stringify(output).includes(this.prefix))throw invalid();
        return {prompt:output,delivered,kind:delivered?(macros.length?'macro':'auto'):null,hadMacro:macros.length>0};
    }
}
