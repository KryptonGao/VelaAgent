import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installRendererLogging } from "./logger";
import "./styles.css";
import "./components/intelligent-ui/intelligent-ui.css";
import "./version-control.css";
import "./version-control-p2.css";

installRendererLogging();

const root = document.getElementById("root");
if (!root) throw new Error("缺少根节点");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
