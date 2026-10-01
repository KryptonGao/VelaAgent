import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { tr } from "../locale";
import { useReducedMotion } from "../hooks/useMotionPresence";
import { CloseIcon } from "./icons";
import {
  CLICK_SLOP,
  MOMENTUM_MIN_VELOCITY,
  ZOOM_STEP,
  anchorPoint,
  arrowIntent,
  clamp,
  clampOffset,
  doubleClickScale,
  glideTarget,
  isSettled,
  nextIndex,
  panByKey,
  panLimits,
  releaseVelocity,
  rubberbandOffset,
  scaleTolerance,
  shouldRecenter,
  springStep,
  thumbTransform,
  wheelZoomFactor,
  zoomAround,
  zoomBounds,
  type Point,
  type PointerSample,
  type Rect,
  type Size,
  type SpringState,
  type ViewerTransform,
} from "./image-viewer";

export interface ViewerImage {
  src: string;
  alt: string;
}

export interface ImageViewerRequest {
  images: ViewerImage[];
  /** 打开时定位到第几张。 */
  index: number;
  /** 缩略图矩形;进出场动画从它出发、回到它,拿不到就只淡入淡出。 */
  origin: Rect | null;
  /** 缩略图元素;关闭后把焦点还回去。 */
  focusTarget: HTMLElement | null;
}

interface Springs {
  scale: SpringState;
  x: SpringState;
  y: SpringState;
}

/** 会被查看器吞掉的滚动键:挡住背后的对话流滚动。 */
const SCROLL_KEYS = new Set([" ", "Spacebar", "PageUp", "PageDown", "Home", "End"]);

type Motion =
  /** 三个弹簧各自独立:开场/退场、惯性滑行、回弹、复位。 */
  | { kind: "move"; springs: Springs; target: ViewerTransform; onSettled?: () => void }
  /** 只弹比例,平移量由锚点推出:滚轮、双击、按钮的定点缩放。 */
  | { kind: "zoom"; springs: Springs; target: number; base: ViewerTransform; anchor: Point; onSettled?: () => void };

/**
 * 全屏图片查看器。图片按视口适配居中,滚轮定点缩放、拖动平移(越界阻尼、松手带惯性),
 * 双击在适配与放大之间切换。所有变换逐帧写进 DOM,不经过 React 渲染,拖动时不会掉帧。
 */
