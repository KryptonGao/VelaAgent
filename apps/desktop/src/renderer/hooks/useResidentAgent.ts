import { useCallback, useEffect, useState } from "react";
import type { ProactiveRulesState, ResidentAgentApi, ResidentSettings, ResidentStatus } from "@vela/shared";

export interface ResidentAgentView {
  api: ResidentAgentApi | null;
  status: ResidentStatus | null;
  settings: ResidentSettings | null;
  rules: ProactiveRulesState | null;
  error: string | null;
  setSettings(settings: ResidentSettings): void;
}

/**
 * 订阅 Resident Agent 的状态、设置和主动规则。主进程是唯一权威：这里只缓存读取结果，
 * 并按推送更新；浏览器预览等没有 window.vela.resident 的环境得到空状态。
 */
export function useResidentAgent(active: boolean): ResidentAgentView {
  const api = window.vela?.resident ?? null;
  const [status, setStatus] = useState<ResidentStatus | null>(null);
  const [settings, setSettings] = useState<ResidentSettings | null>(null);
  const [rules, setRules] = useState<ProactiveRulesState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api || !active) return;
    let live = true;
    const fail = (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); };
    // 先订阅再读取：读取期间到达的推送不会丢，更新的 revision 不会被较旧的读取结果覆盖。
    const offStatus = api.subscribe(next => setStatus(current => !current || next.revision >= current.revision ? next : current));
    const offRules = api.rules.subscribe(setRules);
    void api.getStatus().then(next => { if (live) setStatus(current => !current || next.revision >= current.revision ? next : current); }, fail);
    void api.getSettings().then(next => { if (live) setSettings(next); }, fail);
    void api.rules.list().then(next => { if (live) setRules(next); }, fail);
    return () => { live = false; offStatus(); offRules(); };
  }, [api, active]);

  // 菜单栏等入口也能改模式与暂停：状态里的这两项变了就重新读取设置，面板始终显示权威值。
  const mode = status?.mode;
  const paused = status?.paused;
  useEffect(() => {
    if (!api || !active || mode === undefined) return;
    let live = true;
    void api.getSettings().then(next => { if (live) setSettings(next); }, () => {});
    return () => { live = false; };
  }, [api, active, mode, paused]);

  const replaceSettings = useCallback((next: ResidentSettings) => setSettings(next), []);
  return { api, status, settings, rules, error, setSettings: replaceSettings };
}
