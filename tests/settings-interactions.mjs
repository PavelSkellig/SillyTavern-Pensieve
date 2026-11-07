/** Touch and dialog regression checks against a disposable ST server.
 * node tests/settings-interactions.mjs <playwright/index.mjs> [chromium|webkit] [ST URL]
 */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const playwright=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const engine=process.argv[3]??'chromium';
const browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
const base=process.argv[4]??'http://127.0.0.1:18272';
await fs.mkdir('work/screenshots',{recursive:true});
try {
 const context=await browser.newContext({...playwright.devices['iPhone 13'],defaultBrowserType:undefined});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Windows WebKit lacks Web Speech. Keep unrelated built-in TTS out of this disposable
 // fixture rather than suppressing its errors or changing the extension under test.
 if(engine==='webkit')await page.route('**/api/settings/get',async route=>{
    const response=await route.fetch(),data=await response.json(),settings=JSON.parse(data.settings);
    settings.extension_settings??={};
    settings.extension_settings.disabledExtensions=[...new Set([...(settings.extension_settings.disabledExtensions??[]),'tts'])];
    data.settings=JSON.stringify(settings);await route.fulfill({response,json:data});
 });
 await page.goto(base);await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));
 await page.waitForTimeout(1000);
 const onboarding=page.locator('dialog[open] .popup-input:visible');if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').tap();}
 const fixture=await page.evaluate(async()=>{const c=SillyTavern.getContext();if(!c.characters.length)throw Error('Disposable ST requires synthetic QA character');const avatar=c.characters[0].avatar;await c.selectCharacterById('0');return {avatar,chatId:SillyTavern.getContext().chatId};});
 const loadFixture=()=>page.evaluate(async fixture=>{const c=SillyTavern.getContext();await c.selectCharacterById(String(c.characters.findIndex(x=>x.avatar===fixture.avatar)));if(SillyTavern.getContext().chatId!==fixture.chatId)await SillyTavern.getContext().openCharacterChat(fixture.chatId);},fixture);
 const snapshot=await page.evaluate(()=>{const c=SillyTavern.getContext(),settings=structuredClone(c.extensionSettings.pensieve);delete settings.ui;return JSON.stringify({chat:c.chat,metadata:c.chatMetadata,settings});});
 const outer=page.locator('#extensions-settings-button .drawer-content');
 const header=page.locator('#pensieve-settings-toggle'),content=page.locator('#pensieve-settings-content');
 const showSettings=async()=>{if(!await outer.evaluate(n=>n.classList.contains('openDrawer')))await page.locator('#extensions-settings-button .drawer-toggle').tap();await outer.waitFor({state:'visible'});await header.scrollIntoViewIfNeeded();};
 await showSettings();
 if(await header.getAttribute('aria-expanded')==='true')await header.tap();
 await content.waitFor({state:'hidden'});
 await header.locator('.pv-settings-title span').tap();await content.waitFor({state:'visible'});
 await page.waitForTimeout(1200);
 assert.equal(await page.evaluate(()=>SillyTavern.getContext().extensionSettings.pensieve.ui?.drawerExpanded),true,'expanded state must be saved as an interface preference');
 await header.locator('.inline-drawer-icon').tap();await content.waitFor({state:'hidden'});
 const collapsed=await page.locator('#pensieve-settings').evaluate(root=>({root:root.getBoundingClientRect().height,header:root.querySelector('.pv-settings-header').getBoundingClientRect().height,content:root.querySelector('.pv-settings-content').getBoundingClientRect().height}));
 assert.equal(collapsed.content,0);assert.ok(collapsed.root-collapsed.header<8,'collapsed drawer must leave no empty panel');
 await header.tap();await content.waitFor({state:'visible'});
 await page.locator('#extensions-settings-button .drawer-toggle').tap();await page.locator('#extensions-settings-button .drawer-toggle').tap();
 assert.equal(await header.getAttribute('aria-expanded'),'true','reopening native settings preserves drawer state');
 await page.waitForTimeout(1200);await page.reload();await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));await page.waitForTimeout(700);await loadFixture();await showSettings();
 assert.equal(await header.getAttribute('aria-expanded'),'true','reload restores expanded drawer');assert.equal(await content.isVisible(),true);
 await page.evaluate(()=>{
    window.qaOpenCount=0;const original=HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal=function(...args){if(this.id==='pensieve-panel')window.qaOpenCount++;return original.apply(this,args);};
 });
 const items=[['pensieve-settings-summary','home'],['pensieve-settings-arc','archive'],['pensieve-open','archive'],['pensieve-settings-memory','memory'],['pensieve-settings-prompts','prompts'],['pensieve-settings-options','settings']];
 for(const [id,tab]of items)for(const hit of ['icon','text','padding']) {
    await showSettings();if(await header.getAttribute('aria-expanded')!=='true')await header.tap();
    const control=page.locator(`#${id}`);await control.scrollIntoViewIfNeeded();
    const position=await control.evaluate((n,hit)=>{
       const r=n.getBoundingClientRect(),child=n.querySelector(hit==='icon'?'i':'span').getBoundingClientRect();
       return hit==='padding'?{x:r.width-5,y:r.height/2}:{x:child.x-r.x+Math.min(child.width/2,12),y:child.y-r.y+child.height/2};
    },hit);
    const before=await page.evaluate(()=>qaOpenCount);await control.tap({position});
    const panel=page.locator('#pensieve-panel');await panel.waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>qaOpenCount),before+1,`${id}/${hit}: exactly one action per tap`);
    assert.equal(await panel.locator(`[data-tab="${tab}"]`).getAttribute('aria-current'),'page');
    assert.equal(await header.getAttribute('aria-expanded'),'true','action buttons must not collapse drawer');
    assert.equal(await page.locator('#pensieve-panel').count(),1,'one shared main window');
    if(id==='pensieve-settings-summary')assert.ok(await panel.locator('[name="rangeStart"]').count());
    if(id==='pensieve-settings-arc')assert.ok(await panel.getByText('Для арки выбрано:',{exact:false}).count());
    const box=await panel.evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth}));assert.ok(box.scroll<=box.client+1);
    const scroller=panel.locator('.pv-content');await scroller.evaluate(n=>n.scrollTop=n.scrollHeight);
    await panel.getByRole('button',{name:'Закрыть',exact:true}).tap();await panel.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>!!document.querySelector('#pensieve-panel:modal')),false,'native modal backdrop is removed');
    // A real tap must reach ST again, without forcing clicks through an overlay.
    await showSettings();
    console.log(`PASS ${engine} touch: ${id}/${hit}, correct tab, one open, X close, ST usable`);
 }
 await page.locator('#pensieve-settings-prompts').tap();await page.setViewportSize({width:390,height:420});
 const shortPanel=page.locator('#pensieve-panel');
 const shortBounds=await shortPanel.evaluate(n=>{const box=n.getBoundingClientRect(),main=n.querySelector('.pv-content').getBoundingClientRect(),footer=n.querySelector('.pv-footer').getBoundingClientRect();return {panelBottom:box.bottom,contentBottom:main.bottom,footerTop:footer.top,footerBottom:footer.bottom};});
 assert.ok(shortBounds.contentBottom<=shortBounds.panelBottom&&shortBounds.footerBottom<=shortBounds.panelBottom,'short mobile viewport must not clip the content scroll area or footer');
 await page.screenshot({path:`work/screenshots/short-dialog-${engine}.png`});
 await shortPanel.locator('.pv-content').evaluate(n=>n.scrollTop=n.scrollHeight);await shortPanel.getByRole('button',{name:'Закрыть',exact:true}).tap();
 await page.setViewportSize({width:390,height:844});await showSettings();
 await header.locator('.inline-drawer-icon').tap();await content.waitFor({state:'hidden'});await page.waitForTimeout(1200);
 await page.reload();await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-settings-toggle'));await page.waitForTimeout(700);await loadFixture();await showSettings();
 assert.equal(await header.getAttribute('aria-expanded'),'false','reload restores collapsed drawer');
 const native=page.locator('#memory_settings .inline-drawer-header').first();await native.scrollIntoViewIfNeeded();await native.tap();await page.waitForTimeout(300);assert.equal(await header.getAttribute('aria-expanded'),'false','other native drawers stay independent');await native.tap();
 await page.screenshot({path:`work/screenshots/interactions-${engine}.png`});
 assert.deepEqual(errors,[]);
 // Reload and UI preference saves may update ST bookkeeping, but archive/source payload must remain unchanged.
 const after=await page.evaluate(()=>{const c=SillyTavern.getContext(),settings=structuredClone(c.extensionSettings.pensieve);delete settings.ui;return JSON.stringify({chat:c.chat,metadata:c.chatMetadata,settings});});
 assert.equal(after,snapshot,'UI must not modify chat, archive or non-interface settings');
 console.log(`PASS ${engine}: persisted collapse, compact closed height, native neighbor, no data changes or page errors`);
 await context.close();
}finally{await browser.close();}