export function ImageViewer({ request, onClose }: { request: ImageViewerRequest; onClose: () => void }) {
  const reducedMotion = useReducedMotion();
  const count = request.images.length;
  const [index, setIndex] = useState(() => clamp(request.index, 0, Math.max(0, count - 1)));
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(100);
  // 缩放区间的百分比形式:按钮的可用状态直接用它判断,避免在 JSX 里重复推算。
  const [zoomRange, setZoomRange] = useState({ min: 100, max: 800 });
  const [hint, setHint] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // 已经应用过变换的图片序号:-1 表示当前图片还没开始布局。
  const startedRef = useRef(-1);
  const indexRef = useRef(index);
  const imageSizeRef = useRef<Size>({ width: 1, height: 1 });
  const fitRef = useRef(1);
  const transformRef = useRef<ViewerTransform>({ scale: 1, x: 0, y: 0 });
  const motionRef = useRef<Motion | null>(null);
  const frameRef = useRef(0);
  const lastFrameRef = useRef(0);
  const percentRef = useRef(0);
  const hintRef = useRef(true);
  const closingRef = useRef(false);
  const closedRef = useRef(false);
  const closeTimerRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    limits: Point;
    moved: number;
    onImage: boolean;
  } | null>(null);
  const samplesRef = useRef<PointerSample[]>([]);

  const current = request.images[index] ?? request.images[0];

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      // 关闭后焦点回到缩略图,否则会掉到 body 上,键盘用户找不到刚才的位置。
      const target = request.focusTarget;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [request]);

  useEffect(() => {
    if (closingRef.current) return;
    const timer = window.setTimeout(hideHint, 5200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  // 换图时丢掉上一张的缩放,等新图加载完成后重新适配。
  // 必须排在下面那次「补检查」之前:换图提交时缓存命中的话,先重置再开始布局。
  useLayoutEffect(() => {
    if (indexRef.current === index) return;
    indexRef.current = index;
    stopMotion();
    startedRef.current = -1;
    transformRef.current = { scale: 1, x: 0, y: 0 };
    imageSizeRef.current = { width: 1, height: 1 };
    setStatus("loading");
  }, [index]);

  useLayoutEffect(() => {
    // data: URL 命中缓存时 load 事件不会再来,提交后补一次检查。
    const node = imgRef.current;
    if (node?.complete && node.naturalWidth > 0) beginOpen({ width: node.naturalWidth, height: node.naturalHeight });
  }, [index]);

  useEffect(() => {
    // 挂在根节点而不是图片层:光标停在悬浮控件上时滚轮也应该继续缩放。
    const node = rootRef.current;
    if (!node) return;
    // React 把 wheel 监听挂成 passive,只能自己接一个才能 preventDefault。
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (startedRef.current < 0 || closingRef.current) return;
      const image = imageSizeRef.current;
      const viewport = viewportSize();
      const bounds = zoomBounds(image, viewport);
      const before = transformRef.current;
      const wasFit = shouldRecenter(before.scale, fitRef.current);
      const scale = wasFit ? bounds.min : clamp(before.scale, bounds.min, bounds.max);
      const offset = wasFit ? { x: 0, y: 0 } : clampOffset(before, panLimits(image, scale, viewport));
      fitRef.current = bounds.min;
      setZoomRange({ min: Math.max(1, Math.round(bounds.min * 100)), max: Math.max(1, Math.round(bounds.max * 100)) });
      stopMotion();
      transformRef.current = { scale, x: offset.x, y: offset.y };
      writeTransform();
      updatePercent();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (closingRef.current) {
        event.stopPropagation();
        return;
      }
      // 模态层:带命令键的组合键交给查看器吞掉,免得同时切换侧栏、设置页。
      if (event.metaKey || event.ctrlKey || event.altKey) {
        event.stopPropagation();
        return;
      }
      if (event.key === "Tab") {
        trapTab(event);
        return;
      }
      // 查看器是模态层:翻页键、空格这类滚动键不能透到背后的对话流。
      if (SCROLL_KEYS.has(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_" || event.key === "0") {
        event.preventDefault();
        if (event.key === "0") resetZoom();
        else animateScale(transformRef.current.scale * (event.key === "-" || event.key === "_" ? 1 / ZOOM_STEP : ZOOM_STEP), { x: 0, y: 0 });
        return;
      }
      const direction = event.key === "ArrowLeft" ? { x: -1, y: 0 }
        : event.key === "ArrowRight" ? { x: 1, y: 0 }
          : event.key === "ArrowUp" ? { x: 0, y: -1 }
            : event.key === "ArrowDown" ? { x: 0, y: 1 }
              : null;
      if (!direction) return;
      event.preventDefault();
      const bounds = zoomBounds(imageSizeRef.current, viewportSize());
      const horizontal = direction.x !== 0;
      if (arrowIntent(transformRef.current.scale, bounds) === "pan" || (horizontal && count < 2)) {
        panByArrow(direction);
      } else if (horizontal) {
        step(direction.x);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  function viewportSize(): Size {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect && rect.width > 1 && rect.height > 1) return { width: rect.width, height: rect.height };
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function writeTransform(): void {
    const node = imgRef.current;
    if (!node) return;
    const { scale, x, y } = transformRef.current;
    // 图片用 left/top: 50% 对齐容器中心,再让 -50% 的位移把它自己的中心挪到那里;
    // 之后才是缩放与平移,于是 x/y 始终是「图片中心相对视口中心的偏移」。
    node.style.transform = `translate(-50%, -50%) translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  }

  function updatePercent(): void {
    const next = Math.max(1, Math.round(transformRef.current.scale * 100));
    if (next === percentRef.current) return;
    percentRef.current = next;
    setPercent(next);
  }

  function hideHint(): void {
    if (!hintRef.current) return;
    hintRef.current = false;
    setHint(false);
  }

  function springsFrom(transform: ViewerTransform, velocity: Point = { x: 0, y: 0 }): Springs {
    return {
      scale: { value: transform.scale, velocity: 0 },
      x: { value: transform.x, velocity: velocity.x },
      y: { value: transform.y, velocity: velocity.y },
    };
  }

  function stopMotion(): void {
    motionRef.current = null;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    lastFrameRef.current = 0;
  }

  function startMotion(motion: Motion): void {
    motionRef.current = motion;
    lastFrameRef.current = 0;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
  }

  /** 弹簧推进:与帧率无关,中途接管时从当前值和当前速度重新定目标,不会跳变。 */
  function tick(now: number): void {
    const motion = motionRef.current;
    if (!motion) {
      frameRef.current = 0;
      lastFrameRef.current = 0;
      return;
    }
    const dt = lastFrameRef.current > 0 ? (now - lastFrameRef.current) / 1000 : 1 / 60;
    lastFrameRef.current = now;
    const image = imageSizeRef.current;
    const viewport = viewportSize();
    const scale = springStep(motion.springs.scale, motion.kind === "zoom" ? motion.target : motion.target.scale, dt);
    let x: SpringState;
    let y: SpringState;
    let settled: boolean;
    if (motion.kind === "zoom") {
      const anchored = zoomAround(motion.base, scale.value, motion.anchor);
      const offset = clampOffset(anchored, panLimits(image, scale.value, viewport));
      x = { value: offset.x, velocity: 0 };
      y = { value: offset.y, velocity: 0 };
      settled = isSettled(scale, motion.target, scaleTolerance(motion.target));
    } else {
      x = springStep(motion.springs.x, motion.target.x, dt);
      y = springStep(motion.springs.y, motion.target.y, dt);
      settled = isSettled(scale, motion.target.scale, scaleTolerance(motion.target.scale))
        && isSettled(x, motion.target.x, 0.25)
        && isSettled(y, motion.target.y, 0.25);
    }
    motion.springs = { scale, x, y };
    transformRef.current = { scale: scale.value, x: x.value, y: y.value };
    writeTransform();
    updatePercent();
    if (!settled) {
      frameRef.current = requestAnimationFrame(tick);
      return;
    }
    motionRef.current = null;
    frameRef.current = 0;
    lastFrameRef.current = 0;
    // 收尾对齐到目标值,不留肉眼看不出的偏差。
    transformRef.current = motion.kind === "zoom"
      ? { scale: motion.target, x: x.value, y: y.value }
      : { ...motion.target };
    writeTransform();
    updatePercent();
    motion.onSettled?.();
  }

  /** 图片解码完成后才开始布局:第一张从缩略图飞出来,换图则淡入并重新适配。 */
  function beginOpen(size: Size): void {
    if (startedRef.current === index || closingRef.current) return;
    const first = startedRef.current < 0;
    startedRef.current = index;
    imageSizeRef.current = size;
    const viewport = viewportSize();
    const bounds = zoomBounds(size, viewport);
    fitRef.current = bounds.min;
    setZoomRange({ min: Math.max(1, Math.round(bounds.min * 100)), max: Math.max(1, Math.round(bounds.max * 100)) });
    const fit: ViewerTransform = { scale: bounds.min, x: 0, y: 0 };
    const origin = first ? request.origin : null;
    const from = origin && !reducedMotion ? thumbTransform(origin, size, viewport) : fit;
    stopMotion();
    transformRef.current = from;
    writeTransform();
    updatePercent();
    setStatus("ready");
    if (from.scale !== fit.scale || from.x !== 0 || from.y !== 0) {
      startMotion({ kind: "move", springs: springsFrom(from), target: fit });
    }
  }

  function resolveOrigin(): Rect | null {
    const node = request.focusTarget;
    if (!node?.isConnected) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return rect;
  }

  function finishClose(): void {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }

  function dismiss(): void {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    stopMotion();
    const origin = resolveOrigin();
    // 退场动画可能因为元素被卸载而收不到结束事件,留一个兜底卸载时间。
    closeTimerRef.current = window.setTimeout(finishClose, 620);
    if (!origin || reducedMotion || startedRef.current < 0) {
      window.setTimeout(finishClose, reducedMotion ? 0 : 190);
      return;
    }
    startMotion({
      kind: "move",
      springs: springsFrom(transformRef.current),
      target: thumbTransform(origin, imageSizeRef.current, viewportSize()),
      onSettled: finishClose,
    });
  }

  function animateScale(nextScale: number, anchor: Point): void {
    const image = imageSizeRef.current;
    const bounds = zoomBounds(image, viewportSize());
    const base = { ...transformRef.current };
    const scale = clamp(nextScale, bounds.min, bounds.max);
    if (Math.abs(scale - base.scale) < 1e-4) return;
    hideHint();
    if (shouldRecenter(scale, bounds.min)) {
      startMotion({ kind: "move", springs: springsFrom(base), target: { scale, x: 0, y: 0 } });
      return;
    }
    startMotion({ kind: "zoom", springs: springsFrom(base), target: scale, base, anchor });
  }

  function resetZoom(): void {
    hideHint();
    const bounds = zoomBounds(imageSizeRef.current, viewportSize());
    startMotion({
      kind: "move",
      springs: springsFrom(transformRef.current),
      target: { scale: bounds.min, x: 0, y: 0 },
    });
  }

  function panByArrow(direction: Point): void {
    const image = imageSizeRef.current;
    const viewport = viewportSize();
    const current = transformRef.current;
    const target = panByKey(current, direction, panLimits(image, current.scale, viewport));
    startMotion({
      kind: "move",
      springs: springsFrom(current),
      target: { scale: current.scale, x: target.x, y: target.y },
    });
  }

  function step(delta: number): void {
    if (count < 2) return;
    hideHint();
    stopMotion();
    setIndex((value) => nextIndex(value, delta, count));
  }

  function onWheel(event: WheelEvent): void {
    if (closingRef.current || startedRef.current < 0) return;
    // 查看器里滚轮只用来缩放,不能再滚到背后的对话流。
    event.preventDefault();
    const image = imageSizeRef.current;
    const viewport = viewportSize();
    const rect = stageRef.current?.getBoundingClientRect()
      ?? { left: 0, top: 0, width: viewport.width, height: viewport.height };
    const bounds = zoomBounds(image, viewport);
    if (bounds.max - bounds.min < 1e-4) return;
    const factor = wheelZoomFactor(event.deltaY, event.deltaMode, viewport.height);
    const before = transformRef.current;
    stopMotion();
    const scale = clamp(before.scale * factor, bounds.min, bounds.max);
    const anchored = zoomAround(before, scale, anchorPoint(event.clientX, event.clientY, rect));
    // 缩到适配比例时居中:图片已经完整可见,再停在偏心位置没有意义。
    const offset = shouldRecenter(scale, bounds.min)
      ? { x: 0, y: 0 }
      : clampOffset(anchored, panLimits(image, scale, viewport));
    transformRef.current = { scale, x: offset.x, y: offset.y };
    writeTransform();
    updatePercent();
    hideHint();
  }

  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || closingRef.current || startedRef.current < 0) return;
    const stage = stageRef.current;
    if (!stage || status !== "ready") return;
    // 直接接管当前呈现值:打开动画或缩放动画还没结束也能抓住图片。
    stopMotion();
    stage.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transformRef.current.x,
      originY: transformRef.current.y,
      limits: panLimits(imageSizeRef.current, transformRef.current.scale, viewportSize()),
      moved: 0,
      onImage: event.target === imgRef.current,
    };
    samplesRef.current = [{ t: performance.now(), x: event.clientX, y: event.clientY }];
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    const next = rubberbandOffset({ x: drag.originX + dx, y: drag.originY + dy }, drag.limits, viewportSize());
    transformRef.current = { scale: transformRef.current.scale, x: next.x, y: next.y };
    writeTransform();
    const samples = samplesRef.current;
    samples.push({ t: performance.now(), x: event.clientX, y: event.clientY });
    if (samples.length > 6) samples.shift();
    if (drag.moved > CLICK_SLOP) hideHint();
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const stage = stageRef.current;
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (drag.moved <= CLICK_SLOP) {
      // 点图片本身不关闭,点空白处关闭。
      if (!drag.onImage) dismiss();
      return;
    }
    const image = imageSizeRef.current;
    const viewport = viewportSize();
    const position = transformRef.current;
    const velocity = releaseVelocity(samplesRef.current);
    const moving = Math.hypot(velocity.x, velocity.y) >= MOMENTUM_MIN_VELOCITY;
    const target = glideTarget(position, moving ? velocity : { x: 0, y: 0 }, panLimits(image, position.scale, viewport));
    startMotion({
      kind: "move",
      springs: springsFrom(position, moving ? velocity : { x: 0, y: 0 }),
      target: { scale: position.scale, x: target.x, y: target.y },
    });
  }

  function onStageDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (closingRef.current || startedRef.current < 0) return;
    const stage = stageRef.current;
    if (!stage) return;
    event.preventDefault();
    const image = imageSizeRef.current;
    const bounds = zoomBounds(image, viewportSize());
    const next = doubleClickScale(transformRef.current.scale, bounds);
    const anchor = next === bounds.min
      ? { x: 0, y: 0 }
      : anchorPoint(event.clientX, event.clientY, stage.getBoundingClientRect());
    animateScale(next, anchor);
  }

  function trapTab(event: KeyboardEvent): void {
    const root = rootRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled])"));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !root.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !root.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  function stopPropagation(event: { stopPropagation: () => void }): void {
    event.stopPropagation();
  }

  if (!current) return null;

  return createPortal(
    <div
      ref={rootRef}
      className={`image-viewer${open ? " is-open" : ""}${closingRef.current ? " is-leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("图片查看器", "Image viewer")}
      tabIndex={-1}
    >
      <div
        ref={stageRef}
        className="image-viewer-stage"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onDoubleClick={onStageDoubleClick}
      >
        {status === "failed" ? (
          <p className="image-viewer-error">{tr("这张图片无法显示", "This image could not be displayed")}</p>
        ) : (
          <img
            key={index}
            ref={imgRef}
            className={`image-viewer-image${status === "ready" ? " is-ready" : ""}`}
            src={current.src}
            alt={current.alt}
            draggable={false}
            onLoad={(event) => beginOpen({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setStatus("failed")}
          />
        )}
      </div>
      {count > 1 && status !== "failed" ? (
        <>
          <ViewerNavButton className="is-prev" label={tr("上一张", "Previous image")} onClick={() => step(-1)}>
            <ChevronIcon direction="left" />
          </ViewerNavButton>
          <ViewerNavButton className="is-next" label={tr("下一张", "Next image")} onClick={() => step(1)}>
            <ChevronIcon direction="right" />
          </ViewerNavButton>
        </>
      ) : null}
      <div className="image-viewer-chrome" onPointerDown={stopPropagation} onDoubleClick={stopPropagation}>
        <button
          className="image-viewer-close"
          type="button"
          aria-label={tr("关闭查看器", "Close viewer")}
          title={tr("关闭 (Esc)", "Close (Esc)")}
          onClick={dismiss}
        >
          <CloseIcon size={14} />
        </button>
        <div className="image-viewer-controls">
          <button
            className="image-viewer-action"
            type="button"
            disabled={percent <= zoomRange.min}
            aria-label={tr("缩小", "Zoom out")}
            title={tr("缩小 (−)", "Zoom out (−)")}
            onClick={() => animateScale(transformRef.current.scale / ZOOM_STEP, { x: 0, y: 0 })}
          >
            <ZoomIcon direction="out" />
          </button>
          <button
            className="image-viewer-percent"
            type="button"
            aria-label={tr("重置为适应窗口", "Reset to fit")}
            title={tr("重置为适应窗口 (0)", "Reset to fit (0)")}
            onClick={resetZoom}
          >
            {percent}%
          </button>
          <button
            className="image-viewer-action"
            type="button"
            disabled={percent >= zoomRange.max}
            aria-label={tr("放大", "Zoom in")}
            title={tr("放大 (+)", "Zoom in (+)")}
            onClick={() => animateScale(transformRef.current.scale * ZOOM_STEP, { x: 0, y: 0 })}
          >
            <ZoomIcon direction="in" />
          </button>
          {count > 1 ? (
            <>
              <span className="image-viewer-divider" aria-hidden="true" />
              <span className="image-viewer-counter">{tr(`${index + 1} / ${count}`, `${index + 1} / ${count}`)}</span>
            </>
          ) : null}
        </div>
      </div>
      <p className={`image-viewer-hint${hint ? "" : " is-hidden"}`} aria-hidden="true">
        {count > 1
          ? tr("滚轮缩放 · 拖动平移 · ← → 切换图片", "Scroll to zoom · Drag to pan · ← → switch image")
          : tr("滚轮缩放 · 拖动平移", "Scroll to zoom · Drag to pan")}
      </p>
    </div>,
    document.body,
  );
}

function ViewerNavButton({ className, label, onClick, children }: {
  className: string;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`image-viewer-nav ${className}`}
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ZoomIcon({ direction }: { direction: "in" | "out" }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
      <path d="M10.5 7.5v6" />
      {direction === "in" ? <path d="M7.5 10.5h6" /> : null}
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === "left" ? "m14.5 6-6 6 6 6" : "m9.5 6 6 6-6 6"} />
    </svg>
  );
}
