/** Concurrent first registration in real disposable ST; restores the original drawer. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const pw=await import(pathToFileURL(path.resolve(process.argv[2])).href),engine=process.argv[3]??'chromium',browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
try{
 const context=await browser.newContext(pw.devices['iPhone 13']),page=await context.newPage();if(engine==='webkit')await page.route('**/api/settings/get',async route=>{const response=await route.fetch(),data=await response.json(),settings=JSON.parse(data.settings);settings.extension_settings.disabledExtensions=[...new Set([...(settings.extension_settings.disabledExtensions??[]),'tts'])];data.settings=JSON.stringify(settings);await route.fulfill({response,json:data});});
 await page.goto(process.argv[4]??'http://127.0.0.1:18276');await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-home'));
 const result=await page.evaluate(async()=>{
  const root='/scripts/extensions/third-party/SillyTavern-Pensieve/src/',{UI}=await import(root+'ui.js'),{Engine}=await import(root+'engine.js'),{createHost}=await import(root+'host.js'),core=await import('/script.js'),chats=await import('/scripts/chats.js'),ui=new UI(new Engine(createHost(()=>SillyTavern.getContext(),core,chats))),original=document.querySelector('#pensieve-settings'),parent=original.parentElement,next=original.nextSibling,before=JSON.stringify([SillyTavern.getContext().chatMetadata,SillyTavern.getContext().extensionSettings.pensieve]);
  original.remove();
  try{await Promise.all([ui.mountSettingsDrawer(),ui.mountSettingsDrawer()]);return {roots:document.querySelectorAll('#pensieve-settings').length,actions:document.querySelectorAll('#pensieve-settings .pv-settings-action').length,unchanged:before===JSON.stringify([SillyTavern.getContext().chatMetadata,SillyTavern.getContext().extensionSettings.pensieve])};}
  finally{document.querySelectorAll('#pensieve-settings').forEach(n=>n.remove());parent.insertBefore(original,next);}
 });assert.deepEqual(result,{roots:1,actions:1,unchanged:true});console.log('PASS '+engine+': simultaneous first registration creates one Home entry and preserves data');await context.close();
}finally{await browser.close();}
