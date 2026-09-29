import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePath, parseShellPath } from "../src/main/shell-path.ts";

describe("parseShellPath", () => {
  it("picks the last path-shaped line out of shell noise", () => {
    const stdout = [
      "compinit: initialization aborted",
      "/opt/homebrew/bin:/usr/bin:/bin",
      "",
    ].join("\n");
    assert.equal(parseShellPath(stdout), "/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("plain path output is returned as is", () => {
    assert.equal(parseShellPath("/opt/homebrew/bin:/usr/bin:/bin"), "/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("returns null when nothing looks like a path", () => {
    assert.equal(parseShellPath("unknown shell option: -i\n"), null);
    assert.equal(parseShellPath(""), null);
  });
});

describe("mergePath", () => {
  it("keeps login entries first and appends missing current entries", () => {
    const merged = mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/sbin");
    assert.equal(merged, "/opt/homebrew/bin:/usr/bin:/bin:/sbin");
  });

  it("drops empty entries and duplicates", () => {
    assert.equal(mergePath(":/usr/bin::/usr/bin", ""), "/usr/bin");
    assert.equal(mergePath("/usr/bin", undefined), "/usr/bin");
  });
});
