import type { SkillOrigin, SkillSummary } from "@vela/shared";
import { tr } from "../../locale";

/** 光标所在的 `/查询` 片段。查询只取到光标处，替换时会吃掉整个连续词。 */
export interface SlashToken {
  start: number;
  end: number;
  query: string;
}

/**
 * 光标紧贴在一段 `/查询` 上时返回它。
 * 斜杠必须在行首或空白之后，避免把网址和普通句子里的斜杠当成技能选择。
 */
export function slashTokenAt(value: string, caret: number): SlashToken | null {
  const clamped = Math.max(0, Math.min(caret, value.length));
  const match = /(?:^|\s)(\/[^\s]*)$/.exec(value.slice(0, clamped));
  const token = match?.[1];
  if (!token) return null;
  const start = clamped - token.length;
  let end = clamped;
  while (end < value.length && !/\s/.test(value[end] ?? "")) end += 1;
  return { start, end, query: value.slice(start + 1, clamped) };
}

/** 选中技能后，从输入框去掉 `/查询`，并收起它前面多余的一个空格。 */
export function applySkillPick(value: string, token: SlashToken): { text: string; caret: number } {
  let start = token.start;
  if (start > 0 && value[start - 1] === " " && (token.end === value.length || /\s/.test(value[token.end] ?? ""))) {
    start -= 1;
  }
  let text = value.slice(0, start) + value.slice(token.end);
  if (text.trim() === "") text = "";
  return { text, caret: text === "" ? 0 : start };
}

/** `apple-design` 显示为 Apple Design。命令本身仍用原始名称。 */
export function skillTitle(name: string): string {
  return name
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function skillOriginLabel(origin: SkillOrigin): string {
  if (origin === "project") return tr("项目", "Project");
  if (origin === "agents") return "~/.agents";
  return tr("个人", "Personal");
}

/** 名称前缀优先，其次是名称包含，最后才是描述包含。 */
export function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  const ranked = skills.flatMap((skill) => {
    const rank = matchRank(skill, q);
    return rank === null ? [] : [{ skill, rank }];
  });
  ranked.sort((left, right) => left.rank - right.rank || skillTitle(left.skill.name).localeCompare(skillTitle(right.skill.name)));
  return ranked.map((entry) => entry.skill);
}

function matchRank(skill: SkillSummary, query: string): number | null {
  if (!query) return 1;
  const name = skill.name.toLowerCase();
  const title = skillTitle(skill.name).toLowerCase();
  if (name.startsWith(query) || title.startsWith(query)) return 0;
  if (name.includes(query) || title.includes(query)) return 1;
  if (skill.description.toLowerCase().includes(query)) return 2;
  return null;
}

/**
 * 把选中的技能收成 Pi 能展开的 `/skill:名称`。
 * 名称里如果有空白，展开会在第一个空格处截断，这时只发送正文。
 */
export function composeSkillPrompt(skillName: string | null, text: string): string {
  const body = text.trim();
  if (!skillName || /\s/.test(skillName)) return body;
  return body ? `/skill:${skillName} ${body}` : `/skill:${skillName}`;
}

const skillCommand = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/;
/** Pi 展开后的形态：`<skill>` 包住技能正文，用户原话在闭合标签之后。 */
const skillBlock = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * 把发出的 `/skill:名称`，以及重新打开对话时读回的展开块，还原成芯片和用户原话。
 * 技能正文只留给模型，不进气泡。
 */
export function parseSkillPrompt(text: string): { name: string; body: string } | null {
  const command = skillCommand.exec(text);
  if (command?.[1]) return { name: command[1], body: (command[2] ?? "").trim() };
  const block = skillBlock.exec(text.trim());
  if (!block?.[1]) return null;
  return { name: block[1], body: (block[2] ?? "").trim() };
}
