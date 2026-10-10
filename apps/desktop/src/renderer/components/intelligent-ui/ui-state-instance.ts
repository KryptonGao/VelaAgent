import { uiStorage } from "../../ui-storage";
import { createUiStateStore, type UiStateStore } from "./ui-state-store";

/** 渲染层共用的 UI 状态仓库。单独成文件，让不含 JSX 的模块（如 useSession）也能引用。 */
export const uiStateStore: UiStateStore = createUiStateStore(uiStorage);
