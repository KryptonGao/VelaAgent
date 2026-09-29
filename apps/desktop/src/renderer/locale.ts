import type { AppLocale } from "@vela/shared";
import { createContext, createElement, useContext, type ReactNode } from "react";

export type { AppLocale };

let activeLocale: AppLocale = "zh-CN";
const LocaleContext = createContext<AppLocale>("zh-CN");

export function AppLocaleProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return createElement(LocaleContext.Provider, { value: locale }, children);
}

export function useAppLocale(): AppLocale {
  return useContext(LocaleContext);
}

export function setActiveLocale(locale: AppLocale): void {
  activeLocale = locale;
}

export function tr(chinese: string, english: string): string {
  return activeLocale === "en" ? english : chinese;
}

export function isEnglish(): boolean {
  return activeLocale === "en";
}

const knownErrors: Record<string, string> = {
  "无法读取模型": "Could not load models.",
  "模型操作失败": "Model operation failed.",
  "应用还没准备好": "The app is not ready yet.",
  "登录失败": "Sign-in failed.",
  "Vela API 不可用": "Vela API is unavailable.",
  "操作失败": "Operation failed.",
  "发送失败": "Failed to send message.",
  "无法切换模式": "Could not change mode.",
  "无法执行计划": "Could not run the plan.",
  "无法继续目标": "Could not resume the goal.",
  "新建对话失败": "Could not create chat.",
  "无法读取 Skill": "Could not load skills.",
  "只能删除 Vela Skill 目录里的 Skill": "Only skills in Vela's skills folder can be deleted here.",
  "找不到这个 Skill": "This skill could not be found.",
  "读取失败": "Could not read file.",
  "搜索失败": "Search failed.",
  "找不到这个模型": "Model not found.",
  "这个模型还不能使用，请先登录或填写密钥": "This model is unavailable. Sign in or enter an API key first.",
  "不支持这个思考强度": "This reasoning effort is not supported.",
  "需要同时选择提供方和模型": "Select both a provider and a model.",
  "额外指令过长": "Additional instructions are too long.",
  "模型没有加载成功": "Could not load models.",
  "已有一个登录在进行": "A sign-in is already in progress.",
  "找不到这个提供方": "Provider not found.",
  "这个提供方不支持登录": "This provider does not support sign-in.",
  "这个提供方不支持填写密钥": "This provider does not support API keys.",
  "只能删除在这里添加的模型": "Only models added here can be removed.",
  "接口地址不正确": "Invalid API URL.",
  "接口地址需要以 http 或 https 开头": "The API URL must start with http or https.",
  "不支持这个接口类型": "This API type is not supported.",
  "新接口需要填写密钥": "Enter an API key for a new endpoint.",
  "这个接口还没有密钥": "This endpoint has no API key.",
  "这个模型还不能使用，请先在账号里登录。": "This model is unavailable. Sign in to the provider first.",
  "对话不存在或已结束": "Chat not found or already ended.",
  "回复进行中，不能切换模式": "The mode cannot be changed while a reply is in progress.",
  "上一个回复还在进行中": "The previous reply is still in progress.",
  "还没有可以执行的计划": "There is no plan to run yet.",
  "没有可以继续的目标": "There is no goal to resume.",
  "先选择一个已登录或已配置密钥的模型": "Choose a model with an active sign-in or configured API key first.",
  "未选择工作区": "No workspace selected.",
  "先选择一个工作区": "Choose a workspace first.",
  "工作区路径不正确": "Invalid workspace path.",
  "目录不存在或不可访问": "The directory does not exist or cannot be accessed.",
  "无法定位原工作区目录": "Could not locate the original workspace directory.",
  "需要 GitHub 远程仓库和当前分支": "A GitHub remote and current branch are required.",
  "Pull Request 链接不正确": "Invalid pull request URL.",
  "git 命令超时": "Git command timed out.",
  "git 命令启动失败": "Could not start Git command.",
  "不是普通文件": "This is not a regular file.",
  "搜索词不正确": "Invalid search query.",
  "文件路径不正确": "Invalid file path.",
  "消息不能为空": "Message cannot be empty.",
  "消息过长": "Message is too long.",
  "图片附件过多": "Too many image attachments.",
  "图片附件不正确": "Invalid image attachment.",
  "图片附件过大": "Image attachment is too large.",
  "附件过多": "Too many attachments.",
  "任务不能为空": "Task cannot be empty.",
  "还没有可用的对话": "No available chat.",
  "设置不正确": "Invalid settings.",
  "不支持这个模式": "This mode is not supported.",
  "请选择要迁移的 Skill": "Select skills to migrate.",
  "Skill 不正确": "Invalid skill.",
  "不支持这个登录方式": "This sign-in method is not supported.",
  "登录回复不正确": "Invalid sign-in response.",
  "回答不正确": "Invalid answer.",
  "模型参数不正确": "Invalid model settings.",
  "数字参数不正确": "Invalid numeric value.",
  "消息必须是字符串": "Message must be a string.",
  "文件列表不正确": "Invalid file list.",
  "分支名不正确": "Invalid branch name.",
  "链接不正确": "Invalid link.",
  "权限模式不正确": "Invalid permission mode.",
  "不支持这个执行环境": "This execution environment is not supported.",
  "密钥过长": "API key is too long.",
  "这是内置提供方，请使用登录，不要把它写成自定义接口": "This is a built-in provider. Sign in instead of adding it as a custom API.",
  "模型 ID 不正确": "Invalid model ID.",
  "models.json 格式不正确": "Invalid models.json format.",
  "无法读取模型配置": "Could not read model configuration.",
  "提供方名称只能包含字母、数字、点、下划线和短横线": "Provider names may contain only letters, numbers, periods, underscores, and hyphens.",
  "输出上限需要是正整数": "Maximum output tokens must be a positive integer.",
  "上下文长度需要是正整数": "Context window must be a positive integer.",
  "用户拒绝了命令执行": "Command execution was denied",
  "用户拒绝了工作区外的文件修改": "File changes outside the workspace were denied",
};

export function localizeError(message: string): string {
  if (activeLocale !== "en") return message;
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  const exact = knownErrors[cleaned];
  if (exact) return exact;
  const commandDenied = /^用户拒绝了命令执行[:：](.*)$/.exec(cleaned);
  if (commandDenied) return `${knownErrors["用户拒绝了命令执行"]}: ${commandDenied[1]}`;
  const fileDenied = /^用户拒绝了工作区外的文件修改[:：](.*)$/.exec(cleaned);
  if (fileDenied) return `${knownErrors["用户拒绝了工作区外的文件修改"]}: ${fileDenied[1]}`;
  const tooLong = /^(.+)过长$/.exec(cleaned);
  if (tooLong?.[1]) {
    const labels: Record<string, string> = {
      "额外指令": "Additional instructions",
      "输入": "Input",
      "密钥": "API key",
      "提供方名称": "Provider name",
      "模型名称": "Model name",
    };
    return `${labels[tooLong[1]] ?? tooLong[1]} is too long.`;
  }
  const required = /^需要填写(.+)$/.exec(cleaned);
  if (required?.[1]) {
    const labels: Record<string, string> = { "提供方 ID": "a provider ID", "模型 ID": "a model ID", "接口地址": "an API URL" };
    return `Enter ${labels[required[1]] ?? required[1]}.`;
  }
  return cleaned;
}
