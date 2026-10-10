import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseUiMessage, type InteractionMode, type UiPreference } from "@vela/shared";
import { IntelligentUiSettings } from "../src/intelligent-ui-settings.ts";
import { intelligentUiExample, intelligentUiInstructions } from "../src/intelligent-ui-prompt.ts";
import { fenced } from "./fixtures/intelligent-ui.ts";

describe("intelligentUiInstructions", () => {
  it("injects the syntax only in agent mode", () => {
    const others: InteractionMode[] = ["plan", "goal"];
    for (const mode of others) {
      for (const preference of ["auto", "text_only", "visual_first"] as UiPreference[]) {
        assert.equal(intelligentUiInstructions(preference, mode), null, `${preference}/${mode}`);
      }
    }
    assert.match(intelligentUiInstructions("auto", "agent") ?? "", /vela-ui/);
  });

  it("tells the model to stay with text when the user turned it off", () => {
    const text = intelligentUiInstructions("text_only", "agent") ?? "";
    assert.match(text, /不要输出 vela-ui/);
    assert.doesNotMatch(text, /"op":"begin"/);
  });

  it("differs between auto and visual_first but keeps the same syntax", () => {
    const auto = intelligentUiInstructions("auto", "agent");
    const visual = intelligentUiInstructions("visual_first", "agent");
    assert.notEqual(auto, visual);
    assert.ok(auto?.includes("### 格式") && visual?.includes("### 格式"));
  });

  it("ships an example that the real parser accepts as a ready artifact", () => {
    const segments = parseUiMessage(fenced(intelligentUiExample.split("\n")), { now: () => 0 });
    const ui = segments.find(segment => segment.type === "ui");
    assert.ok(ui && ui.type === "ui");
    assert.equal(ui.artifact.status, "ready");
    assert.equal(ui.artifact.nodes.filter(node => node.invalid).length, 0);
  });
});

describe("IntelligentUiSettings", () => {
  const withDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "vela-iui-"));
    try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("defaults to auto and persists changes", () => {
    withDir(dir => {
      const settings = new IntelligentUiSettings(dir);
      assert.equal(settings.preference, "auto");
      settings.setPreference("text_only");
      assert.equal(new IntelligentUiSettings(dir).preference, "text_only");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "intelligent-ui-settings.json"), "utf8")), { preference: "text_only" });
    });
  });

  it("falls back to auto for corrupt or unknown stored values", () => {
    withDir(dir => {
      writeFileSync(join(dir, "intelligent-ui-settings.json"), '{"preference":"always_ui"}');
      assert.equal(new IntelligentUiSettings(dir).preference, "auto");
      writeFileSync(join(dir, "intelligent-ui-settings.json"), "not json");
      assert.equal(new IntelligentUiSettings(dir).preference, "auto");
    });
  });

  it("rejects invalid preferences without changing the stored one", () => {
    withDir(dir => {
      const settings = new IntelligentUiSettings(dir);
      settings.setPreference("visual_first");
      assert.throws(() => settings.setPreference("bogus" as UiPreference));
      assert.equal(settings.preference, "visual_first");
      assert.equal(new IntelligentUiSettings(dir).preference, "visual_first");
    });
  });
});
