import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentStreamEvent } from "@vela/shared";
import {
  didCompleteTask,
  notificationSoundKinds,
  NotificationSoundPlayer,
  streamNotificationSound,
  synthesizeNotification,
} from "../src/renderer/notification-sounds.ts";

function audioFixture(initialState = "running") {
  const sources: { started: number; stopped: number; disconnected: number; onended: (() => void) | null }[] = [];
  const samples: Float32Array[] = [];
  const context = {
    state: initialState,
    sampleRate: 44100,
    destination: {},
    resumes: 0,
    closes: 0,
    async resume() { this.resumes++; this.state = "running"; },
    async close() { this.closes++; this.state = "closed"; },
    createBuffer(_channels: number, _length: number, _rate: number) {
      return { copyToChannel(data: Float32Array) { samples.push(data); } };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        started: 0, stopped: 0, disconnected: 0,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() { this.disconnected++; },
        start() { this.started++; },
        stop() { this.stopped++; },
      };
      sources.push(source);
      return source;
    },
  };
  let now = 0;
  const player = new NotificationSoundPlayer(() => context as unknown as AudioContext, () => now);
  return { player, context, sources, samples, advance: (ms: number) => { now += ms; } };
}

describe("task sound events", () => {
  it("sounds errors from the root and child agents, including recoverable tool failures", () => {
    const failure = { type: "tool_end", isError: true } as AgentStreamEvent;
    assert.equal(streamNotificationSound({ type: "error", conversationId: "background", message: "failed" }), "error");
    assert.equal(streamNotificationSound(failure), "error");
    assert.equal(streamNotificationSound({ ...failure, isError: false } as AgentStreamEvent), null);
    for (const event of [{ type: "error", message: "child failed" }, { type: "tool_end", isError: true }]) {
      assert.equal(streamNotificationSound({ type: "agent_event", event } as AgentStreamEvent), "error");
    }
    assert.equal(streamNotificationSound({ type: "agent_event", event: { type: "text_delta", delta: "hello" } } as AgentStreamEvent), null);
  });

  it("does not sound token, trace, state, or agent snapshot updates", () => {
    for (const type of ["text_delta", "thinking_delta", "tool_start", "tool_output", "state", "trace", "agents", "assistant_start", "user_message"]) {
      assert.equal(streamNotificationSound({ type } as AgentStreamEvent), null, type);
    }
  });

  it("requires a live streaming-to-ready transition, excluding restored state, duplicates, failures and aborts", () => {
    assert.equal(didCompleteTask("streaming", "ready", false), true);
    assert.equal(didCompleteTask(undefined, "ready", false), false);
    assert.equal(didCompleteTask("ready", "ready", false), false);
    assert.equal(didCompleteTask("starting", "ready", false), false);
    assert.equal(didCompleteTask("streaming", "streaming", false), false);
    assert.equal(didCompleteTask("streaming", "error", false), false);
    assert.equal(didCompleteTask("streaming", "ready", true), false);
  });
});

describe("task chimes", () => {
  it("generates four distinct, sub-second signals with quiet peaks and click-free boundaries", () => {
    for (const rate of [44100, 48000]) {
      const signals = notificationSoundKinds.map(kind => synthesizeNotification(kind, rate));
      for (const samples of signals) {
        assert.ok(samples.length > rate * 0.3 && samples.length < rate * 0.6);
        assert.equal(samples[0], 0);
        assert.equal(samples.at(-1), 0);
        let peak = 0;
        for (const sample of samples) { assert.ok(Number.isFinite(sample)); peak = Math.max(peak, Math.abs(sample)); }
        assert.ok(peak > 0.05 && peak < 0.3, `peak ${peak}`);
      }
      assert.equal(new Set(signals.map(signal => Buffer.from(signal.buffer).toString("base64"))).size, 4);
    }
  });

  it("coalesces bursts of one kind while allowing a question or permission cue immediately", async () => {
    const { player, sources, advance } = audioFixture();
    await player.play("error");
    await player.play("error");
    assert.equal(sources.length, 1);
    await player.play("question");
    await player.play("permission");
    assert.equal(sources.length, 3);
    assert.equal(sources[0]!.stopped, 1);
    advance(900);
    await player.play("error");
    assert.equal(sources.length, 4);
    player.dispose();
  });

  it("muting stops current audio, blocks notifications, and still allows explicit previews", async () => {
    const { player, sources } = audioFixture();
    await player.play("complete");
    player.setEnabled(false);
    assert.equal(sources[0]!.stopped, 1);
    await player.play("question");
    assert.equal(sources.length, 1);
    await player.play("permission", true);
    await player.play("permission", true);
    assert.equal(sources.length, 3);
    player.setEnabled(true);
    await player.play("complete");
    assert.equal(sources.length, 4);
    player.dispose();
  });

  it("unlocks a suspended device silently on user interaction", async () => {
    const { player, context, sources } = audioFixture("suspended");
    await player.unlock();
    assert.equal(context.resumes, 1);
    assert.equal(sources.length, 0);
    await player.play("complete");
    assert.equal(sources[0]!.started, 1);
    sources[0]!.onended?.();
    assert.equal(sources[0]!.disconnected, 1);
    player.dispose();
    assert.equal(context.closes, 1);
  });

  it("does not start deferred audio after mute or disposal", async () => {
    for (const action of ["mute", "dispose"] as const) {
      const { player, context, sources } = audioFixture("suspended");
      let resume!: () => void;
      context.resume = () => new Promise<void>(resolve => { resume = () => { context.state = "running"; resolve(); }; });
      const pending = player.play("complete");
      if (action === "mute") player.setEnabled(false);
      else player.dispose();
      resume();
      await pending;
      assert.equal(sources.length, 0, action);
      player.dispose();
    }
  });

  it("drops obsolete cues if a newer event arrives during audio startup", async () => {
    const { player, context, samples } = audioFixture("suspended");
    const resumes: (() => void)[] = [];
    context.resume = () => new Promise<void>(resolve => { resumes.push(() => { context.state = "running"; resolve(); }); });
    const error = player.play("error");
    const question = player.play("question");
    resumes.forEach(resume => resume());
    await Promise.all([error, question]);
    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0], synthesizeNotification("question", context.sampleRate));
    player.dispose();
  });

  it("audio creation and resume failures remain non-fatal and can recover", async () => {
    const broken = new NotificationSoundPlayer(() => { throw new Error("No audio device"); });
    await assert.doesNotReject(broken.unlock());
    await assert.doesNotReject(broken.play("error"));
    broken.dispose();
    const { player, context, sources } = audioFixture("suspended");
    context.resume = async () => { throw new Error("Autoplay blocked"); };
    await assert.doesNotReject(player.play("question"));
    assert.equal(sources.length, 0);
    context.resume = async () => { context.state = "running"; };
    await player.play("question");
    assert.equal(sources.length, 1);
    player.dispose();
  });
});
