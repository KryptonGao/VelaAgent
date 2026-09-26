/** 快捷键提示里的修饰键前缀:macOS 显示 ⌘,其他平台显示 Ctrl+。 */
export function modKeyLabel(platform: string): string {
  return platform === "darwin" ? "⌘" : "Ctrl+";
}

export function fileManagerName(platform: string): string {
  if (platform === "darwin") return "访达";
  if (platform === "win32") return "资源管理器";
  return "文件管理器";
}
