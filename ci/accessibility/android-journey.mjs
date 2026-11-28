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
  try { const details=await fn(); results.push({id, outcome:'observed',...details}); console.log('OBSERVED '+id); }
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
async function cdp(method,params) {
  const id=++seq;
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},10000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params}));
  });
  return result;
}
async function evaluate(expression) {
  const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
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
      const clone=e.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach(n=>n.remove());
      const label=(e.getAttribute('aria-label')||clone.textContent||'').trim().replace(/\\s+/g,' ').toLowerCase();
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
// Keep the original traversal and its raw evidence. Retry only specific
// capture failures; a reduced-motion-only observation is not a default-mode pass.
async function captureScreen(id,root) {
  await mkdir(root,{recursive:true});
  const args=['android','--config','ci/accessibility/aloud.config.json','--nav','current-screen','--screen-id',id,'--talkback','focus','--tts','logging','--talkback-max-steps','200','--no-gate','--out',root];
  const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:480000,maxBuffer:8*1024*1024});
  const log=[r.stdout,r.stderr,r.error?.message].filter(Boolean).join('\n');
  console.log(log);
  await writeFile(join(root,'capture.log'),log);
  if(r.error || r.status!==0) {
    const e=new Error('Aloud capture failed for '+id+': '+(r.error?.message || r.status));
    e.captureLog=log;
    throw e;
  }
  const s=JSON.parse(await readFile(join(root,'android','summary.json'),'utf8'));
  const evidence=s.screens[id];
  assert.equal(evidence?.transcriptSource,'talkback-focus');
  assert.equal(evidence?.talkBackFocus?.coverage?.complete,true);
  assert.ok(evidence.utterances>0);
  assert.equal(evidence.talkBackFocus.speechSource,'logging-tts');
}
async function motionEvidence() {
  return evaluate("({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches, animations:document.getAnimations().map(a=>({name:a.animationName||a.constructor.name, state:a.playState, iterations:String(a.effect?.getTiming().iterations)}))})");
}
async function screen(id) {
  await record(id,async()=>{
    const root=join(out,id);
    await mkdir(root,{recursive:true});
    const before=await motionEvidence();
    await writeFile(join(root,'motion-before.json'),JSON.stringify(before,null,2));
    try {
      await captureScreen(id,root);
      return {captureMode:'default',attempts:1};
    } catch(first) {
      const log=first.captureLog||'';
      const missingTree=/a11y-dump\.xml: No such file or directory/i.test(log);
      const missingFocus=/no matching focus and speech evidence/i.test(log);
      if(!missingTree && !missingFocus)throw first;
      console.warn('Original capture failed for '+id+'; retaining evidence and retrying '+(missingTree?'with reduced motion':'in default mode'));
      await writeFile(join(root,'first-failure.txt'),String(first)+'\n'+log);
      // Stop any TalkBack session left by the failed capture before retrying.
      tool(['talkback','disable'],60000);
      if(missingTree) {
        // Record the underlying uiautomator diagnostic without trusting a stale dump.
        const diagnostic=spawnSync('adb',['shell','uiautomator','dump','/sdcard/mooneva-diagnostic.xml'],{encoding:'utf8',timeout:25000});
        await writeFile(join(root,'uiautomator-diagnostic.txt'),[diagnostic.stdout,diagnostic.stderr,diagnostic.error?.message].filter(Boolean).join('\n'));
        try {adb('shell','rm','-f','/sdcard/mooneva-diagnostic.xml');}catch{}
        const retryRoot=join(root,'reduced-motion-retry');
        await mkdir(retryRoot,{recursive:true});
        try {
          await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
          await delay(1200);
          const after=await motionEvidence();
          await writeFile(join(retryRoot,'motion.json'),JSON.stringify(after,null,2));
          assert.equal(after.reduced,true,'WebView did not apply reduced-motion preference');
          await captureScreen(id,retryRoot);
          // A successful alternate configuration is useful evidence, but
          // leave CI failing until the original mode is validated.
          throw new Error('Default capture failed; reduced-motion traversal observed successfully (see reduced-motion-retry)');
        } finally {
          await cdp('Emulation.setEmulatedMedia',{features:[]});
          await delay(500);
        }
      }
      await delay(1200);
      await captureScreen(id,join(root,'default-retry'));
      return {captureMode:'default-retry',attempts:2,firstFailure:String(first)};
    }
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
// Native focus and activation are the input path; CDP only observes public UI.
// A failed native action is recorded before fixture recovery for later captures.
async function activateNative(name,id,check,{selection=false,typeText}={}) {
  const {createInteractionSession}=await import(pathToFileURL(join(home,'src/android/talkback-interaction.mjs')).href);
  tool(['talkback','enable'],60000);
  let session;
  try {
    session=createInteractionSession({out:join(out,'interactions'),target,screen:id});
    await session.start();
    const wanted=name.trim().toLowerCase().replace(/\s+/g,' ');
    const normalize=s=>String(s??'').trim().toLowerCase().replace(/\s+/g,' ');
    let step=await session.command('first');
    for(let i=0;i<150;i++){
      const native=normalize(step.after?.text);
      const spoken=(step.speech??[]).map(s=>normalize(s.text)).join(' ');
      const isEditor=typeText===undefined || /edit|text field|text box|text input/i.test(spoken+' '+String(step.after?.className??''));
      if((native===wanted || spoken.includes(wanted)) && spoken.includes(wanted) && isEditor)break;
      if(i===149)throw Error('TalkBack never announced '+name);
      step=await session.command('next');
    }
    const action=await session.command('activate');
    assert.equal(action.status,'observed','Native activation not observed');
    if(selection) {
      const native=action.after;
      const speech=action.speech.map(s=>s.text).join(' ').toLowerCase();
      assert.ok((native.checked || native.selected || /pressed|checked|selected/.test(native.stateDescription||'')) &&
        /\b(pressed|checked|selected|on)\b/.test(speech) && !/not (pressed|checked|selected)|unselected|unchecked|\boff\b/.test(speech),
        'Selected state not verified in native evidence and speech: '+speech);
    }
    if(typeText!==undefined){
      await wait(()=>evaluate("document.activeElement?.matches('textarea[aria-label=\"Notes\"]')"),'native Notes edit focus');
      // Synthetic hardware keyboard input after TalkBack focused the editor.
      // This is not a gesture or a test of the soft keyboard.
      adb('shell','input','text',typeText.replace(/ /g,'%s'));
    }
    await wait(check,'UI effect of TalkBack action '+id);
    return {input:'talkback-native',keyboardInput:typeText!==undefined?'adb-hardware-text':undefined};
  } finally {
    try {if(session)await session.finish();} finally {tool(['talkback','disable'],60000);}
  }
}
const todaySelector='button[aria-current="date"]:not([aria-hidden="true"])';
const todayAttribute=attr=>evaluate('document.querySelector('+JSON.stringify(todaySelector)+')?.getAttribute('+JSON.stringify(attr)+')');
const periodEditOpen=()=>evaluate("!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Done' && e.getClientRects().length)");
const tabSelected=name=>evaluate("[...document.querySelectorAll('[role=tab]')].some(e=>e.textContent.trim()==="+JSON.stringify(name)+" && e.getAttribute('aria-selected')==='true')");
async function nativeTab(name,id){
  return activateNative(name,id,()=>tabSelected(name),{selection:true});
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
  await record('period-open-native',()=>activateNative('Period?','period-open-native',periodEditOpen));
  if(!await periodEditOpen()){console.warn('Fixture recovery: open period editor via CDP');await click('Period?');}
  await screen('period-edit');
  await record('period-day-native',async()=>{
    assert.equal(await todayAttribute('aria-pressed'),'false','Expected a fresh unselected fixture date');
    return activateNative(await todayAttribute('aria-label'),'period-day-native',async()=>await todayAttribute('aria-pressed')==='true',{selection:true});
  });
  if(await todayAttribute('aria-pressed')!=='true'){console.warn('Fixture recovery: select period day via CDP');await clickSelector(todaySelector);}
  await record('period-save-native',()=>activateNative('Done','period-save-native',async()=>!await periodEditOpen() && (await todayAttribute('aria-label'))?.includes('Period')));
  if(await periodEditOpen()){console.warn('Fixture recovery: save period via CDP');await click('Done');}
  await screen('calendar-period');
  await clickSelector('button[aria-current="date"]:not([aria-hidden="true"])');
  if(!await evaluate("!!document.querySelector('[role=tablist]')")) await clickSelector('button[aria-current="date"]:not([aria-hidden="true"])');
  await wait(()=>evaluate("!!document.querySelector('[role=tablist]')"),'daily log');
  await screen('daily-flow');
  for(const tab of ['Mood','Body','Notes','Meds']){
    await click(tab,{selector:'[role="tab"]'}); await screen('daily-'+tab.toLowerCase());
  }
  // Keep the screen captures above independent of the functional tests below.
  await record('daily-functional-native',async()=>{
    await nativeTab('Body','native-body-tab');
    const symptom=await evaluate("document.querySelector('#daily-log-panel-symptoms button[aria-pressed=false]')?.textContent.trim()");
    assert.ok(symptom,'No unselected built-in symptom');
    const symptomSelected=()=>evaluate("[...document.querySelectorAll('#daily-log-panel-symptoms button')].some(e=>e.textContent.trim()==="+JSON.stringify(symptom)+" && e.getAttribute('aria-pressed')==='true')");
    await activateNative(symptom,'native-symptom-select',symptomSelected,{selection:true});
    await nativeTab('Notes','native-notes-tab');
    const note='Accessibility test note';
    const noteSaved=()=>evaluate("document.querySelector('textarea[aria-label=\"Notes\"]')?.value==="+JSON.stringify(note));
    await activateNative('Notes','native-note-entry',noteSaved,{typeText:note});
    await delay(900); // app debounces saves by 600 ms
    await activateNative('Close','native-close-log',()=>evaluate("!document.querySelector('[role=tablist]')"));
    // Existing data opens a day preview first; a second native activation edits it.
    await activateNative(await todayAttribute('aria-label'),'native-reopen-day',async()=>await todayAttribute('aria-pressed')==='true');
    if(!await evaluate("!!document.querySelector('[role=tablist]')")){
      await activateNative(await todayAttribute('aria-label'),'native-reopen-editor',()=>evaluate("!!document.querySelector('[role=tablist]')"));
    }
    await nativeTab('Body','native-check-symptom-tab');
    assert.ok(await symptomSelected(),'Symptom not retained after reopening day');
    await nativeTab('Notes','native-check-note-tab');
    assert.ok(await noteSaved(),'Note not retained after reopening day');
    return {input:'talkback-native and synthetic keyboard',savedAfterReopen:true};
  });
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
