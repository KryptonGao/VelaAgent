/** Full-app fixture with in-memory IPC responses. No filesystem or model calls. */
import React from "react";
import { createRoot } from "react-dom/client";
import type { AppState, VelaApi } from "@vela/shared";
import { App } from "../src/renderer/App";
import "../src/renderer/styles.css";

localStorage.setItem("vela.onboarding.complete", "true");
localStorage.setItem("vela.locale", "zh-CN");
const params = new URLSearchParams(location.search);
if (params.has("layout")) localStorage.setItem("vela.infoLayout", params.get("layout")!);
const state: AppState = {
  activeConversationId: "fixture",
  conversations: [],
  session: {
    id: "fixture", title: "悬浮信息布局", status: "ready", cwd: "/workspace/VelaAgent",
    model: "Preview model", modelProvider: "preview", modelId: "preview", modelReady: true,
    thinkingLevel: "medium", thinkingLevels: ["off", "medium"], tools: ["read", "bash"], mode: "agent",
    proposedPlan: null, planRevisions: [], executionPlan: null, goal: null, error: null,
  },
  context: {
    messageCount: 24, toolCallCount: 8, turnCount: 12, stepCount: 12,
    tokens: 28_100, contextWindow: 1_000_000, percent: 2.81,
    segments: { system: 8100, tools: 6000, rules: 3000, skills: 4000, conversation: 7000 },
    sessionTokens: 64_000, cacheHitRate: 0.9, outputSpeed: 120,
  },
};
const noopSubscription = () => () => {};
let branchName = "main";
const gitSnapshot = () => ({ repo: { name: "VelaAgent", root: "/workspace/VelaAgent" }, branch: branchName,
  upstream: `origin/${branchName}`, files: [], addedLines: 0, deletedLines: 0 });
window.vela = {
  platform: "darwin", setLocale: () => {},
  getState: async () => state,
  getMessages: async () => Array.from({ length: 24 }, (_, i) => ({
    id: `message-${i}`, role: i % 2 ? "assistant" : "user", text: i % 2
      ? "对话区域应延伸到窗口右侧。环境卡片悬浮于对话流右上角，上下文详情通过圆环按需打开。"
      : `第 ${Math.floor(i / 2) + 1} 轮布局讨论`, thinking: "", tools: [],
  })),
  listOpenTargets: async () => [],
  getCatalog: async () => ({ models: [], providers: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  listSkills: async () => ({ skillsDir: "/workspace/skills", skills: [], diagnostics: [] }),
  getWorkspaceState: async () => ({ current: "/workspace/VelaAgent", recents: [{ path: "/workspace/VelaAgent", name: "VelaAgent" }] }),
  getEnvironment: async () => null,
  listEnvironments: async () => [],
  getGitStatus: async () => gitSnapshot(),
  listBranches: async () => Array.from({ length: Number(params.get("branches") ?? 0) }, (_, index) => {
    const name = index === 0 ? "main" : `feature/branch-${index}`;
    return { name, current: name === branchName, remote: false };
  }),
  switchBranch: async (name: string) => { branchName = name; return gitSnapshot(); },
  getPullRequest: async () => null, getSandboxMode: async () => "ask",
  onEvent: noopSubscription, onQuestionEvent: noopSubscription, onModelEvent: noopSubscription,
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription, onApprovalEvent: noopSubscription, onMenuAction: noopSubscription,
} as unknown as VelaApi;
createRoot(document.getElementById("root")!).render(<App />);
