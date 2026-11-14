import {Engine} from './src/engine.js';
import {createHost,verifyHost} from './src/host.js';
import {UI} from './src/ui.js';
import {installMemoryEcho} from './src/memory-echo.js';

export async function boot() {
    const context=()=>globalThis.SillyTavern.getContext();
    const [core,chats]=await Promise.all([import('/script.js'),import('/scripts/chats.js')]);
    verifyHost(context(),core,chats);
    const host=createHost(context,core,chats),engine=new Engine(host);
    engine.settings();
    const ui=new UI(engine);
    const response=await fetch(new URL('./panel.html',import.meta.url));
    if(!response.ok)throw Error('Не удалось загрузить панель «Омута памяти».');
    await ui.mount(await response.text());
    const echo=await installMemoryEcho(engine,{onError:error=>ui.showNotice(error.message)});
    globalThis.pensieveGenerationInterceptor=async(request,_contextSize,abort,type)=>{
        if(type==='quiet'&&engine.busy)return;
        try {
            await echo.prepare(request,type);
        } catch(error) {echo.fail(error);abort(true);}
    };
    return {engine,ui,echo};
}
if(globalThis.SillyTavern)boot().catch(error=>{console.error('[Pensieve]',error);globalThis.toastr?.error?.(error.message,'Омут памяти');});
