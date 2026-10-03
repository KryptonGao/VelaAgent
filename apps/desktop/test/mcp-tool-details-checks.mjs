import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Focused checks using the existing Electron renderer harness. */
export async function checkMcpToolDetails({ win, evaluate, until, captureDir }) {
  const results = { results: [
    { id: "3e8e175a-ab03-8139-ad30-cff139f8b6e5", title: "6 个月薄肌训练计划", url: "https://app.notion.com/3e8e175aab038139ad30cff139f8b6e5?pvs=204", type: "page", highlight: "如果腰围稳定且力量上涨，继续**原计划**。你 14 岁，**计划**以身体重组和长期为主，不做主动减脂期，也不设置严格热量赤字。半年后即使体重略升，只要腰围稳定、肩胸背更有形、腹肌轮廓更明显，也属于**计划**成功。".repeat(3), timestamp: "2026-09-27T14:26:00.000Z", verification: { state: "unverified" } },
    { id: "3c2e175a-ab03-815a-b19f-e790d9b4b747", title: "Notion 功能介绍：从笔记到个人工作台", url: "https://app.notion.com/3c2e175aab03815ab19fe790d9b4b747?pvs=204", type: "page", highlight: "日历视图：适合课程、截止日期和计划。学期目标 → 数学提升计划 → 一次函数复习 → 完成练习题。每日计划模板、学习、课堂笔记与考试计划。" },
  ] };
  const fixture = { id: "mcp-details", name: "opaque_registered_name", status: "done", activity: { mcp: { server: "builtin_notion", tool: "notion-search" }, body: JSON.stringify(results) } };
  const render = async (tool = fixture, compact = false) => {
    await evaluate(`window.renderTool(${JSON.stringify(tool)},${compact})`);
    await until("!!document.querySelector('.tool-card-head')");
    if (!(await evaluate("document.querySelector('.tool-card-head').getAttribute('aria-expanded')==='true'"))) await evaluate("document.querySelector('.tool-card-head').click()");
    if (tool.activity.mcp) await until("!!document.querySelector('.mcp-tool-details')");
    else await until("!!document.querySelector('.tool-note')");
  };
  const tab = async (index) => {
    await evaluate(`document.querySelectorAll('.mcp-detail-tabs button')[${index}].click()`);
    await until(`document.querySelectorAll('.mcp-detail-tabs button')[${index}].getAttribute('aria-selected')==='true'`);
  };
  const frames = () => evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const capture = async (name) => {
    if (!captureDir) return;
    await evaluate("new Promise(resolve=>setTimeout(resolve,320))");
    await frames();
    const bounds = await evaluate("(() => { const box=document.querySelector('.tool-card').getBoundingClientRect();const x=Math.max(0,Math.floor(box.x)-12);const y=Math.max(0,Math.floor(box.y)-12);return {x,y,width:Math.min(innerWidth-x,Math.ceil(box.width)+24),height:Math.min(innerHeight-y,Math.ceil(box.height)+24)}; })()");
    writeFileSync(join(captureDir, name), (await win.webContents.capturePage(bounds)).toPNG());
  };
  await until("!!window.renderTool");
  win.setContentSize(820, 740);
  await render();
  await until("document.querySelectorAll('.mcp-search-result').length===2");
  assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), "Results");
  assert.equal(await evaluate("document.querySelector('.mcp-result-title').textContent"), results.results[0].title);
  assert.equal(await evaluate("document.querySelector('.mcp-result-title').getAttribute('href')"), results.results[0].url);
  await until("Number(document.querySelector('.mcp-detail-scroll .thinking-scroll-fade-bottom').style.opacity)>0");
  assert.equal(await evaluate("Number(document.querySelector('.mcp-detail-scroll .thinking-scroll-fade-top').style.opacity)"), 0);
  assert.equal(await evaluate("document.querySelector('.mcp-result-source').open"), false);
  await until("!!document.querySelector('.mcp-search-result > button')");
  await evaluate("document.querySelector('.mcp-search-result > button').click()");
  await until("!!document.querySelector('.mcp-result-snippet.is-expanded')");
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet').textContent"), results.results[0].highlight.replaceAll("**", ""));
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet strong').textContent"), "原计划");
  await evaluate("(() => {const v=document.querySelector('.mcp-detail-scroll .thinking-scroll-viewport');v.scrollTop=(v.scrollHeight-v.clientHeight)/2;v.dispatchEvent(new Event('scroll'));})()");
  await until("Number(document.querySelector('.mcp-detail-scroll .thinking-scroll-fade-top').style.opacity)>0 && Number(document.querySelector('.mcp-detail-scroll .thinking-scroll-fade-bottom').style.opacity)>0");
  await evaluate("(() => {const v=document.querySelector('.mcp-detail-scroll .thinking-scroll-viewport');v.scrollTop=v.scrollHeight;v.dispatchEvent(new Event('scroll'));})()");
  await until("Number(document.querySelector('.mcp-detail-scroll .thinking-scroll-fade-bottom').style.opacity)===0");
  assert.ok(await evaluate("Number(document.querySelector('.mcp-detail-scroll .thinking-scroll-fade-top').style.opacity)>0"));
  await evaluate("document.querySelector('.mcp-search-result > button').click();document.querySelector('.mcp-result-source').open=true");
  assert.ok((await evaluate("document.querySelector('.mcp-result-source').textContent")).includes(results.results[0].id));
  await evaluate("document.querySelector('.mcp-result-source').open=false");
  console.log("PASS search hierarchy, safe links, full excerpts and source details");

  await tab(1);
  await until("Array.from(document.querySelectorAll('.mcp-detail-scroll .thinking-scroll-fade')).every(node=>Number(node.style.opacity)===0)");
  assert.ok((await evaluate("document.querySelector('.mcp-call-fields').textContent")).includes("builtin_notion"));
  assert.ok((await evaluate("document.querySelector('.mcp-call-fields').textContent")).includes("Completed"));
  await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  await until("document.querySelector('[aria-selected=true]').textContent==='Raw response'");
  assert.equal(await evaluate("document.activeElement===document.querySelector('[aria-selected=true]')"), true);
  assert.deepEqual(JSON.parse(await evaluate("document.querySelector('.mcp-response-code').textContent")), results);
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedResponse=text}}});document.querySelector('.mcp-detail-action').click()");
  await until("document.querySelector('[role=status]').textContent==='Copied'");
  assert.deepEqual(JSON.parse(await evaluate("window.copiedResponse")), results);
  assert.equal(await evaluate("window.copiedResponse"), fixture.activity.body);
  await evaluate("navigator.clipboard.writeText=async()=>{throw new Error('blocked')};document.querySelector('.mcp-detail-action').click()");
  await until("document.querySelector('[role=status]').textContent.includes('Copy failed')");
  await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  await until("document.querySelector('[aria-selected=true]').textContent==='Results'");
  console.log("PASS call metadata, keyboard tabs, lossless formatted response and copy feedback");

  // Capture the actual ToolCard in both layouts and supported themes, using Chinese copy.
  await evaluate("document.documentElement.dataset.theme='celadon';document.getElementById('root').className='tool-card-list is-compact'");
  await render({ ...fixture, id: "mcp-details-zh" }, true);
  // The harness sets the global locale and provides a matching locale context below.
  await evaluate("window.setDetailLocale('zh-CN')");
  await until("document.querySelector('[aria-selected=true]').textContent==='结果'");
  await capture("mcp-details-light.png");
  await evaluate("(() => {const v=document.querySelector('.mcp-detail-scroll .thinking-scroll-viewport');v.scrollTop=(v.scrollHeight-v.clientHeight)/2;v.dispatchEvent(new Event('scroll'));})()");
  await capture("mcp-details-middle.png");
  await tab(2);
  await capture("mcp-details-raw.png");
  await tab(0);
  await evaluate("delete document.documentElement.dataset.theme;document.documentElement.dataset.scheme='dark'");
  await capture("mcp-details-dark.png");
  await evaluate("document.documentElement.dataset.scheme='light';document.documentElement.dataset.theme='celadon'");
  win.setContentSize(390, 740);
  await frames();
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await until("!!document.querySelector('.mcp-search-result > button')");
  await capture("mcp-details-narrow.png");
  win.webContents.setZoomFactor(2);
  win.setContentSize(820, 900);
  await frames();
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await capture("mcp-details-zoom.png");
  win.webContents.setZoomFactor(1);
  win.setContentSize(820, 740);
  await evaluate("window.setDetailLocale('en');document.getElementById('root').className=''");
  await render({ ...fixture, id: "mcp-card-mode" });
  await capture("mcp-details-card.png");
  console.log("PASS compact/card layouts, narrow viewport and 200% zoom without horizontal overflow");

  const markdown = "### 页面摘要\n\n**重点**与 `notion-search`。\n\n- [查看页面](https://app.notion.com/page)\n- 第二项\n\n```json\n{\n  \"count\": 2\n}\n```";
  await render({ ...fixture, id: "markdown-snippet", activity: { ...fixture.activity, body: JSON.stringify({ results: [{ title: "Markdown", highlight: markdown }] }) } });
  await until("!!document.querySelector('.mcp-search-result > button')");
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet h3').textContent"), "页面摘要");
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet strong').textContent"), "重点");
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet :not(pre) > code').textContent"), "notion-search");
  assert.equal(await evaluate("document.querySelectorAll('.mcp-result-snippet li').length"), 2);
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet a').getAttribute('href')"), "https://app.notion.com/page");
  assert.equal(await evaluate("document.querySelector('.mcp-result-snippet pre code').textContent"), '{\n  "count": 2\n}\n');
  await evaluate("document.querySelector('.mcp-search-result > button').click()");
  await until("document.querySelector('.mcp-result-snippet').clientHeight>=document.querySelector('.mcp-result-snippet').scrollHeight-1");
  await evaluate("document.querySelector('.mcp-search-result > button').click()");
  await until("document.querySelector('.mcp-result-snippet').scrollHeight>document.querySelector('.mcp-result-snippet').clientHeight+1");
  console.log("PASS search snippet Markdown headings, emphasis, links, lists and code retain excerpt expand/collapse");

  for (const [id, status, body, selector, text] of [
    ["empty-search", "done", '{"results":[]}', ".mcp-detail-panel", "No matching results"],
    ["empty-body", "done", "", ".mcp-detail-panel", "The tool returned no content"],
    ["pending", "running", "", ".mcp-detail-panel", "Waiting for tool results"],
    ["failed", "error", "Permission denied", "[role=alert]", "Permission denied"],
    ["text", "done", "**Readable text**", ".tool-note strong", "Readable text"],
    ["partial", "running", '{"results":[', ".tool-note", '{"results":['],
    ["generic-json", "done", '{"count":3,"nested":{"ok":true}}', ".mcp-json-fields", "count3"],
    ["mixed-json", "done", '{"results":[{"title":"Valid"},null]}', ".mcp-json-fields", "null"],
  ]) {
    await render({ ...fixture, id, status, activity: { ...fixture.activity, body } });
    await until(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`);
  }
  await render({ ...fixture, id: "unsafe-link", activity: { ...fixture.activity, body: JSON.stringify({ results: [{ title: "Unsafe URL", url: "javascript:alert(1)", timestamp: "invalid" }] }) } });
  assert.equal(await evaluate("document.querySelector('a.mcp-result-title')===null"), true);
  assert.equal(await evaluate("document.querySelector('.mcp-result-meta').textContent.includes('Invalid')"), false);
  await render({ ...fixture, id: "live-transition", status: "running", activity: { ...fixture.activity, body: "" } });
  await evaluate(`window.renderTool(${JSON.stringify({ ...fixture, id: "live-transition" })})`);
  await until("document.querySelector('.tool-card').classList.contains('is-done') && document.querySelectorAll('.mcp-search-result').length===2");
  await evaluate(`window.restoreTool(${JSON.stringify({ ...fixture, id: "restored" })},true)`);
  await until("document.querySelector('.tool-card-head')?.getAttribute('aria-expanded')==='false'");
  await evaluate("document.querySelector('.tool-card-head').click()");
  await until("document.querySelectorAll('.mcp-search-result').length===2");
  await render({ id: "ordinary", name: "ordinary-tool", status: "done", activity: { body: "Normal output" } });
  assert.equal(await evaluate("document.querySelector('.mcp-tool-details')===null"), true);
  assert.equal(await evaluate("document.querySelector('.tool-note').textContent"), "Normal output");
  console.log("PASS empty, running, failed, text, partial and generic JSON responses, restored history and ordinary tools");
}
