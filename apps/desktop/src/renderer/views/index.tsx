import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TrackerState } from '@command-center/core';
import { Button } from '../components/ui/button';
import { StatusDot } from '../components/ui/badges';
import { EmptyState } from '../components/ui/feedback';
import { activeAgentCount, completedThisWeek, taskCounts } from '../lib/derive';
import { HYDRATION_PROMPT, STATUS_META, STATUS_ORDER } from '../lib/status';
import type { TabId } from '../store';
import { toast } from '../toast';

// M2 placeholders: real counts from the store, replaced view by view in M3, M5-M8.

interface Stat {
  label: string;
  value: number;
  color?: string;
}

function Placeholder({
  title,
  note,
  stats,
  empty,
}: {
  title: string;
  note: string;
  stats: Stat[];
  empty?: boolean;
}) {
  const copyPrompt = () => {
    void navigator.clipboard
      .writeText(HYDRATION_PROMPT)
      .then(() => toast.info('Hydration prompt copied'))
      .catch(() => toast.error('Could not copy to the clipboard'));
  };
  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6">
      <div>
        <h1 className="text-[18px] font-semibold">{title}</h1>
        <p className="mt-1 text-muted">{note}</p>
      </div>
      {stats.length > 0 ? (
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-surface p-3">
              <dt className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
                {s.color ? <StatusDot color={s.color} /> : null}
                {s.label}
              </dt>
              <dd className="mt-1 font-mono text-[18px]">{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {empty ? (
        <EmptyState
          icon={Inbox}
          title="No milestones yet"
          help="Hydrate this project with a manifesto and roadmap, or ask an agent to call create_milestone."
          action={<Button onClick={copyPrompt}>Copy hydration prompt</Button>}
        />
      ) : null}
    </section>
  );
}

const noMilestones = (t: TrackerState) => t.milestones.length === 0;

const VIEWS: Record<TabId, (t: TrackerState) => ReactNode> = {
  'swim-lane': (t) => (
    <Placeholder
      title="Swim Lane"
      note="Timeline arrives in M5."
      empty={noMilestones(t)}
      stats={[
        { label: 'Milestones', value: t.milestones.length },
        { label: 'Phases', value: t.phases.length },
        { label: 'Domains', value: new Set(t.milestones.map((m) => m.domain)).size },
        { label: 'Key milestones', value: t.milestones.filter((m) => m.is_key_milestone).length },
      ]}
    />
  ),
  'task-board': (t) => {
    const c = taskCounts(t.subtasks);
    return (
      <Placeholder
        title="Task Board"
        note="Kanban arrives in M3."
        empty={noMilestones(t)}
        stats={STATUS_ORDER.map((s) => ({
          label: STATUS_META[s].label,
          value: c[s],
          color: STATUS_META[s].color,
        }))}
      />
    );
  },
  'agent-hub': (t) => (
    <Placeholder
      title="Agent Hub"
      note="Agent tree and activity feed arrive in M6."
      empty={noMilestones(t)}
      stats={[
        { label: 'Agents', value: t.agents.length },
        { label: 'Active', value: activeAgentCount(t.agents), color: 'var(--success)' },
        { label: 'Log entries', value: t.agent_log.length },
      ]}
    />
  ),
  calendar: (t) => (
    <Placeholder
      title="Calendar"
      note="Weekly completion history arrives in M7."
      empty={noMilestones(t)}
      stats={[
        { label: 'Done this week', value: completedThisWeek(t.subtasks), color: 'var(--success)' },
        { label: 'Done total', value: t.subtasks.filter((s) => s.status === 'done').length },
      ]}
    />
  ),
  terminal: () => (
    <Placeholder title="Terminal" note="Embedded terminal arrives in M8." stats={[]} />
  ),
};

export function ActiveView({ tab, tracker }: { tab: TabId; tracker: TrackerState }) {
  return <>{VIEWS[tab](tracker)}</>;
}
