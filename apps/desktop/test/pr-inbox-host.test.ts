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
