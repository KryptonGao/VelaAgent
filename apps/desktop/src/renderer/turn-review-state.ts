import type { TurnReviewRequest } from "./components/turn-changes";

export type TurnReviews = Record<string, TurnReviewRequest>;

export function turnReviewScope(workspace: string, conversation: string): string {
  return JSON.stringify([workspace, conversation]);
}

export function openTurnReview(current: TurnReviews, scope: string, request: TurnReviewRequest): TurnReviews {
  if (current[scope]?.turnId === request.turnId) return current;
  return {
    ...current,
    [scope]: {
      turnId: request.turnId,
      changes: {
        ...request.changes,
        files: request.changes.files.map(file => ({ ...file, diffs: [...file.diffs] })),
      },
    },
  };
}

export function closeTurnReview(current: TurnReviews, scope: string): TurnReviews {
  if (!(scope in current)) return current;
  const next = { ...current };
  delete next[scope];
  return next;
}
