import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import pty from "node-pty";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

it("keeps the launching terminal readable when Vela exits before its login-shell PATH probe", {
  skip: process.platform !== "darwin", timeout: 15000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "vela-shell-path-pty-"));
  let terminal;
  let exited;
  let output = "";
  let exit;
  try {
    const probeFile = join(temporary, "probe.mjs");
    const source = await readFile(new URL("../src/main/shell-path.ts", import.meta.url), "utf8");
    await writeFile(probeFile, stripTypeScriptTypes(source));
    const entry = join(temporary, "entry.mjs");
    await writeFile(entry, 'import { ensureLoginShellPath } from "./probe.mjs";\nensureLoginShellPath();\nsetTimeout(() => process.exit(0), 100);\n');
    const finished = join(temporary, "probe-finished");
    // A slow shell profile makes the probe outlive its parent, as during a rejected launch or watch restart.
    await writeFile(join(temporary, ".zshrc"), "/bin/sleep 0.5\n");
    await writeFile(join(temporary, ".zlogout"), `printf finished > ${quote(finished)}\n`);
    terminal = pty.spawn("/bin/zsh", ["-f", "-i"], {
      name: "xterm-256color", cols: 120, rows: 30,
      env: { ...process.env, ZDOTDIR: temporary, SHELL: "/bin/zsh", SHELL_SESSIONS_DISABLE: "1", PS1: "VELA_TEST_PROMPT> ", RPS1: "" },
    });
    terminal.onData(data => { output += data; });
    exited = new Promise(resolve => terminal.onExit(result => { exit = result; resolve(result); }));
    async function waitFor(read, message) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await read()) return;
        assert.equal(exit, undefined, `${message}: terminal exited unexpectedly\n${output}`);
        await delay(25);
      }
      assert.fail(`${message}\n${output}`);
    }
    await waitFor(() => output.includes("VELA_TEST_PROMPT>"), "interactive shell did not start");
    terminal.write(`${quote(process.execPath)} ${quote(entry)}\r`);
    await waitFor(async () => {
      try { return (await readFile(finished, "utf8")) === "finished"; }
      catch { return false; }
    }, "login-shell probe did not finish");
    await delay(100);
    terminal.write("printf '\\nPARENT_STILL_READS\\n'\r");
    await waitFor(() => /\r?\nPARENT_STILL_READS\r?\n/.test(output), "launching shell lost terminal access");
    assert.ok(!output.includes("error on TTY read"), output);
    terminal.write("exit\r");
    assert.equal((await exited).exitCode, 0, output);
  } finally {
    if (terminal && !exit) { terminal.kill(); await exited; }
    await rm(temporary, { recursive: true, force: true });
  }
});
