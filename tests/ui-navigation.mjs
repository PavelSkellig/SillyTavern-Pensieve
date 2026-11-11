/** Navigation fixture for real ST browser tests; no production shortcuts. */
export async function openWorkspace(page,tab='home',archiveLevel=null) {
    const entry={home:'home',archive:'archive',memory:'memory',prompts:'prompts',settings:'options'}[tab];
    await page.locator('#pensieve-settings-'+entry).evaluate(node=>node.click());
    const ready=()=>page.waitForFunction(()=>document.querySelector('#pensieve-panel .pv-content')?.dataset.ready==='true');
    await ready();
    if(archiveLevel){const name={summary:'Главы',arc:'Части',volume:'Тома'}[archiveLevel];await page.locator('#pensieve-panel .pv-level-tabs').getByRole('button',{name,exact:true}).evaluate(node=>node.click());await ready();}
}
