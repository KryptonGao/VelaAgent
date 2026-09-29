import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SandboxRiskInput } from "@vela/shared";
import {
  buildSandboxRiskMessage,
  describeSandboxRiskAction,
  parseSandboxRiskVerdict,
} from "../src/sandbox-risk.ts";

const bashInput: SandboxRiskInput = {
  kind: "bash",
  command: "rm -rf ./build",
  path: null,
  cwd: "/repo",
  workspace: "/repo",
  insideWorkspace: false,
};

describe("parseSandboxRiskVerdict", () => {
  it("识别 RISKY 与 SAFE", () => {
    assert.equal(parseSandboxRiskVerdict("RISKY"), "risky");
    assert.equal(parseSandboxRiskVerdict("SAFE"), "safe");
    assert.equal(parseSandboxRiskVerdict("safe\n"), "safe");
  });

  it("大小写不敏感,取最早出现的判定词", () => {
    assert.equal(parseSandboxRiskVerdict("Safe: read-only command"), "safe");
    assert.equal(parseSandboxRiskVerdict("RISKY: not safe"), "risky");
    assert.equal(parseSandboxRiskVerdict("safe, not risky"), "safe");
  });

  it("认不出判定词时返回 unknown", () => {
    assert.equal(parseSandboxRiskVerdict(""), "unknown");
    assert.equal(parseSandboxRiskVerdict("这个操作有风险"), "unknown");
    assert.equal(parseSandboxRiskVerdict("MAYBE"), "unknown");
  });
});

describe("describeSandboxRiskAction", () => {
  it("bash 给出命令、目录和边界", () => {
    const text = describeSandboxRiskAction(bashInput);
    assert.match(text, /运行终端命令/);
    assert.match(text, /rm -rf \.\/build/);
    assert.match(text, /工作目录: \/repo/);
    assert.match(text, /工作区边界: \/repo/);
  });

  it("文件操作给出路径与是否越界", () => {
    const input: SandboxRiskInput = {
      kind: "write",
      command: null,
      path: "/etc/hosts",
      cwd: null,
      workspace: "/repo",
      insideWorkspace: false,
    };
    const text = describeSandboxRiskAction(input);
    assert.match(text, /写入文件/);
    assert.match(text, /路径: \/etc\/hosts/);
    assert.match(text, /工作区外/);
  });
});

describe("buildSandboxRiskMessage", () => {
  it("带上当前任务并裁剪过长内容", () => {
    const task = "重构".repeat(400);
    const message = buildSandboxRiskMessage(bashInput, task);
    assert.match(message, /当前任务: /);
    assert.ok(!message.includes(task));
    assert.match(message, /判定:$/);
  });

  it("没有任务时只给操作描述", () => {
    const message = buildSandboxRiskMessage(bashInput, null);
    assert.ok(!message.includes("当前任务"));
  });
});
