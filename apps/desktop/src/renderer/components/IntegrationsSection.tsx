import { localizeCopy } from "@vela/shared";
import { useEffect, useRef, useState } from "react";
import type { PluginCatalog, PluginSnapshot } from "@vela/shared";
import type { AppLocale } from "../hooks/usePreferences";

const copy = {
  en: { title: "Integrations", hint: "Connect your workspace apps to Vela.", connect: "Connect", disconnect: "Disconnect", cancel: "Cancel", retry: "Try again", loading: "Loading integrations…", failed: "Unable to update integrations. Please try again.", pending: "Tools will become available in the current chat after its turn finishes.", states: { disconnected: "Not connected", connecting: "Connecting…", connected: "Connected", error: "Connection failed" } },
  zh: { title: "集成", hint: "将你的工作应用连接到 Vela。", connect: "连接", disconnect: "断开连接", cancel: "取消", retry: "重试", loading: "正在加载集成…", failed: "无法更新集成，请重试。", pending: "当前对话将在本轮结束后启用新工具。", states: { disconnected: "未连接", connecting: "正在连接…", connected: "已连接", error: "连接失败" } },
};

function PluginIcon({ plugin }: { plugin: PluginSnapshot }) {
  return <span className="integration-icon" aria-hidden="true">{plugin.icon === "notion" ?
    <svg viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="24" height="24" rx="3" stroke="currentColor" strokeWidth="1.6" /><path d="M10 23V9h3l8 11V9M18 9h6M8 9h6M8 23h6M21 9v14h-3" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg> : plugin.name.slice(0, 1)}</span>;
}

export function IntegrationsSection({ locale, workspacePath, conversationId }: { locale: AppLocale; workspacePath: string | null; conversationId?: string | null }) {
  const text = localizeCopy(locale, copy.zh, copy.en);
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const context = useRef(0);
  const request = useRef(0);
  const action = useRef(0);

  useEffect(() => {
    const api = window.vela;
    if (!api) { setError(true); return; }
    const revision = ++context.current;
    let cwd = workspacePath;
    setCatalog(null); setError(false); setBusy(null);
    const load = async () => {
      const sequence = ++request.current;
      try {
        cwd ??= (await api.getState()).session.cwd;
        const next = await api.getPlugins({ cwd, conversationId });
        if (revision === context.current && sequence === request.current) { setCatalog(next); setError(false); }
      } catch { if (revision === context.current && sequence === request.current) setError(true); }
    };
    const offMcp = api.onMcpStatus(event => { if (event.cwd === cwd) void load(); });
    const offPlugins = api.onPluginStatus(event => {
      if (revision !== context.current) return;
      setCatalog(current => current ? { ...current, plugins: current.plugins.map(plugin => plugin.id === event.id ? { ...plugin, status: event.status, error: event.error } : plugin) } : current);
      void load();
    });
    void load();
    return () => { context.current++; offMcp(); offPlugins(); };
  }, [workspacePath, conversationId, reload]);

  async function act(plugin: PluginSnapshot, disconnect: boolean) {
    const api = window.vela;
    if (!api || !catalog) return;
    const revision = context.current;
    const sequence = ++action.current;
    setBusy(plugin.id); setError(false);
    if (!disconnect) setCatalog({ ...catalog, plugins: catalog.plugins.map(item => item.id === plugin.id ? { ...item, status: "connecting", error: undefined } : item) });
    try {
      const next = await (disconnect ? api.disconnectPlugin : api.connectPlugin)({ cwd: catalog.cwd, conversationId, id: plugin.id });
      if (revision === context.current && sequence === action.current) { request.current++; setCatalog(next); }
    } catch { if (revision === context.current && sequence === action.current) setError(true); }
    finally { if (revision === context.current && sequence === action.current) setBusy(null); }
  }

  return <section className="settings-section integrations-section" aria-label={text.title}>
    <div className="settings-block" data-setting-id="integrations"><h2>{text.title}</h2><p className="settings-hint">{text.hint}</p></div>
    {error ? <div className="settings-block"><p role="alert">{text.failed}</p><button className="settings-secondary" onClick={() => setReload(value => value + 1)}>{text.retry}</button></div> : null}
    {!catalog && !error ? <p role="status" className="settings-hint">{text.loading}</p> : null}
    {catalog?.plugins.map(plugin => <article className="integration-card" key={plugin.id}>
      <PluginIcon plugin={plugin} />
      <div className="integration-content"><h3>{plugin.name}</h3><p className="settings-hint">{plugin.description}</p>
        <p className={`integration-status ${plugin.status}`} role="status" aria-atomic="true">{text.states[plugin.status]}</p>
      </div>
      <div className="integration-actions">
        {plugin.status === "connecting" ? <button type="button" className="settings-secondary" aria-label={`${text.cancel} ${plugin.name}`} onClick={() => void act(plugin, true)}>{text.cancel}</button> : <>
          <button type="button" className="settings-secondary" disabled={busy === plugin.id} aria-label={`${plugin.status === "connected" ? text.disconnect : text.connect} ${plugin.name}`} onClick={() => void act(plugin, plugin.status === "connected")}>{plugin.status === "connected" ? text.disconnect : text.connect}</button>
          {plugin.status === "error" ? <button type="button" className="settings-secondary" disabled={busy === plugin.id} onClick={() => void act(plugin, true)}>{text.disconnect}</button> : null}
        </>}
      </div>
    </article>)}
    {catalog?.pendingApply ? <p className="settings-hint" role="status">{text.pending}</p> : null}
  </section>;
}
