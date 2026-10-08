import type { ReactNode } from 'react';
import type { TrackerState } from '@command-center/core';
import { HydrationEmptyState } from '../components/HydrationEmptyState';
import { StatusDot } from '../components/ui/badges';
import type { TabId } from '../store';
import { SwimLane } from './swim-lane/SwimLane';
import { Calendar } from './calendar/Calendar';
import { AgentHub } from './agent-hub/AgentHub';
import { TaskBoard } from './task-board/TaskBoard';

// Placeholders show real counts until each view lands (M8 Terminal).

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

const VIEWS: Record<TabId, (t: TrackerState) => ReactNode> = {
  'swim-lane': (t) => <SwimLane tracker={t} />,
  'task-board': (t) => <TaskBoard tracker={t} />,
  'agent-hub': (t) => <AgentHub tracker={t} />,
  calendar: (t) => <Calendar tracker={t} />,
  terminal: () => (
    <Placeholder title="Terminal" note="Embedded terminal arrives in M8." stats={[]} />
  ),
};

export function ActiveView({ tab, tracker }: { tab: TabId; tracker: TrackerState }) {
  return <>{VIEWS[tab](tracker)}</>;
}
