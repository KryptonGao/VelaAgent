import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMarkdownHref,
  headingIdsByLine,
  headingSlug,
  isMarkdownPath,
} from "../src/renderer/components/preview/markdown-path.ts";

describe("isMarkdownPath", () => {
  it("accepts markdown extensions regardless of case", () => {
    assert.equal(isMarkdownPath("README.md"), true);
    assert.equal(isMarkdownPath("docs/guide.MD"), true);
    assert.equal(isMarkdownPath("notes.markdown"), true);
    assert.equal(isMarkdownPath("page.mdx"), true);
  });

  it("rejects other files", () => {
    assert.equal(isMarkdownPath("src/App.tsx"), false);
    assert.equal(isMarkdownPath("Makefile"), false);
    assert.equal(isMarkdownPath("readme.md.bak"), false);
  });
});

describe("headingSlug", () => {
  it("folds punctuation and spaces", () => {
    assert.equal(headingSlug("Hello, World!"), "hello-world");
    assert.equal(headingSlug("快速开始"), "快速开始");
    assert.equal(headingSlug("***"), "section");
  });
});

describe("headingIdsByLine", () => {
  it("numbers duplicate headings and skips fenced code", () => {
    const ids = headingIdsByLine(["# Intro", "", "```md", "# Not a heading", "```", "", "## Intro"].join("\n"));
    assert.equal(ids.get(1), "intro");
    assert.equal(ids.has(4), false);
    assert.equal(ids.get(7), "intro-1");
  });

  it("reads a setext heading", () => {
    const ids = headingIdsByLine("Title\n----\n");
    assert.equal(ids.get(1), "title");
  });
});

describe("classifyMarkdownHref", () => {
  it("resolves relative files from the document directory", () => {
    assert.deepEqual(classifyMarkdownHref("docs/guide.md", "./images/flow.svg"), {
      kind: "file",
      path: "docs/images/flow.svg",
      anchor: null,
    });
    assert.deepEqual(classifyMarkdownHref("docs/guide.md", "../README.md#install"), {
      kind: "file",
      path: "README.md",
      anchor: "install",
    });
  });

  it("treats a leading slash as the workspace root", () => {
    assert.deepEqual(classifyMarkdownHref("docs/guide.md", "/assets/cover.png"), {
      kind: "file",
      path: "assets/cover.png",
      anchor: null,
    });
  });

  it("keeps anchors, web links, and image data urls", () => {
    assert.deepEqual(classifyMarkdownHref("README.md", "#快速开始"), { kind: "anchor", id: "快速开始" });
    assert.deepEqual(classifyMarkdownHref("README.md", "#Hello, World!"), { kind: "anchor", id: "hello-world" });
    assert.deepEqual(classifyMarkdownHref("README.md", "https://example.com"), {
      kind: "external",
      href: "https://example.com",
    });
    assert.equal(classifyMarkdownHref("README.md", "data:image/png;base64,aaaa").kind, "external");
  });

  it("rejects traversal, scripts, and empty targets", () => {
    assert.deepEqual(classifyMarkdownHref("docs/guide.md", "../../etc/passwd"), { kind: "ignore" });
    assert.deepEqual(classifyMarkdownHref("README.md", "javascript:alert(1)"), { kind: "ignore" });
    assert.deepEqual(classifyMarkdownHref("README.md", "data:text/html,hi"), { kind: "ignore" });
    assert.deepEqual(classifyMarkdownHref("README.md", "   "), { kind: "ignore" });
  });
});
