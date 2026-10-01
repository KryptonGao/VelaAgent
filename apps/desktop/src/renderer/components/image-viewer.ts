/**
 * 全屏图片查看器的几何与手势规则。
 * 组件只负责 DOM 与事件,数值(适配比例、平移边界、缩放锚点、惯性投射、弹簧)都在这里,便于单测。
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 图片的呈现变换:先按 scale 缩放(视口中心为原点),再平移 x/y 像素。 */
export interface ViewerTransform extends Point {
  scale: number;
}

/** 拖动轨迹上的一个采样点,用于估算释放速度。 */
export interface PointerSample extends Point {
  t: number;
}

/** 全屏查看时四周留出的空白,保证缩放后仍能看出图片边界。 */
export const VIEWER_PADDING = 28;
/** 相对适配尺寸允许放大的倍数;大图按适配比例算,小图至少能放到原始尺寸。 */
export const MAX_ZOOM_MULTIPLIER = 8;
/** 低于这个位移的按下—抬起按点击处理,而不是拖动。 */
export const CLICK_SLOP = 4;
/** 低于这个释放速度不做惯性滑行,避免松手后图片自己爬。 */
export const MOMENTUM_MIN_VELOCITY = 220;
/** Apple 的滚动减速率:0.998 是常规手感,越接近 1 滑得越远。 */
const DECELERATION_RATE = 0.998;
/** 滚轮像素量到缩放倍数的系数。 */
const WHEEL_SENSITIVITY = 0.0022;
/** 浏览器按行报滚轮时,一行约等于的像素高度。 */
const WHEEL_LINE_HEIGHT = 16;
/** 临界阻尼弹簧的默认响应时间(秒);Apple 的 response,不是动画时长。 */
export const SPRING_RESPONSE = 0.32;
/** 键盘与按钮的单步缩放倍数。 */
export const ZOOM_STEP = 1.4;
/** 方向键的单步平移量。 */
const KEY_PAN_STEP = 48;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 图片完整放进视口且不超过原始尺寸的缩放比例。 */
export function fitScale(image: Size, viewport: Size, padding = VIEWER_PADDING): number {
  const fitWidth = Math.max(1, viewport.width - padding * 2) / Math.max(1, image.width);
  const fitHeight = Math.max(1, viewport.height - padding * 2) / Math.max(1, image.height);
  return Math.min(fitWidth, fitHeight, 1);
}

/** 缩放区间:下限是适配比例(永远能看全),上限是适配的 8 倍且至少到原始尺寸。 */
export function zoomBounds(image: Size, viewport: Size, padding = VIEWER_PADDING): { min: number; max: number } {
  const min = fitScale(image, viewport, padding);
  return { min, max: Math.max(min * MAX_ZOOM_MULTIPLIER, 1) };
}

/**
 * 各轴允许的最大平移量。图片大于视口时边界是「图片边缘贴住视口边缘」;
 * 图片小于视口时允许在视口内自由摆放,和系统预览一致,不会把图片钉死在正中。
 */
export function panLimits(image: Size, scale: number, viewport: Size): Point {
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: Math.max(0, Math.abs(viewport.width - width) / 2),
    y: Math.max(0, Math.abs(viewport.height - height) / 2),
  };
}

export function clampOffset(offset: Point, limits: Point): Point {
  return { x: clamp(offset.x, -limits.x, limits.x), y: clamp(offset.y, -limits.y, limits.y) };
}

/** Apple 的 rubber band:越界越远跟手越少,松手后再弹回边界。 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const size = Math.max(1, dimension);
  const excess = Math.abs(overshoot);
  return Math.sign(overshoot) * (excess * size * constant) / (size + constant * excess);
}

export function rubberbandOffset(offset: Point, limits: Point, viewport: Size): Point {
  const x = offset.x > limits.x
    ? limits.x + rubberband(offset.x - limits.x, viewport.width)
    : offset.x < -limits.x
      ? -limits.x + rubberband(offset.x + limits.x, viewport.width)
      : offset.x;
  const y = offset.y > limits.y
    ? limits.y + rubberband(offset.y - limits.y, viewport.height)
    : offset.y < -limits.y
      ? -limits.y + rubberband(offset.y + limits.y, viewport.height)
      : offset.y;
  return { x, y };
}

/** 屏幕坐标换算成相对视口中心的偏移,滚轮和双击都用它当缩放锚点。 */
export function anchorPoint(clientX: number, clientY: number, stage: Rect): Point {
  return { x: clientX - (stage.left + stage.width / 2), y: clientY - (stage.top + stage.height / 2) };
}

