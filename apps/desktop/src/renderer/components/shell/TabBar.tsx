import { motion } from 'framer-motion';
import { activeAgentCount, taskCounts } from '../../lib/derive';
import { cn } from '../../lib/cn';
import { useApp, type TabId } from '../../store';
import { StatusDot, Tag } from '../ui/badges';
import { TABS } from './tabs';

function Badges({ tab }: { tab: TabId }) {
  const tracker = useApp((s) => s.tracker);
  if (!tracker) return null;
  if (tab === 'task-board') {
    const c = taskCounts(tracker.subtasks);
    return (
      <>
        {c.review > 0 ? (
          <Tag color="var(--warning)" className="font-mono" aria-label={`${c.review} in review`}>
            {c.review}
          </Tag>
        ) : null}
        {c.blocked > 0 ? (
          <Tag color="var(--danger)" className="font-mono" aria-label={`${c.blocked} blocked`}>
            {c.blocked}
          </Tag>
        ) : null}
      </>
    );
  }
  if (tab === 'agent-hub') {
    const active = activeAgentCount(tracker.agents);
    return active > 0 ? (
      <Tag color="var(--success)" className="font-mono">
        <StatusDot color="var(--success)" pulse />
        {active}
      </Tag>
    ) : null;
  }
  return null; // Terminal session count arrives with M8.
}

export function TabBar() {
  const activeTab = useApp((s) => s.activeTab);
  const setActiveTab = useApp((s) => s.setActiveTab);
  return (
    <nav
      role="tablist"
      aria-label="Views"
      className="flex h-11 shrink-0 items-stretch gap-1 border-b border-border bg-bg px-3"
    >
      {TABS.map(({ id, label, icon: Icon }, i) => {
        const selected = id === activeTab;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={selected}
            aria-controls="view-panel"
            title={`${label} (Ctrl+${i + 1})`}
            onClick={() => setActiveTab(id)}
            className={cn(
              'relative inline-flex items-center gap-2 px-3 text-[13px] transition-colors',
              selected ? 'text-text' : 'text-muted hover:text-text',
            )}
          >
            <Icon size={16} aria-hidden />
            {label}
            <Badges tab={id} />
            {selected ? (
              <motion.span
                layoutId="tab-underline"
                transition={{ duration: 0.2 }}
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent"
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
