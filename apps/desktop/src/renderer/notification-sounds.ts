import type { AgentStreamEvent, SessionStatus } from "@vela/shared";

export const notificationSoundKinds = ["error", "complete", "question", "permission"] as const;
export type NotificationSound = (typeof notificationSoundKinds)[number];
export type NotifySound = (sound: NotificationSound) => void;
export const noSound: NotifySound = () => undefined;
export const soundEffectsKey = "vela.soundEffects";

/** Only live execution failures produce an error cue; ordinary stream updates stay quiet. */
export function streamNotificationSound(event: AgentStreamEvent): NotificationSound | null {
  if (event.type === "agent_event") {
    const child = event.event;
    return child.type === "error" || (child.type === "tool_end" && child.isError) ? "error" : null;
  }
  return event.type === "error" || (event.type === "tool_end" && event.isError) ? "error" : null;
}

export function didCompleteTask(previous: SessionStatus | undefined, next: SessionStatus, blocked: boolean): boolean {
  return previous === "streaming" && next === "ready" && !blocked;
}

interface Note {
  frequency: number;
  at: number;
  duration: number;
}

const melodies: Record<NotificationSound, readonly Note[]> = {
  error: [
    { frequency: 392, at: 0, duration: 0.16 },
    { frequency: 311.13, at: 0.18, duration: 0.24 },
  ],
  complete: [
    { frequency: 523.25, at: 0, duration: 0.16 },
    { frequency: 659.25, at: 0.12, duration: 0.16 },
    { frequency: 783.99, at: 0.24, duration: 0.28 },
  ],
  question: [
    { frequency: 587.33, at: 0, duration: 0.17 },
    { frequency: 739.99, at: 0.2, duration: 0.28 },
  ],
  permission: [
    { frequency: 440, at: 0, duration: 0.12 },
    { frequency: 440, at: 0.16, duration: 0.12 },
    { frequency: 659.25, at: 0.32, duration: 0.22 },
  ],
};

/** Quiet, locally synthesized chimes with soft attacks and releases; no assets or network needed. */
export function synthesizeNotification(sound: NotificationSound, sampleRate: number): Float32Array<ArrayBuffer> {
  const notes = melodies[sound];
  const duration = Math.max(...notes.map(note => note.at + note.duration));
  const samples = new Float32Array(Math.ceil(duration * sampleRate) + 1);
  for (const note of notes) {
    const start = Math.round(note.at * sampleRate);
    const length = Math.floor(note.duration * sampleRate);
    for (let i = 0; i < length; i++) {
      const time = i / sampleRate;
      const attack = Math.min(1, time / 0.008);
      const release = Math.min(1, (length - 1 - i) / (sampleRate * 0.035));
      const envelope = attack * release * Math.exp(-3 * time / note.duration);
      const phase = 2 * Math.PI * note.frequency * time;
      samples[start + i] += 0.14 * envelope * (Math.sin(phase) + 0.2 * Math.sin(2 * phase));
    }
  }
  return samples;
}

export class NotificationSoundPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private enabled = true;
  private generation = 0;
  private readonly lastPlayed = new Map<NotificationSound, number>();

  constructor(
    private readonly createContext: () => AudioContext = () => new AudioContext({ latencyHint: "interactive" }),
    private readonly now: () => number = () => Date.now(),
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (!enabled) this.stop();
    this.lastPlayed.clear();
  }

  /** Called on user interaction so later IPC events can play even while the window is in the background. */
  async unlock(): Promise<void> {
    if (!this.enabled) return;
    try {
      const context = this.getContext();
      if (context.state === "suspended") await context.resume();
    } catch {
      // Audio device/autoplay failures must never interfere with the task.
    }
  }

  async play(sound: NotificationSound, preview = false): Promise<void> {
    if (!preview && !this.enabled) return;
    const now = this.now();
    const previous = this.lastPlayed.get(sound);
    // Coalesce error bursts and duplicate requests without suppressing another kind of cue.
    if (!preview && previous !== undefined && now - previous < 900) return;
    if (!preview) this.lastPlayed.set(sound, now);
    const generation = ++this.generation;
    try {
      const context = this.getContext();
      if (context.state === "suspended") await context.resume();
      // A newer cue, mute, or unmount supersedes pending audio-device startup.
      if (generation !== this.generation || (!preview && !this.enabled) || context.state !== "running") return;
      const samples = synthesizeNotification(sound, context.sampleRate);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.stop();
      this.source = source;
      source.onended = () => {
        source.disconnect();
        if (this.source === source) this.source = null;
      };
      source.start();
    } catch {
      // Notifications are best-effort; keep the existing visual feedback available.
      if (!preview) this.lastPlayed.delete(sound);
    }
  }

  dispose(): void {
    this.generation++;
    this.stop();
    const context = this.context;
    this.context = null;
    this.lastPlayed.clear();
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  private getContext(): AudioContext {
    if (!this.context || this.context.state === "closed") this.context = this.createContext();
    return this.context;
  }

  private stop(): void {
    if (!this.source) return;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }
}
