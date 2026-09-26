import { useEffect, useRef } from "react";

/**
 * Popover / 下拉的外点与 Esc 关闭处理,与现有 dock-popover 交互一致。
 */
export function useDismissable<T extends HTMLElement>(active: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        closeRef.current();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active]);

  return ref;
}

/**
 * 对话框按 Esc 关闭。返回的 ref 挂在对话框上:多个对话框叠放时只有最上层响应,
 * 例如在账号面板上打开的登录框。
 */
export function useEscapeKey<T extends HTMLElement>(active: boolean, onEscape: () => void) {
  const ref = useRef<T>(null);
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const layers = document.querySelectorAll(".sheet-presence:not(.is-leaving)");
      const top = layers[layers.length - 1];
      if (ref.current && top && !top.contains(ref.current)) return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  return ref;
}
