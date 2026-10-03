import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
const workers: FakeWorker[] = [];
class Port extends EventEmitter {
  peer!: Port; closed = false;
  postMessage(data: any) { if (!this.closed) queueMicrotask(() => this.peer.emit('message', {data})); }
  start() {} close() { this.closed = true; }
}
class FakeWorker extends EventEmitter {
  port!: Port; killed = false;
  postMessage(_message: unknown, ports: Port[]) {
    this.port = ports[0]!;
    this.port.on('message', ({data}) => {
      if (data.type !== 'execute') return;
      if (data.code === 'hang') return;
      if (data.code === 'crash') { this.emit('exit', 1); return; }
      this.port.postMessage({type:'rpc',id:1,invocationId:data.invocationId,method:'tabs.list',args:[]});
      setTimeout(() => this.port.postMessage({type:'result',invocationId:data.invocationId,content:[{type:'text',text: data.rebuilt ? 'rebuilt' : 'ok'}]}), 15);
    });
  }
  kill() { this.killed = true; }
}
mock.module('electron', { namedExports: {
  utilityProcess: {fork: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }},
  MessageChannelMain: class { port1 = new Port(); port2 = new Port(); constructor() { this.port1.peer=this.port2; this.port2.peer=this.port1; } },
} });
const { BrowserReplManager } = await import('../src/main/browser-repl');
function fixture() {
  const contexts = new Set<any>(); const events: string[] = [];
  const endings: ('complete' | 'cancel' | undefined)[] = [];
  let windowId = 7; const windows: number[] = [];
  const manager = new BrowserReplManager({
    resolveWindow: () => windowId,
    beginInvocation: context => { contexts.add(context); windows.push(context.windowId); events.push(`begin:${context.invocationId}`); return reason => { endings.push(reason); contexts.delete(context); events.push(`end:${context.invocationId}`); }; },
    invoke: async context => { assert.ok(contexts.has(context)); events.push(`rpc:${context.invocationId}`); return []; },
  }, '/worker.mjs');
  let id = 0;
  return { manager, events, endings, windows, setWindow: (id: number) => { windowId = id; }, run: (code = 'ok', agentId = 'a', options = {}) => manager.execute({conversationId:'c',agentId,turnId:'t',invocationId:String(++id),code,...options}) };
}
test('whole conversation invocations serialize across agent contexts', async () => {
  const f=fixture(); try {
    await Promise.all([f.run(), f.run('ok','b')]);
    assert.deepEqual(f.events, ['begin:1','rpc:1','end:1','begin:2','rpc:2','end:2']);
  } finally { f.manager.dispose(); }
});
test('timeout, abort, crash revoke and kill; next invocation rebuilds', async () => {
  const f=fixture(); try {
    await assert.rejects(f.run('hang','a',{timeoutMs:10}), /timed out/);
    assert.ok(workers.at(-1)!.killed); assert.equal(f.events.at(-1),'end:1');
    assert.equal(f.endings.at(-1), 'cancel');
    assert.equal((await f.run()).content[0]!.text, 'rebuilt');
    assert.equal(f.endings.at(-1), 'complete');
    const controller = new AbortController(); const task=f.run('hang','a',{signal:controller.signal});
    setTimeout(() => controller.abort(),10); await assert.rejects(task);
    assert.equal(f.endings.at(-1), 'cancel');
    await assert.rejects(f.run('crash'), /exited/);
    assert.equal(f.endings.at(-1), 'cancel');
    assert.equal((await f.run()).content[0]!.text, 'rebuilt');
  } finally { f.manager.dispose(); }
});
test('reset isolates agents; closeWindow and dispose reject running calls', async () => {
  const f=fixture(); await f.run(); await f.run('ok','b');
  const a=workers.at(-2)!; const b=workers.at(-1)!;
  await f.manager.reset({conversationId:'c',agentId:'a'});
  assert.ok(a.killed); assert.equal(b.killed,false);
  const task=f.run('hang','b'); setTimeout(() => f.manager.closeWindow(7),10);
  await assert.rejects(task,/window closed/); assert.ok(b.killed);
  const task2=f.run('hang'); setTimeout(() => f.manager.dispose(),10);
  await assert.rejects(task2,/disposed/); await assert.rejects(f.run(),/disposed/);
});
test('queued abort returns promptly without executing', async () => {
  const f=fixture(); const first=f.run('hang','a',{timeoutMs:30});
  const controller=new AbortController(); const queued=f.run('ok','b',{signal:controller.signal}); controller.abort();
  await assert.rejects(queued); await assert.rejects(first);
  assert.deepEqual(f.events,['begin:1','end:1']); f.manager.dispose();
});

test('all agents retain conversation window ownership; another conversation resolves independently', async () => {
  const f = fixture(); try {
    await f.run(); f.setWindow(9); await f.run(); await f.run('ok','b');
    await f.run('ok','a',{conversationId:'other'});
    assert.deepEqual(f.windows, [7,7,7,9]);
    const root=workers.at(-3)!; const child=workers.at(-2)!; const other=workers.at(-1)!;
    f.manager.closeWindow(9);
    assert.equal(root.killed,false); assert.equal(child.killed,false); assert.equal(other.killed,true);
    f.manager.closeWindow(7); assert.equal(root.killed,true); assert.equal(child.killed,true);
    await f.run('ok','new-child'); assert.equal(f.windows.at(-1),9);
  } finally { f.manager.dispose(); }
});
test('conversation window binding survives all resets and worker faults', async () => {
  const f = fixture(); try {
    await f.run(); f.setWindow(9);
    await f.manager.reset({conversationId:'c',agentId:'a'});
    await f.run('ok','b');
    await assert.rejects(f.run('crash','b'),/exited/);
    await f.run('ok','a');
    await f.manager.reset({conversationId:'c',agentId:'a'});
    await f.run('ok','third');
    assert.deepEqual(f.windows,[7,7,7,7,7]);
    f.manager.closeWindow(7); await f.run();
    assert.equal(f.windows.at(-1),9);
  } finally { f.manager.dispose(); }
});
