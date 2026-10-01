import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const turnTimingEntryType = "vela_turn_timing";

export interface TurnTiming {
  assistantEntryId: string;
  startedAt: number;
  completedAt: number;
}

/** Timing metadata follows the selected branch and never enters model context. */
export function readTurnTimings(entries: readonly SessionEntry[]): Map<string, TurnTiming> {
  const timings = new Map<string, TurnTiming>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== turnTimingEntryType) continue;
    const data = entry.data as Partial<TurnTiming> | null | undefined;
    if (!data || typeof data.assistantEntryId !== "string" || !data.assistantEntryId ||
      typeof data.startedAt !== "number" || !Number.isFinite(data.startedAt) || data.startedAt < 0 ||
      typeof data.completedAt !== "number" || !Number.isFinite(data.completedAt) || data.completedAt < data.startedAt) continue;
    timings.set(data.assistantEntryId, data as TurnTiming);
  }
  return timings;
}

/** A fork ending at an assistant entry also needs the timing record written after it. */
export function copyTurnTimings(timings: ReadonlyMap<string, TurnTiming>, target: SessionManager): void {
  const branch = target.getBranch();
  const present = readTurnTimings(branch);
  const ids = new Set(branch.map(entry => entry.id));
  for (const [id, timing] of timings) {
    if (ids.has(id) && !present.has(id)) target.appendCustomEntry(turnTimingEntryType, timing);
  }
}
