import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { runGh } from '../src/gh-run.ts';
let directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-gh-run-'));
  const source = `#!${process.execPath}\nconst args=process.argv.slice(2);const input=[];process.stdin.on('data',d=>input.push(d));process.stdin.on('end',()=>{ const mode=args[0];if(mode==='wait'){setTimeout(()=>{process.stdout.write('done');},150);return;}if(mode==='hang'){setInterval(()=>{},100);return;}if(mode==='big'){process.stdout.write('新'.repeat(100));return;}if(mode==='failure'){process.stderr.write('checks pending');process.exitCode=8;return;}process.stdout.write(JSON.stringify({args,input:Buffer.concat(input).toString(),host:process.env.GH_HOST,pager:process.env.GH_PAGER,prompt:process.env.GH_PROMPT_DISABLED}));});`;
  const path = join(directory, 'gh'); await writeFile(path, source); await chmod(path, 0o755);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });
const env = () => ({ PATH: directory, GH_HOST: 'github.com' });
describe('gh executor', () => {
  it('passes literal argv, stdin and process-scoped environment without shell expansion', async () => {
    const result = await runGh(null, ['echo', '$(do-not-execute)', 'value with spaces'], 1000, 'body $value\n', { env: env() });
    assert.equal(result.exitCode, 0); assert.equal(result.ok, true);
    const output = JSON.parse(result.stdout); assert.deepEqual(output.args, ['echo', '$(do-not-execute)', 'value with spaces']);
    assert.equal(output.input, 'body $value\n'); assert.equal(output.host, 'github.com'); assert.equal(output.pager, 'cat'); assert.equal(output.prompt, '1');
  });
  it('retains nonzero exit codes and stderr', async () => {
    const r = await runGh(null, ['failure'], 1000, undefined, { env: env() }); assert.equal(r.exitCode, 8); assert.equal(r.ok, false); assert.equal(r.stderr, 'checks pending');
  });
  it('bounds output without corrupting UTF-8', async () => {
    const r = await runGh(null, ['big'], 1000, undefined, { env: env(), maxOutputBytes: 10 });
    assert.equal(r.outputTruncated, true); assert.equal(r.stdout, '新新新'); assert.ok(Buffer.byteLength(r.stdout) <= 10);
  });
  it('distinguishes timeout, cancellation and spawn failure', async () => {
    const timed = await runGh(null, ['hang'], 50, undefined, { env: env() }); assert.equal(timed.timedOut, true); assert.equal(timed.cancelled, false);
    const controller = new AbortController(); const pending = runGh(null, ['hang'], 2000, undefined, { env: env(), signal: controller.signal });
    setTimeout(() => controller.abort(), 40); const cancelled = await pending; assert.equal(cancelled.cancelled, true); assert.equal(cancelled.timedOut, false);
    const missing = await runGh(null, [], 1000, undefined, { env: { PATH: '/nonexistent-vela-gh-bin' } }); assert.ok(missing.spawnError); assert.equal(missing.exitCode, null);
  });
  it('limits concurrent children to four and removes cancelled queued requests', async () => {
    const start = Date.now();
    const requests = Array.from({ length: 4 }, () => runGh(null, ['wait'], 2000, undefined, { env: env() }));
    const controller = new AbortController();
    const queued = runGh(null, ['hang'], 1000, undefined, { env: env(), signal: controller.signal }); controller.abort();
    const fifth = runGh(null, ['wait'], 2000, undefined, { env: env() });
    assert.equal((await queued).cancelled, true); assert.ok((await Promise.all([...requests, fifth])).every(r => r.ok));
    assert.ok(Date.now() - start >= 300);
    assert.equal((await runGh(null, [], 1000, undefined, { env: env() })).ok, true);
  });
});
