/** Full-app fixture with in-memory IPC responses. No filesystem or model calls. */
import React from "react";
import { createRoot } from "react-dom/client";
import type { AgentStreamEvent, AppState, ProposedPlanItem, VelaApi } from "@vela/shared";
import { App } from "../src/renderer/App";
import "../src/renderer/styles.css";

localStorage.setItem("vela.onboarding.complete", "true");
localStorage.setItem("vela.locale", "zh-CN");
const params = new URLSearchParams(location.search);
if (params.has("layout")) localStorage.setItem("vela.infoLayout", params.get("layout")!);
const planFixture = params.has("plan");
const plans: ProposedPlanItem[] = [1, 2].map(revision => ({
  id: `plan-${revision}`, revision, supersedes: revision === 2 ? "plan-1" : null,
  status: revision === 2 ? "draft" : "superseded", objective: "在右侧 Panel 审查本轮文件变更",
  markdown: `# ${revision === 2 ? "在右侧 Panel 审查本轮文件变更" : "第一版审查方案"}\n\n## 概述\n\n点击对话流中的计划卡片，或悬浮 RepoCard 的计划标题，在右侧 Panel 查看完整计划。\n\n## 接入与交互\n\n- 对话展示计划标题与概述。\n- RepoCard 展示最新计划。\n- 点击历史卡片打开对应修订。\n\n## 验证\n\n检查折叠过程、不同信息布局和流式生成。`,
  createdAt: revision, approvedAt: null,
}));
const state: AppState = {
  activeConversationId: "fixture",
  conversations: [],
  session: {
    id: "fixture", title: planFixture ? "Plan 展示与右侧面板" : "悬浮信息布局", status: "ready", cwd: "/workspace/VelaAgent",
    model: "Preview model", modelProvider: "preview", modelId: "preview", modelReady: true,
    thinkingLevel: "medium", thinkingLevels: ["off", "medium"], tools: ["read", "bash"], mode: planFixture ? "plan" : "agent",
    proposedPlan: planFixture ? plans[1]! : null, planRevisions: planFixture ? plans : [], executionPlan: null, goal: null, error: null,
  },
  context: {
    messageCount: 24, toolCallCount: 8, turnCount: 12, stepCount: 12,
    tokens: 28_100, contextWindow: 1_000_000, percent: 2.81,
    segments: { system: 8100, tools: 6000, rules: 3000, skills: 4000, conversation: 7000 },
    sessionTokens: 64_000, cacheHitRate: 0.9, outputSpeed: 120,
  },
};
const noopSubscription = () => () => {};
const eventListeners = new Set<(event: AgentStreamEvent) => void>();
const emit = (event: AgentStreamEvent) => { for (const listener of eventListeners) listener(event); };
let branchName = "main";
const gitSnapshot = () => ({ repo: { name: "VelaAgent", root: "/workspace/VelaAgent" }, branch: branchName,
  upstream: `origin/${branchName}`, files: [], addedLines: 0, deletedLines: 0 });
window.vela = {
  platform: "darwin", setLocale: () => {},
  getState: async () => state,
  getMessages: async () => planFixture ? plans.flatMap((plan, index) => [
    { id: `u-${index}`, role: "user", text: index ? "补齐计划入口" : "设计审查方案", thinking: "", tools: [] },
    { id: `a-${index}`, role: "assistant", text: params.has("only") ? "" : "已确定方案，提交计划如下。", thinking: "检查了现有面板与消息结构。", tools: [], planIds: [plan.id], turnStartedAt: 1000, turnCompletedAt: 4000, timestamp: 4000 },
  ]) : Array.from({ length: 24 }, (_, i) => ({
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
  getGitStatus: async () => params.has("nogit") ? { ...gitSnapshot(), repo: null } : gitSnapshot(),
  listBranches: async () => Array.from({ length: Number(params.get("branches") ?? 0) }, (_, index) => {
    const name = index === 0 ? "main" : `feature/branch-${index}`;
    return { name, current: name === branchName, remote: false };
  }),
  switchBranch: async (name: string) => { branchName = name; return gitSnapshot(); },
  getPullRequest: async () => null, getSandboxMode: async () => "ask",
  onEvent: (listener: (event: AgentStreamEvent) => void) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
  onQuestionEvent: noopSubscription, onModelEvent: noopSubscription,
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription, onApprovalEvent: noopSubscription, onMenuAction: noopSubscription,
} as unknown as VelaApi;
createRoot(document.getElementById("root")!).render(<App />);

if (planFixture) {
  const streamButton = document.createElement("button");
  streamButton.textContent = "模拟生成新计划";
  streamButton.style.cssText = "position:fixed;bottom:8px;left:8px;z-index:9999;padding:6px;background:#eee;color:#222";
  document.body.append(streamButton);
  streamButton.onclick = () => {
    const conversationId = "fixture";
    const createdAt = Date.now();
    const nextPlan: ProposedPlanItem = { ...plans[1]!, id: `stream-${createdAt}`, revision: 3, createdAt, supersedes: "plan-2", markdown: "# 流式计划入口\n\n## 概述\n\n只有计划输出时，聊天卡片和 RepoCard 仍可打开右侧文档。" };
    state.session = { ...state.session, status: "streaming", turnStartedAt: createdAt };
    state.conversations = [{ ...state.session } as never];
    emit({ type: "state", state: { ...state } });
    emit({ type: "user_message", conversationId, text: "生成新计划" });
    emit({ type: "assistant_start", conversationId });
    emit({ type: "proposed_plan_start", conversationId, planId: nextPlan.id, revision: 3 });
    emit({ type: "proposed_plan_delta", conversationId, planId: nextPlan.id, delta: nextPlan.markdown });
    window.setTimeout(() => {
      state.session = { ...state.session, proposedPlan: nextPlan, planRevisions: [...plans, nextPlan] };
      emit({ type: "state", state: { ...state } });
      emit({ type: "proposed_plan_end", conversationId, plan: nextPlan });
      state.session = { ...state.session, status: "ready", turnCompletedAt: Date.now() };
      state.conversations = [{ ...state.session } as never];
      emit({ type: "state", state: { ...state } });
    }, 2000);
  };
}
