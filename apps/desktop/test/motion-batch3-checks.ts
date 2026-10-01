/** Browser checks against the real renderer components in the Batch 3 fixture. */
export async function runBatch3MotionChecks(setReducedMotion: (value: boolean) => void) {
  const output = document.createElement("pre");
  output.id = "batch3-check-results";
  output.style.cssText = "position:fixed;inset:0;z-index:1000;background:white;color:#202124;padding:24px;overflow:auto";
  document.body.append(output);
  const f = (window as any).batch3Fixture;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const node = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  let passed = 0;
  const check = async (name: string, callback: () => Promise<void>) => {
    await callback(); ++passed; output.textContent += `PASS ${name}\n`;
  };
  try {
    await wait(300);
    await check("Markdown keeps settled blocks, animates a new tail once, and does not replay for chunks", async () => {
      const root = node(".fixture-markdown .md-content"), settled = node(".fixture-markdown .md-block");
      let mutations = 0;
      const observer = new MutationObserver(() => mutations++);
      observer.observe(settled, { subtree: true, childList: true, characterData: true, attributes: true });
      const text = "# 流式输出\n\n已完成的第一段。\n\n第二段。\n\n正在生成的尾段\n\n新段落";
      f.text(text); await wait(20);
      const tail = node(".fixture-markdown .md-block:last-child > p");
      assert(tail.getAnimations().length > 0, "new tail did not animate");
      assert(settled === root.firstElementChild && settled.firstElementChild!.getAnimations().length === 0, "settled block replayed");
      await wait(150); f.text(text + "继续追加。"); await wait(20);
      assert(tail === node(".fixture-markdown .md-block:last-child > p"), "tail remounted for a chunk");
      assert(tail.getAnimations().length === 0, "chunk replayed tail animation");
      assert(mutations === 0, "settled block was mutated"); observer.disconnect();
      assert(getComputedStyle(settled.firstElementChild!).marginTop === "0px", "first block spacing changed");
      assert(getComputedStyle(tail).marginBottom === "0px", "last block spacing changed");
    });
    await check("late reference definitions and footnotes preserve whole-document semantics without bulk animation", async () => {
      f.text("[link][id]\n\nSecond\n\nThird\n\n[id]: https://example.com\n\nNote[^a]\n\n[^a]: Footnote"); await wait(20);
      assert(node<HTMLAnchorElement>(".fixture-markdown a").href === "https://example.com/", "late reference did not resolve");
      assert(document.querySelectorAll(".fixture-markdown .md-block").length === 1, "document semantics were split");
      assert(document.querySelectorAll(".fixture-markdown [id^='user-content-fn-']").length === 1, "footnote missing or duplicated");
      assert(node(".fixture-markdown .md-content").getAnimations({ subtree: true }).length === 0, "whole document animated for a chunk");
    });
    await check("plan revisions crossfade, rapidly reverse, retain reading positions and exit menus", async () => {
      const scroll = node(".plan-doc-scroll"); scroll.scrollTop = 120; scroll.dispatchEvent(new Event("scroll"));
      f.revision("plan-2");
      assert(node(".plan-revision-swap .content-swap-outgoing").inert, "outgoing plan remains interactive");
      assert(node(".plan-revision-swap .content-swap-current").getAnimations().length > 0, "revision did not fade in");
      await wait(190); assert(scroll.scrollTop === 0, "new revision inherited old scroll");
      scroll.scrollTop = 200; scroll.dispatchEvent(new Event("scroll"));
      f.revision("plan-1"); await wait(20); assert(scroll.scrollTop === 120, "old revision reading position lost");
      f.revision("plan-2"); await wait(190);
      assert(scroll.scrollTop === 200 && !document.querySelector(".plan-revision-swap .content-swap-outgoing"), "rapid revision change left stale layer/position");
      node<HTMLButtonElement>(".plan-revision-trigger").click(); await wait(20);
      node<HTMLButtonElement>(".plan-revision-trigger").click(); await wait(20);
      assert(node(".plan-revision-anchor .popover-presence").inert, "closing revision menu accepts input");
      await wait(150); assert(!document.querySelector(".plan-revision-menu"), "revision menu did not unmount");
    });
    await check("streamed plan chunks update only the tail and do not restart revision transitions", async () => {
      f.draft("# Draft\n\nStable\n\nTail"); await wait(190);
      const first = node(".plan-doc-body .md-block");
      f.draft("# Draft\n\nStable\n\nTail\n\nNew plan block"); await wait(20);
      assert(first === node(".plan-doc-body .md-block"), "plan prefix remounted");
      assert(node(".plan-doc-body .md-block:last-child > p").getAnimations().length > 0, "plan tail missing arrival");
      assert(node(".plan-revision-swap .content-swap-current").getAnimations().length === 0, "plan chunk restarted revision fade");
    });
    await check("file branches collapse, retain nested nodes, reverse quickly and exclude hidden controls", async () => {
      f.tree(true); await wait(150); const file = node<HTMLButtonElement>(".explorer-tree-item.file[title='src/components/Button.tsx']");
      f.tree(false); assert(file.closest("[inert]"), "collapsed branch remains interactive");
      await wait(35); f.tree(true); await wait(150);
      assert(file === node(".explorer-tree-item.file[title='src/components/Button.tsx']"), "branch lost nested nodes");
      assert(!file.closest("[inert]"), "quick reversal left file inert");
      f.tree(false); await wait(150);
      assert(node(".explorer-branch").getBoundingClientRect().height < 1, "branch did not collapse");
      f.tree(true); await wait(150);
    });
    await check("Skill keyboard highlight scrolls smoothly, reverses and respects reduced motion", async () => {
      const list = node(".skill-menu-list");
      f.skill(25); await wait(30);
      assert(list.scrollTop > 0 && list.scrollTop < 650, "highlight scroll did not interpolate");
      f.skill(1); await wait(600);
      const row = node(".skill-menu-row.active").getBoundingClientRect(), box = list.getBoundingClientRect();
      assert(row.top >= box.top - 1 && row.bottom <= box.bottom + 1, "rapid reversal ended outside viewport");
      setReducedMotion(true); await wait(20); f.skill(29); await wait(20);
      assert(node(".skill-menu-row.active").getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1, "reduced-motion scroll was delayed");
      setReducedMotion(false); await wait(30);
    });
    await check("thinking summaries arrive in inline, headline and prose styles", async () => {
      for (const style of ["inline", "headline", "prose"]) {
        f.summary(false, style); await wait(20); f.summary(true, style); await wait(20);
        assert(node(".summary-arrival").getAnimations().length > 0, `${style} summary missing arrival`);
        await wait(190);
      }
    });
    await check("Trace virtual scrolling does not replay history, while new events and bars arrive", async () => {
      const list = node(".trace-list"); list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); await wait(30);
      assert(node(".trace-row").getAnimations().length === 0, "virtual history replayed an entrance");
      list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event("scroll")); await wait(30);
      const timeline = node(".trace-timeline"); timeline.scrollLeft = timeline.scrollWidth; timeline.dispatchEvent(new Event("scroll")); await wait(30);
      f.traceAppend(); await wait(20);
      assert(node("#trace-row-trace-120").getAnimations().length > 0, "new trace event missing arrival");
      assert(node('.trace-bar[data-arrival-key="bar:trace-120"]').getAnimations().length > 0, "new trace bar missing arrival");
      await wait(280);
      list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); await wait(20);
      assert(node(".trace-row").getAnimations().length === 0, "recycled row replayed its animation");
    });
    await check("subagent appends and newly appearing message steps fade once without breaking follow", async () => {
      f.messages([{ id: "m1", role: "assistant", text: "子代理开始检查界面。", thinking: "", tools: [] },
        { id: "m2", role: "assistant", text: "", thinking: "检查新步骤", tools: [] }]); await wait(20);
      assert(node('[data-arrival-key="m2"]').getAnimations().length > 0, "new subagent step did not arrive");
      await wait(160);
      f.messages([{ id: "m1", role: "assistant", text: "子代理开始检查界面。", thinking: "", tools: [] },
        { id: "m2", role: "assistant", text: "发现动画入口", thinking: "检查新步骤", tools: [] }]); await wait(20);
      assert(node('[data-arrival-key="m2:text"]').getAnimations().length > 0, "new answer step did not arrive");
      const scroll = node(".agent-pane-scroll");
      assert(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2, "subagent no longer follows output");
    });
    await check("feedback timings, stagger, sheet blur and reduced-motion cancellation", async () => {
      assert(getComputedStyle(node(".mode-pill")).transitionDuration.includes("0.18s"), "pill semantic transition missing");
      assert(getComputedStyle(node(".skill-menu-row")).transitionProperty.includes("background-color"), "menu feedback missing");
      const cards = [...document.querySelectorAll(".start-option")];
      assert(getComputedStyle(cards[1]!).animationDelay === "0.03s" && getComputedStyle(cards[2]!).animationDelay === "0.06s", "start cards missing stagger");
      const backdrop = document.createElement("div"); backdrop.className = "sheet-backdrop"; document.body.append(backdrop);
      assert(getComputedStyle(backdrop).backdropFilter === "blur(2px)", "sheet blur missing"); backdrop.remove();
      setReducedMotion(true); await wait(20); f.traceAppend();
      f.messages([{ id: "reduced", role: "assistant", text: "Reduced motion", thinking: "", tools: [] }]);
      f.revision("plan-1"); await wait(20);
      assert(node('[data-arrival-key="reduced"]').getAnimations().length === 0, "JS arrival ignored reduced motion");
      assert(!document.querySelector(".content-swap-outgoing"), "reduced-motion version retains an exit");
      assert(getComputedStyle(cards[2]!).animationDelay === "0s", "reduced motion retains a stagger delay");
      setReducedMotion(false); await wait(20);
      assert(node('[data-arrival-key="reduced"]').getAnimations().length === 0, "preference change replayed old entries");
    });
    output.textContent += `\n${passed} Batch 3 checks passed.\n`;
  } catch (error) { output.textContent += `FAIL ${error instanceof Error ? error.stack : String(error)}\n`; }
}
