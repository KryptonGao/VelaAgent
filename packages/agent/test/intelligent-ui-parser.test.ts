import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UiStreamParser,
  mayContainUi,
  parseUiMessage,
  uiLimits,
  type UiArtifact,
  type UiSegment,
} from "@vela/shared";
import { extractProposedPlans } from "../src/plan.ts";
import { billSplit, fenced } from "./fixtures/intelligent-ui.ts";

const now = () => 0;

const message = `先看结果。\n\n${fenced(billSplit)}\n\n每人 48 元。`;

function uiSegments(segments: UiSegment[]): Array<Extract<UiSegment, { type: "ui" }>> {
  return segments.filter((segment): segment is Extract<UiSegment, { type: "ui" }> => segment.type === "ui");
}

function parseChunks(text: string, sizes: number[]): UiSegment[] {
  const parser = new UiStreamParser({ now });
  let offset = 0;
  let turn = 0;
  while (offset < text.length) {
    const size = sizes[turn % sizes.length];
    parser.feed(text.slice(offset, offset + size));
    offset += size;
    turn += 1;
  }
  parser.finish();
  return parser.segments();
}

describe("Intelligent UI stream parser", () => {
  it("splits a reply into Markdown, UI and Markdown in order", () => {
    const segments = parseUiMessage(message, { now });
    assert.deepEqual(segments.map(segment => segment.type), ["markdown", "ui", "markdown"]);
    assert.equal(segments[0].type === "markdown" && segments[0].text, "先看结果。\n\n");
    assert.equal(segments[2].type === "markdown" && segments[2].text.trim(), "每人 48 元。");
    const artifact = uiSegments(segments)[0].artifact;
    assert.equal(artifact.status, "ready");
    assert.equal(artifact.artifactId, "split-1");
    assert.equal(artifact.title, "账单平摊");
    assert.equal(artifact.nodes.length, 4);
    assert.deepEqual(artifact.nodes[0].childrenIds, ["amountInput", "peopleInput", "total"]);
    assert.equal(artifact.stateDefinitions.length, 2);
  });

  it("produces identical results for every two-way split point", () => {
    const expected = JSON.stringify(parseUiMessage(message, { now }));
    for (let index = 0; index <= message.length; index += 1) {
      const parser = new UiStreamParser({ now });
      parser.feed(message.slice(0, index));
      parser.feed(message.slice(index));
      parser.finish();
      assert.equal(JSON.stringify(parser.segments()), expected, `split at ${index}`);
    }
  });

  it("is invariant for odd chunk sizes, single characters and CRLF input", () => {
    const expected = JSON.stringify(parseUiMessage(message, { now }));
    for (const sizes of [[1], [2], [3, 5], [7], [13, 1, 2], [64]]) {
      assert.equal(JSON.stringify(parseChunks(message, sizes)), expected, `sizes ${sizes}`);
    }
    const crlf = message.replace(/\n/g, "\r\n");
    const segments = parseUiMessage(crlf, { now });
    assert.equal(uiSegments(segments)[0].artifact.status, "ready");
  });

  it("splits Chinese text and JSON escapes without corrupting them", () => {
    const lines = [
      '{"op":"begin","id":"cn","version":1}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"node","id":"t","parent":"root","type":"text","props":{"text":"引号\\"和\\\\反斜杠\\n与表情😀与中文"}}',
      '{"op":"commit"}',
    ];
    const text = fenced(lines);
    const expected = uiSegments(parseUiMessage(text, { now }))[0].artifact.nodes[1].props.text;
    assert.equal(expected, '引号"和\\反斜杠\n与表情😀与中文');
    for (let index = 0; index <= text.length; index += 1) {
      const parser = new UiStreamParser({ now });
      parser.feed(text.slice(0, index));
      parser.feed(text.slice(index));
      parser.finish();
      assert.equal(uiSegments(parser.segments())[0].artifact.nodes[1].props.text, expected, `split at ${index}`);
    }
  });

  it("shows validated nodes before commit and never exposes half lines", () => {
    const parser = new UiStreamParser({ now });
    const partial = billSplit.slice(0, 5).join("\n");
    parser.feed(`好的\n\`\`\`vela-ui\n${partial}\n{"op":"node","id":"peopleInp`);
    const [text, ui] = parser.segments();
    assert.equal(text.type, "markdown");
    assert.equal(ui.type, "ui");
    const artifact = (ui as Extract<UiSegment, { type: "ui" }>).artifact;
    assert.equal(artifact.status, "receiving");
    assert.deepEqual(artifact.nodes.map(node => node.id), ["root", "amountInput"]);
    assert.equal((ui as Extract<UiSegment, { type: "ui" }>).closed, false);
    parser.feed(`ut","parent":"root","type":"number_input","props":{"label":"人数","bind":"people"}}\n`);
    assert.deepEqual(uiSegments(parser.segments())[0].artifact.nodes.map(node => node.id), ["root", "amountInput", "peopleInput"]);
  });

  it("marks a block without commit as incomplete and keeps its safe nodes", () => {
    const text = `${fenced(billSplit.slice(0, 5)).replace(/\n```$/, "")}`;
    const segments = parseUiMessage(text, { now });
    const artifact = uiSegments(segments)[0].artifact;
    assert.equal(artifact.status, "incomplete");
    assert.deepEqual(artifact.nodes.map(node => node.id), ["root", "amountInput"]);
    // A closed fence without commit is also incomplete once the stream is over.
    const closed = parseUiMessage(fenced(billSplit.slice(0, 5)), { now });
    assert.equal(uiSegments(closed)[0].artifact.status, "incomplete");
  });

  it("does not hide trailing text that follows an open UI block until it is closed", () => {
    const parser = new UiStreamParser({ now });
    parser.feed(`${fenced(billSplit)}\n之后的`);
    const segments = parser.segments();
    assert.deepEqual(segments.map(segment => segment.type), ["ui", "markdown"]);
    assert.equal(segments[1].type === "markdown" && segments[1].text, "之后的");
  });

  it("holds back a partial fence line so ```vela-u never flashes as text", () => {
    const parser = new UiStreamParser({ now });
    parser.feed("说明\n```vela-u");
    assert.equal(parser.segments().map(s => s.type === "markdown" ? s.text : "").join(""), "说明\n");
    parser.feed("i\n");
    // Still pending: the block shows only once begin is read.
    assert.equal(uiSegments(parser.segments()).length, 0);
    parser.feed(`${billSplit[0]}\n`);
    assert.equal(uiSegments(parser.segments()).length, 1);
    const plain = new UiStreamParser({ now });
    plain.feed("普通文字 `inline");
    assert.equal(plain.segments()[0].type === "markdown" && plain.segments()[0].text, "普通文字 `inline");
  });

  it("treats a code sample that merely mentions vela-ui as ordinary code", () => {
    const sample = "下面是语法示例：\n\n```vela-ui\nnot json at all\n```\n\n完。";
    const segments = parseUiMessage(sample, { now });
    assert.deepEqual(segments.map(segment => segment.type), ["markdown"]);
    assert.equal(segments[0].type === "markdown" && segments[0].text, `${sample}\n`);
    const unrelated = "```vela-ui\n{\"op\":\"node\",\"id\":\"x\"}\n```";
    assert.equal(uiSegments(parseUiMessage(unrelated, { now })).length, 0);
    const empty = parseUiMessage("```vela-ui\n```\n后文", { now });
    assert.equal(uiSegments(empty).length, 0);
  });

  it("ignores fences nested inside another code fence", () => {
    const quoted = `演示如何写：\n\n\`\`\`\`markdown\n${fenced(billSplit)}\n\`\`\`\`\n\n结束`;
    const segments = parseUiMessage(quoted, { now });
    assert.equal(uiSegments(segments).length, 0);
    assert.equal(segments.length, 1);
    const tilde = `~~~text\n${fenced(billSplit)}\n~~~`;
    assert.equal(uiSegments(parseUiMessage(tilde, { now })).length, 0);
    const indented = `    ${"```"}vela-ui\n    ${billSplit[0]}`;
    assert.equal(uiSegments(parseUiMessage(indented, { now })).length, 0);
    // A fence that follows a closed example fence is live again.
    const after = `\`\`\`ts\nconst a = 1;\n\`\`\`\n${fenced(billSplit)}`;
    assert.equal(uiSegments(parseUiMessage(after, { now })).length, 1);
  });

  it("supports several blocks per message with unique, stable ids", () => {
    const second = billSplit.map(line => line.replace("split-1", "split-1"));
    const text = `${fenced(billSplit)}\n中间\n${fenced(second)}`;
    const ids = uiSegments(parseUiMessage(text, { now })).map(segment => segment.artifact.artifactId);
    assert.deepEqual(ids, ["split-1", "split-1-2"]);
  });

  it("keeps segment object identity while nothing changed", () => {
    const parser = new UiStreamParser({ now });
    parser.feed(`介绍\n${fenced(billSplit.slice(0, 4)).replace(/\n```$/, "")}\n`);
    const before = parser.segments();
    const again = parser.segments();
    assert.equal(before[0], again[0]);
    assert.equal(before[1], again[1]);
    parser.feed(`${billSplit[4]}\n`);
    const after = parser.segments();
    assert.equal(before[0], after[0]);
    assert.notEqual(before[1], after[1]);
  });

  describe("rejection", () => {
    const rejects = (lines: string[], reason: string) => {
      const [segment] = uiSegments(parseUiMessage(fenced(lines), { now }));
      assert.ok(segment, "ui block present");
      assert.equal(segment.artifact.status, "invalid", `expected invalid for ${reason}`);
      assert.equal(segment.artifact.reason, reason);
      return segment.artifact;
    };
    const begin = '{"op":"begin","id":"b","version":1}';
    const root = '{"op":"node","id":"root","type":"column","props":{}}';

    it("rejects malformed JSON, unknown ops and unsupported versions", () => {
      rejects([begin, "{nope"], "bad_json");
      rejects([begin, "[]"], "bad_op");
      rejects([begin, '{"op":"exec","cmd":"rm -rf /"}'], "unknown_op");
      rejects([begin, begin], "bad_op");
      rejects(['{"op":"begin","id":"b","version":2}', root], "unsupported_version");
    });

    it("rejects out-of-order and duplicate nodes", () => {
      rejects([begin, '{"op":"node","id":"a","parent":"root","type":"text","props":{"text":"x"}}'], "missing_parent");
      rejects([begin, root, root], "duplicate_id");
      rejects([begin, root, '{"op":"node","id":"r2","type":"column","props":{}}'], "second_root");
      rejects([begin, root, '{"op":"node","id":"t","parent":"root","type":"text","props":{"text":"x"}}', '{"op":"node","id":"u","parent":"t","type":"text","props":{"text":"y"}}'], "not_container");
      rejects([begin, '{"op":"commit"}'], "empty_artifact");
    });

    it("rejects prototype-polluting keys wherever they appear", () => {
      rejects([begin, '{"op":"node","id":"root","type":"column","props":{"__proto__":{"polluted":true}}}'], "forbidden_key");
      rejects([begin, '{"op":"node","id":"root","type":"table","props":{"rows":[{"constructor":1}]}}'], "forbidden_key");
      rejects([begin, '{"op":"state","name":"a","kind":"number","initial":1,"__proto__":{"x":1}}'], "forbidden_key");
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      rejects([begin, '{"op":"state","name":"constructor","kind":"number","initial":1}'], "bad_state");
    });

    it("rejects invalid or conflicting states", () => {
      rejects([begin, '{"op":"state","name":"a","kind":"number","initial":"1"}'], "bad_state");
      rejects([begin, '{"op":"state","name":"a","kind":"number","initial":0,"min":1}'], "bad_state");
      rejects([begin, '{"op":"state","name":"a","kind":"number","initial":1,"min":5,"max":2}'], "bad_state");
      rejects([begin, '{"op":"state","name":"a","kind":"date","initial":1}'], "bad_state");
      rejects([begin, '{"op":"state","name":"a","kind":"string","initial":"x","options":["y"]}'], "bad_state");
      rejects([begin, '{"op":"state","name":"a","kind":"boolean","initial":true}', '{"op":"state","name":"a","kind":"boolean","initial":false}'], "duplicate_id");
    });

    it("validates references, bindings and cycles at commit", () => {
      const state = '{"op":"state","name":"n","kind":"number","initial":1}';
      rejects([begin, state, root, '{"op":"node","id":"s","parent":"root","type":"stat","props":{"label":"x","value":{"ref":"ghost"}}}', '{"op":"commit"}'], "bad_reference");
      rejects([begin, state, root, '{"op":"node","id":"i","parent":"root","type":"slider","props":{"label":"x","bind":"nope"}}', '{"op":"commit"}'], "bad_reference");
      rejects([begin, state, root, '{"op":"node","id":"i","parent":"root","type":"checkbox","props":{"label":"x","bind":"n"}}', '{"op":"commit"}'], "bad_binding");
      rejects([begin, '{"op":"derive","name":"a","expr":{"ref":"b"}}', '{"op":"derive","name":"b","expr":{"ref":"a"}}', root, '{"op":"commit"}'], "cyclic_reference");
      rejects([begin, '{"op":"derive","name":"a","expr":{"op":"eval","args":[1]}}'], "bad_derive");
      rejects([begin, state, root, '{"op":"node","id":"b","parent":"root","type":"button","props":{"label":"go","action":{"type":"set_state","name":"zzz","value":1}}}', '{"op":"commit"}'], "bad_reference");
    });

    it("enforces node, depth, state and size limits", () => {
      const many = Array.from({ length: uiLimits.nodes }, (_, index) => `{"op":"node","id":"n${index}","parent":"root","type":"text","props":{"text":"x"}}`);
      rejects([begin, root, ...many.slice(0, uiLimits.nodes)], "limit_nodes");
      const deep = [begin, root];
      let parent = "root";
      for (let level = 0; level < uiLimits.depth; level += 1) {
        deep.push(`{"op":"node","id":"d${level}","parent":"${parent}","type":"column","props":{}}`);
        parent = `d${level}`;
      }
      rejects(deep, "limit_depth");
      const states = Array.from({ length: uiLimits.states + 1 }, (_, index) => `{"op":"state","name":"s${index}","kind":"number","initial":0}`);
      rejects([begin, ...states], "limit_states");
      const huge = `{"op":"node","id":"root","type":"code","props":{"code":"${"x".repeat(uiLimits.lineBytes)}"}}`;
      rejects([begin, huge], "limit_line");
      const filler = `{"op":"node","id":"root","type":"text","props":{"text":"${"y".repeat(8_000)}"}}`;
      const flood = [begin, ...Array.from({ length: 40 }, () => filler)];
      const [segment] = uiSegments(parseUiMessage(fenced(flood), { now }));
      assert.equal(segment.artifact.reason === "limit_bytes" || segment.artifact.reason === "second_root", true);
      const options = Array.from({ length: 6 }, (_, index) => `{"op":"node","id":"t${index}","parent":"root","type":"table","props":{"columns":[{"key":"a"}],"rows":[${Array.from({ length: 100 }, () => '{"a":1}').join(",")}]}}`);
      rejects([begin, root, ...options], "limit_options");
    });

    it("stops after the first failure and never leaks the rest into Markdown", () => {
      const text = `前\n${fenced([begin, "{bad", root, '{"op":"node","id":"x","parent":"root","type":"text","props":{"text":"SECRET"}}'])}\n后`;
      const segments = parseUiMessage(text, { now });
      const joined = segments.filter(segment => segment.type === "markdown").map(segment => segment.type === "markdown" ? segment.text : "").join("");
      assert.equal(joined.includes("SECRET"), false);
      assert.equal(uiSegments(segments)[0].artifact.nodes.length, 0);
      assert.match(uiSegments(segments)[0].raw, /SECRET/);
    });
  });

  it("keeps unknown components and bad props as local placeholders", () => {
    const text = fenced([
      '{"op":"begin","id":"p","version":1}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"node","id":"w","parent":"root","type":"iframe","props":{"src":"https://evil.example"}}',
      '{"op":"node","id":"s","parent":"root","type":"stat","props":{"label":"x"}}',
      '{"op":"node","id":"ok","parent":"root","type":"text","props":{"text":"fine"}}',
      '{"op":"commit"}',
    ]);
    const artifact = uiSegments(parseUiMessage(text, { now }))[0].artifact;
    assert.equal(artifact.status, "ready");
    const byId = Object.fromEntries(artifact.nodes.map(node => [node.id, node]));
    assert.match(byId.w.invalid ?? "", /unsupported component/);
    assert.deepEqual(byId.w.props, {});
    assert.ok(byId.s.invalid);
    assert.equal(byId.ok.invalid, undefined);
    assert.ok(artifact.diagnostics.some(item => item.code === "node_rejected"));
  });

  it("ignores data after commit", () => {
    const text = fenced([...billSplit, '{"op":"node","id":"late","parent":"root","type":"text","props":{"text":"x"}}']);
    const artifact = uiSegments(parseUiMessage(text, { now }))[0].artifact;
    assert.equal(artifact.status, "ready");
    assert.equal(artifact.nodes.some(node => node.id === "late"), false);
    assert.ok(artifact.diagnostics.some(item => item.code === "op_after_commit"));
  });

  it("disposes artifacts", () => {
    const parser = new UiStreamParser({ now });
    parser.feed(fenced(billSplit));
    parser.dispose();
    const artifact = uiSegments(parser.segments())[0].artifact as UiArtifact;
    assert.equal(artifact.status, "disposed");
    assert.equal(artifact.nodes.length, 0);
  });

  it("quickly skips messages that cannot contain UI", () => {
    assert.equal(mayContainUi("普通回答"), false);
    assert.equal(mayContainUi(message), true);
  });

  it("leaves <proposed_plan> extraction untouched when mixed with UI", () => {
    const plan = "<proposed_plan>\n# 方案\n\n## Goal\n\n做事\n</proposed_plan>";
    const text = `${plan}\n${fenced(billSplit)}`;
    const extracted = extractProposedPlans(text);
    assert.equal(extracted.plans.length, 1);
    assert.match(extracted.plans[0], /# 方案/);
    assert.equal(extracted.plans[0].includes("vela-ui"), false);
    // The plan parser runs first, so the UI parser sees only the visible text.
    assert.equal(uiSegments(parseUiMessage(extracted.text, { now })).length, 1);
    // A UI fence quoted inside the plan body stays plan content, not an artifact.
    const inside = `<proposed_plan>\n# 方案\n\n${fenced(billSplit, "````")}\n</proposed_plan>`;
    const quoted = extractProposedPlans(inside);
    assert.equal(quoted.plans.length, 1);
    assert.equal(uiSegments(parseUiMessage(quoted.text, { now })).length, 0);
  });
});