/** 缩放时让 anchor 处的像素保持不动:先算新比例对应的平移,再由调用方夹到边界内。 */
export function zoomAround(transform: ViewerTransform, nextScale: number, anchor: Point): ViewerTransform {
  const ratio = nextScale / transform.scale;
  return {
    scale: nextScale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}

/** 滚轮一次事件的缩放倍数;按行/按页报数量的浏览器先换算成像素。 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const pixels = deltaMode === 1
    ? deltaY * WHEEL_LINE_HEIGHT
    : deltaMode === 2
      ? deltaY * Math.max(1, viewportHeight)
      : deltaY;
  // 上限夹住一次事件的最大幅度:触控板与鼠标滚轮的量级差很多,但不该一跳跳过头。
  return clamp(Math.exp(-pixels * WHEEL_SENSITIVITY), 0.5, 2);
}

/** 双击/按钮缩放的落点:已经放大过就回到适配,否则放大到 2.5 倍。 */
export function doubleClickScale(scale: number, bounds: { min: number; max: number }): number {
  return scale > bounds.min * 1.05 ? bounds.min : Math.min(bounds.max, bounds.min * 2.5);
}

/** 回到适配比例时顺便居中:缩到底还歪着会让「重置」看起来没生效。 */
export function shouldRecenter(scale: number, min: number): boolean {
  return scale <= min * 1.001;
}

/** 键盘方向键:放大时平移视野,未放大时切换图片。 */
export function arrowIntent(scale: number, bounds: { min: number; max: number }): "pan" | "navigate" {
  return scale > bounds.min * 1.05 ? "pan" : "navigate";
}

export function panByKey(offset: Point, direction: Point, limits: Point, step = KEY_PAN_STEP): Point {
  return clampOffset({ x: offset.x + direction.x * step, y: offset.y + direction.y * step }, limits);
}

/** Apple 的动量投射:按释放速度估算还要滑行多远,再夹进边界。 */
export function glideTarget(offset: Point, velocity: Point, limits: Point, decelerationRate = DECELERATION_RATE): Point {
  const project = (value: number) => (value / 1000) * decelerationRate / (1 - decelerationRate);
  return clampOffset({ x: offset.x + project(velocity.x), y: offset.y + project(velocity.y) }, limits);
}

/** 取轨迹里最近一小段的平均速度;窗口内没有更早的采样时退回最后一帧的位移。 */
export function releaseVelocity(samples: PointerSample[], windowMs = 90): Point {
  const last = samples[samples.length - 1];
  if (!last) return { x: 0, y: 0 };
  let first = last;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (last.t - sample.t > windowMs) break;
    first = sample;
  }
  if (first === last) {
    // 采样稀疏(慢速拖动)时窗口里只有最后一帧,用上一帧仍比当作静止好。
    const previous = samples[samples.length - 2];
    if (!previous) return { x: 0, y: 0 };
    first = previous;
  }
  const elapsed = (last.t - first.t) / 1000;
  if (elapsed < 0.008) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed };
}

export interface SpringState {
  value: number;
  velocity: number;
}

/**
 * 临界阻尼弹簧的解析解(Apple 的 response = 无阻尼周期)。
 * 与帧率无关,而且可以带着当前速度重新定目标,所以手势中途接管不会跳变。
 */
export function springStep(state: SpringState, target: number, dt: number, response = SPRING_RESPONSE): SpringState {
  const step = clamp(dt, 0, 0.05);
  if (step <= 0) return state;
  const omega = (2 * Math.PI) / Math.max(0.05, response);
  const delta = state.value - target;
  const boost = state.velocity + omega * delta;
  const decay = Math.exp(-omega * step);
  return {
    value: target + (delta + boost * step) * decay,
    velocity: (state.velocity - omega * boost * step) * decay,
  };
}

/** 弹簧是否已经到位:位移和速度都低于阈值就可以停掉逐帧循环。 */
export function isSettled(state: SpringState, target: number, distance: number): boolean {
  return Math.abs(state.value - target) < distance && Math.abs(state.velocity) < distance * 20;
}

/** 缩放的收敛阈值按比例缩放:0.5 个像素在 6000px 宽的图上和 100px 宽的图上不是一回事。 */
export function scaleTolerance(target: number): number {
  return Math.max(0.0004, Math.abs(target) * 0.0015);
}

/** 开场/退场动画的起点:缩略图矩形换成同样的变换(cover 口径,让它从缩略图的样子长出来)。 */
export function thumbTransform(origin: Rect, image: Size, viewport: Size): ViewerTransform {
  return {
    scale: Math.max(origin.width / Math.max(1, image.width), origin.height / Math.max(1, image.height)),
    x: origin.left + origin.width / 2 - viewport.width / 2,
    y: origin.top + origin.height / 2 - viewport.height / 2,
  };
}

export function nextIndex(index: number, delta: number, count: number): number {
  if (count < 1) return 0;
  return ((index + delta) % count + count) % count;
}
