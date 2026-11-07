/** Uses a disposable real SillyTavern instance, Playwright and installed Edge.
 * node tests/settings-ui.mjs <playwright/index.mjs> [ST URL]
 * Checks settings placement/layout/navigation only; never changes memory data.
 */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const browser=await chromium.launch({channel:'msedge',headless:true});
await fs.mkdir('work/screenshots',{recursive:true});
try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.argv[3]??'http://127.0.0.1:18272');
    await page.waitForFunction(()=>window.SillyTavern&&document.querySelector('#pensieve-open'));
    await page.waitForTimeout(1000);
    const onboarding=page.locator('dialog[open] .popup-input:visible');
    if(await onboarding.count()){await onboarding.fill('Pensieve QA');await page.locator('dialog[open] .popup-button-ok:visible').click();}
    const container=page.locator('#extensions_settings2');
    await page.locator('#extensions-settings-button .drawer-toggle').click();
    await container.waitFor({state:'visible'});
    // First assertion fails on the original isolated narrow button.
    assert.equal(await page.locator('#extensions_settings2 > #pensieve-settings > .inline-drawer > .inline-drawer-header').count(),1,'must be a standalone native settings drawer');
    assert.equal(await page.getByRole('button',{name:'Омут памяти · открыть архив',exact:true}).count(),0);
    const header=page.locator('#pensieve-settings-toggle'),content=page.locator('#pensieve-settings-content');
    const memoryBefore=await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata));
    for(const width of [320,375,390,430,1280]){
        await page.setViewportSize({width,height:900});await header.scrollIntoViewIfNeeded();
        if(await content.isVisible())await header.click();
        await content.waitFor({state:'hidden'});
        const bounds=await header.evaluate(n=>{
            const root=n.closest('#pensieve-settings'),parent=root.parentElement,title=n.querySelector('.pv-settings-title');
            const r=n.getBoundingClientRect(),p=parent.getBoundingClientRect(),t=title.getBoundingClientRect();
            const range=document.createRange();range.selectNodeContents(title);const lines=range.getClientRects();
            return {width:r.width,parent:p.width,height:r.height,titleHeight:t.height,lineHeight:parseFloat(getComputedStyle(title).lineHeight),scroll:root.scrollWidth,client:root.clientWidth,lines:lines.length,whiteSpace:getComputedStyle(title).whiteSpace};
        });
        assert.ok(bounds.width>=bounds.parent-12,`${width}: full-width heading ${JSON.stringify(bounds)}`);
        assert.ok(bounds.width<=width,`${width}: fits viewport`);assert.ok(bounds.scroll<=bounds.client+1,`${width}: no horizontal overflow`);
        assert.equal(bounds.whiteSpace,'nowrap');assert.ok(bounds.height<65,`${width}: standard row height`);
        assert.equal(await header.getAttribute('aria-expanded'),'false');
        await header.click();await content.waitFor({state:'visible'});
        await page.waitForTimeout(300);assert.equal(await header.getAttribute('aria-expanded'),'true');
        const buttons=content.locator('.pv-settings-action');assert.equal(await buttons.count(),6);
        const sizes=await buttons.evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,scroll:n.scrollWidth,client:n.clientWidth})));
        assert.ok(sizes.every(s=>Math.abs(s.width-sizes[0].width)<1&&s.scroll<=s.client),`${width}: equal readable buttons`);
        assert.ok(await header.locator('.inline-drawer-icon.up').count());
        await page.screenshot({path:`work/screenshots/settings-drawer-${width}.png`});
        await header.click();await content.waitFor({state:'hidden'});assert.equal(await header.getAttribute('aria-expanded'),'false');
        console.log(`PASS native settings drawer ${width}px: full width, single line, six buttons, expand/collapse`);
    }
    await page.setViewportSize({width:390,height:844});await header.scrollIntoViewIfNeeded();
    await header.focus();await page.keyboard.press('Enter');await content.waitFor({state:'visible'});
    for(const [id,tab]of [['pensieve-settings-summary','home'],['pensieve-settings-arc','archive'],['pensieve-open','archive'],['pensieve-settings-memory','memory'],['pensieve-settings-prompts','prompts'],['pensieve-settings-options','settings']]){
        const outer=page.locator('#extensions-settings-button .drawer-content');
        if(!await outer.evaluate(n=>n.classList.contains('openDrawer')))await page.locator('#extensions-settings-button .drawer-toggle').click();
        await page.waitForTimeout(300);
        await page.locator(`#${id}`).click();const panel=page.locator('#pensieve-panel');await panel.waitFor({state:'visible'});
        assert.equal(await panel.locator(`[data-tab="${tab}"]`).getAttribute('aria-current'),'page');await panel.locator('[data-action="close"]').click();
        await page.waitForTimeout(300);
    }
    if(!await page.locator('#extensions-settings-button .drawer-content').evaluate(n=>n.classList.contains('openDrawer')))await page.locator('#extensions-settings-button .drawer-toggle').click();
    await header.focus();await page.keyboard.press('Space');await content.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata)),memoryBefore,'UI navigation must not mutate archive');
    assert.deepEqual(errors,[]);console.log('PASS settings navigation, keyboard, no archive mutations or page errors');
}finally{await browser.close();}
