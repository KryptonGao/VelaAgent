/** Run after building: node_modules/.bin/electron apps/desktop/test/notification-sounds-electron-smoke.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const temporary = mkdtempSync(join(tmpdir(), "vela-sounds-smoke-"));
const electronData = join(temporary, "electron");
const velaData = join(temporary, "vela");
mkdirSync(electronData);
mkdirSync(velaData);
app.setPath("userData", electronData);
process.env.VELA_USER_DATA = velaData;
process.env.VELA_CWD = temporary;
delete process.env.ELECTRON_RENDERER_URL;
delete process.env.VELA_CAPTURE;
writeFileSync(join(velaData, "ui-state.json"), JSON.stringify({
  "vela.onboarding.complete": "true", "vela.appearance": "light", "vela.locale": "en",
}));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const watchdog = setTimeout(() => app.exit(1), 45000);
  try {
    await import("../out/main/index.mjs");
    await until(() => BrowserWindow.getAllWindows().length > 0, "application window");
    const win = BrowserWindow.getAllWindows()[0];
    const rendererErrors = [];
    win.webContents.on("console-message", event => {
      if (event.level === "error") rendererErrors.push(event.message);
    });
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    await until(() => evaluate("!!document.querySelector('.sidebar-user-pill')"), "renderer");
    await evaluate(`(() => {
      window.soundStarts = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(...args) {
        window.soundStarts.push(this.buffer.duration);
        return start.apply(this, args);
      };
    })()`);
    const count = () => evaluate("window.soundStarts.length");
    const emit = event => win.webContents.send("session:event", event);
    const openSettings = async () => {
      await evaluate("document.querySelector('.sidebar-user-pill').click()");
      await until(() => evaluate("!!document.querySelector('.settings-nav-item')"), "settings");
      await evaluate("Array.from(document.querySelectorAll('.settings-nav-item')).find(n => n.textContent === 'Appearance & shortcuts').click()");
    };
    await openSettings();
    assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Task sounds\"] button')[1].getAttribute('aria-checked')"), "true");
    for (let i = 0; i < 4; i++) {
      await evaluate(`document.querySelectorAll('[aria-label="Preview sounds"] button')[${i}].click()`);
      await until(async () => await count() === i + 1, `preview ${i}`);
    }
    assert.equal(new Set(await evaluate("window.soundStarts")).size, 4);
    console.log("PASS four distinct native Web Audio previews");

    await evaluate("document.querySelector('.settings-done').click()");
    let base = await evaluate("window.vela.getState()");
    if (!base.activeConversationId) base = await evaluate("window.vela.createConversation()");
    const id = base.activeConversationId;
    assert.ok(id);
    const state = (status, background = false) => ({
      ...base,
      session: { ...base.session, status: background ? "ready" : status },
      conversations: background
        ? [...base.conversations, { ...base.conversations[0], id: "background", status }]
        : base.conversations.map(item => item.id === id ? { ...item, status } : item),
    });
    emit({ type: "state", state: state("streaming") });
    emit({ type: "state", state: state("ready") });
    await until(async () => await count() === 5, "task completion");
    emit({ type: "state", state: state("ready") });
    await pause(100);
    assert.equal(await count(), 5);
    emit({ type: "state", state: state("streaming") });
    emit({ type: "error", conversationId: id, message: "Sound test failure" });
    emit({ type: "state", state: state("ready") });
    await until(async () => await count() === 6, "task failure");
    assert.equal(await count(), 6);

    win.webContents.send("session:question-event", { type: "request", request: {
      id: "sound-question", conversationId: id, toolCallId: "sound-tool", question: "Sound test question?",
      options: [], allowFreeText: true, createdAt: Date.now(),
    } });
    await until(async () => await count() === 7, "question request");
    win.webContents.send("session:question-event", { type: "resolved", id: "sound-question", answer: "yes" });
    win.webContents.send("sandbox:approval-event", { type: "request", request: {
      id: "sound-permission", kind: "bash", command: "echo sound-test", path: null, cwd: temporary, createdAt: Date.now(),
    } });
    await until(async () => await count() === 8, "permission request");
    win.webContents.send("sandbox:approval-event", { type: "resolved", id: "sound-permission", allowed: true });
    await pause(950);
    win.minimize();
    emit({ type: "state", state: state("streaming", true) });
    emit({ type: "state", state: state("ready", true) });
    await until(async () => await count() === 9, "background completion in minimized window");
    win.restore();
    console.log("PASS live completion, failure, questions, permissions and minimized background chat; no duplicate completion");

    emit({ type: "state", state: state("streaming") });
    await until(() => evaluate("document.querySelector('[aria-label=\"Stop generating\"]')?.disabled === false"), "stop control");
    await evaluate("document.querySelector('[aria-label=\"Stop generating\"]').click()");
    await pause(150);
    assert.equal(await count(), 9);
    console.log("PASS manual stop stays silent");

    await openSettings();
    await evaluate("document.querySelector('[aria-label=\"Task sounds\"] button').click()");
    await until(() => evaluate("window.vela.uiStorage.getItem('vela.soundEffects') === 'false'"), "saved mute preference");
    emit({ type: "error", conversationId: id, message: "Muted failure" });
    await pause(100);
    assert.equal(await count(), 9);
    await evaluate("document.querySelector('[aria-label=\"Preview sounds\"] button').click()");
    await until(async () => await count() === 10, "explicit preview while muted");
    await win.webContents.reload();
    await until(() => evaluate("!!document.querySelector('.sidebar-user-pill')"), "reloaded renderer");
    await openSettings();
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Task sounds\"] button').getAttribute('aria-checked')"), "true");
    assert.deepEqual(rendererErrors, []);
    console.log("PASS immediate mute, preview while muted, persisted mute on reload and no renderer errors");
    clearTimeout(watchdog);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(watchdog);
    app.exit(1);
  }
}
app.on("will-quit", () => rmSync(temporary, { recursive: true, force: true }));
void run();
