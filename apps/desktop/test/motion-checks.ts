/** Browser integration checks run by opening motion-preview.html?checks=1. */
export async function runMotionChecks(setReducedMotion: (value: boolean) => void) {
  const result = document.createElement("pre");
  result.id = "motion-check-results";
  result.style.cssText = "position:fixed;inset:0;z-index:1000;background:white;color:#202124;padding:24px;overflow:auto";
  document.body.append(result);
  const checks: string[] = [];
  const assert = {
    equal(actual: unknown, expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    ok(value: unknown, message: string) { if (!value) throw new Error(message); },
  };
  // Test-only expressions operate solely on this fixture's DOM and in-memory React state.
  const evaluate = async (code: string) => (0, eval)(code);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function check(name: string, callback: () => Promise<void>) {
    await callback(); checks.push(name); result.textContent = checks.map((name) => `PASS ${name}`).join("\n");
  }
  try {
  await check("root screens overlap, exit is inert, and main content remains", async () => {
    await evaluate("motionFixture.screen(true)");
    assert.equal(await evaluate(`({ screens: document.querySelectorAll('.app-screen').length,
      inert: document.querySelector('.app-screen-onboarding').inert,
      duration: getComputedStyle(document.querySelector('.app-screen-main')).transitionDuration })`),
    { screens: 2, inert: true, duration: "0.24s, 0.24s" });
    await wait(250);
    assert.equal(await evaluate("document.querySelectorAll('.app-screen').length"), 1);
  });
  await check("popover retains DOM on close and cancels removal on rapid reopen", async () => {
    await evaluate("motionFixture.popover(true)"); await wait(230);
    await evaluate("document.querySelector('#test-menu input').value = 'edited'; motionFixture.popover(false)");
    assert.equal(await evaluate("document.querySelector('#test-menu').parentElement.inert"), true);
    await wait(45); await evaluate("motionFixture.popover(true)"); await wait(200);
    assert.equal(await evaluate("document.querySelector('#test-menu input').value"), "edited");
    await evaluate("motionFixture.popover(false)"); await wait(200);
    assert.equal(await evaluate("document.querySelector('#test-menu') === null"), true);
  });
  await check("tab crossfade preserves form state and excludes outgoing tab from input", async () => {
    await evaluate("document.querySelector('#tab-a input').value = 'saved'; motionFixture.tab('b')");
    assert.equal(await evaluate(`({ retained: !document.querySelector('#tab-a').hidden,
      inert: document.querySelector('#tab-a').inert, visible: !document.querySelector('#tab-b').hidden })`),
    { retained: true, inert: true, visible: true });
    await wait(200);
    assert.equal(await evaluate("document.querySelector('#tab-a').hidden"), true);
    await evaluate("motionFixture.tab('a')"); await wait(30); await evaluate("motionFixture.tab('b')");
    await wait(30); await evaluate("motionFixture.tab('a')"); await wait(200);
    assert.equal(await evaluate("document.querySelector('#tab-a input').value"), "saved");
    assert.equal(await evaluate("document.querySelector('#tab-a').hidden"), false);
  });
  await check("shared file preview animates a content swap without losing editor state", async () => {
    await evaluate("motionFixture.file('file-b')");
    assert.equal(await evaluate("document.querySelector('#tab-a').getAnimations().length > 0"), true);
    assert.equal(await evaluate("document.querySelector('#tab-a input').value"), "saved");
    await wait(180);
    assert.equal(await evaluate("document.querySelector('#tab-a').getAnimations().length"), 0);
  });
  await check("workbench opens from zero width in collapsed responsive layout and retains last tab while exiting", async () => {
    await evaluate("motionFixture.workbench(true)");
    const width = await evaluate("document.querySelector('.workbench-panel').getBoundingClientRect().width");
    await wait(340);
    const full = await evaluate("document.querySelector('.workbench-panel').getBoundingClientRect().width");
    assert.ok(width < full, `opening width ${width} < ${full}`);
    await evaluate("motionFixture.workbench(false)");
    assert.equal(await evaluate(`({ inert: document.querySelector('.workbench-panel').inert,
      tabs: document.querySelectorAll('.workbench-tab').length })`), { inert: true, tabs: 1 });
    await wait(50); await evaluate("motionFixture.workbench(true)"); await wait(230);
    assert.equal(await evaluate("document.querySelector('.workbench-panel').inert"), false);
    await evaluate("motionFixture.workbench(false)"); await wait(240);
    assert.equal(await evaluate("document.querySelector('.workbench-panel') === null"), true);
  });
  await check("native repository popover stays in top layer through exit and uses trigger origin", async () => {
    await evaluate("motionFixture.repo(true)"); await wait(220);
    assert.equal(await evaluate("document.querySelector('.test-repo').matches(':popover-open')"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('.test-repo').style.transformOrigin)"), true);
    await evaluate("motionFixture.repo(false)");
    assert.equal(await evaluate("document.querySelector('.test-repo').matches(':popover-open')"), true);
    assert.equal(await evaluate("document.querySelector('.test-repo').parentElement.inert"), true);
    await wait(200);
    assert.equal(await evaluate("document.querySelector('.test-repo') === null"), true);
  });
  await check("real menu selection and Escape close via shared presence", async () => {
    await evaluate("document.querySelector('.mode-pill').click()"); await wait(220);
    await evaluate("document.querySelectorAll('.mode-option')[1].click()");
    assert.equal(await evaluate("document.querySelector('.mode-pill').textContent"), "Plan");
    assert.equal(await evaluate("document.querySelector('.mode-popover').parentElement.inert"), true);
    await wait(180);
    await evaluate("document.querySelector('.attach-btn').click()"); await wait(220);
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))"); await wait(20);
    assert.equal(await evaluate("document.querySelector('.attach-menu').parentElement.inert"), true);
    await wait(180);
    assert.equal(await evaluate("document.querySelector('.attach-menu') === null"), true);
  });
  await check("context usage portal completes exit and restores trigger focus", async () => {
    await evaluate("document.querySelector('.context-usage-trigger').click()"); await wait(230);
    await evaluate("document.querySelector('.context-popover-close').click()");
    assert.equal(await evaluate("document.querySelector('.context-usage-popover').inert"), true);
    assert.equal(await evaluate("document.activeElement === document.querySelector('.context-usage-trigger')"), true);
    await wait(200);
    assert.equal(await evaluate("document.querySelector('.context-usage-popover') === null"), true);
  });
  await check("reduced motion removes exits immediately, including preference changes during exit", async () => {
    await evaluate("motionFixture.popover(true); motionFixture.workbench(true)"); await wait(340);
    await evaluate("motionFixture.popover(false)");
    setReducedMotion(true);
    await wait(25);
    assert.equal(await evaluate("document.querySelector('#test-menu') === null"), true);
    await evaluate("motionFixture.file('file-c')");
    assert.equal(await evaluate("document.querySelector('#tab-a').getAnimations().length"), 0);
    await evaluate("motionFixture.workbench(false); motionFixture.tab('b'); motionFixture.repo(true)"); await wait(25);
    assert.equal(await evaluate("document.querySelector('.workbench-panel') === null"), true);
    assert.equal(await evaluate("document.querySelector('#tab-a').hidden"), true);
    await evaluate("motionFixture.repo(false)");
    assert.equal(await evaluate("document.querySelector('.test-repo') === null"), true);
    await evaluate("motionFixture.screen(false)");
    assert.equal(await evaluate("document.querySelectorAll('.app-screen').length"), 1);
  });
    result.dataset.status = "passed";
    result.textContent += `\n${checks.length} motion integration checks passed.`;
  } catch (error) {
    result.dataset.status = "failed";
    result.textContent += `\nFAIL ${String(error)}`;
  }
}
