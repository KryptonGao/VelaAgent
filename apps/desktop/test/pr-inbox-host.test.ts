import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it, mock } from 'node:test';
import { PrInboxIpc } from '@vela/shared';

const handlers = new Map<string, (...args: any[]) => any>();
mock.module('electron', { namedExports: { app: {}, shell: {}, ipcMain: {
  handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
  removeHandler: (name: string) => handlers.delete(name),
} } });
const { PrInboxHost } = await import('../src/main/pr-inbox-host.ts');
it('forwards forced activity revalidation through the validated read IPC', async () => {
  let args: any[] = [];
  const host = new PrInboxHost({ activity: async (...input: any[]) => { args = input; return { headSha: 'a'.repeat(40) }; } } as any);
  host.register();
  try {
    const frame = {}; const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame });
    const target = { host: 'github.com', owner: 'Owner', repo: 'Repo', number: 128 };
    await handlers.get(PrInboxIpc.activity)!({ sender, senderFrame: frame }, target, 'comments', null, 'a'.repeat(40), null,
      { requestId: 'forced-activity', identityKey: 'github.com/alice', force: true });
    assert.equal(args[5], 'github.com/alice'); assert.ok(args[6] instanceof AbortSignal); assert.equal(args[7], true);
  } finally { host.dispose(); }
});
it('only the main frame may submit comments; read cancellation does not cancel a dispatched write', async () => {
  const calls: unknown[][] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = { comment: async (...args: unknown[]) => { calls.push(args); await gate; return { id: 'IC_1' }; } };
  const host = new PrInboxHost(service as any); host.register();
  try {
    const frame = {}; const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame });
    const event = { sender, senderFrame: frame };
    const options = { requestId: 'write1', identityKey: 'github.com/alice' };
    const target = { host: 'github.com', owner: 'Owner', repo: 'Repo', number: 128 };
    const invoke = handlers.get(PrInboxIpc.comment)!;
    assert.throws(() => invoke({ ...event, senderFrame: {} }, target, 'body', options), /主页面/);
    assert.throws(() => invoke(event, target, 'body', { ...options, requestId: '../bad' }), /参数/);
    assert.equal(calls.length, 0);
    const pending = invoke(event, target, 'body', options);
    handlers.get(PrInboxIpc.cancel)!(event, 'write1'); sender.emit('destroyed');
    release(); assert.deepEqual(await pending, { id: 'IC_1' });
    assert.deepEqual(calls[0], [target, 'body', 'github.com/alice', 'write1']);
  } finally { host.dispose(); }
  assert.equal(handlers.size, 0);
});
it('response IPC is main-frame only, reports a missing service, and routes validated writes', async () => {
  const calls: Array<[string, unknown[]]> = [];
  const responses = {
    prepare: async (...args: unknown[]) => { calls.push(['prepare', args]); return { threads: [] }; },
    start: async (...args: unknown[]) => { calls.push(['start', args]); return { id: 'run1' }; },
    publish: async (...args: unknown[]) => { calls.push(['publish', args]); return { push: { state: 'pushed' } }; },
    runsFor: (...args: unknown[]) => { calls.push(['runs', args]); return []; },
    discard: async (...args: unknown[]) => { calls.push(['discard', args]); return { id: 'run1' }; },
  };
  const host = new PrInboxHost({} as any); host.register();
  try {
    const frame = {}; const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame });
    const event = { sender, senderFrame: frame };
    const target = { host: 'github.com', owner: 'Owner', repo: 'Repo', number: 128 };
    const options = { requestId: 'req1', identityKey: 'github.com/alice' };
    await assert.rejects(Promise.resolve().then(() => handlers.get(PrInboxIpc.responseRuns)!(event, target)), /尚未就绪/);
    host.setResponses(responses as any);
    assert.throws(() => handlers.get(PrInboxIpc.responseStart)!({ ...event, senderFrame: {} }, {}, options), /主页面/);
    assert.throws(() => handlers.get(PrInboxIpc.responseStart)!(event, {}, { ...options, requestId: '../bad' }), /参数/);
    assert.throws(() => handlers.get(PrInboxIpc.responsePublish)!(event, { runId: 'r', requestId: 'ok', identityKey: 'not-an-identity' }), /参数/);
    assert.throws(() => handlers.get(PrInboxIpc.responseRuns)!(event, { ...target, host: 'evil.test' }));
    assert.equal(calls.length, 0, 'invalid calls never reach the service');
    await handlers.get(PrInboxIpc.responsePrepare)!(event, target, options);
    assert.equal(calls[0]![0], 'prepare'); assert.equal(calls[0]![1][1], 'github.com/alice'); assert.ok(calls[0]![1][2] instanceof AbortSignal);
    await handlers.get(PrInboxIpc.responseStart)!(event, { threadIds: ['a'] }, options);
    assert.deepEqual(calls[1], ['start', [{ threadIds: ['a'] }, 'github.com/alice', 'req1']]);
    const publish = { runId: 'run1', requestId: 'req2', identityKey: 'github.com/alice', tipSha: 'a'.repeat(40), replies: [] };
    await handlers.get(PrInboxIpc.responsePublish)!(event, publish);
    assert.deepEqual(calls[2], ['publish', [publish]]);
    await handlers.get(PrInboxIpc.responseDiscard)!(event, 'run1', true);
    assert.deepEqual(calls[3], ['discard', ['run1', true]]);
  } finally { host.dispose(); }
  assert.equal(handlers.size, 0);
});
