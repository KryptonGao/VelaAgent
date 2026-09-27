/** 快捷键提示里的修饰键前缀:macOS 显示 ⌘,其他平台显示 Ctrl+。 */
export function modKeyLabel(platform: string): string {
  return platform === "darwin" ? "⌘" : "Ctrl+";
}

export function fileManagerName(platform: string): string {
  if (platform === "darwin") return tr("访达", "Finder");
  if (platform === "win32") return tr("资源管理器", "File Explorer");
  return tr("文件管理器", "File Manager");
}
import { tr } from "./locale";
