import {Engine} from './src/engine.js';
import {createHost,verifyHost} from './src/host.js';
import {UI} from './src/ui.js';
import {installMemoryEcho} from './src/memory-echo.js';
import {Diagnostics,tagError,describeError,trace} from './src/diagnostics.js';
import {DiagnosticsView,setErrorSink} from './src/diagnostics-view.js';
const runtime=globalThis[Symbol.for('sillytavern.pensieve.runtime')]??={};
function storage(){try{return globalThis.localStorage;}catch{return null;}}
export function boot(){
    return runtime.promise??=(async()=>{
        const context=()=>globalThis.SillyTavern.getContext();
        const diagnostics=runtime.diagnostics??=new Diagnostics({storage:storage()});
        const view=runtime.view??=new DiagnosticsView(diagnostics);setErrorSink((error,meta)=>diagnostics.report(error,{code:'INT-002',stage:'handler',operation:'ui',...meta}));
        const [core,chats,user]=await trace({code:'INT-002',stage:'startup',operation:'startup'},()=>Promise.all([import('/script.js'),import('/scripts/chats.js'),import('/scripts/user.js')]));
        diagnostics.getScope=()=>user.getCurrentUserHandle();diagnostics.stVersion=()=>core.CLIENT_VERSION;
        verifyHost(context(),core,chats);
        const host=createHost(context,core,chats,globalThis.fetch,diagnostics),engine=new Engine(host);engine.settings();let echo=null;
        globalThis.pensieveGenerationInterceptor=async(request,_contextSize,abort,type)=>{
            if(type==='quiet'&&engine.busy)return;
            try{
                if(!echo){const memory=await engine.refreshMemory();if(!memory.enabled||!memory.text&&!memory.blocked)return;throw tagError(Error('Макрос памяти не зарегистрирован.'),{code:'MEM-011',stage:'registration',operation:'context'});}
                await echo.prepare(request,type);
            }catch(error){abort(true);if(echo)echo.fail(error);else{diagnostics.report(error,{operation:'context',status:'blocked'});try{context().stopGeneration();}catch(failure){diagnostics.report(failure,{code:'INT-004',stage:'unlock',notify:false});}}}
        };
        const ui=new UI(engine);ui.diagnosticsView=view;
        try{echo=await trace({code:'MEM-011',stage:'registration',operation:'startup'},()=>installMemoryEcho(engine,{onError:(_error,record)=>{if(record)ui.showNotice(describeError(record).brief);}}));}
        catch(error){diagnostics.report(error,{code:'MEM-011',stage:'registration',operation:'startup'});}
        try{const response=await fetch(new URL('./panel.html',import.meta.url));if(!response.ok)throw Error('Не удалось загрузить панель «Омута памяти».');await ui.mount(await response.text());}
        catch(error){diagnostics.report(error,{code:'UI-001',stage:'ui',operation:'startup',severity:'warning'});}
        return {engine,ui,echo,diagnostics};
    })();
}
if(globalThis.SillyTavern)boot().catch(error=>runtime.diagnostics?.report(error,{code:'INT-002',stage:'startup',operation:'startup'}));
