import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMotionPresence, useReducedMotion } from "../hooks/useMotionPresence";
import { reconcileMotionItems, type MotionEntry } from "./list-motion";

/** Snapshot only committed content; rapid changes replace the outgoing layer. */
export function ContentSwap({ motionKey, children, className = "", direction = 0, exitMs = 140, inline = false, hideWhenEmpty = false }: {
  motionKey: string | number; children: ReactNode; className?: string;
  direction?: number; exitMs?: number; inline?: boolean; hideWhenEmpty?: boolean;
}) {
  const reduced = useReducedMotion();
  const committed = useRef({ key: motionKey, children });
  const [frame, setFrame] = useState<{ key: string | number; outgoing: typeof committed.current | null }>({ key: motionKey, outgoing: null });
  if (frame.key !== motionKey) setFrame({ key: motionKey, outgoing: reduced ? null : committed.current });
  useLayoutEffect(() => { committed.current = { key: motionKey, children }; });
  useLayoutEffect(() => {
    if (!frame.outgoing) return;
    if (reduced) { setFrame((current) => ({ ...current, outgoing: null })); return; }
    const timer = window.setTimeout(() => setFrame((current) => ({ ...current, outgoing: null })), exitMs + 32);
    return () => window.clearTimeout(timer);
  }, [frame.key, frame.outgoing, reduced, exitMs]);
  if (hideWhenEmpty && children == null && (!frame.outgoing || reduced)) return null;
  const Element = inline ? "span" : "div";
  return <Element className={`content-swap ${className}`} style={{
    "--swap-direction": direction, "--swap-exit-ms": `${exitMs}ms`,
  } as CSSProperties}>
    <Element className="content-swap-current" key={motionKey}>{children}</Element>
    {frame.outgoing && !reduced ? <Element className="content-swap-outgoing" key={frame.outgoing.key}
      inert aria-hidden="true">{frame.outgoing.children}</Element> : null}
  </Element>;
}

/** Animate content arrival/replacement without remounting editors or scroll containers. */
export function useContentArrival(key: string, duration = 150, offset = 2) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (reduced) return;
    const animation = ref.current?.animate([
      { opacity: 0, transform: `translateY(${offset}px)` },
      { opacity: 1, transform: "none" },
    ], { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    return () => animation?.cancel();
  }, [key, duration, offset, reduced]);
  return ref;
}

export function MotionList<T>({ items, keyOf, children, className = "", horizontal = false }: {
  items: readonly T[]; keyOf: (item: T) => string; children: (item: T) => ReactNode;
  className?: string; horizontal?: boolean;
}) {
  const reduced = useReducedMotion();
  const [source, setSource] = useState(items);
  const [entries, setEntries] = useState<MotionEntry<T>[]>(() => items.map((item) => ({ key: keyOf(item), item, present: true, entering: false })));
  if (source !== items) {
    setSource(items);
    setEntries((current) => reconcileMotionItems(current, items, keyOf));
  }
  const root = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const animations = useRef(new Map<string, Animation>());
  const layout = useRef({ order: "", width: 0 });
  useLayoutEffect(() => {
    if (entries.some((entry) => entry.present)) lastHeight.current = root.current?.offsetHeight ?? 0;
    const rootBox = root.current?.getBoundingClientRect();
    const order = JSON.stringify(entries.filter((entry) => entry.present).map((entry) => entry.key));
    // Pruning a collapsed exit must not replay the movement that already happened.
    const changed = order !== layout.current.order;
    const resized = Math.abs((rootBox?.width ?? 0) - layout.current.width) > 1;
    layout.current = { order, width: rootBox?.width ?? 0 };
    const nodes = [...(root.current?.children ?? [])] as HTMLElement[];
    // Read all layout/active translations first, then write animations (FLIP).
    const measurements = nodes.map((node) => {
      const key = node.dataset.motionKey!;
      const rect = node.getBoundingClientRect();
      const transform = getComputedStyle(node).transform;
      const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);
      const tx = matrix?.m41 ?? 0, ty = matrix?.m42 ?? 0;
      // List-relative coordinates ignore scrolling and movement of ancestor surfaces.
      const next = { x: rect.left - tx - (rootBox?.left ?? 0), y: rect.top - ty - (rootBox?.top ?? 0) };
      const old = positions.current.get(key);
      return { key, node, next, dx: old ? old.x + tx - next.x : 0, dy: old ? old.y + ty - next.y : 0 };
    });
    for (const { key, node, next, dx, dy } of measurements) {
      if (changed || reduced || resized) {
        animations.current.get(key)?.cancel();
        animations.current.delete(key);
      }
      if (changed && !reduced && !resized && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
        const animation = node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
        animations.current.set(key, animation);
      }
      positions.current.set(key, next);
    }
    const keys = new Set(measurements.map(({ key }) => key));
    for (const key of positions.current.keys()) if (!keys.has(key)) {
      positions.current.delete(key); animations.current.get(key)?.cancel(); animations.current.delete(key);
    }
  }, [entries, reduced]);
  useLayoutEffect(() => () => { for (const animation of animations.current.values()) animation.cancel(); }, []);
  return <div ref={root} className={`motion-list${horizontal ? " is-horizontal" : ""} ${className}`}
    style={horizontal && entries.length > 0 && !entries.some((entry) => entry.present) ? { minHeight: lastHeight.current } : undefined}>
    {entries.map((entry) => <MotionListItem key={entry.key} entry={entry} horizontal={horizontal}
      onRemove={() => setEntries((current) => current.filter((item) => item.key !== entry.key || item.present))}>
      {children(entry.item)}
    </MotionListItem>)}
  </div>;
}

function MotionListItem<T>({ entry, children, horizontal, onRemove }: {
  entry: MotionEntry<T>; children: ReactNode; horizontal: boolean; onRemove: () => void;
}) {
  const presence = useMotionPresence(entry.present, 140);
  const remove = useRef(onRemove);
  remove.current = onRemove;
  const ref = useRef<HTMLDivElement>(null);
  const lastBox = useRef({ left: 0, top: 0, width: 0 });
  useLayoutEffect(() => {
    if (!presence.mounted) { remove.current(); return; }
    if (entry.present && ref.current) {
      lastBox.current = { left: ref.current.offsetLeft, top: ref.current.offsetTop, width: ref.current.offsetWidth };
    }
  }, [presence.mounted, entry.present, children]);
  if (!presence.mounted) return null;
  return <div ref={ref} data-motion-key={entry.key}
    className={`motion-list-item${entry.entering ? " is-entering" : ""}${presence.closing ? " is-closing" : ""}`}
    style={horizontal && presence.closing ? lastBox.current : undefined}
    inert={presence.closing} aria-hidden={presence.closing || undefined}>
    <div className="motion-list-body">{children}</div>
  </div>;
}
