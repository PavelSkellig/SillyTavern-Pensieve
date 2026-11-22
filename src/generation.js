const HEADER_RESERVE=32;
const SEGMENT_PROMPT='Описывай только события этого фрагмента переписки. Сохраняй их порядок. Не добавляй введение или итог всей истории.';
const CONTINUE_PROMPT='Продолжи сводку непосредственно с места остановки. Верни только новый текст. Не повторяй предыдущий текст, заголовок или введение.';

export const inputBudget=(context,tokens)=>Math.floor(context-tokens)-HEADER_RESERVE;

export async function chapterSegments(prompt,range,source,limits,count){
    const tokens=await count(prompt,source);
    if(inputBudget(limits.context,tokens)>=limits.output)return [{prompt,source,tokens}];
    const segmentPrompt=prompt+'\n\n'+SEGMENT_PROMPT;
    const header=await count(segmentPrompt,'');
    const available=inputBudget(limits.context,header);
    if(available<2)return [{prompt,source,tokens}];
    // Keep room for source text even when the preset reserves almost the whole window for output.
    const output=Math.min(limits.output,Math.max(1,Math.floor(available*0.75)));
    if(tokens+output+HEADER_RESERVE<=limits.context&&limits.output>output)return [{prompt,source,tokens}];
    const budget=limits.context-HEADER_RESERVE-output,segments=[];
    const blocks=range.map(message=>message.name+':\n'+message.text);
    for(let first=0;first<blocks.length;){
        let left=1,right=blocks.length-first,best=null;
        while(left<=right){
            const length=Math.floor((left+right)/2),body=blocks.slice(first,first+length).join('\n\n');
            const size=await count(segmentPrompt,body);
            if(size<=budget){best={length,source:body,tokens:size};left=length+1;}else right=length-1;
        }
        if(best){segments.push({prompt:segmentPrompt,source:best.source,tokens:best.tokens});first+=best.length;continue;}
        const chars=Array.from(blocks[first++]);
        for(let start=0;start<chars.length;){
            let left=1,right=chars.length-start,best=0,bestTokens=0;
            while(left<=right){
                const length=Math.floor((left+right)/2);
                const size=await count(segmentPrompt,chars.slice(start,start+length).join(''));
                if(size<=budget){best=length;bestTokens=size;left=length+1;}else right=length-1;
            }
            if(!best)return [{prompt,source,tokens}];
            segments.push({prompt:segmentPrompt,source:chars.slice(start,start+best).join(''),tokens:bestTokens});
            start+=best;
        }
    }
    return segments;
}

export async function continuationRequest(segment,previous,context,count){
    const prompt=segment.prompt+'\n\n'+CONTINUE_PROMPT;
    let tail=previous.slice(-4000);
    while(tail.length){
        const source=segment.source+'\n\nКонец уже написанной сводки:\n'+tail;
        const tokens=await count(prompt,source);
        if(inputBudget(context,tokens)>0)return {prompt,source,tokens};
        tail=tail.slice(Math.ceil(tail.length/2));
    }
    return null;
}

export function appendContinuation(previous,next){
    if(!previous)return next;
    const left=previous.trimEnd(),right=next.trimStart();
    if(right.startsWith(left))return left+right.slice(left.length);
    for(let size=Math.min(4000,left.length,right.length);size>=6;size--){
        if(left.endsWith(right.slice(0,size)))return left+right.slice(size);
    }
    if(!right||left.endsWith(right))return left;
    // A leading space or a newline is part of the continuation returned by the model.
    return /^\s/.test(next)?left+next:left+' '+right;
}

export const FINISH_REASONS=new Set(['length','stop','stop-sequence','interrupted','filtered','error','timeout','canceled','unknown']);

export function responseFinish(data){
    if(data?.stopped_limit===true)return 'length';
    const raw=data?.choices?.[0]?.finish_reason??data?.stop_reason??data?.finish_reason??data?.finishReason
        ??data?.candidates?.[0]?.finishReason??data?.results?.[0]?.stop_reason??data?.incomplete_details?.reason??data?.stop_type;
    const reason=typeof raw==='string'?raw.toLowerCase():'';
    if(['length','max_tokens','max_new_tokens','max_output_tokens','max_length','token_limit','num_predict'].includes(reason))return 'length';
    if(['content_filter','safety','refusal','recitation','blocklist','prohibited_content'].includes(reason))return 'filtered';
    if(['stop_sequence','stop-sequence','stopping_string'].includes(reason))return 'stop-sequence';
    if(['error','cancelled','canceled','interrupted','disconnect','timeout','tool_calls','function_call'].includes(reason)
        ||data?.status==='incomplete'||data?.incomplete_details!=null)return 'interrupted';
    if(['stop','end_turn','eos','eos_token','completed','end_of_sequence','stop_token'].includes(reason))return 'stop';
    return 'unknown';
}
