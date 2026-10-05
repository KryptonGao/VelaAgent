import { tr } from "../locale";
import { useSlidingTabIndicator } from "./useSlidingTabIndicator";

export type ConversationViewKey = "chat" | "trace" | "versionControl" | "usage";

const TABS: ReadonlyArray<readonly [ConversationViewKey, string, string]> = [
  ["chat", "对话", "Conversation"],
  ["trace", "轨迹", "Trace"],
  ["versionControl", "版本控制", "Version Control"],
  ["usage", "使用统计", "Usage"],
];

interface ConversationViewTabsProps {
  view: ConversationViewKey;
  showVersionControl: boolean;
  onChange: (next: ConversationViewKey) => void;
}

/** 顶部会话视图选项卡:共享下划线跟随激活项滑动,悬停激活项时向两侧展开。 */
export function ConversationViewTabs({ view, showVersionControl, onChange }: ConversationViewTabsProps) {
  const tabs = useSlidingTabIndicator({ activeKey: view });

  return (
    <nav
      ref={tabs.navRef}
      className="conversation-view-tabs"
      role="tablist"
      aria-label={tr("会话视图", "Conversation view")}
      onPointerMove={tabs.onPointerMove}
      onPointerLeave={tabs.onPointerLeave}
    >
      {TABS.filter(([key]) => key !== "versionControl" || showVersionControl).map(([key, chinese, english]) => (
        <button
          key={key}
          type="button"
          role="tab"
          data-tab-key={key}
          aria-selected={view === key}
          ref={tabs.registerTab(key)}
          onClick={() => onChange(key)}
        >
          {tr(chinese, english)}
        </button>
      ))}
      {tabs.indicator}
    </nav>
  );
}
