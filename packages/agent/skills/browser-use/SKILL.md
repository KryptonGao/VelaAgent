---
name: browser-use
description: Inspect and operate the same pages as Vela's right-hand Browser Panel through persistent Browser REPL JavaScript.
---

Use this skill when checking a webpage, testing a UI, or verifying changes after HMR.
Browser tools require execution mode and an injected desktop Browser Host.

1. Start with `const browser = await agent.browsers.get("iab");` in `browser_repl`.
2. Inspect `await browser.tabs.list()` and reuse the relevant tab with `await browser.tabs.get(id)` or `await browser.tabs.selected()`.
3. Print `await tab.snapshot()` using `nodeRepl.write`. Inspect the actual DOM before choosing a locator.
4. Use `tab.query({ref})`, `{role,name}`, `{text}`, or `{css}`. Await locator `click()`, `fill(value)`, `type(text)`, `press(key)`, or `selectOption(value)`.
5. Inspect again after navigation, node replacement or HMR. References bind to the page generation; ambiguous/stale targets fail rather than guessing.
6. Verify with `nodeRepl.emitImage(await tab.screenshot())`. Inspect `tab.console({since,limit})` and `tab.network({since,limit})` when diagnosing problems.

Tab management: `browser.tabs.open(url)`, `select(id)`, `close(id)`.
Navigation: `tab.url()`, `title()`, `goto(url)`, `back()`, `forward()`, `reload()`.
Frames: `tab.frame(frameId)` exposes the same DOM operations. Scroll with `tab.scroll({x,y})`; inspect page JavaScript with `tab.evaluate(expression,args)`.

REPL bindings persist per agent. Use top-level await and await all browser operations.
Default timeout is 30 seconds; `timeoutMs` permits up to 120 seconds. Reset clears bindings only; it retains pages and login state.
The REPL is a local Node environment under ask/smart/full permissions. Treat every execution as a possible workspace mutation and redo Goal validation after browser checks.
