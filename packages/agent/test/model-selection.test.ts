import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ModelDirectory } from "../src/model-directory.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vela-selection-"));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("new conversation selection settings", () => {
  it("persists the selection mode and last used choice", async () => {
    const dir = await tempDir();
    const directory = await ModelDirectory.open(dir);
    assert.deepEqual(directory.getSettings(), {
      provider: null,
      modelId: null,
      thinkingLevel: "medium",
      newConversationSelection: "default",
      instructions: "",
    });

    await directory.saveSettings({
      provider: null,
      modelId: null,
      thinkingLevel: "high",
      newConversationSelection: "lastUsed",
      instructions: "",
    });
    await directory.rememberLastUsed("anthropic", "claude-sonnet-4", "xhigh");

    const raw = JSON.parse(await readFile(join(dir, "selection.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.newConversationSelection, "lastUsed");
    assert.equal(raw.thinkingLevel, "high");
    assert.deepEqual(raw.lastUsed, {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "xhigh",
    });

    const reopened = await ModelDirectory.open(dir);
    assert.equal(reopened.getSettings().newConversationSelection, "lastUsed");
    assert.equal(reopened.getSettings().thinkingLevel, "high");
    assert.equal(reopened.lastUsedThinkingLevel(), "xhigh");
  });

  it("falls back to defaults when stored data is missing or malformed", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "selection.json"), JSON.stringify({
      thinkingLevel: "low",
      lastUsed: { provider: "openai", modelId: "", thinkingLevel: "nope" },
    }));
    const directory = await ModelDirectory.open(dir);
    assert.equal(directory.getSettings().newConversationSelection, "default");
    assert.equal(directory.getSettings().thinkingLevel, "low");
    assert.equal(directory.lastUsedThinkingLevel(), "medium");
    assert.equal(directory.availableLastUsed(), undefined);

    await writeFile(join(dir, "selection.json"), "not json");
    const broken = await ModelDirectory.open(dir);
    assert.equal(broken.getSettings().newConversationSelection, "default");
    assert.equal(broken.getSettings().thinkingLevel, "medium");
  });

  it("keeps an existing last used record when saving settings", async () => {
    const dir = await tempDir();
    const directory = await ModelDirectory.open(dir);
    await directory.rememberLastUsed("anthropic", "claude-sonnet-4", "high");
    await directory.saveSettings({
      provider: null,
      modelId: null,
      thinkingLevel: "medium",
      newConversationSelection: "lastUsed",
      instructions: "",
    });
    const reopened = await ModelDirectory.open(dir);
    assert.equal(reopened.lastUsedThinkingLevel(), "high");
    assert.equal(reopened.getSettings().newConversationSelection, "lastUsed");
  });
});
