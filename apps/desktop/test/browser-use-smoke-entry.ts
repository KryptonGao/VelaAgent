/** Dedicated fixture, not the product main or renderer. Bundled by the .mjs runner. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, session, webContents, ipcMain, nativeImage } from 'electron';
import { BrowserHost } from '../src/main/browser-host';
import { BrowserCdp } from '../src/main/browser-cdp';
import { BrowserReplManager } from '../src/main/browser-repl';
const temporary = process.env.VELA_SMOKE_TEMP!;
app.setPath('userData', join(temporary, 'electron'));
app.commandLine.appendSwitch('site-per-process');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => any, label: string) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  throw new Error(`Timed out: ${label}`);
}
const clients = new Set<any>();
const source = join(temporary, 'fixture.js');
writeFileSync(source, 'window.fixtureVersion="one";document.querySelector("#hmr").textContent="one";');
let base = '';
const server = createServer((req, res) => {
  if (req.url === '/fail') { req.socket.destroy(); return; }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.url?.split('?')[0] === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(readFileSync(source)); return; }
  if (req.url === '/api') { res.end('ok'); return; }
  if (req.url === '/frame') {
    res.end('<button onclick="window.clicked=true">Frame action</button><input aria-label="Frame input"><script>window.frameGlobal=73</script>'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Browser use fixture</title><style>body{margin:8px}iframe{width:300px;height:100px}</style>
  <form onsubmit="event.preventDefault();document.cookie='login=yes;path=/';localStorage.login='yes';window.loggedIn=true">
  <input aria-label="Username"><button>Login</button></form><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>
  <button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button><button id="replace">Replace me</button>
  <div id="shadow"></div><div id="hmr"></div><iframe src="/frame"></iframe><iframe src="${base.replace('127.0.0.1', 'localhost')}/frame"></iframe>
  <script>window.appGlobal={answer:42};window.domMarker=Math.random();document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button onclick="window.shadowClicked=true">Shadow action</button>';
  new EventSource('/events').onmessage=()=>{const s=document.createElement('script');s.src='/fixture.js?t='+Date.now();document.head.append(s)};</script><script src="/fixture.js"></script>`);
});
let host: BrowserHost; let repl: BrowserReplManager; let win: BrowserWindow;
let sequence = 0;
const failures: string[] = [];
const partition = 'persist:vela-ui-browser';
async function run() {
  await new Promise<void>(resolve => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await app.whenReady();
  host = new BrowserHost(guest => new BrowserCdp(guest), session.fromPartition(partition));
  repl = new BrowserReplManager(host, process.env.VELA_SMOKE_WORKER!);
  const preload = join(temporary, 'preload.cjs');
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{bind:(tabId,guestId)=>ipcRenderer.invoke('fixture:bind',tabId,guestId),subscribe:fn=>ipcRenderer.on('fixture:state',(_,s)=>fn(s))});`);
  win = new BrowserWindow({ show: false, width: 1050, height: 820, webPreferences: { preload, webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  host.registerWindow(win.id, win.webContents);
  win.webContents.on('will-attach-webview', (_event, preferences, params) => {
    assert.equal(params.partition, partition); delete preferences.preload;
    preferences.sandbox = true; preferences.contextIsolation = true; preferences.nodeIntegration = false;
  });
  win.webContents.on('did-attach-webview', (_event, guest) => host.registerGuest(win.id, guest));
  ipcMain.handle('fixture:bind', (event, tabId, guestId) => host.command(win.id, event.sender, event.senderFrame === event.sender.mainFrame, { type: 'bind', tabId, guestId }));
  const observedActions: { tabId: string; cursor: NonNullable<ReturnType<BrowserHost['state']>['tabs'][number]['agentCursor']> }[] = [];
  let lastCursorSequence = 0;
  host.subscribe((_id, state) => {
    for (const tab of state.tabs) if (tab.agentCursor && tab.agentCursor.sequence > lastCursorSequence) {
      lastCursorSequence = tab.agentCursor.sequence; observedActions.push({tabId: tab.id, cursor: tab.agentCursor});
    }
    win.webContents.send('fixture:state', state);
  });
  const renderer = join(temporary, 'renderer.html');
  writeFileSync(renderer, `<!doctype html><style>html,body{margin:0}webview{width:1024px;height:768px}</style><script>
  const views=new Map();window.fixture.subscribe(state=>{for(const tab of state.tabs){if(views.has(tab.id))continue;const v=document.createElement('webview');v.setAttribute('partition','${partition}');v.src='about:blank';views.set(tab.id,v);v.addEventListener('dom-ready',()=>window.fixture.bind(tab.id,v.getWebContentsId()));document.body.append(v)}for(const [id,v] of views)if(!state.tabs.some(t=>t.id===id)){v.remove();views.delete(id)}});
  </script>`);
  await win.loadFile(renderer);
  const command = (input: any) => host.command(win.id, win.webContents, true, input);
  await command({ type: 'activate', conversationId: 'main' });
  await command({ type: 'open', id: 'manual', url: 'about:blank' });
  await until(() => host.registry.list(win.id).find(t => t.id === 'manual')?.guestId, 'blank guest bind');
  const guest = webContents.fromId(host.registry.list(win.id)[0].guestId!)!;
  assert.equal(guest.getURL(), 'about:blank');
  assert.equal(guest.session, session.fromPartition(partition));
  assert.notEqual(guest.session, win.webContents.session);
  const preferences = guest.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.preload, undefined);
  await guest.loadURL(base);
  // Manual input uses Chromium input rather than automation or setting the login cookie.
  await guest.executeJavaScript(`document.querySelector('input').focus()`);
  guest.insertText('manual-user');
  await guest.executeJavaScript('document.querySelector("form").requestSubmit()');
  await until(() => guest.executeJavaScript('window.loggedIn'), 'manual login');
  const execute = (code: string, agentId = 'main', conversationId = 'main', options: any = {}) => repl.execute({ code, agentId, conversationId, turnId: 'smoke', invocationId: `smoke-${++sequence}`, timeoutMs: 6000, ...options });
  const text = (result: any) => result.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
  const check = async (code: string, expected: RegExp, agent = 'main', conversation = 'main') => { const output = text(await execute(code, agent, conversation)); assert.match(output, expected, code); return output; };
  await check(`var browser=await agent.browsers.get('iab');var tab=await browser.tabs.get('manual');nodeRepl.write(await tab.snapshot());`, /Username/);
  await check(`nodeRepl.write(await tab.evaluate('({cookie:document.cookie,storage:localStorage.login,user:document.querySelector("input").value,answer:appGlobal.answer})'));`, /manual-user/);
  assert.equal(await guest.executeJavaScript('document.cookie'), 'login=yes');
  assert.equal(await guest.executeJavaScript('localStorage.login'), 'yes');
  await check(`await tab.query({role:'textbox',name:'Username'}).fill('filled');await tab.query({role:'textbox',name:'Username'}).type('-typed');await tab.query({role:'textbox',name:'Username'}).press('Enter');await tab.query({role:'combobox',name:'Choice'}).selectOption('b');await tab.query({text:'Shadow action'}).click();nodeRepl.write(await tab.evaluate('({user:document.querySelector("input").value,choice:document.querySelector("select").value,shadow:shadowClicked})'));`, /shadow: true/);
  if (await guest.executeJavaScript('document.querySelector("input").value') !== 'filled-typed') failures.push('CDP fill/type did not change Username');
  assert.equal(await guest.executeJavaScript('document.querySelector("select").value'), 'b');
  assert.equal(await guest.executeJavaScript('window.shadowClicked'), true);
  assert.ok(observedActions.some(a => a.cursor.kind === 'type'));
  assert.ok(observedActions.some(a => a.cursor.kind === 'press'));
  assert.ok(observedActions.some(a => a.cursor.kind === 'select'));
  assert.equal(observedActions.at(-1)?.cursor.kind, 'click');
  const retainedCursor=host.state(win.id).tabs.find(t=>t.id==='manual')!.agentCursor!;
  await pause(1900);
  const idleCursor=host.state(win.id).tabs.find(t=>t.id==='manual')!.agentCursor!;
  assert.equal(idleCursor.sequence,retainedCursor.sequence);assert.equal(idleCursor.x,retainedCursor.x);
  assert.equal(idleCursor.active,false,'REPL completion retains the last pointer after action feedback expires');
  await check(`var snap=await tab.snapshot();nodeRepl.write(snap.frames);`, /localhost/);
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const beforeFrameActions = observedActions.length;
    const frameOutput = await check(`var frame=tab.frame((await tab.snapshot()).frames.find(f=>f.url.includes('${hostname}')&&f.url.endsWith('/frame')).id);await frame.query({text:'Frame action'}).click();await frame.query({role:'textbox',name:'Frame input'}).fill('frame-text');nodeRepl.write(await frame.evaluate('({clicked:window.clicked,value:document.querySelector("input").value,global:frameGlobal})'));`, /global: 73/);
    if (!frameOutput.includes('clicked: true')) failures.push(`${hostname} iframe click did not reach button`);
    if (!frameOutput.includes("value: 'frame-text'")) failures.push(`${hostname} iframe fill did not change input`);
    const frameCursor = observedActions.slice(beforeFrameActions).find(a => a.cursor.kind === 'click')?.cursor;
    assert.ok(frameCursor, `${hostname} iframe reports visible action`);
    const expected = await guest.executeJavaScript(`(() => { const frame=Array.from(document.querySelectorAll('iframe')).find(f=>new URL(f.src).hostname===${JSON.stringify(hostname)});const r=frame.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}; })()`);
    const inside = frameCursor.x >= expected.left && frameCursor.x <= expected.right && frameCursor.y >= expected.top && frameCursor.y <= expected.bottom;
    assert.ok(inside, `${hostname} cursor maps inside the real root iframe bounds: ${JSON.stringify({frameCursor,expected})}`);
  }
  assert.ok((await guest.debugger.sendCommand('Target.getTargets')).targetInfos.some((t: any) => t.type === 'iframe'), 'cross-site frame must be an OOPIF');
  const imageResult = await execute(`nodeRepl.emitImage(await tab.screenshot());`);
  const image = imageResult.content.find(x => x.type === 'image') as any;
  assert.ok(image); assert.equal(image.mimeType, 'image/png');
  if (process.env.VELA_BROWSER_USE_SMOKE_CAPTURE_DIR) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(process.env.VELA_BROWSER_USE_SMOKE_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.VELA_BROWSER_USE_SMOKE_CAPTURE_DIR, 'browser-use-before-hmr.png'), Buffer.from(image.data, 'base64'));
  }
  const viewport = await guest.executeJavaScript('({width:innerWidth*devicePixelRatio,height:innerHeight*devicePixelRatio})');
  assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).getSize(), viewport);
  await check(`await tab.evaluate('console.log("smoke-console");fetch("/api")');await new Promise(r=>setTimeout(r,100));nodeRepl.write(await tab.console());nodeRepl.write(await tab.network());`, /smoke-console/);
  await check(`nodeRepl.write(await tab.network());`, /\/api/);
  console.log(failures.length ? 'FAIL forms/frames: ' + failures.join('; ') : 'PASS manual login → same guest REPL forms/shadow/frames/OOPIF/globals/image/console/network');
  await check(`await tab.query({css:'.duplicate'}).click()`, /AMBIGUOUS_LOCATOR/);
  await check(`var oldRef=(await tab.snapshot()).text.match(/\\[([^\\]]+)\\] button Replace me/)[1];await tab.evaluate('document.querySelector("#replace").outerHTML="<button id=replace>Replacement</button>"');await tab.query({ref:oldRef}).click();`, /STALE_REF/);
  await execute(`var binding=11;`);
  await check(`nodeRepl.write(typeof binding);var binding=22;`, /undefined/, 'child');
  await check(`nodeRepl.write(binding)`, /11/);
  await check(`nodeRepl.write(binding)`, /22/, 'child');
  const ordered = await Promise.all([execute(`await new Promise(r=>setTimeout(r,100));await tab.evaluate('window.order=1')`), execute(`var childTab=await (await agent.browsers.get('iab')).tabs.get('manual');nodeRepl.write(await childTab.evaluate('window.order'));`, 'child')]);
  assert.match(text(ordered[1]), /1/);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Instrument invocation admission only; execution and workers remain real.
  const originalBegin = host.beginInvocation.bind(host); const admitted: string[] = [];
  host.beginInvocation = context => { admitted.push(context.conversationId); if (new Set(admitted).size === 2) release(); return originalBegin(context); };
  const parallel = [execute(`await new Promise(r=>setTimeout(r,500));`, 'main', 'main'), execute(`await new Promise(r=>setTimeout(r,500));`, 'main', 'background')];
  await Promise.race([gate, pause(400).then(() => { throw new Error('Cross-conversation execution serialized'); })]);
  await Promise.all(parallel); host.beginInvocation = originalBegin;
  const focus = host.state(win.id).focusRequest; const wasFocused = win.isFocused();
  await check(`var bg=await agent.browsers.get('iab');var bgTab=await bg.tabs.open('about:blank');await bg.tabs.select(bgTab.id);nodeRepl.write(await bg.tabs.list());`, /about:blank/, 'main', 'background');
  assert.deepEqual(host.state(win.id).focusRequest, focus); assert.equal(win.isFocused(), wasFocused);
  await assert.rejects(execute('while(true){}', 'main', 'main', { timeoutMs: 250 }), /timed out/);
  await check('nodeRepl.write(typeof binding)', /rebuilt[\s\S]*undefined/);
  const controller = new AbortController(); const stopped = execute('await new Promise(()=>{})', 'main', 'main', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100); await assert.rejects(stopped, /abort/i);
  await check(`nodeRepl.write('after-stop')`, /after-stop/);
  await assert.rejects(execute(`process.exit(7)`), /worker exited/);
  await check(`var browser=await agent.browsers.get('iab');var tab=await browser.tabs.get('manual');nodeRepl.write('after-crash')`, /rebuilt[\s\S]*after-crash/);
  await execute(`var late='pending';setTimeout(()=>tab.evaluate('window.illegalLate=true').then(()=>late='allowed',()=>late='rejected'),100);`);
  await pause(180); await check(`nodeRepl.write(late)`, /rejected/);
  assert.equal(await guest.executeJavaScript('window.illegalLate'), undefined);
  const guestId = guest.id;
  await repl.reset({ conversationId: 'main', agentId: 'main' });
  await check(`var browser=await agent.browsers.get('iab');var tab=await browser.tabs.get('manual');nodeRepl.write(await tab.evaluate('({cookie:document.cookie,storage:localStorage.login})'));`, /login=yes/);
  assert.equal(guest.id, guestId); assert.equal(await guest.executeJavaScript('localStorage.login'), 'yes');
  const marker = await guest.executeJavaScript('window.domMarker');
  await until(() => clients.size > 0, 'HMR SSE connection');
  const editResult = await execute(`require('node:fs').writeFileSync(${JSON.stringify(source)}, ${JSON.stringify('window.fixtureVersion="two";document.querySelector("#hmr").textContent="two";document.body.style.background="rgb(120, 200, 150)";')})`);
  assert.ok(!text(editResult).includes('Error'), text(editResult));
  assert.match(readFileSync(source, 'utf8'), /two/);
  for (const client of clients) client.write('data: update\n\n');
  await until(() => guest.executeJavaScript('window.fixtureVersion==="two"'), 'HMR code update');
  assert.equal(await guest.executeJavaScript('window.domMarker'), marker); assert.equal(guest.id, guestId);
  const hmrResult = await execute(`nodeRepl.write(await tab.snapshot());nodeRepl.write(await tab.evaluate('window.fixtureVersion'));nodeRepl.emitImage(await tab.screenshot())`);
  assert.match(text(hmrResult), /two/);
  const hmrImage = hmrResult.content.find(x => x.type === 'image') as any; assert.ok(hmrImage);
  if (process.env.VELA_BROWSER_USE_SMOKE_CAPTURE_DIR) writeFileSync(join(process.env.VELA_BROWSER_USE_SMOKE_CAPTURE_DIR, 'browser-use-after-hmr.png'), Buffer.from(hmrImage.data, 'base64'));
  assert.notEqual(hmrImage.data, image.data, 'HMR changes screenshot');
  console.log('PASS stale references/navigation errors/bindings/serial and parallel work/background/timeout/stop/crash/late RPC/reset/HMR');
  await check(`var navRef=(await tab.snapshot()).text.match(/\\[([^\\]]+)\\] textbox Username/)[1];await tab.goto(${JSON.stringify(base + '/next')});await tab.query({ref:navRef}).click();`, /STALE_REF/);
  await check(`await tab.goto(${JSON.stringify(base + '/fail')});`, /ERR_|load|failed/i);
  await check(`await tab.goto(${JSON.stringify(base)});nodeRepl.write(await tab.title());`, /Browser use fixture/);
  const pending = execute(`await tab.evaluate('new Promise(()=>{})')`);
  await pause(100); const closeStart = Date.now();
  await command({ type: 'close', tabId: 'manual' });
  assert.match(text(await pending), /tab.closed|PAGE_DESTROYED|CDP_DISPOSED/i);
  assert.ok(Date.now() - closeStart < 1500, 'close promptly rejects pending operation');
  assert.equal(guest.isDestroyed(), true);
  console.log('PASS close rejects in-flight CDP immediately');
  assert.deepEqual(failures, [], 'Backend smoke failures');
  console.log('PASS browser-use smoke complete');
}
const watchdog = setTimeout(() => { console.error('FAIL fixture deadline (80s)'); app.exit(1); }, 80000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code: number) {
  clearTimeout(watchdog); repl?.dispose(); host?.dispose();
  ipcMain.removeHandler('fixture:bind'); for (const client of clients) client.end();
  server.closeAllConnections(); server.close(); win?.destroy(); app.exit(code);
}

process.on("uncaughtException", error => { console.error("UNCAUGHT fixture", error); finish(1); });
process.on("unhandledRejection", error => { console.error("UNHANDLED fixture", error); finish(1); });
