const HEADER_RESERVE=32;
export const SEGMENT_PROMPT='Описывай только события этого фрагмента исходных материалов. Сохраняй их порядок. Не добавляй введение или итог всей истории.';
export const SYNTHESIS_PROMPT='Объедини промежуточные сводки в одну итоговую согласно промпту выше. Убери повторения одного и того же события. Сохрани хронологию, события начала, середины и конца, важные изменения, решения и последствия. Не добавляй новых фактов.';
const CONTINUE_PROMPT='Продолжи сводку непосредственно с места остановки. Верни только новый текст. Не повторяй предыдущий текст, заголовок или введение.';

export const inputBudget=(context,tokens)=>Math.floor(context-tokens)-HEADER_RESERVE;

export async function planSegments(prompt,blocks,limits,count,partPrompt=prompt){
    const source=blocks.join('\n\n'),whole=(tokens)=>[{prompt,source,tokens,first:0,last:blocks.length-1}];
    const tokens=await count(prompt,source);
    if(inputBudget(limits.context,tokens)>=limits.output)return whole(tokens);
    const segmentPrompt=partPrompt;
    const header=await count(segmentPrompt,'');
    const available=inputBudget(limits.context,header);
    if(available<2)return whole(tokens);
    // Keep room for source text even when the preset reserves almost the whole window for output.
    const output=Math.min(limits.output,Math.max(1,Math.floor(available*0.75)));
    if(tokens+output+HEADER_RESERVE<=limits.context&&limits.output>output)return whole(tokens);
    const budget=limits.context-HEADER_RESERVE-output,segments=[];
    for(let first=0;first<blocks.length;){
        let left=1,right=blocks.length-first,best=null;
        while(left<=right){
            const length=Math.floor((left+right)/2),body=blocks.slice(first,first+length).join('\n\n');
            const size=await count(segmentPrompt,body);
            if(size<=budget){best={length,source:body,tokens:size};left=length+1;}else right=length-1;
        }
        if(best){segments.push({prompt:segmentPrompt,source:best.source,tokens:best.tokens,first,last:first+best.length-1});first+=best.length;continue;}
        const chars=Array.from(blocks[first]);
        for(let start=0;start<chars.length;){
            let left=1,right=chars.length-start,best=0,bestTokens=0;
            while(left<=right){
                const length=Math.floor((left+right)/2);
                const size=await count(segmentPrompt,chars.slice(start,start+length).join(''));
                if(size<=budget){best=length;bestTokens=size;left=length+1;}else right=length-1;
            }
            if(!best)return whole(tokens);
            segments.push({prompt:segmentPrompt,source:chars.slice(start,start+best).join(''),tokens:bestTokens,first,last:first});
            start+=best;
        }
        first++;
    }
    return segments;
}

export function distinctParagraphs(text){
    return [...new Set(text.split(/\n\s*\n/).map(paragraph=>paragraph.trim()).filter(Boolean))];
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
    if(data?.stopped_word===true)return 'stop-sequence';
    const raw=data?.choices?.[0]?.finish_reason??data?.stop_reason??data?.finish_reason??data?.finishReason
        ??data?.candidates?.[0]?.finishReason??data?.results?.[0]?.stop_reason??data?.results?.[0]?.finish_reason??data?.incomplete_details?.reason??data?.stop_type;
    const reason=typeof raw==='string'?raw.toLowerCase():'';
    if(['length','max_tokens','max_new_tokens','max_output_tokens','max_length','token_limit','num_predict'].includes(reason))return 'length';
    if(['content_filter','safety','refusal','recitation','blocklist','prohibited_content'].includes(reason))return 'filtered';
    if(['stop_sequence','stop-sequence','stopping_string','word'].includes(reason))return 'stop-sequence';
    if(['error','cancelled','canceled','interrupted','disconnect','timeout','tool_calls','function_call'].includes(reason)
        ||['incomplete','cancelled','canceled','failed'].includes(data?.status)||data?.incomplete_details!=null)return 'interrupted';
    if(['stop','end_turn','eos','eos_token','completed','end_of_sequence','stop_token'].includes(reason)||data?.stopped_eos===true)return 'stop';
    return 'unknown';
}
