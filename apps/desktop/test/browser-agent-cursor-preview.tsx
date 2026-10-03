/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { BrowserAgentCursor } from "@vela/shared";
import { BrowserAgentPointer } from "../src/renderer/components/browser/BrowserAgentPointer";
import { setActiveLocale } from "../src/renderer/locale";
import "../src/renderer/styles.css";

setActiveLocale("zh-CN");
document.documentElement.dataset.scheme = "light";
const initial: BrowserAgentCursor = { x: 208, y: 120, viewportWidth: 640, viewportHeight: 320, kind: "click", sequence: 1, active: true };
let controls: { cursor(value: BrowserAgentCursor | null): void; stop(): void; width(value: number): void; visible(value: boolean): void };
let clicks = 0;
function Fixture() {
  const [cursor, setCursor] = useState<BrowserAgentCursor | null>(initial);
  const [width, setWidth] = useState(640);
  const [visible, setVisible] = useState(true);
  const stop = () => setCursor(current => current ? { ...current, active: false } : { ...initial, active: false });
  controls = { cursor: setCursor, stop, width: setWidth, visible: setVisible };
  const action = (kind: BrowserAgentCursor['kind']) => setCursor({ ...initial, kind, sequence: (cursor?.sequence ?? 0) + 1 });
  return <main style={{ padding: 32, overflow: "auto", width: "100%", color: "var(--text-primary)" }}>
    <h1 style={{ fontSize: 22, marginBottom: 16 }}>Agent 鼠标</h1>
    <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
      {(["click", "type", "press", "select", "scroll"] as const).map(kind => <button key={kind} onClick={() => action(kind)}>{kind}</button>)}
      <button onClick={stop}>停止</button>
    </div>
    <div id="cursor-viewport" style={{ position: "relative", width, height: 320, background: "var(--bg-primary)", border: "1px solid var(--border)", boxSizing: "content-box" }}>
      <button id="page-action" onClick={() => clicks++} style={{ position: "absolute", left: 128, top: 96, width: 160, height: 48 }}>网页按钮</button>
      <input aria-label="网页输入" defaultValue="Vela" style={{ position: "absolute", left: 70, top: 190, width: 280, height: 32 }} />
      {visible && cursor && <BrowserAgentPointer cursor={cursor} width={width} height={320} />}
    </div>
    <pre id="browser-agent-cursor-results" style={{ marginTop: 24, whiteSpace: "pre-wrap", fontSize: 13 }} />
  </main>;
}
flushSync(() => createRoot(document.getElementById("root")!).render(<Fixture />));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pointer = () => document.querySelector<HTMLElement>(".browser-agent-pointer");
const position = () => {
  const viewport = document.getElementById("cursor-viewport")!;
  const outer = viewport.getBoundingClientRect(), inner = pointer()!.getBoundingClientRect();
  return { x: inner.left - outer.left - viewport.clientLeft, y: inner.top - outer.top - viewport.clientTop };
};
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
let sequence = 1;
const update = (changes: Partial<BrowserAgentCursor>) => flushSync(() => controls.cursor({ ...initial, ...changes, sequence: ++sequence }));
async function run() {
  const results = document.getElementById("browser-agent-cursor-results")!;
  results.dataset.status = "pending";
  const pass = (message: string) => { results.textContent += `PASS ${message}\n`; };
  try {
    assert(pointer()?.querySelector("svg path") && pointer()?.textContent === "", "Pointer icon appears without a text label");
    assert(Math.abs(position().x - initial.x) < 1 && Math.abs(position().y - initial.y) < 1, "Pointer hotspot matches CSS viewport coordinates");
    pass("无文字标签的指针图标和真实 CSS 坐标");

    const target = document.getElementById("page-action")!.getBoundingClientRect();
    const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
    assert(hit?.closest("#page-action"), "Overlay passes manual pointer input to the page");
    (hit as HTMLElement).click(); assert(clicks === 1, "Page click handler receives the click");
    pass("指针不会阻挡手动点击");

    const persistentPointer = pointer();
    update({ active: false }); await wait(2000);
    assert(pointer() === persistentPointer, "Idle pointer remains mounted beyond the old expiry interval");
    assert(pointer()?.textContent === "" && !pointer()?.querySelector(".browser-agent-feedback"), "Idle pointer has no text label or stale action feedback");
    pass("空闲时指针持续显示，动作提示单独消退");

    for (const kind of ["click", "type", "press", "select", "scroll"] as const) {
      update({ kind });
      assert(pointer()?.classList.contains(`is-${kind}`), `${kind} has its own feedback`);
      assert(Boolean(pointer()?.querySelector(".browser-agent-feedback")), `${kind} feedback is rendered`);
    }
    const feedback = pointer()!.querySelector(".browser-agent-feedback");
    update({ kind: "scroll" });
    assert(feedback !== pointer()!.querySelector(".browser-agent-feedback"), "Repeated action restarts feedback");
    pass("点击、输入、按键、选择、滚动反馈及连续动作");

    update({ x: 630, y: 310 }); await wait(360);
    assert(Math.abs(position().x - 630) < 1 && Math.abs(position().y - 310) < 1 && pointer()?.textContent === "", "Edge pointer reaches its target without a text label");
    pass("靠近页面边缘时指针位置正确且无文字标签");

    flushSync(() => controls.width(320)); update({ x: 400, y: 160 }); await wait(360);
    assert(Math.abs(position().x - 200) < 1 && Math.abs(position().y - 160) < 1, "Viewport resizing projects the cursor correctly");
    pass("视口缩放后坐标映射正确");
    flushSync(() => controls.width(640)); update({ x: 100, y: 100, active: false }); await wait(360);
    const movingPointer = pointer();
    update({ x: 500, y: 240 }); await wait(50);
    assert(pointer() === movingPointer, "Next action moves the same pointer rather than remounting it");
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) assert(position().x > 100 && position().x < 500, "Cursor transition has an intermediate position");
    update({ x: 250, y: 160 }); await wait(360);
    assert(Math.abs(position().x - 250) < 1 && Math.abs(position().y - 160) < 1, "Interrupted movement settles at the latest target");
    pass("移动可中断并到达最新操作位置");

    flushSync(() => controls.visible(false)); assert(!pointer(), "Hidden tab does not show the pointer");
    flushSync(() => controls.visible(true)); assert(pointer(), "Showing the tab restores its current pointer");
    const stoppedPointer = pointer();
    flushSync(() => controls.stop()); assert(pointer() === stoppedPointer && pointer()?.dataset.action === "idle", "Stop retains the same idle pointer");
    pass("隐藏后恢复，停止后指针仍然保留");
    for (const scheme of ["dark", "light"]) {
      document.documentElement.dataset.scheme = scheme; update({ kind: "type" });
      const color = getComputedStyle(pointer()!).color;
      assert(color !== "rgba(0, 0, 0, 0)" && color !== "transparent", `${scheme} pointer has a visible color`);
    }
    pass("浅色和深色主题");
    results.dataset.status = "passed";
  } catch (error) {
    results.textContent += `FAIL ${error instanceof Error ? error.stack || error.message : String(error)}\n`; results.dataset.status = "failed";
  }
}
if (new URLSearchParams(location.search).has("checks")) void run();
