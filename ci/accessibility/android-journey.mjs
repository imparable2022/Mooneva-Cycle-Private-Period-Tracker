import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const target = 'com.mooneva.app.debug';
const home = join(process.env.RUNNER_TEMP, 'aloud');
const cli = join(home, 'bin/aloud.mjs');
const out = 'android-journey';
const results = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
await mkdir(out, {recursive:true});
const adb = (...args) => execFileSync('adb',args,{encoding:'utf8',timeout:20000}).trim();
function tool(args, timeout=480000) {
  const r = spawnSync(process.execPath,[cli,...args],{stdio:'inherit',timeout});
  if(r.error || r.status!==0) throw new Error('Aloud '+args[0]+': '+(r.error?.message || r.status));
}
async function record(id, fn) {
  try { await fn(); results.push({id, outcome:'observed'}); }
  catch(e) { results.push({id,outcome:'failed',error:String(e)}); console.error(id,e); }
  finally { await writeFile(join(out,'summary.json'),JSON.stringify(results,null,2)); }
}
let port, socket, seq=0;
const pending=new Map();
async function attach() {
  const pid=adb('shell','pidof',target);
  assert.match(pid,/^\d+$/);
  const sockets=adb('shell','cat','/proc/net/unix');
  const name='webview_devtools_remote_'+pid;
  assert.ok(sockets.includes('@'+name), 'Debug WebView DevTools socket unavailable');
  port=adb('forward','tcp:0','localabstract:'+name);
  assert.match(port,/^\d+$/);
  const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(10000)})).json();
  const app=pages.filter(p=>p.type==='page' && /^https?:\/\/localhost(?:[:/]|$)/.test(p.url));
  assert.equal(app.length,1,'Expected one local Mooneva WebView');
  const url=new URL(app[0].webSocketDebuggerUrl);
  url.hostname='127.0.0.1'; url.port=port;
  socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('CDP connect timeout')),10000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connect failed'));},{once:true});
  });
  socket.addEventListener('message',e=>{
    const m=JSON.parse(e.data);
    const p=pending.get(m.id);
    if(!p)return;
    pending.delete(m.id);clearTimeout(p.timer);
    if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);
  });
}
async function evaluate(expression) {
  const id=++seq;
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},10000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true,userGesture:true}}));
  });
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(fn,label) {
  for(let i=0;i<30;i++){const v=await fn();if(v)return v;await delay(350);}
  throw Error('Screen preparation failed: '+label);
}
// CDP is used ONLY to prepare a screen through its existing UI. It is not
// TalkBack interaction evidence and never writes storage or app internals.
async function click(name,{prefix=false,selector='button,[role="tab"],[role="switch"]',optional=false}={}) {
  const fn=()=>evaluate(`(() => {
    const wanted=${JSON.stringify(name.toLowerCase())};
    const found=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>{
      const label=(e.getAttribute('aria-label')||e.innerText||e.textContent||'').trim().replace(/\\s+/g,' ').toLowerCase();
      return e.getClientRects().length && !e.disabled && (${prefix} ? label.startsWith(wanted):label===wanted);
    });
    if(found.length!==1)return false;
    found[0].click();return true;
  })()`);
  if(optional){await fn();return;}
  await wait(fn,name);await delay(500);
}
async function clickSelector(selector) {
  await wait(()=>evaluate(`(() => {const a=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&!e.disabled);if(a.length!==1)return false;a[0].click();return true;})()`),selector);
  await delay(500);
}
async function expectText(text) {
  await wait(()=>evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`),text);
}
async function screen(id) {
  await record(id,async()=>{
    // Separate output roots retain raw evidence even if another screen fails.
    tool(['android','--config','ci/accessibility/aloud.config.json','--nav','current-screen','--screen-id',id,'--talkback','focus','--talkback-max-steps','200','--no-gate','--out',join(out,id)]);
    const s=JSON.parse(await readFile(join(out,id,'android','summary.json'),'utf8'));
    const evidence=s.screens[id];
    assert.equal(evidence?.transcriptSource,'talkback-focus');
    assert.equal(evidence?.talkBackFocus?.coverage?.complete,true);
    assert.ok(evidence.utterances>0);
  });
}
async function selectWithTalkBack(name,id,check) {
  const {createInteractionSession}=await import(pathToFileURL(join(home,'src/android/talkback-interaction.mjs')).href);
  tool(['talkback','enable'],60000);
  let session;
  try {
    session=createInteractionSession({out:join(out,'interactions'),target,screen:id});
    await session.start();
    let step=await session.command('first');
    const wanted=name.toLowerCase();
    for(let i=0;i<100;i++){
      if(step.after.text.trim().toLowerCase()===wanted || step.speech.some(s=>s.text.toLowerCase().startsWith(wanted+',')))break;
      if(i===99)throw Error('TalkBack never reached '+name);
      step=await session.command('next');
    }
    const activation=await session.command('activate');
    assert.equal(activation.status,'observed');
    assert.ok(await check(),'UI state did not change after TalkBack activation');
    const speech=activation.speech.map(s=>s.text).join(' ').toLowerCase();
    // A click is not sufficient proof that state was announced.
    const native=activation.after;
    assert.ok((native.checked || native.selected || /pressed|checked|selected/.test(native.stateDescription||'')) &&
      /\b(pressed|checked|selected|on)\b/.test(speech) && !/not (pressed|checked|selected)|unselected|unchecked/.test(speech),'Selection state not verified in native evidence and speech: '+speech);
  } finally {
    try { if(session) await session.finish(); } finally { tool(['talkback','disable'],60000); }
  }
}
try {
  await attach();
  await expectText('Choose your language');
  await record('weekday-real-activation',()=>selectWithTalkBack('Sunday','weekday',()=>evaluate(
    "Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Sunday'&&e.getAttribute('aria-pressed')==='true')")));
  // Reset the fixture via the UI whether the interaction passed or failed.
  await click('Monday');
  await click('Continue'); await expectText('Your Body. Your Data. Your Device.'); await screen('privacy');
  await click('Start Tracking'); await expectText('calibrate your cycle'); await screen('calibration');
  await click('Next'); await expectText('What is your focus?'); await screen('goal');
  await click('Track Cycle',{prefix:true}); await click('Continue'); await expectText('Cycle Management'); await screen('cycle-setup');
  await click('Continue'); await expectText('Camouflage Mode'); await screen('camouflage');
  await click('Skip Tutorial'); await expectText("Here's how to get started"); await screen('get-started');
  await click("Let's Go"); await wait(()=>evaluate("!!document.querySelector('nav')"),'main navigation');
  await click('Close',{selector:'[role="dialog"] button',optional:true});
  await screen('calendar');
  await click('Period?'); await screen('period-edit');
  await clickSelector('button[aria-current="date"]:not([aria-hidden="true"])');
  await click('Done'); await screen('calendar-period');
  await clickSelector('button[aria-current="date"]:not([aria-hidden="true"])');
  if(!await evaluate("!!document.querySelector('[role=tablist]')")) await clickSelector('button[aria-current="date"]:not([aria-hidden="true"])');
  await wait(()=>evaluate("!!document.querySelector('[role=tablist]')"),'daily log');
  await screen('daily-flow');
  for(const tab of ['Mood','Body','Notes','Meds']){
    await click(tab,{selector:'[role="tab"]'}); await screen('daily-'+tab.toLowerCase());
  }
  await click('Insights',{selector:'nav button'}); await screen('insights');
  await click('Settings',{selector:'nav button'}); await screen('settings');
  await click('Reminders',{prefix:true}); await expectText('Notification Manager'); await screen('reminders');
  await click('Back'); await screen('settings-return');
  await click('Data Management',{prefix:true}); await expectText('Data Management'); await screen('data-management');
  adb('shell','input','keyevent','4'); await delay(600);
  await click('Export for Doctor',{prefix:true}); await screen('report-warning');
  await click('Generate Private Report'); await expectText('Report Preview'); await screen('clinical-report');
} catch(e) {
  results.push({id:'journey-setup',outcome:'failed',error:String(e)}); console.error(e);
} finally {
  socket?.close();
  if(port)try{adb('forward','--remove','tcp:'+port);}catch{}
  await writeFile(join(out,'summary.json'),JSON.stringify(results,null,2));
}
if(results.some(r=>r.outcome==='failed'))process.exitCode=1;
