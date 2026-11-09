/** Runs the review regressions against a disposable ST instance only. */
import {execFileSync} from 'node:child_process';
const [playwright,engine='chromium',url='http://127.0.0.1:18274']=process.argv.slice(2);
if(!playwright)throw Error('Usage: node tests/reference-regressions.mjs /path/to/playwright/index.mjs [chromium|webkit] [disposable-ST-url]');
execFileSync(process.execPath,['tests/reference-ui.mjs',playwright,engine,url],{stdio:'inherit'});
for(const scenario of ['home','membership','loading','title'])execFileSync(process.execPath,['tests/memory-workspace.mjs',playwright,engine,url,'review-'+scenario],{stdio:'inherit'});
