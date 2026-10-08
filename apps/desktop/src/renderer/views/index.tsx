import { Cpu } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TrackerState } from '@command-center/core';
import { HydrationEmptyState } from '../components/HydrationEmptyState';
import { McpConnect } from '../components/McpConnect';
import { StatusDot } from '../components/ui/badges';
import { EmptyState } from '../components/ui/feedback';
import { activeAgentCount, completedThisWeek } from '../lib/derive';
import type { TabId } from '../store';
import { TaskBoard } from './task-board/TaskBoard';

// Placeholders show real counts until each view lands (M5 Swim Lane, M6 Agent Hub, M7 Calendar, M8 Terminal).

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
  children,
}: {
  title: string;
  note: string;
  stats: Stat[];
  empty?: boolean;
  children?: ReactNode;
}) {
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
      {empty ? <HydrationEmptyState /> : null}
      {children}
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
  'task-board': (t) => <TaskBoard tracker={t} />,
  'agent-hub': (t) => {
    // The built-in operator and system agents don't count as connected agents.
    const connected = t.agents.filter((a) => a.id !== 'operator' && a.id !== 'system');
    return (
      <Placeholder
        title="Agent Hub"
        note="Agent tree and activity feed arrive in M6."
        // One big empty state at a time: with no agents, connecting one comes first.
        empty={noMilestones(t) && connected.length > 0}
        stats={[
          { label: 'Agents', value: connected.length },
          { label: 'Active', value: activeAgentCount(t.agents), color: 'var(--success)' },
          { label: 'Log entries', value: t.agent_log.length },
        ]}
      >
        {connected.length === 0 ? (
          <>
            <EmptyState
              icon={Cpu}
              title="No agents connected"
              help="Add the MCP server to Claude Code and it registers itself on its first call."
            />
            <McpConnect />
          </>
        ) : (
          <details className="max-w-3xl">
            <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
              Connect another agent
            </summary>
            <div className="mt-3">
              <McpConnect />
            </div>
          </details>
        )}
      </Placeholder>
    );
  },
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
