import { Component, type ErrorInfo, type ReactNode } from "react";
import { createLogger } from "../logger";
import { tr } from "../locale";

const log = createLogger("react");

interface State {
  error: Error | null;
}

/** Last-resort boundary: records the render crash and offers a retry instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("render crashed", Object.assign(error, { componentStack: info.componentStack ?? undefined }));
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-crash" role="alert">
        <h1>{tr("界面出错了", "Something went wrong")}</h1>
        <p>{tr("错误已写入日志。可以重试,或在 帮助 → 导出诊断日志 中导出日志反馈问题。", "The error was written to the log. Retry, or use Help → Export Diagnostic Logs to report it.")}</p>
        <pre>{error.message}</pre>
        <div className="app-crash-actions">
          <button type="button" className="primary-btn" onClick={() => this.setState({ error: null })}>{tr("重试", "Retry")}</button>
          <button type="button" onClick={() => window.location.reload()}>{tr("重新加载", "Reload")}</button>
        </div>
      </div>
    );
  }
}
