/** 图片查看器的浏览器夹具:真实 ChatView + 一条带三张图片的用户消息,用来核对缩放、平移与进出场。 */
import React from "react";
import { createRoot } from "react-dom/client";
import type { AppState, ConversationSummary, ImageAttachment, VelaApi } from "@vela/shared";
import { ChatView } from "../src/renderer/components/ChatView";
import { FilePreviewProvider } from "../src/renderer/components/preview/FilePreviewContext";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import "../src/renderer/styles.css";

const noopSubscription = () => () => {};
window.vela = {
  platform: "darwin", setLocale() {}, listOpenTargets: async () => [],
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  listSkills: async () => ({ skills: [] }),
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription,
  pickAttachments: async () => [], hydrateAttachments: async () => [],
  listWorkspaceFiles: async () => ({ root: "/workspace/Vela", files: [] }),
  readWorkspaceFile: async (path: string) => ({ path, absolutePath: `/workspace/Vela/${path}`, kind: "text", content: "", size: 0, truncated: false }),
} as unknown as VelaApi;

const models = {
  catalog: { models: [], providers: [] }, login: { active: false },
  select() {}, setThinking() {}, add() {}, remove() {}, logout() {}, loginProvider() {},
  replyLogin() {}, cancelLogin() {}, dismissLogin() {},
} as unknown as ReturnType<typeof useModels>;
const project = {
  workspace: { current: "/workspace/Vela", recents: [] }, approval: null, environment: null, environments: [],
  sandboxMode: "ask", git: null, openWorkspaceDialog: async () => {}, replyApproval() {}, listBranches: async () => [],
} as unknown as ProjectApi;
const conversation: ConversationSummary = {
  id: "preview", title: "图片查看", updatedAt: Date.now(), cwd: "/workspace/Vela", archivedAt: null, status: "ready",
};

/** 带网格与页码的测试图:缩放、平移是否生效,一眼能看出来。 */
function makeImage(width: number, height: number, hue: number, label: string): ImageAttachment {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 62% 34%)`);
  gradient.addColorStop(1, `hsl(${hue + 40} 58% 62%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(255,255,255,0.35)";
  context.lineWidth = Math.max(1, Math.round(width / 800));
  for (let x = 0; x <= width; x += 100) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += 100) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.fillStyle = "#fff";
  context.font = `600 ${Math.round(width / 14)}px -apple-system, sans-serif`;
  context.textAlign = "center";
  context.fillText(label, width / 2, height / 2);
  context.font = `500 ${Math.round(width / 34)}px -apple-system, sans-serif`;
  context.fillText(`${width} × ${height}`, width / 2, height / 2 + Math.round(width / 14));
  return { type: "image", data: canvas.toDataURL("image/png").split(",")[1]!, mimeType: "image/png" };
}

const images = [
  makeImage(2400, 1600, 210, "Landscape"),
  makeImage(1200, 1800, 20, "Portrait"),
  makeImage(320, 240, 140, "Small"),
];

const messages = [
  { id: "u1", role: "user", text: "这两张截图帮我看看布局。", images, thinking: "", tools: [], timestamp: Date.now(), planIds: [] },
  { id: "a1", role: "assistant", text: "收到,我先看一下图片里的布局。", images: [], thinking: "", tools: [], timestamp: Date.now(), planIds: [] },
  { id: "u2", role: "user", text: "重点是第三张里的小图。", images: [], thinking: "", tools: [], timestamp: Date.now(), planIds: [] },
];
const state = {
  activeConversationId: "preview",
  conversations: [conversation],
  session: {
    id: "preview", title: "图片查看", cwd: "/workspace/Vela", status: "ready", model: "Preview",
    modelReady: true, modelProvider: "preview", modelId: "preview", tools: [], mode: "agent",
    thinkingLevel: "medium", thinkingLevels: ["medium"],
  },
  context: { tokens: 1000, contextWindow: 100000, percent: 1, messageCount: 3, toolCallCount: 0,
    segments: { system: 200, tools: 0, rules: 0, skills: 0, conversation: 800 } },
} as AppState;

function Fixture() {
  return (
    <div style={{ height: "100vh", display: "flex", background: "var(--bg-chat)" }}>
      <ChatView messages={messages as never} state={state} project={project} sendError={null} platform="darwin"
        leftCollapsed rightCollapsed models={models} onToggleLeft={() => {}} onToggleRight={() => {}}
        onSend={async () => {}} onAbort={async () => {}} onMode={() => {}} getQuestion={() => null}
        onReplyQuestion={() => {}} onBranch={() => {}} showNewTab={false} onNewTab={() => {}} onOpenChanges={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><FilePreviewProvider><Fixture /></FilePreviewProvider></React.StrictMode>,
);
