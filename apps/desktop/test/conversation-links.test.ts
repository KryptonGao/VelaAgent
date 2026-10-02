import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isConversationLinkTarget, routeConversationLink } from "../src/renderer/browser/conversation-link-policy.ts";

describe("conversation link routing", () => {
  it("routes web links to a manual browser tab when embedded is selected", () => {
    const opened: string[] = [];
    for (const url of ["https://example.com/path?q=a#part", "http://localhost:5173/page"]) {
      assert.equal(routeConversationLink(url, "embedded", (value) => opened.push(value)), true);
    }
    assert.deepEqual(opened, ["https://example.com/path?q=a#part", "http://localhost:5173/page"]);
  });
  it("preserves native handling when the system browser is selected", () => {
    assert.equal(routeConversationLink("https://example.com", "external", () => assert.fail("opened internal browser")), false);
  });
  it("leaves mail links and invalid/privileged protocols out of the embedded browser", () => {
    for (const href of ["mailto:user@example.com", "file:///private", "javascript:alert(1)",
      "data:text/html,test", "about:blank", "vela://command", "#heading", "/relative", "https://"]) {
      assert.equal(routeConversationLink(href, "embedded", () => assert.fail(href)), false);
    }
  });
  it("accepts only supported saved preferences", () => {
    assert.equal(isConversationLinkTarget("embedded"), true);
    assert.equal(isConversationLinkTarget("external"), true);
    for (const value of [null, undefined, "invalid", {}, false]) assert.equal(isConversationLinkTarget(value), false);
  });
});
