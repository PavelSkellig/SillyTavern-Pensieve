export const MEMORY_ECHO=/{{\s*memory_echo\s*}}/gi;
export const DEFAULT_INJECTION_TEMPLATE='[Предыдущие события:\n{{memory_echo}}\n]';

/** Template Echo is internal to the automatic block, not a user macro invocation. */
export function automaticMemory(text,settings) {
    if(!text||Number(settings?.position)===-1)return '';
    const template=typeof settings?.template==='string'?settings.template:'';
    if(!template.trim())return text;
    let inserted=false;
    const formatted=template.replace(MEMORY_ECHO,()=>{if(inserted)return '';inserted=true;return text;});
    return inserted?formatted:`${template}\n${text}`;
}
