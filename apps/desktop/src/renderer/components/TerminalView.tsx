import type { TerminalSessionInfo } from "@vela/shared";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { tr } from "../locale";

const monoFont = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const lightAnsi: Partial<ITheme> = {
  black: "#3b3f46",
  red: "#cd3131",
  green: "#0d8a4f",
  yellow: "#9a7b00",
  blue: "#0451a5",
  magenta: "#a21caf",
  cyan: "#0e7490",
  white: "#6b7280",
  brightBlack: "#8b95a7",
  brightRed: "#d13438",
  brightGreen: "#059669",
  brightYellow: "#b45309",
  brightBlue: "#2563eb",
  brightMagenta: "#c026d3",
  brightCyan: "#0891b2",
  brightWhite: "#202124",
};

const darkAnsi: Partial<ITheme> = {
  black: "#3b4048",
  red: "#f07178",
  green: "#7fd88f",
  yellow: "#e5c07b",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#56b6c2",
  white: "#c5ccd6",
  brightBlack: "#6b7787",
  brightRed: "#ff8a92",
  brightGreen: "#9ae6a8",
  brightYellow: "#ffd58a",
  brightBlue: "#a3c2ff",
  brightMagenta: "#dbb2f5",
  brightCyan: "#7fd4de",
  brightWhite: "#f3f5f8",
};

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 从当前主题的 CSS 变量推导 xterm 配色,主题切换时重新读取。 */
function readTerminalTheme(): ITheme {
  const dark = document.documentElement.dataset.scheme === "dark";
  const background = cssColor("--term-bg", dark ? "#0e141c" : "#f5f5f6");
  const foreground = cssColor("--term-fg", dark ? "#d5dee8" : "#202124");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? "rgba(120, 150, 200, 0.35)" : "rgba(37, 99, 235, 0.22)",
    ...(dark ? darkAnsi : lightAnsi),
  };
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || tr("终端启动失败", "Failed to start the terminal");
}

/**
 * 集成终端面板:为每个标签页维护一个 PTY 会话,xterm.js 负责渲染。
 * 组件卸载(关闭标签/切换工作区)时结束对应 shell 进程。
 */
export function TerminalView({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const refitRef = useRef<() => void>(() => {});
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState<number | null>(null);
  // 重启:自增后重新执行挂载副作用,重建 PTY 会话。
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const api = window.vela;
    const host = hostRef.current;
    if (!api || !host) return;
    setSession(null);
    setError(null);
    setExited(null);

    let disposed = false;
    let ready = false;
    let frame = 0;
    let sentCols = 0;
    let sentRows = 0;
    const pending: string[] = [];

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: monoFont,
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;

    const measure = (): { cols: number; rows: number } | null => {
      // 面板隐藏时尺寸为 0,直接用会让 xterm 算出非法列数。
      if (host.clientWidth < 24 || host.clientHeight < 16) return null;
      try {
        fit.fit();
      } catch {
        return null;
      }
      if (term.cols < 2 || term.rows < 2) return null;
      return { cols: term.cols, rows: term.rows };
    };
    const pushSize = (): void => {
      if (!ready) return;
      const size = measure();
      if (!size) return;
      if (size.cols === sentCols && size.rows === sentRows) return;
      sentCols = size.cols;
      sentRows = size.rows;
      api.resizeTerminal(sessionId, size.cols, size.rows);
    };
    refitRef.current = () => {
      pushSize();
      term.focus();
    };

    const initial = measure() ?? { cols: 80, rows: 24 };
    const offEvent = api.onTerminalEvent((event) => {
      if (event.id !== sessionId) return;
      if (event.type === "output") {
        if (ready) term.write(event.data);
        else pending.push(event.data);
        return;
      }
      setExited(event.exitCode);
      term.write(`\r\n\x1b[2m${tr("[进程已退出]", "[process exited]")} · ${event.exitCode}\x1b[0m\r\n`);
    });
    const input = term.onData((data) => api.writeTerminal(sessionId, data));

    void api
      .createTerminal({ id: sessionId, cols: initial.cols, rows: initial.rows })
      .then((info) => {
        // 挂载已被清理时不再接管会话;清理阶段的 closeTerminal 已经结束了它。
        if (disposed) return;
        ready = true;
        sentCols = initial.cols;
        sentRows = initial.rows;
        setSession(info);
        for (const chunk of pending) term.write(chunk);
        pending.length = 0;
        pushSize();
      })
      .catch((caught) => {
        if (!disposed) setError(readableError(caught));
      });

    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        pushSize();
      });
    });
    observer.observe(host);

    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "data-theme"] });

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      offEvent();
      input.dispose();
      api.closeTerminal(sessionId);
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId, generation]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => refitRef.current());
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const shellName = session ? session.shell.split("/").filter(Boolean).pop() ?? session.shell : null;

  return (
    <div className="panel-terminal-view">
      <div className="terminal-subbar">
        <span className="terminal-subbar-path" title={session?.cwd ?? ""}>
          {shellName ? <strong>{shellName}</strong> : null}
          {session ? <span className="terminal-subbar-cwd">{session.cwd}</span> : null}
          {exited !== null ? (
            <span className="terminal-subbar-exit">{tr("已退出", "Exited")} {exited}</span>
          ) : null}
        </span>
        <span className="terminal-subbar-actions">
          <button
            type="button"
            className="terminal-action"
            disabled={Boolean(error)}
            onClick={() => termRef.current?.clear()}
          >
            {tr("清空", "Clear")}
          </button>
          <button type="button" className="terminal-action" onClick={() => setGeneration((value) => value + 1)}>
            {tr("重启", "Restart")}
          </button>
        </span>
      </div>
      <div className="terminal-body">
        <div className="terminal-xterm" ref={hostRef} />
        {error ? (
          <div className="terminal-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
