import { AsyncLocalStorage } from 'node:async_hooks';
import { Console } from 'node:console';
import { PassThrough, Writable } from 'node:stream';
import { start } from 'node:repl';
import { inspect } from 'node:util';
import { createRequire } from 'node:module';
import { createBrowserClient, BROWSER_SKILL, serializeBrowserError, type BrowserRpc } from './browser-client';

export interface WorkerPort { postMessage(value: unknown): void; on(event: 'message', listener: (value: any) => void): unknown; start?(): void }
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
/** Exported so Node worker_threads fixtures can exercise the exact utility worker. */
export function attachBrowserRepl(port: WorkerPort) {
  const scopes = new AsyncLocalStorage<string>();
  let active: string | undefined;
  let sequence = 0;
  let content: Content[] = [];
  let bytes = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const append = (item: Content) => {
    if (scopes.getStore() !== active || !active) return;
    const size = item.type === 'text' ? Buffer.byteLength(item.text) : item.data.length;
    if (content.length >= 100 || bytes + size > 8 * 1024 * 1024) return;
    bytes += size; content.push(item);
  };
  const text = (value: unknown) => append({ type: 'text', text: typeof value === 'string' ? value.slice(0, 65536) : inspect(value, { depth: 5, maxArrayLength: 100 }).slice(0, 65536) });
  let failure: ((error: unknown) => void) | undefined;
  const output = new Writable({ write(chunk, _encoding, callback) {
    // Node 24 routes evaluator/domain failures to REPL output, not its callback.
    // A prior invocation can still write here while a new evaluator is pending.
    if (active && scopes.getStore() === active) failure?.(new Error(String(chunk).trim()));
    callback();
  } });
  const repl = start({ input: new PassThrough(), output, terminal: false, prompt: '', useGlobal: false });
  // Node 24's domain emits the original error before REPL formats it for output.
  // Preserve metadata there; retain the output fallback for evaluator diagnostics.
  (repl as unknown as { _domain?: { prependListener(event: string, listener: (error: unknown) => void): void } })._domain?.prependListener('error', error => {
    if (active && scopes.getStore() === active) failure?.(error);
  });
  const consoleOutput = new Writable({ write(chunk, _encoding, callback) { text(String(chunk).trimEnd()); callback(); } });
  repl.context.console = new Console(consoleOutput, consoleOutput);
  repl.context.require = createRequire(import.meta.url);
  repl.context.agent = createBrowserClient((request: BrowserRpc) => {
    const invocationId = scopes.getStore();
    if (!invocationId || invocationId !== active) return Promise.reject(new Error('Browser invocation is no longer active'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject }); port.postMessage({ type: 'rpc', id, invocationId, ...request });
    });
  });
  repl.context.nodeRepl = { write: text, emitImage: (value: any) => {
    const data = typeof value?.data === 'string' ? value.data : value?.data instanceof Uint8Array ? Buffer.from(value.data).toString('base64') : undefined;
    if (!data || !/^image\/(png|jpeg|webp|gif)$/.test(value.mimeType)) throw new Error('Expected screenshot {data: base64, mimeType: image/*}');
    append({ type: 'image', data, mimeType: value.mimeType });
  } };
  // Catch background rejections without letting them terminate the utility process.
  process.on('unhandledRejection', error => { if (active && scopes.getStore() === active) failure?.(error); });
  port.on('message', raw => {
    const message = raw?.data ?? raw;
    if (message.type === 'rpc-result') {
      const entry = pending.get(message.id); pending.delete(message.id);
      if (message.error) {
        const metadata = serializeBrowserError(message.error);
        entry?.reject(Object.assign(new Error(metadata.message), metadata));
      } else entry?.resolve(message.value);
      return;
    }
    if (message.type !== 'execute' || active) return;
    active = message.invocationId; content = []; bytes = 0;
    scopes.run(active!, () => {
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return; settled = true;
        const metadata = error == null ? undefined : serializeBrowserError(error);
        if (metadata) text(`${metadata.name}${metadata.code ? ` [${metadata.code}]` : ''}: ${metadata.message}`);
        else if (value !== undefined) text(value);
        const result = content; active = undefined; failure = undefined;
        for (const entry of pending.values()) entry.reject(new Error('Browser invocation ended'));
        pending.clear();
        port.postMessage({ type: 'result', invocationId: message.invocationId, content: result, isError: !!metadata, details: { isError: !!metadata, ...(metadata ? { error: metadata } : {}) } });
      };
      failure = finish;
      try {
        if (message.cwd) { process.chdir(message.cwd); repl.context.require = createRequire(`${message.cwd}/browser-repl.cjs`); }
        if (message.first) text(BROWSER_SKILL);
        if (message.rebuilt) text('REPL context rebuilt after interruption or worker failure; prior variables are gone.');
        repl.eval(`${message.code}\n`, repl.context, 'browser-repl', (error, value) => finish(error, value));
      } catch (error) { finish(error); }
    });
  });
  port.start?.();
}
const parent = (process as unknown as { parentPort?: WorkerPort }).parentPort;
parent?.on('message', (event: any) => { if (event.ports?.[0]) attachBrowserRepl(event.ports[0]); });
