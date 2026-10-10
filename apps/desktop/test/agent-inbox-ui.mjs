/** Renderer behavior checks for the Agent Inbox page: node apps/desktop/test/agent-inbox-ui.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));

// 一个内存里的「主进程」：决策、推送和并发冲突的语义与 AgentInboxService 保持一致。
const mockScript = String.raw`
(() => {
  const listeners = new Set();
  const now = Date.now();
  let revision = 10;
  const base = { schemaVersion: 1, readState: "unread", priority: "normal", revision: 1, decisions: {}, actions: [] };
  const items = [
    { ...base, id: "approval1", type: "approval", origin: "sandbox", status: "pending", priority: "high", title: "Deploy chat", summary: "npm run build",
      sourceEventId: "approval:r1", requestId: "r1", conversationId: "c1", workspaceId: "/work/app", createdAt: now - 60000, updatedAt: now - 60000,
      actions: ["approve", "deny"], detail: { kind: "approval", request: { id: "r1", kind: "bash", command: "npm run build", path: null, cwd: "/work/app", createdAt: now - 60000 } } },
    { ...base, id: "question1", type: "question", origin: "question", status: "pending", priority: "high", title: "Login feature", summary: "Keep the old API?",
      sourceEventId: "question:q1", requestId: "q1", conversationId: "c2", workspaceId: "/work/app", createdAt: now - 120000, updatedAt: now - 120000,
      actions: ["answer", "skip"], detail: { kind: "question", toolCallId: "t1", question: "Keep the old API?", options: [{ label: "Keep v1" }, { label: "Drop v1", description: "Breaking" }], allowFreeText: false } },
    { ...base, id: "result1", type: "result", origin: "scheduled_task", status: "resolved", outcome: "success", title: "Nightly check", summary: "All 42 tests pass.",
      sourceEventId: "schedrun:s1:success", conversationId: "c3", createdAt: now - 3600000, updatedAt: now - 3600000, detail: { kind: "text", text: "All 42 tests pass." } },
    { ...base, id: "error1", type: "error", origin: "turn", status: "pending", outcome: "failed", title: "Refactor", summary: "model unavailable",
      sourceEventId: "turn:c4:1", conversationId: "c4", createdAt: now - 7200000, updatedAt: now - 7200000, actions: ["acknowledge"], detail: { kind: "text", text: "model unavailable" } },
  ];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const badge = () => items.filter((item) => item.status === "pending").length;
  const push = (changed) => { revision += 1; for (const listener of listeners) listener({ revision, upserts: changed.map(clone), badge: badge(), error: null }); };
  const fixture = window.fixture = {
    calls: [], forceResult: null, contents: {}, submitResult: { ok: true },
    add(item) { items.push({ ...base, ...item }); push([items.at(-1)]); },
    resolveElsewhere(id, status, outcome) { const item = items.find((entry) => entry.id === id); Object.assign(item, { status, outcome, actions: [], revision: item.revision + 1, updatedAt: Date.now() }); push([item]); },
  };
  window.vela = { agentInbox: {
    list: async (query) => ({ items: items.filter((item) => (item.readState === "archived") === Boolean(query?.archived)).map(clone), nextBefore: null, badge: badge(), revision, error: null }),
    get: async (id) => clone(items.find((item) => item.id === id) ?? null),
    decide: async (request) => {
      fixture.calls.push({ method: "decide", request });
      const item = items.find((entry) => entry.id === request.itemId);
      if (fixture.forceResult) return { ok: false, reason: fixture.forceResult, item: clone(item) };
      if (item.revision !== request.expectedRevision) return { ok: false, reason: "stale", item: clone(item) };
      if (item.status !== "pending") return { ok: false, reason: "not_pending", item: clone(item) };
      const outcome = { approve: ["resolved", "approved"], deny: ["rejected", "denied"], answer: ["resolved", "answered"], skip: ["cancelled", "skipped"], acknowledge: ["resolved", "acknowledged"] }[request.decision];
      Object.assign(item, { status: outcome[0], outcome: outcome[1], actions: [], revision: item.revision + 1, updatedAt: Date.now() });
      if (request.decision === "answer") item.detail = { ...item.detail, answer: request.answer };
      push([item]);
      return { ok: true, item: clone(item) };
    },
    markRead: async (id) => { const item = items.find((entry) => entry.id === id); if (item.readState === "unread") { item.readState = "read"; push([item]); } return clone(item); },
    archive: async (id, archived) => { const item = items.find((entry) => entry.id === id); item.readState = archived ? "archived" : "read"; fixture.calls.push({ method: "archive", id, archived }); push([item]); return clone(item); },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getContent: async (id) => { fixture.calls.push({ method: "getContent", id }); return clone(fixture.contents[id] ?? null); },
    submitToSource: async (id, text) => { fixture.calls.push({ method: "submit", id, text }); return fixture.submitResult; },
    takeNavigation: async () => null,
    onNavigate: () => () => {},
  },
  resident: (() => {
    const statusListeners = new Set();
    const ruleListeners = new Set();
    const settings = { mode: "standby", paused: false, showMenuBarIcon: true, launchAtLogin: false, quitWhenWindowsClosed: false,
      notifications: { enabled: true, hidePreview: false, notifyResults: false, quietHours: { enabled: false, startMinute: 1320, endMinute: 480 } },
      limits: { maxConcurrentTasks: 2, maxTaskMinutes: 60, dailyProactiveRuns: 10, pauseProactiveOnBattery: true } };
    const status = { state: "ready", mode: "standby", paused: false, conversationId: "res1", model: "test-model", residentBusy: false, runningTasks: 1, queuedTasks: 0,
      waitingItems: 0, pendingItems: 2, lastActivityAt: now - 5000, suspended: false, onBattery: false, error: null, proactiveRunsToday: 0,
      tasks: [
        { id: "t1", title: "Check build", prompt: "p", workspace: "/work/app", source: "agent", status: "running", conversationId: "c9", createdAt: now - 1000, startedAt: now - 900, finishedAt: null },
        { id: "t2", title: "Lint", prompt: "p", workspace: "/work/app", source: "rule", reason: "Rule X: file changed", status: "failed", error: "exit code 2", conversationId: null, createdAt: now - 90000, startedAt: now - 80000, finishedAt: now - 70000 },
      ], workspaces: ["/work/app", "/work/api"], revision: 1 };
    let rules = [];
    const derive = () => { status.state = settings.paused ? "paused" : settings.mode === "disabled" ? "offline" : status.runningTasks ? "working" : "ready"; status.mode = settings.mode; status.paused = settings.paused; status.revision += 1; };
    const emitStatus = () => { derive(); for (const listener of statusListeners) listener(clone(status)); };
    const emitRules = () => { for (const listener of ruleListeners) listener(clone({ rules, error: null })); };
    window.residentFixture = { calls: [], rules: () => rules };
    const call = (method, args) => window.residentFixture.calls.push({ method, ...args });
    return {
      getStatus: async () => { derive(); return clone(status); },
      getSettings: async () => clone(settings),
      updateSettings: async (patch) => {
        call("updateSettings", { patch });
        for (const key of Object.keys(patch)) {
          if (patch[key] && typeof patch[key] === "object") {
            for (const inner of Object.keys(patch[key])) {
              if (patch[key][inner] && typeof patch[key][inner] === "object") Object.assign(settings[key][inner], patch[key][inner]); else settings[key][inner] = patch[key][inner];
            }
          } else settings[key] = patch[key];
        }
        emitStatus();
        return clone(settings);
      },
      pause: async () => { call("pause", {}); settings.paused = true; emitStatus(); return clone(status); },
      resume: async () => { call("resume", {}); settings.paused = false; emitStatus(); return clone(status); },
      submit: async (input) => {
        call("submit", { input });
        if (settings.mode === "disabled") return { ok: false, reason: "disabled" };
        return input.workspace ? { ok: true, target: "task", taskId: "t9" } : { ok: true, target: "resident" };
      },
      cancelTask: async (id) => { call("cancelTask", { id }); const task = status.tasks.find((entry) => entry.id === id); task.status = "cancelled"; status.runningTasks = 0; emitStatus(); return clone(status); },
      getMessages: async () => [],
      subscribe: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
      rules: {
        list: async () => clone({ rules, error: null }),
        save: async (input, id) => {
          call("saveRule", { input, id });
          const existing = rules.find((rule) => rule.id === id);
          if (existing) Object.assign(existing, input, { updatedAt: Date.now() });
          else rules.push({ ...input, id: "rule" + (rules.length + 1), createdAt: Date.now(), updatedAt: Date.now(), lastTriggeredAt: null, runDay: "", runsToday: 0, lastSkip: null });
          emitRules();
          return { ok: true, rule: clone(existing ?? rules.at(-1)) };
        },
        remove: async (id) => { call("removeRule", { id }); rules = rules.filter((rule) => rule.id !== id); emitRules(); return clone({ rules, error: null }); },
        subscribe: (listener) => { ruleListeners.add(listener); return () => ruleListeners.delete(listener); },
      },
    };
  })() };
})();
`;

if (!process.versions.electron) {
  const temp = mkdtempSync(join(tmpdir(), "vela-agent-inbox-ui-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AgentInboxPage } from './apps/desktop/src/renderer/components/AgentInboxPage';
      import { setActiveLocale } from './apps/desktop/src/renderer/locale';
      import { createMessageStore, messageScope } from './apps/desktop/src/renderer/hooks/message-store';
      const root = createRoot(document.getElementById('root'));
      window.opened = [];
      window.handled = [];
      window.transcripts = [];
      window.messageStore = createMessageStore((callback) => { callback(); return () => {}; });
      window.messageScope = messageScope;
      let currentLocale = 'en';
      let navigation = null;
      let nonce = 0;
      const ensureTranscript = (id) => { window.transcripts.push(id); };
      const handled = (value) => { window.handled.push(value); if (navigation?.nonce === value) { navigation = null; window.renderInbox(currentLocale); } };
      window.renderInbox = (locale) => { currentLocale = locale; setActiveLocale(locale); root.render(<AgentInboxPage key={locale} active sidebarCollapsed={false} onToggleSidebar={() => {}} onOpenConversation={(id) => window.opened.push(id)}
        messageStore={window.messageStore} ensureTranscript={ensureTranscript} navigation={navigation} onNavigationHandled={handled} />); };
      window.navigate = (target) => { nonce += 1; navigation = { target, nonce }; window.renderInbox(currentLocale); };
      window.renderInbox('en');
    `,
        resolveDir: resolve(here, "../../.."),
        loader: "tsx",
      },
      loader: { ".svg": "dataurl" },
      bundle: true,
      outfile: join(temp, "ui.js"),
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    writeFileSync(
      join(temp, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        readFileSync(resolve(here, "../src/renderer/styles.css"), "utf8") +
        '</style><link rel="stylesheet" href="ui.css"></head><body><div id="root" style="height:100vh;display:flex"></div><script>' +
        mockScript +
        '</script><script src="ui.js"></script></body></html>',
    );
    const env = { ...process.env, VELA_AGENT_INBOX_UI_TEMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    const code = await new Promise((res, rej) => { child.once("error", rej); child.once("exit", res); });
    clearTimeout(timer);
    assert.equal(code, 0, "Agent Inbox renderer behavior checks failed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.env.VELA_AGENT_INBOX_UI_TEMP, "profile"));
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    try {
      const errors = [];
      win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
      await win.loadFile(join(process.env.VELA_AGENT_INBOX_UI_TEMP, "index.html"));
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const until = async (code) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(code)) return;
          await new Promise((res) => setTimeout(res, 20));
        }
        throw new Error("Timed out: " + code);
      };
      const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
      const clickText = (selector, label) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.textContent.includes(${JSON.stringify(label)})).click()`);
      const rows = () => evaluate("Array.from(document.querySelectorAll('.agent-inbox-row')).map(node => node.querySelector('strong').textContent)");
      const navCount = (label) => evaluate(`Array.from(document.querySelectorAll('.agent-inbox-nav button')).find(node => node.textContent.startsWith(${JSON.stringify(label)})).querySelector('.agent-inbox-count').textContent`);
      const capture = async (name) => {
        if (!process.env.VELA_AGENT_INBOX_UI_CAPTURE) return;
        await new Promise((res) => setTimeout(res, 250));
        writeFileSync(join(process.env.VELA_AGENT_INBOX_UI_CAPTURE, name + ".png"), (await win.webContents.capturePage()).toPNG());
      };

      await until("document.querySelectorAll('.agent-inbox-row').length === 4");
      assert.equal(await text(".agent-inbox-summary"), "3 need your attention");
      assert.equal(await navCount("Needs action"), "3");
      assert.deepEqual(await rows(), ["Tool approval", "Agent question", "Conversation failed", "Scheduled task finished"], "pending items first, approvals before questions");
      assert.equal(await evaluate("document.querySelectorAll('.agent-inbox-group').length"), 2);
      console.log("PASS overview lists pending work first and the badge matches Needs action");
      await capture("overview");

      await clickText(".agent-inbox-row", "Tool approval");
      await until("!!document.querySelector('.approval-banner')");
      assert.match(await text(".approval-banner-summary"), /npm run build/);
      assert.match(await text(".agent-inbox-facts"), /\/work\/app/);
      await capture("approval");
      await clickText(".approval-btn.allow", "Allow once");
      await until("document.querySelector('.agent-inbox-summary').textContent === '2 need your attention'");
      assert.equal(await evaluate("document.querySelector('.approval-banner')"), null, "no buttons once decided");
      assert.match(await text(".agent-inbox-detail-head"), /Approved/);
      const approve = await evaluate("fixture.calls.at(-1).request");
      assert.equal(approve.decision, "approve");
      assert.equal(approve.itemId, "approval1");
      assert.equal(approve.expectedRevision, 1);
      assert.match(approve.clientActionId, /^[0-9a-f-]{36}$/);
      assert.ok(!("requestId" in approve), "the renderer never sends a request id");
      console.log("PASS approving goes through the Host decision and updates the item and badge");

      await clickText(".agent-inbox-row", "Agent question");
      await until("!!document.querySelector('.agent-inbox-question')");
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.question-option-label')).map(node => node.textContent)"), ["Keep v1", "Drop v1"]);
      assert.equal(await evaluate("document.querySelector('.question-custom-input')"), null, "free text is hidden when not allowed");
      await clickText(".question-option", "Drop v1");
      await until("document.querySelector('.agent-inbox-summary').textContent === '1 need your attention'");
      assert.match(await text(".question-card-a"), /Drop v1/);
      assert.deepEqual(await evaluate("fixture.calls.at(-1).request.answer"), "Drop v1");
      console.log("PASS answering a question stores the chosen option");

      await evaluate("fixture.calls.length = 0; fixture.forceResult = 'stale'");
      await clickText(".agent-inbox-row", "Conversation failed");
      await until("!!document.querySelector('.agent-inbox-actions .agent-inbox-primary')");
      await evaluate("document.querySelector('.agent-inbox-primary').click()");
      await until("!!document.querySelector('.agent-inbox-notice[role=alert]')");
      assert.match(await text(".agent-inbox-notice[role=alert]"), /changed|latest state/);
      await evaluate("fixture.forceResult = null");
      await evaluate("document.querySelector('.agent-inbox-primary').click()");
      await until("document.querySelector('.agent-inbox-summary').textContent === 'All caught up'");
      console.log("PASS a stale decision is explained and the retry succeeds");

      await evaluate("fixture.add({ id: 'approval2', type: 'approval', origin: 'sandbox', status: 'pending', priority: 'high', title: 'Other chat', summary: 'rm -rf dist', sourceEventId: 'approval:r2', requestId: 'r2', createdAt: Date.now(), updatedAt: Date.now(), actions: ['approve','deny'], detail: { kind: 'approval', request: { id: 'r2', kind: 'bash', command: 'rm -rf dist', path: null, cwd: null, createdAt: Date.now() } } })");
      await until("document.querySelector('.agent-inbox-summary').textContent === '1 need your attention'");
      await clickText(".agent-inbox-row", "Tool approval");
      await until("!!document.querySelector('.approval-banner')");
      await evaluate("fixture.resolveElsewhere('approval2', 'resolved', 'approved')");
      await until("!document.querySelector('.approval-banner')");
      assert.match(await text(".agent-inbox-detail-head"), /Approved/, "answering in the chat updates the open detail");
      console.log("PASS a decision made elsewhere replaces the open approval controls");

      await evaluate("fixture.add({ id: 'approval4', type: 'approval', origin: 'sandbox', status: 'pending', priority: 'high', title: 'Quick chat', summary: 'git status', sourceEventId: 'approval:r4', requestId: 'r4', createdAt: Date.now(), updatedAt: Date.now(), actions: ['approve','deny'], detail: { kind: 'approval', request: { id: 'r4', kind: 'bash', command: 'git status', path: null, cwd: null, createdAt: Date.now() } } })");
      await until("!!document.querySelector('.agent-inbox-row-actions')");
      assert.equal(await evaluate("document.querySelectorAll('.agent-inbox-row-actions').length"), 1, "only pending approvals get quick actions");
      assert.equal(await evaluate("document.querySelector('.agent-inbox-row .agent-inbox-quick')"), null, "row buttons are not nested");
      await capture("quick-actions");
      await evaluate("fixture.calls.length = 0");
      await evaluate("document.querySelector('.agent-inbox-quick:not(.allow)').click()");
      await until("document.querySelector('.agent-inbox-summary').textContent === 'All caught up'");
      const quick = await evaluate("fixture.calls.at(-1).request");
      assert.equal(quick.itemId, "approval4");
      assert.equal(quick.decision, "deny");
      assert.equal(await evaluate("document.querySelectorAll('.agent-inbox-row-actions').length"), 0, "quick actions disappear once decided");
      console.log("PASS quick Deny on a row goes through the Host decision");

      await evaluate("fixture.add({ id: 'approval3', type: 'approval', origin: 'sandbox', status: 'pending', priority: 'high', title: 'Third chat', summary: 'ls', sourceEventId: 'approval:r3', requestId: 'r3', createdAt: Date.now(), updatedAt: Date.now(), actions: ['approve','deny'], detail: { kind: 'approval', request: { id: 'r3', kind: 'bash', command: 'ls', path: null, cwd: null, createdAt: Date.now() } } })");
      await until("document.querySelector('.agent-inbox-summary').textContent === '1 need your attention'");
      await clickText(".agent-inbox-nav button", "Needs action");
      await until("document.querySelectorAll('.agent-inbox-row').length === 1");
      await clickText(".agent-inbox-row", "Tool approval");
      await until("!!document.querySelector('.approval-banner')");
      await clickText(".agent-inbox-actions button", "Archive");
      await until("document.querySelector('.agent-inbox-actions button:last-child').textContent === 'Unarchive'");
      assert.equal(await text(".agent-inbox-summary"), "1 need your attention", "archiving does not resolve the request");
      assert.equal(await evaluate("document.querySelectorAll('.agent-inbox-row').length"), 1, "a pending item stays in Needs action");
      assert.equal(await evaluate("fixture.calls.some(call => call.method === 'decide' && call.request.itemId === 'approval3')"), false);
      assert.equal(await evaluate("!!document.querySelector('.approval-banner')"), true, "the Host controls are still available");
      await clickText(".agent-inbox-nav button", "Archive");
      await until("document.querySelectorAll('.agent-inbox-row').length === 1");
      console.log("PASS archiving a pending request only changes display");
      await clickText(".agent-inbox-nav button", "Activity");
      await until("document.querySelectorAll('.agent-inbox-row').length >= 1");
      await evaluate("document.querySelector('input[type=search]').focus()");

      await clickText(".agent-inbox-nav button", "Overview");
      await until("document.querySelectorAll('.agent-inbox-row').length >= 4");
      await evaluate("(() => { const input = document.querySelector('input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'nightly'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await until("document.querySelectorAll('.agent-inbox-row').length === 1");
      assert.deepEqual(await rows(), ["Scheduled task finished"]);
      await clickText(".agent-inbox-row", "Scheduled task finished");
      await until("!!document.querySelector('.agent-inbox-actions')");
      await clickText(".agent-inbox-actions button", "Open conversation");
      assert.deepEqual(await evaluate("window.opened"), ["c3"]);
      console.log("PASS search narrows the list and opens the source conversation");

      await win.setContentSize(760, 800);
      await new Promise((res) => setTimeout(res, 150));
      assert.equal(await evaluate("document.querySelector('.agent-inbox-body').dataset.mode"), "detail");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.agent-inbox-feed')).display"), "none", "narrow: detail replaces the list");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.agent-inbox-back')).display !== 'none'"), true);
      await evaluate("document.querySelector('.agent-inbox-back').click()");
      await until("document.querySelector('.agent-inbox-body').dataset.mode === 'list'");
      assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "no horizontal page scroll");
      await capture("narrow");
      await win.setContentSize(1280, 800);
      console.log("PASS narrow windows switch between list and detail");

      await evaluate("(() => { const input = document.querySelector('input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await until("!!document.querySelector('.agent-inbox-status')");
      await evaluate("document.documentElement.dataset.scheme = 'dark'");
      await capture("dark");
      const status = await evaluate("getComputedStyle(document.querySelector('.agent-inbox-status')).color");
      assert.notEqual(status, "", "status chips resolve theme tokens in dark mode");
      await evaluate("document.documentElement.dataset.scheme = 'light'");

      await evaluate("window.renderInbox('zh-CN')");
      await until("document.querySelector('.agent-inbox-topbar h1')?.textContent === 'Agent 收件箱'");
      assert.match(await text(".agent-inbox-nav"), /需要处理/);
      for (const [locale, title] of [["zh-TW", "Agent 收件匣"], ["ja", "Agent 受信トレイ"], ["ko", "Agent 받은편지함"]]) {
        await evaluate(`window.renderInbox(${JSON.stringify(locale)})`);
        await until(`document.querySelector('.agent-inbox-topbar h1')?.textContent === ${JSON.stringify(title)}`);
      }
      await capture("ko");
      console.log("PASS all five languages render the page");

      // ---------- Phase 4-7: Resident Agent, delegate approvals, Intelligent UI content ----------
      await evaluate("window.renderInbox('en')");
      await until("document.querySelector('.agent-inbox-topbar h1')?.textContent === 'Agent Inbox'");
      const setField = (selector, value) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
      const uiFence = (label, text) => "Pick one\n\n```vela-ui\n" + [
        '{"op":"begin","id":"plan","version":1,"title":"Plan"}',
        '{"op":"node","id":"root","type":"column","props":{}}',
        '{"op":"node","id":"go","parent":"root","type":"button","props":{"label":' + JSON.stringify(label) + ',"variant":"primary","action":{"type":"submit_to_agent","text":' + JSON.stringify(text) + '}}}',
        '{"op":"commit"}',
      ].join("\n") + "\n```";

      await evaluate(`(() => {
        const now = Date.now();
        fixture.contents.ui1 = { text: ${JSON.stringify(uiFence("Go with plan A", "Use plan A"))}, conversationId: "c7", uiOrdinal: 2 };
        fixture.add({ id: "delegate1", type: "approval", origin: "resident", status: "pending", priority: "high", title: "Resident Agent", summary: "Check build", sourceEventId: "approval:d1", requestId: "d1", conversationId: "res1", createdAt: now, updatedAt: now, actions: ["approve", "deny"], detail: { kind: "approval", request: { id: "d1", kind: "delegate", command: "Check build\\n\\nrun the tests", path: null, cwd: "/work/api", createdAt: now } } });
        fixture.add({ id: "ui1", type: "suggestion", origin: "proactive", status: "resolved", title: "Watch build", summary: "Pick one", reason: "Rule Watch build: file changed: src/a.ts", sourceEventId: "turn:c7:1", conversationId: "c7", contentRef: { conversationId: "c7", uiOrdinal: 2, fingerprint: "abc" }, createdAt: now, updatedAt: now - 1, detail: { kind: "text", text: "Pick one" } });
        fixture.add({ id: "ui2", type: "result", origin: "resident", status: "resolved", title: "Old report", summary: "Old summary", sourceEventId: "turn:c8:1", conversationId: "c8", contentRef: { conversationId: "c8", uiOrdinal: 0, fingerprint: "zzz" }, createdAt: now, updatedAt: now - 2, detail: { kind: "text", text: "Old summary" } });
      })()`);
      await until("Array.from(document.querySelectorAll('.agent-inbox-row strong')).some(node => node.textContent === 'Background task approval')");
      assert.ok((await rows()).includes("Proactive suggestion") && (await rows()).includes("Background task finished"), "origin-specific labels");

      await clickText(".agent-inbox-row", "Background task approval");
      await until("!!document.querySelector('.approval-banner')");
      assert.match(await text(".approval-banner-title"), /Create background task requires approval/);
      assert.match(await text(".approval-banner-summary"), /Workspace: \/work\/api[\s\S]*Task: Check build/);
      console.log("PASS a delegate approval names the workspace and the task");

      await clickText(".agent-inbox-row", "Proactive suggestion");
      await until("!!document.querySelector('.iui-button')");
      assert.match(await text(".agent-inbox-facts"), /Why it ran[\s\S]*file changed: src\/a\.ts/);
      assert.equal(await evaluate("fixture.calls.filter(call => call.method === 'getContent').at(-1).id"), "ui1");
      await clickText(".iui-button", "Go with plan A");
      assert.match(await text(".iui-confirm-text"), /Use plan A/);
      assert.equal(await evaluate("fixture.calls.some(call => call.method === 'submit')"), false, "nothing is sent before the user confirms");
      await evaluate("document.querySelector('.iui-confirm .iui-button-primary').click()");
      await until("fixture.calls.some(call => call.method === 'submit')");
      const sent = await evaluate("fixture.calls.find(call => call.method === 'submit')");
      assert.deepEqual({ id: sent.id, text: sent.text }, { id: "ui1", text: "Use plan A" }, "the target is the item, never a renderer-chosen conversation");
      await until("!!document.querySelector('.agent-inbox-notice[role=status]')");
      assert.equal(await evaluate("fixture.calls.some(call => call.method === 'decide' && call.request.itemId === 'delegate1')"), false, "an Intelligent UI action never approves a request");
      assert.equal(await text(".agent-inbox-summary"), "2 need your attention", "the earlier archived request and the delegate request are both still pending");
      await evaluate("fixture.submitResult = { ok: false, message: 'The conversation is gone' }");
      await clickText(".iui-button", "Go with plan A");
      await evaluate("document.querySelector('.iui-confirm .iui-button-primary').click()");
      await until("!!document.querySelector('.agent-inbox-notice[role=alert]')");
      assert.match(await text(".agent-inbox-notice[role=alert]"), /conversation is gone/);
      console.log("PASS Intelligent UI in an item submits to the item's source, never approves");
      await capture("iui-content");

      await clickText(".agent-inbox-row", "Background task finished");
      await until("document.querySelector('.agent-inbox-content') === null && !!document.querySelector('.agent-inbox-text')");
      assert.match(await text(".agent-inbox-detail"), /no longer available[\s\S]*Old summary/);
      console.log("PASS a content reference that no longer resolves falls back to the stored text");

      // Resident view
      await clickText(".agent-inbox-nav button", "Resident Agent");
      await until("!!document.querySelector('.resident-view')");
      assert.equal(await evaluate("document.querySelector('.agent-inbox-body').dataset.mode"), "resident");
      assert.equal(await text(".resident-state-label"), "Working", "a running task makes the whole resident working");
      assert.deepEqual(await evaluate("window.transcripts"), ["res1"], "the hidden conversation's history is loaded on demand");
      assert.equal(await evaluate("document.querySelector('.resident-modes [aria-checked=true]').textContent"), "Standby");
      assert.match(await text(".resident-state"), /1 running/);
      assert.match(await text(".resident-facts"), /test-model/);
      await capture("resident");
      console.log("PASS the Resident view shows real state, mode and model");

      await clickText(".resident-modes button", "Proactive");
      await until("document.querySelector('.resident-modes [aria-checked=true]').textContent === 'Proactive'");
      assert.match(await text(".resident-mode-note"), /costs money/);
      assert.deepEqual(await evaluate("window.residentFixture.calls.find(call => call.method === 'updateSettings').patch"), { mode: "proactive" });
      await evaluate("document.querySelector('.resident-pause').click()");
      await until("document.querySelector('.resident-state-label').textContent === 'Paused'");
      assert.equal(await evaluate("document.querySelector('.resident-pause').getAttribute('aria-pressed')"), "true");
      await evaluate("document.querySelector('.resident-pause').click()");
      await until("document.querySelector('.resident-state-label').textContent === 'Working'");
      console.log("PASS mode and pause go through the Host and the UI follows its answer");

      // Chat: live messages, UI inside the Resident chat, composer
      await evaluate(`window.messageStore.publish(window.messageScope("res1"), [
        { id: "m1", role: "user", text: "Check the api tests", thinking: "", tools: [] },
        { id: "m2", role: "assistant", text: ${JSON.stringify(uiFence("Start with the api", "Start with the api project"))}, thinking: "", tools: [{ id: "tc1", name: "delegate_workspace_task", status: "done", activity: {} }] },
      ])`);
      await until("!!document.querySelector('.resident-msg.assistant .iui-button')");
      assert.equal(await text(".resident-tools li"), "Created a background task");
      await clickText(".resident-msg .iui-button", "Start with the api");
      await evaluate("document.querySelector('.iui-confirm .iui-button-primary').click()");
      await until("window.residentFixture.calls.some(call => call.method === 'submit')");
      assert.deepEqual(await evaluate("window.residentFixture.calls.find(call => call.method === 'submit').input"), { text: "Start with the api project" }, "UI submit goes to the Resident conversation only");
      await evaluate("window.residentFixture.calls.length = 0");

      await setField("#resident-input", "Run the api tests");
      await setField(".resident-composer select", "/work/api");
      await evaluate("document.querySelector('.resident-composer .agent-inbox-primary').click()");
      await until("window.residentFixture.calls.some(call => call.method === 'submit')");
      assert.deepEqual(await evaluate("window.residentFixture.calls.find(call => call.method === 'submit').input"), { text: "Run the api tests", workspace: "/work/api" });
      await until("document.querySelector('#resident-input').value === ''");
      console.log("PASS the Resident chat renders Intelligent UI and routes input to the right target");

      // Tasks
      await clickText(".resident-tabs button", "Tasks");
      await until("document.querySelectorAll('.resident-task').length === 2");
      assert.match(await text(".resident-task[data-status=failed]"), /Rule X: file changed[\s\S]*exit code 2/);
      await clickText(".resident-task[data-status=running] button", "Stop");
      await until("document.querySelector('.resident-task[data-status=cancelled]') !== null");
      assert.deepEqual(await evaluate("window.residentFixture.calls.find(call => call.method === 'cancelTask').id"), "t1");
      console.log("PASS tasks show their reason and error, and can be stopped");

      // Rules
      await clickText(".resident-tabs button", "Rules");
      await until("!!document.querySelector('.resident-cost')");
      assert.match(await text(".resident-cost"), /costs money/);
      await clickText(".resident-rule-toolbar button", "New rule");
      await setField(".resident-rule-form input", "Watch the build");
      await setField(".resident-rule-form textarea", "Find out why it failed");
      await evaluate("document.querySelector('.resident-rule-form button[type=submit]').click()");
      await until("document.querySelectorAll('.resident-rule').length === 1");
      const saved = await evaluate("window.residentFixture.calls.find(call => call.method === 'saveRule').input");
      assert.equal(saved.title, "Watch the build");
      assert.equal(saved.workspace, "/work/app");
      assert.equal(saved.allowTools, false, "rules are read-only unless the user opts in");
      assert.deepEqual(saved.trigger, { kind: "inbox_error", filter: "" });
      assert.match(await text(".resident-rule-state"), /Waiting for an event/);
      await clickText(".resident-rule-buttons button", "Turn off");
      await until("document.querySelector('.resident-rule-state').textContent === 'Off'");
      await clickText(".resident-rule-buttons button", "Delete");
      await until("document.querySelectorAll('.resident-rule').length === 0");
      console.log("PASS rules can be created read-only, toggled and removed");

      // Settings
      await clickText(".resident-tabs button", "Settings");
      await until("!!document.querySelector('.resident-settings')");
      await clickText(".resident-row", "Hide notification previews");
      await until("window.residentFixture.calls.some(call => call.method === 'updateSettings' && call.patch.notifications?.hidePreview === true)");
      await clickText(".resident-row", "Quiet hours");
      await until("document.querySelectorAll('.resident-quiet input[type=time]').length === 2");
      assert.equal(await evaluate("document.querySelector('.resident-quiet input').value"), "22:00");
      await setField(".resident-quiet input", "23:30");
      await until("window.residentFixture.calls.some(call => call.method === 'updateSettings' && call.patch.notifications?.quietHours?.startMinute === 1410)");
      await setField(".resident-number input", "4");
      await evaluate("document.querySelector('.resident-number input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
      await until("window.residentFixture.calls.some(call => call.method === 'updateSettings' && call.patch.limits?.maxConcurrentTasks === 4)");
      console.log("PASS settings send only the changed field");

      // Disabled: nothing can be submitted, nothing is interrupted
      await clickText(".resident-modes button", "Disabled");
      await until("document.querySelector('.resident-state-label').textContent === 'Offline'");
      await clickText(".resident-tabs button", "Chat");
      await until("document.querySelector('#resident-input')?.disabled === true");
      assert.match(await text(".resident-blocked"), /Resident Agent is off/);
      await clickText(".resident-modes button", "Standby");
      await until("document.querySelector('#resident-input')?.disabled === false");

      // Navigation requests from notifications and the menu bar
      await evaluate("window.navigate({ view: 'item', itemId: 'ui1' })");
      await until("document.querySelector('.agent-inbox-body').dataset.mode === 'detail' && !!document.querySelector('.iui-button')");
      assert.match(await text(".agent-inbox-detail-head h2"), /Proactive suggestion/);
      await evaluate("window.navigate({ view: 'resident' })");
      await until("!!document.querySelector('.resident-view')");
      assert.equal(await evaluate("window.handled.length"), 2, "every navigation request is consumed exactly once");
      console.log("PASS navigation requests open the item or the Resident view");

      await win.setContentSize(700, 800);
      await new Promise((res) => setTimeout(res, 150));
      assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "no horizontal scroll in the Resident view when narrow");
      await capture("resident-narrow");
      await win.setContentSize(1280, 800);
      console.log("PASS the Resident view fits narrow windows");

      assert.deepEqual(errors, [], "no renderer console errors");
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
