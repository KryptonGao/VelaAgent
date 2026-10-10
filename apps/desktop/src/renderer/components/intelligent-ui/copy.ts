import type { UiEvalErrorCode, UiInputError, UiRejectReason } from "@vela/shared";
import { tr, trf } from "../../locale";

/** Intelligent UI 的界面文案。中文原文是查找键，zh-TW/ja/ko 译文在 packages/shared/src/i18n-messages。 */
export const uiCopy = {
  region: () => tr("交互式界面", "Interactive interface"),
  building: () => tr("正在生成界面…", "Building interface…"),
  incomplete: () => tr("界面生成未完成，下面只显示已验证的部分。", "The interface was cut short. Only the verified parts are shown."),
  invalidTitle: () => tr("无法显示这个界面", "This interface can't be shown"),
  invalidHint: () => tr("内容不符合安全格式，已隐藏。可以查看原始文本。", "The content doesn't match the safe format and was hidden. You can view the source."),
  viewSource: () => tr("查看原始文本", "View source"),
  hideSource: () => tr("隐藏原始文本", "Hide source"),
  copyText: () => tr("复制文字", "Copy as text"),
  copied: () => tr("已复制", "Copied"),
  copyFailed: () => tr("复制失败", "Copy failed"),
  unsupported: () => tr("不支持的组件", "Unsupported component"),
  cannotShow: () => tr("无法显示此组件", "This component can't be shown"),
  source: () => tr("来源", "Source"),
  unverified: () => tr("未验证", "unverified"),
  noData: () => tr("暂无数据", "No data"),
  search: () => tr("搜索", "Search"),
  filter: () => tr("筛选", "Filter"),
  all: () => tr("全部", "All"),
  expand: () => tr("展开", "Expand"),
  collapse: () => tr("收起", "Collapse"),
  noRows: () => tr("没有匹配的行", "No matching rows"),
  sortBy: (label: string) => trf("按「{0}」排序", "Sort by {0}", label),
  sortedAsc: () => tr("升序", "ascending"),
  sortedDesc: () => tr("降序", "descending"),
  sendToAgent: () => tr("将发送给 Agent", "Send to the agent"),
  willSend: () => tr("将发送以下内容：", "This will be sent:"),
  send: () => tr("发送", "Send"),
  queueNote: () => tr("Agent 正在运行，这条消息会排队等待。", "The agent is running, so this message will be queued."),
  cancel: () => tr("取消", "Cancel"),
  unavailable: () => tr("当前不能发送消息", "Messages can't be sent right now"),
  openLink: (url: string) => trf("将在浏览器中打开：{0}", "This will open in the browser: {0}", url),
  open: () => tr("打开", "Open"),
  statusLoading: () => tr("加载中", "Loading"),
  statusStale: () => tr("可能已过期", "May be out of date"),
  statusError: () => tr("获取失败", "Failed to load"),
  statusEmpty: () => tr("没有内容", "Nothing here"),
  required: () => tr("必填", "Required"),
  inputError: (code: UiInputError, bound: number | undefined): string => {
    switch (code) {
      case "required": return tr("请填写这一项", "This is required");
      case "not_a_number": return tr("请输入有效数字", "Enter a valid number");
      case "below_min": return trf("不能小于 {0}", "Must be at least {0}", bound ?? "");
      case "above_max": return trf("不能大于 {0}", "Must be at most {0}", bound ?? "");
      case "too_long": return tr("内容太长", "Too long");
      case "not_an_option": return tr("请选择有效的选项", "Choose a valid option");
      default: return tr("输入无效", "Invalid input");
    }
  },
  evalError: (code: UiEvalErrorCode): string => {
    switch (code) {
      case "division_by_zero": return tr("除数不能为零", "Can't divide by zero");
      case "not_finite": return tr("结果不是有限数", "The result isn't a finite number");
      case "invalid_input": return tr("请先修正输入", "Fix the input first");
      case "pending_ref": return tr("等待数据", "Waiting for data");
      case "type_mismatch": return tr("数据类型不匹配", "Values don't match");
      default: return tr("无法计算", "Can't calculate");
    }
  },
  reason: (reason: UiRejectReason | null): string => {
    switch (reason) {
      case "unsupported_version": return tr("不支持的界面版本", "Unsupported interface version");
      case "limit_nodes": case "limit_depth": case "limit_states": case "limit_derived": case "limit_options": case "limit_bytes": case "limit_line":
        return tr("界面超出大小限制", "The interface is over the size limit");
      case "forbidden_key": return tr("包含不允许的字段", "Contains a forbidden field");
      case "bad_reference": case "cyclic_reference": case "bad_binding": return tr("引用或绑定不正确", "A reference or binding is wrong");
      case "bad_json": case "bad_op": case "unknown_op": return tr("格式不正确", "The format is wrong");
      default: return tr("结构不正确", "The structure is wrong");
    }
  },
  cannotSave: () => tr("无法保存这项设置，已恢复原来的选择。", "Couldn't save this setting, so the previous choice was restored."),
  progress: (value: string, max: string) => trf("{0} / {1}", "{0} / {1}", value, max),
  yes: () => tr("是", "Yes"),
  no: () => tr("否", "No"),
  setting: {
    title: () => tr("交互式界面", "Interactive interface"),
    description: () => tr("让 Agent 在合适时用计算器、对比表等原生界面回答，而不是只给文字。界面不会运行代码，也不会自动执行任何操作。", "Let the agent answer with native calculators, comparison tables and similar views when they help. Interfaces never run code or take actions on their own."),
    auto: () => tr("自动", "Auto"),
    autoHint: () => tr("只在界面比文字更好用时生成", "Only when an interface beats plain text"),
    textOnly: () => tr("仅文字", "Text only"),
    textOnlyHint: () => tr("不生成交互界面", "Never generate interfaces"),
    visualFirst: () => tr("偏向可视化", "Visual first"),
    visualFirstHint: () => tr("比较、计算类问题优先用界面", "Prefer interfaces for comparisons and calculators"),
  },
};
