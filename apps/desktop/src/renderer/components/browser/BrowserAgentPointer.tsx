import type { BrowserAgentCursor } from "@vela/shared";

/** App-owned overlay: never injected into the page or included in Agent screenshots. */
export function BrowserAgentPointer({ cursor, width, height }: {
  cursor: BrowserAgentCursor; width: number; height: number;
}) {
  const x = Math.max(0, Math.min(width - 1, cursor.x * width / cursor.viewportWidth));
  const y = Math.max(0, Math.min(height - 1, cursor.y * height / cursor.viewportHeight));
  const action = cursor.active === false ? 'idle' : cursor.kind;
  return <div className="browser-agent-overlay" aria-hidden="true">
    <div className={`browser-agent-pointer is-${action}`} style={{ transform: `translate(${x}px, ${y}px)` }}
      data-action={action}>
      {cursor.active !== false && <span key={cursor.sequence} className="browser-agent-feedback" />}
      <svg className="browser-agent-arrow" width="24" height="29" viewBox="0 0 24 29" fill="none">
        <path d="M1.5 1.5L21 17.1L12.5 18.2L8.4 26.5L1.5 1.5Z" fill="currentColor" stroke="white" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  </div>;
}
