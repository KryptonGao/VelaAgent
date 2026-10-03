import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createBrowserClient } from '../src/main/browser-client';

function fixture() {
  const worker = new Worker(new URL('./fixtures/browser-repl-worker.ts', import.meta.url));
  let sequence = 0;
  const calls: any[] = [];
  worker.on('message', message => {
    if (message.type !== 'rpc') return;
    calls.push(message);
    if (message.method === 'network') return; // Intentionally unawaited RPC fixture.
    if (message.method === 'title') { worker.postMessage({ type: 'rpc-result', id: message.id, error: {name:'BrowserHostError',code:'STALE_TAB',message:'Tab is gone'} }); return; }
    worker.postMessage({ type: 'rpc-result', id: message.id, value: message.method === 'tabs.open' ? { id: 'tab-1' } : 'ok' });
  });
  return { worker, calls, run: (code: string, options = {}, full = false) => new Promise<any>( (resolve, reject) => {
    const invocationId = `inv-${++sequence}`;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fixture timed out')); }, 3000);
    const receive = (message: any) => { if (message.type === 'result' && message.invocationId === invocationId) { cleanup(); resolve(full ? message : message.content); } };
    const cleanup = () => { clearTimeout(timer); worker.off('message', receive); };
    worker.on('message', receive);
    worker.postMessage({ type: 'execute', invocationId, code, ...options });
  }) };
}
test('persistent variables, TLA, separate console and first-call skill', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  const first = await f.run('var number = await Promise.resolve(40); console.log("hello"); number', { first: true });
  assert.match(first[0].text, /Browser Panel/);
  assert.equal(first[1].text, 'hello'); assert.equal(first[2].text, '40');
  assert.deepEqual(await f.run('number += 2'), [{ type: 'text', text: '42' }]);
});
test('syntax, declarations, synchronous exceptions and TLA rejection settle and recover', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  for (const code of ['const =', 'throw new Error("sync")', 'await Promise.reject(new Error("async"))', 'let unique = 1', 'let unique = 2']) {
    const result = await f.run(code);
    if (code !== 'let unique = 1') assert.match(result.map(x => x.text).join('\n'), /Error|Syntax|sync|async/);
    assert.deepEqual(await f.run('1 + 1'), [{ type: 'text', text: '2' }]);
  }
});
test('browser RPC identity, frames, screenshots and stale callbacks', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  await f.run('var browser = await agent.browsers.get("iab"); var tab = await browser.tabs.open("https://example.com"); await tab.frame("frame-2").query({ref:"r1"}).fill("hi")');
  assert.equal(f.calls[1].method, 'fill'); assert.equal(f.calls[1].frameId, 'frame-2');
  assert.equal(f.calls[1].invocationId, 'inv-1');
  const image = await f.run('nodeRepl.emitImage({data:"aGVsbG8=",mimeType:"image/png"})');
  assert.deepEqual(image, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
  await f.run('setTimeout(() => browser.tabs.list().catch(() => {}), 40); undefined');
  await f.run('await new Promise(resolve => setTimeout(resolve, 100)); "done"');
  assert.equal(f.calls.length, 2);
});
test('bounded text output and rebuild notice', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  const result = await f.run('for (let i=0;i<200;i++) nodeRepl.write("x".repeat(100000)); undefined', { rebuilt: true });
  assert.match(result[0].text, /rebuilt/); assert.equal(result.length, 100);
  assert.ok(result.every(x => x.text.length <= 65536));
});
test('client emits the Host action contract', async () => {
  const calls: any[] = [];
  const agent = createBrowserClient(async request => { calls.push(request); return { tabId: 't' }; });
  const b = await agent.browsers.get('iab'); const tab = await b.tabs.get('t');
  await tab!.press('Enter'); await tab!.query({css:'input'}).press('Tab');
  assert.deepEqual(calls.map(c => [c.method,c.args]), [['tabs.get',[]],['press',[null,'Enter']],['press',[{css:'input'},'Tab']]]);
  await assert.rejects(agent.browsers.get('chrome'));
});

test('RPC error code is available to scripts and preserved in evaluator result metadata', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  await f.run('var browser = await agent.browsers.get("iab"); var tab = await browser.tabs.open("https://example.com")');
  const result = await f.run('await tab.title()', {}, true);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {isError:true,error:{name:'BrowserHostError',code:'STALE_TAB',message:'Tab is gone'}});
  assert.match(result.content[0].text, /STALE_TAB/);
  const caught = await f.run('try { await tab.title() } catch (error) { nodeRepl.write(error.code) }');
  assert.equal(caught[0].text, 'STALE_TAB');
  const sync = await f.run('throw Object.assign(new Error("oops"), {code:"SYNC_CODE"})', {}, true);
  assert.equal(sync.details.error.code, 'SYNC_CODE');
  const good = await f.run('1', {}, true); assert.equal(good.isError, false);
});

test('prior timer domain throw cannot settle or contaminate a pending invocation', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  const faults: unknown[] = []; f.worker.on('error', error => faults.push(error));
  // Arm from the second invocation so the old callback certainly fires while
  // that invocation is pending, without depending on inter-call timing.
  await f.run('var staleTimerRan = false; var releaseOldTimer; var oldTimerGate = new Promise(resolve => releaseOldTimer = resolve); oldTimerGate.then(() => setTimeout(() => { staleTimerRan = true; console.log("stale output"); throw Object.assign(new Error("old timer failure"), {code:"OLD_TIMER"}); }, 5)); undefined');
  const result = await f.run('releaseOldTimer(); await new Promise(resolve => setTimeout(resolve, 60)); nodeRepl.write(staleTimerRan); "current complete"', {}, true);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{type:'text',text:'true'}, {type:'text',text:"current complete"}]);
  assert.deepEqual(faults, []);
  const next = await f.run('21 * 2', {}, true);
  assert.equal(next.isError, false); assert.deepEqual(next.content, [{type:'text',text:'42'}]);
});

test('early rejection settles once and late TLA evaluator completion cannot affect next call', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  const results: any[] = [];
  f.worker.on('message', message => { if (message.type === 'result') results.push(message); });
  const first = await f.run('var lateEvaluatorRan = false; setTimeout(() => Promise.reject(new Error("early rejection")), 5); await new Promise(resolve => setTimeout(resolve, 60)); lateEvaluatorRan = true; "old completion"', {}, true);
  assert.equal(first.isError, true); assert.match(first.details.error.message, /early rejection/);
  const second = await f.run('await new Promise(resolve => setTimeout(resolve, 120)); nodeRepl.write(lateEvaluatorRan); "new completion"', {}, true);
  assert.equal(second.isError, false);
  assert.deepEqual(second.content, [{type:'text',text:'true'},{type:'text',text:'new completion'}]);
  assert.deepEqual(results.map(result => result.invocationId), ['inv-1','inv-2']);
  assert.deepEqual(await f.run('2 + 2'), [{type:'text',text:'4'}]);
});

test('finish rejects unawaited RPC without contaminating next invocation', async t => {
  const f = fixture(); t.after(() => f.worker.terminate());
  await f.run('var browser = await agent.browsers.get("iab"); var tab = await browser.tabs.open("https://example.com"); tab.network(); undefined');
  const next = await f.run('await new Promise(resolve => setTimeout(resolve, 60)); "still usable"', {}, true);
  assert.equal(next.isError, false);
  assert.deepEqual(next.content, [{type:'text',text:'still usable'}]);
});
