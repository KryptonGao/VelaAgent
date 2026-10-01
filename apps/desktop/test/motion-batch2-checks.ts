/** Browser integration checks for the real Batch 2 surfaces. */
export async function runBatch2MotionChecks(setReducedMotion: (value: boolean) => void) {
  const result = document.createElement("pre");
  result.id = "batch2-check-results";
  result.style.cssText = "position:fixed;inset:0;z-index:1000;background:white;color:#202124;padding:24px;overflow:auto";
  document.body.append(result);
  // Fixture-only API and DOM access; no production state or external side effects.
  const fixture = (window as any).batch2Fixture;
  const preview = () => (window as any).batch2Preview;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const node = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  let passed = 0;
  async function check(name: string, callback: () => Promise<void>) {
    await callback(); ++passed; result.textContent += `PASS ${name}\n`;
  }
  const inputValue = (value: string) => {
    const textarea = node<HTMLTextAreaElement>(".input-textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await check("conversation/workspace arrival preserves Composer and history does not animate individually", async () => {
      inputValue("draft preserved"); await wait(20);
      const composer = node(".chat-dock-wrapper"), old = node(".chat-message-surface");
      fixture.active("b");
      assert(node(".chat-message-surface") !== old, "message surface did not change");
      assert(node(".chat-message-surface").getAnimations().length > 0, "missing arrival animation");
      assert(node(".chat-dock-wrapper") === composer, "Composer remounted");
      assert(node<HTMLTextAreaElement>(".input-textarea").value === "draft preserved", "draft was lost");
      assert(!document.querySelector(".chat-message-surface .message-enter"), "history received individual entrance motion");
      await wait(220);
      const next = node(".chat-message-surface"); fixture.workspace("/workspace/Other");
      assert(node(".chat-message-surface") !== next, "workspace did not replace message surface");
      await wait(220);
      fixture.append(); await wait(25);
      const scroller = node(".chat-scroll-area");
      assert(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2, "append no longer follows bottom");
    });
    await check("sidebar inserts, retains inert exits, reorders via FLIP and cancels a rapid archive reversal", async () => {
      fixture.conversations(["new", "c", "a", "b"]);
      assert(node('[data-motion-key="new"]').classList.contains("is-entering"), "new row missing entrance");
      assert(node('[data-motion-key="c"]').getAnimations().length > 0, "existing row did not FLIP");
      await wait(190);
      fixture.conversations(["new", "a", "b"]);
      assert(node('[data-motion-key="c"]').inert, "archived row accepts input");
      assert(node('[data-motion-key="c"]').classList.contains("is-closing"), "row was removed before exit");
      await wait(45); fixture.conversations(["c", "new", "a", "b"]); await wait(210);
      assert(!node('[data-motion-key="c"]').inert, "rapid restore left row inert");
      fixture.conversations(["c", "b"]); await wait(210);
      assert(!document.querySelector('[data-motion-key="new"]'), "exit did not unmount");
      assert(node('[data-motion-key="b"]').getAnimations().length === 0, "pruning a collapsed row replayed its completed movement");
      assert([...document.querySelectorAll(".subchat-title")].map((item) => item.textContent).join(",") === "Chat c,Chat b", "live row order is incorrect");
      const many = Array.from({ length: 50 }, (_, index) => `row-${index}`);
      fixture.conversations(many); await wait(210);
      const scrollArea = node(".sidebar-scroll-area"); scrollArea.scrollTop = 180;
      const row = node('[data-motion-key="row-10"]');
      const before = row.getBoundingClientRect().top;
      const reordered = [...many]; [reordered[10], reordered[11]] = [reordered[11], reordered[10]];
      fixture.conversations(reordered);
      assert(Math.abs(row.getBoundingClientRect().top - before) < 2, "scrolling changed the FLIP starting position");
      await wait(190);
      fixture.conversations(reordered);
      assert(row.getAnimations().length === 0, "unchanged row order started a spurious animation after scroll");
      fixture.conversations(["c", "b"]); await wait(210);
    });
    await check("disclosures animate height, retain content state and exclude collapsed controls", async () => {
      const field = node<HTMLInputElement>(".panel-disclosure input"); field.value = "saved value";
      fixture.disclosure(true); await wait(270);
      const expanded = node(".panel-disclosure-content").getBoundingClientRect().height;
      fixture.disclosure(false);
      assert(node(".panel-disclosure-content").inert, "collapsed region is interactive");
      await wait(270);
      assert(node(".panel-disclosure-content").getBoundingClientRect().height < 1, "region did not collapse to zero");
      fixture.disclosure(true); await wait(270);
      assert(node<HTMLInputElement>(".panel-disclosure input").value === "saved value" && expanded > 0, "disclosure lost content state");
      node<HTMLButtonElement>(".context-usage-title").click(); await wait(260);
      assert(node(".context-usage-details").getBoundingClientRect().height > 0, "usage legend did not expand");
      node<HTMLButtonElement>(".context-usage-title").click(); await wait(260);
      assert(node(".context-usage-details").getBoundingClientRect().height < 1 && node(".context-usage-details").inert, "usage legend did not collapse");
    });
    await check("Composer height smoothly grows/shrinks and reaches its 140px cap", async () => {
      inputValue("short"); await wait(160);
      const input = node<HTMLTextAreaElement>(".input-textarea");
      const small = input.getBoundingClientRect().height;
      inputValue(Array.from({ length: 20 }, () => "a line of text").join("\n")); await wait(25);
      assert(input.getAnimations().length > 0, "textarea has no height transition");
      await wait(160);
      assert(Math.abs(input.getBoundingClientRect().height - 140) < 1, "textarea cap changed");
      inputValue("short"); await wait(160);
      assert(Math.abs(input.getBoundingClientRect().height - small) < 1, "textarea failed to shrink");
    });
    await check("send/stop fixed slot changes semantics immediately and only current action is interactive", async () => {
      assert(Number(getComputedStyle(node(".composer-action-slot .stop")).opacity) === 0, "inactive disabled stop is visible");
      fixture.streaming(true);
      const send = node<HTMLButtonElement>(".composer-action-slot .send"), stop = node<HTMLButtonElement>(".composer-action-slot .stop");
      assert(send.inert && send.disabled && !stop.inert && !stop.disabled, "streaming controls are incorrect");
      assert(getComputedStyle(send).pointerEvents === "none", "outgoing send intercepts input");
      await wait(35); fixture.streaming(false); await wait(35); fixture.streaming(true); await wait(190);
      assert(Number(getComputedStyle(send).opacity) === 0 && Number(getComputedStyle(stop).opacity) === 1, "crossfade did not settle");
      stop.click(); await wait(190);
      assert(!send.inert && stop.inert && stop.disabled, "stop action did not restore send");
      assert(Number(getComputedStyle(stop).opacity) === 0, "inactive stop remains visible over send");
    });
    await check("usage ring interpolates and high-usage color settles", async () => {
      fixture.percent(85); await wait(20);
      const ring = node(".composer-stat-ring-progress");
      assert(ring.getAnimations().length > 0, "ring has no progress transition");
      assert(node(".composer-stat-context").classList.contains("high"), "high state did not change");
      await wait(350); assert(ring.getAnimations().length === 0, "ring transition did not complete");
    });
    await check("file arrival does not remount its editor or reset restored scroll on asynchronous highlight", async () => {
      const code = node(".preview-code-pane"), scroller = node(".code-scroll");
      scroller.scrollTop = 500; scroller.dispatchEvent(new Event("scroll"));
      preview().openFile("second.txt"); await wait(25);
      assert(document.querySelector(".code-state"), "new file did not show loading");
      await wait(100);
      assert(node(".preview-code-pane") === code, "editor remounted");
      assert(code.getAnimations().length > 0, "loaded file did not animate");
      preview().openFile("first.txt"); await wait(220);
      assert(node(".code-scroll").scrollTop === 500, "cached file scroll was not restored");
    });
    await check("Diff selection never shows old file contents and arrival preserves permanent diff colors", async () => {
      fixture.changePath("second.txt"); await wait(15);
      assert(!node(".changes-diff").textContent?.includes("first.txt old"), "old diff leaked under new file heading");
      await wait(100);
      const diff = node(".diff-content-enter");
      assert(diff.textContent?.includes("second.txt old"), "wrong diff response");
      assert(diff.getAnimations().length > 0, "diff has no arrival motion");
      await wait(300);
      assert(getComputedStyle(node(".diff-line.add")).backgroundColor !== "rgba(0, 0, 0, 0)", "added line lost semantic color");
      fixture.changePath("first.txt"); await wait(15); fixture.changePath("second.txt"); await wait(130);
      assert(node(".changes-diff").textContent?.includes("second.txt old"), "late response replaced current diff");
    });
    await check("tool status crossfade retains only inaccessible outgoing marks and cancels stale states", async () => {
      fixture.status("done");
      assert(node(".tool-status-swap .content-swap-outgoing").inert, "old tool status remained accessible");
      assert(node(".tool-status-swap .content-swap-current").textContent !== undefined, "missing current status");
      await wait(35); fixture.status("error"); await wait(210);
      assert(!document.querySelector(".tool-status-swap .content-swap-outgoing"), "old mark did not leave");
      assert(document.querySelector(".tool-status-mark.error"), "final error status is missing");
      fixture.status("done"); await wait(210);
      assert(!document.querySelector(".tool-status-swap.compact"), "completed compact status still occupies a flex gap");
    });
    await check("attachments retain inert exits, keep stable nodes and reflow remaining chips via FLIP", async () => {
      node<HTMLButtonElement>(".attach-btn").click(); await wait(180);
      node<HTMLButtonElement>(".attach-menu-row").click(); await wait(190);
      const chips = [...document.querySelectorAll<HTMLElement>(".attachment-row > .motion-list-item")];
      assert(chips.length === 3, "attachments were not added");
      const remaining = chips[1]; chips[0].querySelector<HTMLButtonElement>("button")!.click(); await wait(15);
      assert(chips[0].inert, "removed chip remained interactive");
      assert(remaining.getAnimations().length > 0, "remaining attachments did not FLIP");
      await wait(210);
      assert(document.querySelectorAll(".attachment-chip").length === 2 && remaining.isConnected, "remaining attachment was remounted or wrong count");
      document.querySelectorAll<HTMLButtonElement>(".attachment-remove").forEach((button) => button.click()); await wait(210);
      assert(!document.querySelector(".attachment-chip"), "final chip remained");
      assert(getComputedStyle(node(".attachment-row")).display === "none", "empty attachment row kept spacing");
    });
    await check("Onboarding has opposite directions and rapid changes retain only one outgoing step", async () => {
      node("#onboarding-fixture").style.display = "block";
      const welcome = node(".onboarding-step-swap > .content-swap-current");
      node<HTMLButtonElement>(".onboarding-start").click(); await wait(20);
      assert(node(".onboarding-step-swap").style.getPropertyValue("--swap-direction") === "1", "forward direction is wrong");
      assert(node(".onboarding-step-swap > .content-swap-outgoing").inert, "old step remains interactive");
      assert(node(".onboarding-step-swap > .content-swap-outgoing") === welcome, "exit remounted the previous step");
      assert(node(".onboarding-step-swap > .content-swap-current").scrollTop === 0, "new step inherited old scroll");
      node<HTMLButtonElement>(".onboarding-secondary").click(); await wait(20);
      assert(node(".onboarding-step-swap").style.getPropertyValue("--swap-direction") === "-1", "backward direction is wrong");
      assert(document.querySelectorAll(".onboarding-step-swap > .content-swap-outgoing").length === 1, "rapid change accumulated stale screens");
      await wait(220);
      assert(!document.querySelector(".onboarding-step-swap > .content-swap-outgoing"), "old step failed to unmount");
      node("#onboarding-fixture").style.display = "none";
    });
    await check("reduced-motion preference changes cancel JS animations and skip all exit delays", async () => {
      fixture.conversations(["c"]); fixture.status("running"); fixture.active("c");
      setReducedMotion(true); await wait(25);
      assert(!document.querySelector('[data-motion-key="b"]'), "reduced motion retained a sidebar exit");
      assert(!document.querySelector(".tool-status-swap .content-swap-outgoing"), "reduced motion retained a status exit");
      assert(node(".chat-message-surface").getAnimations().length === 0, "arrival animation was not cancelled");
      fixture.conversations(["x", "c"]); fixture.active("x"); await wait(25);
      assert(node('[data-motion-key="c"]').getAnimations().length === 0, "reduced motion started FLIP");
      assert(node(".chat-message-surface").getAnimations().length === 0, "reduced motion started arrival");
      assert(getComputedStyle(node(".composer-action-slot .send")).transform === "none", "reduced motion retained button scale");
      assert(parseFloat(getComputedStyle(node(".composer-action-slot .send")).transitionDuration) < 0.001, "reduced motion retained CSS delay");
    });
    result.dataset.status = "passed"; result.textContent += `${passed} Batch 2 motion integration checks passed.`;
  } catch (error) {
    result.dataset.status = "failed"; result.textContent += `FAIL ${String(error)}`;
  }
}
