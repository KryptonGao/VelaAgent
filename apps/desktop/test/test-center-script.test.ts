import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runScriptFixture } from "../test-center/script-fixture-runner.mjs";

async function fixture(source: string, options: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vela-script-fixture-test-"));
  const path = join(directory, "check.mjs"); writeFileSync(path, source);
  const output: { stream: string; chunk: string }[] = [];
  try {
    const result = await runScriptFixture({ nodePath: process.execPath, script: path, cwd: directory, timeoutMs: 2000,
      successText: "PASS complete", onOutput: (stream: string, chunk: string) => output.push({stream,chunk}), ...options });
    return { result, output, childPid: (() => { try { return Number(readFileSync(join(directory,"child.pid"), "utf8")); } catch { return null; } })() };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("script UI checks stream output and require the completed success marker", async () => {
  const {result,output}=await fixture('console.error("diagnostic");console.log("PASS complete");');
  assert.equal(result.status,"passed");assert.equal(result.error,null);
  assert.ok(output.some(item=>item.stream==="stdout"&&item.chunk.includes("PASS complete")));
  assert.ok(output.some(item=>item.stream==="stderr"&&item.chunk.includes("diagnostic")));
  assert.equal((await fixture('console.log("PASS partial");')).result.status,"failed");
});
test("script UI checks preserve failed exit diagnostics", async () => {
  const {result}=await fixture('console.error("FAIL pointer is missing");process.exitCode=2;');
  assert.equal(result.status,"failed");assert.match(result.error.message,/exit code 2/);assert.match(result.error.message,/pointer is missing/);
});
test("script UI check cancellation ends a hanging process", async () => {
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),100);
  try {
    const {result}=await fixture('setInterval(()=>{},1000);',{signal:abort.signal});
    assert.equal(result.status,"failed");assert.match(result.error.message,/取消/);
  } finally {clearTimeout(timer);}
});
test("script UI check timeout cleans up its own child processes", async () => {
  const {result,childPid}=await fixture('import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync("child.pid",String(child.pid));setInterval(()=>{},1000);',{timeoutMs:400});
  assert.equal(result.status,"failed");assert.match(result.error.message,/超时/);
  if (process.platform!=="win32") {
    assert.ok(childPid);assert.throws(()=>process.kill(childPid,0),{code:"ESRCH"});
  }
});
test("script UI checks report unavailable runtimes as failures", async () => {
  const {result}=await fixture('',{nodePath:"/missing/vela-node"});
  assert.equal(result.status,"failed");assert.match(result.error.message,/无法启动/);
});
