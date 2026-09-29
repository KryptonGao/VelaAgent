import type { OpenTarget } from "@vela/shared";
import { useEffect, useState } from "react";
import { useDismissable } from "../hooks/useDismissable";
import { tr } from "../locale";
import { CheckIcon, ChevronDownIcon, FolderIcon, MonitorIcon, TerminalIcon } from "./icons";

const openTargetKey = "vela.openTarget";

function readStoredTarget(): string | null {
  try {
    return localStorage.getItem(openTargetKey);
  } catch {
    return null;
  }
}

function writeStoredTarget(id: string): void {
  try {
    localStorage.setItem(openTargetKey, id);
  } catch {
    // 写不进去时仍保留本次会话的选择。
  }
}

function FallbackIcon({ kind }: { kind: OpenTarget["kind"] }) {
  if (kind === "file-manager") return <FolderIcon size={14} />;
  if (kind === "terminal") return <TerminalIcon size={14} />;
  return <MonitorIcon size={14} />;
}

function AppIcon({ target }: { target: OpenTarget }) {
  if (target.icon) {
    return <img className="open-in-icon" src={target.icon} alt="" width={15} height={15} draggable={false} />;
  }
  return (
    <span className="open-in-icon open-in-icon-fallback">
      <FallbackIcon kind={target.kind} />
    </span>
  );
}

/**
 * 对话区顶栏右侧的「打开方式」分裂按钮:左侧按上次选择直接打开项目目录,
 * 右侧下拉列出本机已安装的编辑器、终端与访达。检测在主进程完成,非 macOS 为空列表。
 */
export function OpenInAppButton({ path }: { path: string | null }) {
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readStoredTarget);
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    let active = true;
    void api
      .listOpenTargets()
      .then((list) => {
        if (active) setTargets(list);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const active = targets.find((target) => target.id === activeId) ?? targets[0] ?? null;
  if (!active || !path) return null;
  const workspacePath = path;

  function launch(target: OpenTarget): void {
    setActiveId(target.id);
    writeStoredTarget(target.id);
    void window.vela?.openInTarget(target.id, workspacePath).catch(() => undefined);
  }

  const openLabel = tr(`在 ${active.name} 中打开`, `Open in ${active.name}`);

  return (
    <div className="open-in-anchor" ref={ref}>
      <div className={`open-in-split${open ? " open" : ""}`}>
        <button className="open-in-main" type="button" title={openLabel} aria-label={openLabel} onClick={() => launch(active)}>
          <AppIcon target={active} />
        </button>
        <span className="open-in-divider" aria-hidden="true" />
        <button
          className="open-in-toggle"
          type="button"
          title={tr("选择打开方式", "Choose another app")}
          aria-label={tr("选择打开方式", "Choose another app")}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDownIcon size={10} />
        </button>
      </div>
      {open ? (
        <div className="dock-popover composer-popover open-in-menu" role="menu">
          {targets.map((target) => {
            const current = target.id === active.id;
            return (
              <button
                key={target.id}
                className={`open-in-row${current ? " active" : ""}`}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => {
                  setOpen(false);
                  launch(target);
                }}
              >
                <AppIcon target={target} />
                <span className="open-in-row-name">{target.name}</span>
                {current ? <CheckIcon size={12} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
