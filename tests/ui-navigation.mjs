/** Navigation fixture for real ST browser tests; no production shortcuts. */
export async function openWorkspace(page,tab='home',archiveLevel=null) {
    await page.locator('#pensieve-settings-home').evaluate(node=>node.click());
    const ready=()=>page.waitForFunction(()=>document.querySelector('#pensieve-panel .pv-content')?.dataset.ready==='true');
    await ready();
    if(tab!=='home'){await page.locator('#pensieve-panel [data-tab="'+tab+'"]').evaluate(node=>node.click());await ready();}
    if(archiveLevel){const name={summary:'Эпизоды',arc:'Главы',volume:'Тома'}[archiveLevel];await page.locator('#pensieve-panel .pv-level-tabs').getByRole('button',{name,exact:true}).evaluate(node=>node.click());await ready();}
}
