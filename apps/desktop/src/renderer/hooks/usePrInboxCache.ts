import { useEffect, useSyncExternalStore } from 'react';
import { getPrInboxCache, type PrInboxCache } from '../components/pr-inbox-cache';

export function usePrInboxCache() {
  const cache = getPrInboxCache(window.vela!.prInbox);
  const version = useSyncExternalStore(cache.subscribe, cache.getVersion);
  return { cache, api: cache.api, version };
}

/** Keep loaded PR data fresh while working elsewhere; pause when the window is hidden or input is active. */
export function usePrInboxIdleRefresh(cache: PrInboxCache) {
  useEffect(() => {
    let lastInput = Date.now(); let disposed = false; let idle: number | null = null;
    const input = () => { lastInput = Date.now(); };
    const isIdle = () => !disposed && document.visibilityState === 'visible' && Date.now() - lastInput >= 10_000;
    const tick = () => {
      if (!isIdle() || idle !== null) return;
      idle = window.requestIdleCallback(() => { idle = null; void cache.refreshIdle(isIdle); });
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    for (const event of events) window.addEventListener(event, input, { passive: true });
    document.addEventListener('visibilitychange', input);
    const timer = window.setInterval(tick, 15_000);
    return () => {
      disposed = true; clearInterval(timer); if (idle !== null) window.cancelIdleCallback(idle);
      for (const event of events) window.removeEventListener(event, input);
      document.removeEventListener('visibilitychange', input);
    };
  }, [cache]);
}
