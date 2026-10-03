/**
 * 浏览器 UI 检查清单。每个 fixture 是一个已存在的预览页,页面里的检查脚本把结果写进
 * 结果元素(带 data-status,或在文本里输出 PASS/FAIL 行)。新增检查时在这里登记,
 * 并在预览页的检查脚本里保证结果元素最终带上 data-status。
 */
export const browserFixtures = [
  {
    id: "ui:browser-agent-cursor",
    title: "Agent 鼠标 · 界面与动效",
    feature: "browser",
    page: "test/browser-agent-cursor-preview.html?checks=1",
    resultSelector: "#browser-agent-cursor-results",
    timeoutMs: 30_000,
  },
  {
    id: "ui:browser-electron",
    title: "Agent 鼠标 · Electron 网页操作",
    feature: "browser",
    page: "test/browser-agent-cursor-preview.html",
    resultSelector: "#browser-agent-cursor-results",
    script: "test/browser-test-center-smoke.mjs",
    successText: "Browser Electron smoke:",
    timeoutMs: 120_000,
  },
  {
    id: "ui:motion",
    title: "动效 · Batch 1",
    page: "test/motion-preview.html?checks=1",
    resultSelector: "#motion-check-results",
    timeoutMs: 120_000,
  },
  {
    id: "ui:motion-batch2",
    title: "动效 · Batch 2",
    page: "test/motion-batch2-preview.html?checks=1",
    resultSelector: "#batch2-check-results",
    timeoutMs: 120_000,
  },
  {
    id: "ui:motion-batch3",
    title: "动效 · Batch 3",
    page: "test/motion-batch3-preview.html?checks=1",
    resultSelector: "#batch3-check-results",
    timeoutMs: 120_000,
  },
  {
    id: "ui:turn-review",
    title: "变更审查",
    page: "test/turn-review-preview.html?checks=1",
    resultSelector: "#turn-review-results",
    timeoutMs: 120_000,
  },
  {
    id: "ui:tool-process",
    title: "工具过程显示",
    page: "test/tool-process-preview.html?checks=1",
    resultSelector: "#check-result",
    timeoutMs: 120_000,
  },
  {
    id: "ui:stream-performance",
    title: "流式渲染性能",
    page: "test/stream-performance-preview.html?checks=1",
    resultSelector: "#stream-check-results",
    timeoutMs: 120_000,
  },
  {
    id: "ui:workbench-close",
    title: "工作面板关闭",
    page: "test/workbench-close-preview.html",
    resultSelector: "#workbench-close-results",
    timeoutMs: 120_000,
  },
];

/** 打开预览(不带检查参数)用的页面地址。 */
export function previewPage(fixture) {
  return fixture.page.split("?")[0];
}
