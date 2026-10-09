import type { UpdateState, UpdatesApi } from "@vela/shared";
import { useEffect, useState } from "react";

/** 订阅主进程持有的更新状态；非桌面环境（浏览器预览）没有更新接口，返回空。 */
export function useUpdates(): { state: UpdateState | null; api: UpdatesApi | undefined } {
  const api = window.vela?.updates;
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.subscribe(next => { if (active) setState(next); });
    void api.getState().then(next => { if (active) setState(current => current ?? next); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, [api]);
  return { state, api };
}

/** 把 `{0}`、`{1}` 占位符替换成参数。 */
export function fillTemplate(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => String(args[Number(index)] ?? match));
}
