import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillSummary } from "@vela/shared";
import {
  applySkillPick,
  composeSkillPrompt,
  filterSkills,
  parseSkillPrompt,
  skillOriginLabel,
  skillTitle,
  slashTokenAt,
} from "../src/renderer/components/composer/skill-picker.ts";

function skill(name: string, description: string): SkillSummary {
  return {
    name,
    description,
    location: `/skills/${name}/SKILL.md`,
    origin: "user",
    disableModelInvocation: false,
  };
}

describe("slashTokenAt", () => {
  it("reads a slash query at the caret and keeps the rest of the token", () => {
    const token = slashTokenAt("请用 /apple 设计", "请用 /app".length);
    assert.deepEqual(token, { start: 3, end: 9, query: "app" });
  });

  it("opens on a bare slash at the start or after whitespace", () => {
    assert.equal(slashTokenAt("/", 1)?.query, "");
    assert.equal(slashTokenAt("hello\n/", 7)?.query, "");
  });

  it("ignores slashes inside words and urls", () => {
    assert.equal(slashTokenAt("http://exa", 10), null);
    assert.equal(slashTokenAt("路径a/b", 4), null);
  });
});

describe("applySkillPick", () => {
  it("removes the slash token and the separating space", () => {
    const token = slashTokenAt("hello /app world", "hello /app".length);
    assert.ok(token);
    assert.deepEqual(applySkillPick("hello /app world", token), { text: "hello world", caret: 5 });
  });

  it("clears the field when the slash token is the whole draft", () => {
    const token = slashTokenAt("/apple-design", 13);
    assert.ok(token);
    assert.deepEqual(applySkillPick("/apple-design", token), { text: "", caret: 0 });
  });
});

describe("filterSkills", () => {
  const skills = [
    skill("design-report", "Create documents with the Design Report template"),
    skill("apple-design", "Apple's approach to interface design"),
    skill("documents", "Create and edit documents"),
  ];

  it("lists every skill, with prefix matches first", () => {
    assert.deepEqual(filterSkills(skills, "").map((item) => item.name), [
      "apple-design",
      "design-report",
      "documents",
    ]);
    assert.deepEqual(filterSkills(skills, "app").map((item) => item.name), ["apple-design"]);
    assert.deepEqual(filterSkills(skills, "template").map((item) => item.name), ["design-report"]);
  });
});

describe("prompt formatting", () => {
  it("turns a kebab-case name into a title and a sendable command", () => {
    assert.equal(skillTitle("apple-design"), "Apple Design");
    assert.equal(skillOriginLabel("user"), "个人");
    assert.equal(skillOriginLabel("project"), "项目");
    assert.equal(composeSkillPrompt("apple-design", "  改一下登录页 "), "/skill:apple-design 改一下登录页");
    assert.equal(composeSkillPrompt("apple-design", "  "), "/skill:apple-design");
    assert.equal(composeSkillPrompt("Apple Design", "你好"), "你好");
  });

  it("parses a sent skill command back into a chip and the remaining request", () => {
    assert.deepEqual(parseSkillPrompt("/skill:apple-design 改一下登录页\n\n[图片 ×1]"), {
      name: "apple-design",
      body: "改一下登录页\n\n[图片 ×1]",
    });
    assert.equal(parseSkillPrompt("普通消息"), null);
  });

  it("hides the expanded skill body and keeps only the user's request", () => {
    const expanded = [
      '<skill name="beautify-github-readme" location="/Users/chenkaigao/vela/skills/beautify-github-readme/SKILL.md">',
      "References are relative to /Users/chenkaigao/vela/skills/beautify-github-readme.",
      "",
      "# Beautify Github README",
      "Turn a repository homepage into a visual story.",
      "</skill>",
      "",
      "优化这个 README",
    ].join("\n");
    assert.deepEqual(parseSkillPrompt(expanded), {
      name: "beautify-github-readme",
      body: "优化这个 README",
    });
    assert.deepEqual(
      parseSkillPrompt(
        '<skill name="apple-design" location="/skills/apple-design/SKILL.md">\n# Apple\n</skill>',
      ),
      { name: "apple-design", body: "" },
    );
    assert.equal(parseSkillPrompt("正文里提到 <skill name=\"x\"> 但不是整条消息"), null);
  });
});
