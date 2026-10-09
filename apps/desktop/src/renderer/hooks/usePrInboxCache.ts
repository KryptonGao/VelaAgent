import { useEffect, useSyncExternalStore } from 'react';
import { defaultPrInboxQuery, getPrInboxCache } from '../components/pr-inbox-cache';

export function usePrInboxCache() {
  const cache = getPrInboxCache(window.vela!.prInbox);
  const version = useSyncExternalStore(cache.subscribe, cache.getVersion);
  return { cache, api: cache.api, version };
}

/**
 * Keep PR data fresh from app start, whichever page is open and whether or not the user is typing,
 * and preload the details of PRs not opened yet so clicking one renders from cache.
 * Only a hidden window pauses it; becoming visible again refreshes right away.
 */
export function usePrInboxBackgroundRefresh(enabled: boolean) {
  useEffect(() => {
    const source = window.vela?.prInbox;
    if (!enabled || !source) return;
    const cache = getPrInboxCache(source);
    let disposed = false; let idle: number | null = null;
    const isVisible = () => !disposed && document.visibilityState === 'visible';
    const tick = () => {
      if (!isVisible() || idle !== null) return;
      // Idle callbacks only wait for a free frame; the timeout keeps refreshes going during continuous interaction.
      idle = window.requestIdleCallback(() => {
        idle = null;
        void cache.warm(defaultPrInboxQuery)
          .then(() => cache.preload(defaultPrInboxQuery, isVisible))
          .then(() => cache.refreshIdle(isVisible));
      }, { timeout: 2_000 });
    };
    const start = window.setTimeout(tick, 3_000);
    const timer = window.setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      disposed = true; clearTimeout(start); clearInterval(timer); if (idle !== null) window.cancelIdleCallback(idle);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled]);
}
