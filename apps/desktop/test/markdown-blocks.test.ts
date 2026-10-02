import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { trailingParagraphEnd, partitionMarkdown, type MarkdownPartition } from "../src/renderer/components/markdown-blocks.ts";

const parser = unified().use(remarkParse).use(remarkGfm);
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "position" ? undefined : item));
const examples = {
  paragraphs: "# Title\n\nFirst **paragraph**.\n\nSecond paragraph.\n\nThird.\n\nFourth.",
  setext: "First\n\nSecond\n\nHeading\n---\n\nTail\n\nMore",
  tables: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n\nTail\n\nMore",
  lists: "Intro\n\n- one\n\n  continuation\n\n- two\n  - nested\n\nAfter\n\nMore",
  ordered: "Intro\n\n3. third\n4. fourth\n\nAfter\n\nMore",
  quotes: "Intro\n\n> quoted\n>\n> - list\n> - next\n\nAfter\n\nMore",
  fences: "Intro\n\n```ts\nconst x = 1;\n\n// blank line in code\n```\n\nAfter\n\nMore",
  indented: "Intro\n\n    code\n\n    more code\n\nAfter\n\nMore",
  html: "Intro\n\n<div>\n\nraw\n</div>\n\nAfter\n\nMore",
  breaks: "Intro\n\n---\n\nTail\n\nFinal",
  crlf: "Intro\r\n\r\n# Heading\r\n\r\nText\r\n\r\nTail",
  tasks: "Intro\n\n- [x] done\n- [ ] todo\n\nAfter\n\nTail",
};

describe("incremental Markdown blocks", () => {
  for (const [name, source] of Object.entries(examples)) {
    it(`preserves whole-document syntax at every streamed prefix: ${name}`, () => {
      let previous: MarkdownPartition | undefined;
      for (let size = 1; size <= source.length; size++) {
        const text = source.slice(0, size);
        const next = partitionMarkdown(text, previous);
        const segmented = next.blocks.flatMap((block) => parser.parse(block.text).children);
        assert.deepEqual(normalize(segmented), normalize(parser.parse(text).children), `prefix ${size}: ${JSON.stringify(text)}`);
        for (let index = 0; index < (previous?.stable.length ?? 0); index++) {
          assert.equal(next.stable[index], previous!.stable[index], "settled prefix was reparsed");
        }
        previous = next;
      }
    });
  }
  it("uses whole-document semantics for late references and footnotes", () => {
    for (const source of ["[link][id]\n\nTail\n\n[id]: https://example.com", "Note[^a]\n\n[^a]: definition"]) {
      const prior = partitionMarkdown(source.slice(0, source.indexOf("\n\n")));
      const next = partitionMarkdown(source, prior);
      assert.equal(next.wholeDocument, true);
      assert.equal(next.blocks.length, 1);
      assert.equal(next.blocks[0]!.text, source);
    }
  });
  it("resets the prefix when a document is replaced or truncated", () => {
    const previous = partitionMarkdown("# Old\n\nFirst\n\nSecond\n\nTail");
    for (const text of ["# New\n\nNew body", "# Old", ""]) {
      assert.deepEqual(partitionMarkdown(text, previous), partitionMarkdown(text));
    }
  });
  it("reuses an unchanged partition", () => {
    const previous = partitionMarkdown("# Title\n\nBody");
    assert.equal(partitionMarkdown(previous.text, previous), previous);
  });
});

describe("trailing placement in the last paragraph", () => {
  it("locates the end of the paragraph a document closes with", () => {
    const text = "summary with `runtime.prompt` inside";
    assert.equal(trailingParagraphEnd(text), text.length);
    const paragraphs = "first paragraph\n\nsecond paragraph";
    assert.equal(trailingParagraphEnd(paragraphs), paragraphs.length);
    // 段落后还有空行时,位置停在段落内容末尾而不是文档末尾。
    assert.equal(trailingParagraphEnd("summary\n\n"), "summary".length);
  });
  it("has no paragraph target for other closing nodes", () => {
    assert.equal(trailingParagraphEnd("- one\n- two"), undefined);
    assert.equal(trailingParagraphEnd("```ts\nconst x = 1;\n```"), undefined);
    assert.equal(trailingParagraphEnd("# Heading"), undefined);
    assert.equal(trailingParagraphEnd("> quoted text"), undefined);
    assert.equal(trailingParagraphEnd("| a | b |\n| --- | --- |\n| x | y |"), undefined);
    assert.equal(trailingParagraphEnd(""), undefined);
  });
  it("keeps the same answer for the final partition block", () => {
    const endingInList = partitionMarkdown("Intro\n\n- one\n- two");
    assert.equal(trailingParagraphEnd(endingInList.blocks.at(-1)!.text), undefined);
    const endingInParagraph = partitionMarkdown("Intro\n\nTail paragraph.");
    const tail = endingInParagraph.blocks.at(-1)!.text;
    assert.equal(trailingParagraphEnd(tail), tail.length);
  });
});
