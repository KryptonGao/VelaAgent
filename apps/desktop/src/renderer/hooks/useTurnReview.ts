import { useCallback, useState } from "react";
import type { TurnReviewRequest } from "../components/turn-changes";
import { closeTurnReview, openTurnReview, turnReviewScope, type TurnReviews } from "../turn-review-state";

/** 与 App 的其他工作面板标签一样只保存在内存，按工作区和聊天隔离。 */
export function useTurnReview(workspace: string, conversation: string) {
  const [reviews, setReviews] = useState<TurnReviews>({});
  const scope = turnReviewScope(workspace, conversation);
  const open = useCallback((request: TurnReviewRequest) => {
    setReviews(current => openTurnReview(current, scope, request));
  }, [scope]);
  const close = useCallback(() => setReviews(current => closeTurnReview(current, scope)), [scope]);
  return { review: reviews[scope] ?? null, tabId: `turn-review:${encodeURIComponent(scope)}`, open, close };
}
