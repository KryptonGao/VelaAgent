import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nextStreamFollow,
  releasesStreamFollow,
  shouldResumeFollowForMessages,
} from "../src/renderer/components/chat-scroll.ts";

describe("nextStreamFollow", () => {
  it("keeps following when content grows but the user has not moved", () => {
    assert.equal(
      nextStreamFollow({
        following: true,
        scrollTop: 400,
        previousScrollTop: 400,
        distanceFromBottom: 500,
      }),
      true,
    );
  });

  it("stops following as soon as the user scrolls up, even near the bottom", () => {
    assert.equal(
      nextStreamFollow({
        following: true,
        scrollTop: 360,
        previousScrollTop: 400,
        distanceFromBottom: 40,
      }),
      false,
    );
  });

  it("resumes following only after the user scrolls back to the bottom", () => {
    assert.equal(
      nextStreamFollow({
        following: false,
        scrollTop: 480,
        previousScrollTop: 400,
        distanceFromBottom: 4,
      }),
      true,
    );
    assert.equal(
      nextStreamFollow({
        following: false,
        scrollTop: 450,
        previousScrollTop: 400,
        distanceFromBottom: 40,
      }),
      false,
    );
  });

  it("does not resume when a small downward move stays away from the bottom", () => {
    assert.equal(
      nextStreamFollow({
        following: false,
        scrollTop: 402,
        previousScrollTop: 400,
        distanceFromBottom: 28,
      }),
      false,
    );
  });

  it("ignores a tiny upward jitter while following", () => {
    assert.equal(
      nextStreamFollow({
        following: true,
        scrollTop: 398,
        previousScrollTop: 400,
        distanceFromBottom: 2,
      }),
      true,
    );
  });
});

describe("releasesStreamFollow", () => {
  it("releases before the wheel moves when the list can scroll upward", () => {
    assert.equal(releasesStreamFollow(120, true), true);
    assert.equal(releasesStreamFollow(0, true), false);
    assert.equal(releasesStreamFollow(120, false), false);
  });
});

describe("shouldResumeFollowForMessages", () => {
  it("resumes on conversation switch and a new user message, not on stream deltas", () => {
    assert.equal(
      shouldResumeFollowForMessages({
        conversationChanged: true,
        previousUserMessageId: "u1",
        userMessageId: "u1",
      }),
      true,
    );
    assert.equal(
      shouldResumeFollowForMessages({
        conversationChanged: false,
        previousUserMessageId: "u1",
        userMessageId: "u2",
      }),
      true,
    );
    assert.equal(
      shouldResumeFollowForMessages({
        conversationChanged: false,
        previousUserMessageId: "u1",
        userMessageId: "u1",
      }),
      false,
    );
  });
});
