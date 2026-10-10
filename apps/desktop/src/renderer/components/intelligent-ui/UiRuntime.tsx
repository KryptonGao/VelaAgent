import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildUiEnv,
  initialUiValues,
  restoreUiValues,
  validateStateValue,
  type UiArtifact,
  type UiEvalEnv,
  type UiNode,
  type UiValue,
} from "@vela/shared";
import { uiSourceFingerprint, type UiSavedValues, type UiStateScope } from "./ui-state-store";
import { uiStateStore } from "./ui-state-instance";

export { uiStateStore };

// ---------- 会话级宿主：由聊天页提供 ----------

export interface UiHost {
  conversationId: string | null;
  /** 把聊天里的消息 id 映射成稳定的 UI 回复位置；不含 UI 的消息返回 null。 */
  stableMessageId(messageId: string): string | null;
  /** 现在能不能向 Agent 发消息（模型就绪）。 */
  canSubmit: boolean;
  /** Agent 正在运行时，提交会进入队列。 */
  agentBusy: boolean;
  submit(text: string): Promise<void>;
  openLink(url: string): boolean;
}

const fallbackHost: UiHost = {
  conversationId: null,
  stableMessageId: () => null,
  canSubmit: false,
  agentBusy: false,
  submit: async () => undefined,
  openLink: () => false,
};

const HostContext = createContext<UiHost>(fallbackHost);
export const UiHostProvider = HostContext.Provider;
export function useUiHost(): UiHost {
  return useContext(HostContext);
}

// ---------- 单个 artifact 的运行时：状态、求值、动作 ----------

export interface UiArtifactRuntime {
  artifact: UiArtifact;
  byId: ReadonlyMap<string, UiNode>;
  values: Readonly<Record<string, UiValue>>;
  env: UiEvalEnv;
  receiving: boolean;
  setValue(name: string, value: UiValue): void;
  host: UiHost;
}

const RuntimeContext = createContext<UiArtifactRuntime | null>(null);

export function UiRuntimeProvider({ value, children }: { value: UiArtifactRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useUiRuntime(): UiArtifactRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("UI runtime is missing");
  return runtime;
}

const saveDelayMs = 400;

/**
 * 本地 UI 状态：
 * - `edits` 只记录用户改过的值；没改过的状态始终取最新的 initial，所以流式追加新 state 或
 *   提交 commit 都不会重置已填写的内容。
 * - 有效值 = 初始值 ∪（恢复的快照 + 本次编辑），再按当前定义校验。
 * - 只在定义稳定（不再 receiving）后写盘，并节流，避免拖动滑块时频繁 IO。
 */
export function useUiArtifactState(artifact: UiArtifact, raw: string, scope: UiStateScope | null) {
  const fingerprint = useMemo(() => uiSourceFingerprint(artifact.artifactId, raw), [artifact.artifactId, raw]);
  const scopeKey = scope ? `${scope.conversationId}/${scope.messageId}/${scope.artifactId}` : null;
  const settled = artifact.status === "ready" || artifact.status === "incomplete";
  const [edits, setEdits] = useState<UiSavedValues>({});
  const [restored, setRestored] = useState<{ key: string | null; values: UiSavedValues | null }>({ key: null, values: null });
  const editsRef = useRef(edits);
  editsRef.current = edits;

  // 定义稳定后载入快照。流式期间用户已经做的编辑（edits）比快照新，必须保留；
  // 只有换到另一个位置或另一份定义时，旧编辑才作废。
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!scope || !settled) return;
    const key = `${scopeKey}#${fingerprint}`;
    if (loadedKey.current === key) return;
    if (loadedKey.current !== null) setEdits({});
    loadedKey.current = key;
    setRestored({ key, values: uiStateStore.load(scope, fingerprint) });
  }, [scope, scopeKey, settled, fingerprint]);

  const values = useMemo(
    () => restoreUiValues(artifact, { ...restored.values, ...edits }),
    [artifact, restored.values, edits],
  );

  const setValue = useCallback((name: string, value: UiValue) => {
    const definition = artifact.stateDefinitions.find(item => item.name === name);
    if (!definition) return;
    // 数字框允许清空（null）这种中间态；其它类型必须类型正确。
    if (value !== null && validateStateValue({ ...definition, min: undefined, max: undefined }, value) !== null) return;
    if (value === null && definition.kind !== "number") return;
    setEdits(current => current[name] === value ? current : { ...current, [name]: value });
  }, [artifact.stateDefinitions]);

  const pending = useRef<{ timer: ReturnType<typeof setTimeout> | null }>({ timer: null });
  useEffect(() => {
    if (!scope || !settled || Object.keys(edits).length === 0) return;
    const timer = setTimeout(() => {
      pending.current.timer = null;
      uiStateStore.save(scope, fingerprint, { ...restored.values, ...edits });
    }, saveDelayMs);
    pending.current.timer = timer;
    return () => clearTimeout(timer);
  }, [edits, scope, settled, fingerprint, restored.values]);

  // 卸载（滚出、切换会话）时把还没落盘的编辑立刻写下。
  const latest = useRef({ scope, settled, fingerprint, restored: restored.values });
  latest.current = { scope, settled, fingerprint, restored: restored.values };
  useEffect(() => () => {
    const { scope: current, settled: ready, fingerprint: print, restored: saved } = latest.current;
    if (current && ready && Object.keys(editsRef.current).length > 0) uiStateStore.save(current, print, { ...saved, ...editsRef.current });
  }, []);

  const env = useMemo(() => buildUiEnv(artifact, values), [artifact, values]);
  return { values, env, setValue, initial: useMemo(() => initialUiValues(artifact), [artifact]) };
}
