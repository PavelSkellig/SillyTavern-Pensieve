/** Optional per-operation accounting. Never reconstruct an unknown source baseline. */
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e9;
export const estimateTokens=text=>Math.ceil(String(text).length/4);
export const TOKENIZER_NAMES=new Set(['gpt2','openai','llama','nerdstash','nerdstash_v2','mistral','yi','claude','llama3','gemma','jamba','qwen2','command-r','nemo','deepseek','command-a']);
export function validateCounter(value){
    if(!value||!['server','current','estimate'].includes(value.kind))throw Error('Повреждён способ подсчёта статистики.');
    if(value.kind==='server'&&!TOKENIZER_NAMES.has(value.tokenizer))throw Error('Неизвестный токенизатор статистики.');
    if(value.kind==='server'&&value.tokenizer==='openai'&&(typeof value.model!=='string'||!value.model.trim()))throw Error('В статистике отсутствует модель токенизатора.');
    if(value.kind==='current'&&(typeof value.signature!=='string'||value.signature.length>2000))throw Error('Повреждён токенизатор статистики.');
    if(value.kind==='current'&&!['remote-textgen','remote-kobold'].includes(value.tokenizer))throw Error('Неизвестный удалённый токенизатор статистики.');
    if(value.model!==undefined&&(typeof value.model!=='string'||value.model.length>256))throw Error('Повреждена модель токенизатора.');
    return {kind:value.kind,...(value.kind!=='estimate'?{tokenizer:value.tokenizer}:{}),...(value.kind==='current'?{signature:value.signature}:{}),...(value.model!==undefined?{model:value.model}:{})};
}
export function validateCompression(value){
    if(!value||value.version!==1||!count(value.sourceTokens)||!(value.resultTokens===null||count(value.resultTokens))||!count(value.sourceEstimate)||!count(value.resultEstimate)||typeof value.approximate!=='boolean'||typeof value.updatedAt!=='string'||value.updatedAt.length>100||!Number.isFinite(Date.parse(value.updatedAt))||typeof value.resultHash!=='string'||!/^[a-f0-9]{32}$/.test(value.resultHash))throw Error('Повреждена статистика сжатия записи.');
    return withSavings({version:1,sourceTokens:value.sourceTokens,resultTokens:value.resultTokens,sourceEstimate:value.sourceEstimate,resultEstimate:value.resultEstimate,counter:validateCounter(value.counter),approximate:value.approximate,updatedAt:value.updatedAt,resultHash:value.resultHash});
}
export function compressionValues(value){
    if(!value)return null;const fallback=value.resultTokens===null,before=fallback?value.sourceEstimate:value.sourceTokens,after=fallback?value.resultEstimate:value.resultTokens;
    return {before,after,saved:before-after,percent:before?100*(before-after)/before:null,approximate:fallback||value.approximate,fallback};
}
function withSavings(value){const pair=compressionValues(value);return {...value,savedTokens:pair.saved,reductionPercent:pair.percent};}
export async function createCompression(source,text,{host,bounded,timeout,hash}){
    const sourceEstimate=estimateTokens(source),resultEstimate=estimateTokens(text);let counter={kind:'estimate'},sourceTokens=sourceEstimate,resultTokens=resultEstimate;
    const controller=new AbortController();
    try{counter=validateCounter(await bounded(()=>host.statisticsCounter(),timeout));if(counter.kind!=='estimate'){const counts=await bounded(()=>Promise.all([host.countStatistic(source,counter,controller.signal),host.countStatistic(text,counter,controller.signal)]),timeout);if(!counts.every(count))throw Error('Нет статистики токенов.');[sourceTokens,resultTokens]=counts;}}
    catch{controller.abort();counter={kind:'estimate'};sourceTokens=sourceEstimate;resultTokens=resultEstimate;}
    return withSavings({version:1,sourceTokens,resultTokens,sourceEstimate,resultEstimate,counter,approximate:true,updatedAt:new Date().toISOString(),resultHash:hash(text)});
}
export async function editCompression(previous,text,{host,bounded,timeout,hash}){
    const old=validateCompression(previous),resultHash=hash(text);if(resultHash===old.resultHash)return old;
    let resultTokens=null;const controller=new AbortController();
    try{resultTokens=old.counter.kind==='estimate'?estimateTokens(text):await bounded(()=>host.countStatistic(text,old.counter,controller.signal),timeout);if(!count(resultTokens))throw Error('Нет статистики токенов.');}catch{controller.abort();resultTokens=null;}
    return withSavings({...old,resultTokens,resultEstimate:estimateTokens(text),resultHash,updatedAt:new Date().toISOString()});
}
