export const SCROLL_EDGE_HEIGHT = 66;
const EDGE_REVEAL_DISTANCE = 24;

/** Reveal continuously near a boundary, including fractional/overscrolled positions. */
export function thinkingEdges(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const position = Math.max(0, Math.min(scrollTop, maxScroll));
  const strength = (distance: number) => {
    const progress = Math.min(distance / EDGE_REVEAL_DISTANCE, 1);
    return progress * progress * (3 - 2 * progress);
  };
  return { top: strength(position), bottom: strength(maxScroll - position) };
}
