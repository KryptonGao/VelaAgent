/**
 * 悬浮信息布局下,环境卡片固定在对话区右上角,会压住居中的对话列右缘。
 * 让位规则:
 *   1. 没被卡片压住时保持自然居中,不做任何挪动;
 *   2. 被压住时,把对话列放到「左侧边栏分界 → 卡片左缘」之间居中,
 *      让列左缘到分界的距离等于列右缘到卡片左缘的距离;
 *   3. 原始宽度放不下时收窄不到 10% 的宽度补足;需要收窄 10% 以上
 *      就保持原样,让卡片盖住对话流。
 * 纯几何计算,便于单测;DOM 测量留在 ChatView 里。
 */

export interface ChatLanePlan {
  /** 对话列向左移动的距离(px)。 */
  shift: number;
  /** 对话列收窄的宽度(px);0 表示保持自然宽度。 */
  shrink: number;
}

export interface ChatLaneInput {
  /** 对话列自然状态下的左边界(视口坐标)。 */
  laneLeft: number;
  /** 对话列自然宽度(px)。 */
  laneWidth: number;
  /** 环境卡片左边界(视口坐标)。 */
  cardLeft: number;
  /** 左侧边栏分界,即对话区左缘(视口坐标)。 */
  laneLimitLeft: number;
  /** 允许的最大收窄比例(相对自然宽度),默认 {@link chatLaneMaxShrinkRatio}。 */
  maxShrinkRatio?: number;
}

export const chatLaneMaxShrinkRatio = 0.1;
/** 与 CSS 的 --chat-lane-max 保持一致;能读到变量时以变量为准。 */
export const chatLaneDefaultMaxWidth = 760;

export function planChatLane(input: ChatLaneInput): ChatLanePlan {
  const noChange: ChatLanePlan = { shift: 0, shrink: 0 };
  const { laneLeft, laneWidth, cardLeft, laneLimitLeft } = input;
  if (!(laneWidth > 0) || !Number.isFinite(laneLeft) || !Number.isFinite(cardLeft) || !Number.isFinite(laneLimitLeft)) {
    return noChange;
  }
  // 卡片没有压住列时保持自然居中。
  if (laneLeft + laneWidth <= cardLeft) return noChange;
  const region = cardLeft - laneLimitLeft;
  if (!(region > 0)) return noChange;
  const shrink = Math.max(0, laneWidth - region);
  // 恰好 10% 也算收得过多:小于 10% 才值得为卡片让位。
  if (shrink >= laneWidth * (input.maxShrinkRatio ?? chatLaneMaxShrinkRatio)) return noChange;
  // 以分界为参照居中:左右两侧留出相同距离;放不下时距离自然收成 0。
  // 收窄后列会重新居中,左缘右移 shrink/2,要从左移量里扣掉。
  const width = laneWidth - shrink;
  const targetLeft = laneLimitLeft + (region - width) / 2;
  return { shift: laneLeft + shrink / 2 - targetLeft, shrink };
}
