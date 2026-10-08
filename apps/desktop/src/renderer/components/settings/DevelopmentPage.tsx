import {
  productionSyncCategories,
  type DevToolsInfo,
  type DevelopmentApi,
  type ProductionSyncBatch,
  type ProductionSyncCategory,
  type ProductionSyncPreview,
} from "@vela/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localizeError } from "../../locale";
import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock } from "./primitives";

type Busy = "preview" | "sync" | "devtools" | "reload" | "restart" | `rollback:${string}` | null;

/** 贴进 issue 的纯文本，固定使用英文，和界面语言无关。 */
export function formatDevToolsInfo(info: DevToolsInfo): string {
  const commit = info.commit
    ? `${info.commit}${info.branch ? ` (${info.branch}${info.dirty ? ", uncommitted changes" : ""})` : info.dirty ? " (uncommitted changes)" : ""}`
    : "unknown";
  return [
    `${info.name} ${info.version}`,
    `Commit: ${commit}`,
    `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · V8 ${info.v8}`,
    `OS: ${info.platform} ${info.arch} ${info.osRelease}`,
  ].join("\n");
}

function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return localizeError(error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "") || fallback);
}

export function DevelopmentPage({ copy, development }: {
  copy: SettingsCopy;
  development: DevelopmentApi;
}) {
  const text = copy.development;
  const [selected, setSelected] = useState<ProductionSyncCategory[]>(["conversations"]);
  const [preview, setPreview] = useState<{ key: string; value: ProductionSyncPreview } | null>(null);
  const [batches, setBatches] = useState<ProductionSyncBatch[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [info, setInfo] = useState<DevToolsInfo | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const key = selected.join(",");
  const current = preview?.key === key ? preview.value : null;
  const stale = preview !== null && !current;
  const blocked = current?.categories.some(item => item.error) ?? false;

  const refreshBatches = useCallback(async () => {
    try { setBatches(await development.listProductionSyncBatches()); }
    catch (cause) { setError(describeError(cause, text.retry)); }
  }, [development, text.retry]);
  useEffect(() => { void refreshBatches(); }, [refreshBatches]);
  useEffect(() => {
    let active = true;
    development.getDevToolsInfo().then(next => { if (active) setInfo(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [development]);

  async function run(next: Exclude<Busy, null>, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(next); setNotice(null); setError(null);
    try { await action(); }
    catch (cause) { setError(describeError(cause, text.retry)); }
    finally { setBusy(null); }
  }
  const toggle = (category: ProductionSyncCategory, on: boolean) =>
    setSelected(productionSyncCategories.filter(item => item === category ? on : selected.includes(item)));
  const scopeRow = useMemo(() => new Map(current?.categories.map(item => [item.category, item])), [current]);

  return <section className="settings-section" aria-busy={busy !== null}>
    <SettingsBlock id="dev-sync" title={text.title} hint={text.hint}>
      <fieldset className="dev-sync-scopes">
        <legend className="settings-note">{text.scopeLabel}</legend>
        {productionSyncCategories.map(category => {
          const row = scopeRow.get(category);
          return <label key={category} className="dev-sync-scope">
            <input
              type="checkbox"
              checked={selected.includes(category)}
              disabled={busy !== null}
              onChange={event => toggle(category, event.target.checked)}
            />
            <span className="dev-sync-scope-text">
              <span>{text.scopes[category].label}</span>
              <span className="settings-note">{text.scopes[category].hint}</span>
              {row ? row.error
                ? <span className="settings-error" role="alert">{localizeError(row.error)}</span>
                : <span className="dev-sync-count" role="status">{text.previewRow(row.imported, row.existing, row.unavailable)}</span> : null}
            </span>
          </label>;
        })}
      </fieldset>
      <div className="settings-actions">
        <button
          className="settings-secondary"
          type="button"
          disabled={busy !== null || selected.length === 0}
          onClick={() => void run("preview", async () => {
            setPreview({ key, value: await development.previewProductionSync(selected) });
          })}
        >{busy === "preview" ? text.previewing : text.preview}</button>
        {current && current.total > 0 && !blocked ? <button
          className="primary-btn"
          type="button"
          disabled={busy !== null}
          onClick={() => void run("sync", async () => {
            const result = await development.runProductionSync(selected);
            setPreview(null);
            setNotice(text.result(result.total));
            if (result.restartRequired) setRestartNeeded(true);
            await refreshBatches();
          })}
        >{busy === "sync" ? text.syncing : text.sync(current.total)}</button> : null}
      </div>
      {current ? <p className="dev-sync-total" role="status">
        {current.total > 0 ? text.previewTotal(current.total) : text.nothing}
        {current.needsCredentials > 0 ? ` ${text.credentials(current.needsCredentials)}` : ""}
      </p> : null}
      {stale ? <p className="settings-note">{text.previewStale}</p> : null}
      {notice ? <p className="settings-saved" role="status">{notice}</p> : null}
      {restartNeeded ? <div className="settings-actions">
        <span className="settings-note">{text.restartNeeded}</span>
        <button className="settings-secondary" type="button" disabled={busy !== null} onClick={() => void run("restart", () => development.restartMain())}>
          {busy === "restart" ? text.restarting : text.restartMain}
        </button>
      </div> : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </SettingsBlock>

    <SettingsBlock id="dev-sync-history" title={text.historyTitle} hint={text.historyHint}>
      {batches.length === 0 ? <p className="settings-note">{text.historyEmpty}</p> : <ul className="dev-sync-batches">
        {batches.map(batch => <li key={batch.id} className="dev-sync-batch">
          <div className="dev-sync-batch-main">
            <strong>{new Date(batch.createdAt).toLocaleString()}</strong>
            <span className="settings-note">
              {batch.status === "applying" ? `${text.unfinished} · ` : ""}
              {text.historyRow(batch.total)} · {batch.categories.filter(item => item.imported > 0).map(item => `${text.scopes[item.category].label} ${item.imported}`).join("，") || "—"}
            </span>
            {confirming === batch.id ? <span className="settings-error">{text.rollbackWarning}</span> : null}
          </div>
          <div className="settings-actions">
            {confirming === batch.id ? <>
              <button
                className="settings-secondary dev-danger"
                type="button"
                disabled={busy !== null}
                onClick={() => void run(`rollback:${batch.id}`, async () => {
                  const result = await development.rollbackProductionSync(batch.id);
                  setConfirming(null);
                  setNotice(text.rollbackResult(result.reverted, result.kept));
                  if (result.restartRequired) setRestartNeeded(true);
                  await refreshBatches();
                })}
              >{busy === `rollback:${batch.id}` ? text.rollingBack : text.rollbackConfirm}</button>
              <button className="settings-secondary" type="button" disabled={busy !== null} onClick={() => setConfirming(null)}>{text.rollbackCancel}</button>
            </> : <button className="settings-secondary" type="button" disabled={busy !== null} onClick={() => setConfirming(batch.id)}>{text.rollback}</button>}
          </div>
        </li>)}
      </ul>}
    </SettingsBlock>

    <SettingsBlock id="dev-tools" title={text.toolsTitle} hint={text.toolsHint}>
      <div className="settings-actions">
        <button className="settings-secondary" type="button" disabled={busy !== null} onClick={() => void run("devtools", () => development.openDevTools())}>{text.openDevTools}</button>
        <button className="settings-secondary" type="button" disabled={busy !== null} onClick={() => void run("reload", () => development.reloadWindow())}>{text.reloadWindow}</button>
        <button className="settings-secondary" type="button" disabled={busy !== null} onClick={() => void run("restart", () => development.restartMain())}>
          {busy === "restart" ? text.restarting : text.restartMain}
        </button>
      </div>
      <p className="settings-note">{text.restartMainHint}</p>
    </SettingsBlock>

    <SettingsBlock id="dev-info" title={text.infoTitle} hint={text.infoHint}>
      {info ? <>
        <dl className="dev-info">
          <dt>{text.infoFields.app}</dt><dd>{info.name} {info.version}</dd>
          <dt>{text.infoFields.commit}</dt>
          <dd title={info.commit ?? undefined}>
            {info.commit ? <code>{info.commit.slice(0, 10)}</code> : text.unknown}
            {info.dirty ? ` · ${text.dirty}` : ""}
          </dd>
          <dt>{text.infoFields.branch}</dt><dd>{info.branch ?? text.unknown}</dd>
          <dt>{text.infoFields.electron}</dt><dd>{info.electron}</dd>
          <dt>{text.infoFields.chrome}</dt><dd>{info.chrome}</dd>
          <dt>{text.infoFields.node}</dt><dd>{info.node}</dd>
          <dt>{text.infoFields.v8}</dt><dd>{info.v8}</dd>
          <dt>{text.infoFields.system}</dt><dd>{info.platform} {info.arch} {info.osRelease}</dd>
          <dt>{text.infoFields.home}</dt><dd><code>{info.home}</code></dd>
        </dl>
        <div className="settings-actions">
          <button
            className="settings-secondary"
            type="button"
            onClick={() => {
              setCopied(null);
              navigator.clipboard.writeText(formatDevToolsInfo(info)).then(
                () => setCopied("copied"),
                () => setCopied("failed"),
              );
            }}
          >{text.copy}</button>
          {copied ? <span className={copied === "copied" ? "settings-saved" : "settings-error"} role="status">{copied === "copied" ? text.copied : text.copyFailed}</span> : null}
        </div>
      </> : <p className="settings-note">{text.infoLoading}</p>}
    </SettingsBlock>
  </section>;
}
