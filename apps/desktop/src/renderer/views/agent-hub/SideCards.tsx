import { Copy } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { Agent, TrackerState } from '@command-center/core';
import { Button } from '../../components/ui/button';
import { StatusDot } from '../../components/ui/badges';
import { contextString, lastChangeAt, middleTruncate, todaySummary } from '../../lib/agent-hub';
import { useNow } from '../../lib/hooks';
import { relativeTime } from '../../lib/time';
import { useApp } from '../../store';
import { toast } from '../../toast';

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.info(`${what} copied`))
    .catch(() => toast.error('Could not copy to the clipboard'));
}

function Card({ title, children, label }: { title: string; children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="rounded-lg border border-border bg-surface p-3">
      <h2 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** DB path, sync status, entity counts and the age of the latest change. */
export function SharedState({ tracker }: { tracker: TrackerState }) {
  const dbPath = useApp((s) => s.project?.dbPath ?? null);
  const sync = useApp((s) => s.sync);
  const now = useNow(5_000);
  const last = lastChangeAt(tracker);
  const color =
    sync.state === 'live'
      ? 'var(--success)'
      : sync.state === 'syncing'
        ? 'var(--warning)'
        : 'var(--danger)';
  const label =
    sync.state === 'live' ? 'Live' : sync.state === 'syncing' ? 'Syncing…' : 'Disconnected';
  return (
    <Card title="Shared state" label="Shared state">
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          title={dbPath ?? undefined}
          data-db-path
        >
          {dbPath ? middleTruncate(dbPath, 34) : 'No database'}
        </span>
        {dbPath ? (
          <Button
            variant="ghost"
            aria-label="Copy database path"
            onClick={() => copy(dbPath, 'Path')}
          >
            <Copy size={12} aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[12px]">
        <StatusDot color={color} pulse={sync.state === 'syncing'} />
        {label}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
        {[
          ['Milestones', tracker.milestones.length],
          ['Tasks', tracker.subtasks.length],
          ['Log entries', tracker.agent_log.length],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md bg-surface-2 py-1.5">
            <dd className="font-mono text-[14px]">{v}</dd>
            <dt className="text-[10px] text-muted">{k}</dt>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-muted">
        Last change {last ? relativeTime(new Date(last).toISOString(), now) : 'never'}
      </p>
    </Card>
  );
}

/** What an agent gets injected as project context; updates live with the board. */
export function ContextPreview({ tracker }: { tracker: TrackerState }) {
  const text = useMemo(() => contextString(tracker), [tracker]);
  return (
    <Card title="Context injection preview" label="Context injection preview">
      <pre
        className="rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] break-words whitespace-pre-wrap"
        data-context-preview
      >
        {text}
      </pre>
      <Button className="mt-2" onClick={() => copy(text, 'Context')}>
        <Copy size={12} aria-hidden /> Copy
      </Button>
    </Card>
  );
}

export function TodaySummary({
  tracker,
  agents,
}: {
  tracker: TrackerState;
  agents: ReadonlyMap<string, Agent>;
}) {
  const s = useMemo(() => todaySummary(tracker), [tracker]);
  const total = s.contributions.reduce((n, c) => n + c.count, 0);
  return (
    <Card title="Today's summary" label="Today's summary">
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          ['Completed', s.completed, 'var(--success)'],
          ['In progress', s.inProgress, 'var(--accent)'],
          ['Blocked', s.blocked, 'var(--danger)'],
        ].map(([k, v, c]) => (
          <div key={k as string} className="rounded-md bg-surface-2 py-1.5">
            <dd className="font-mono text-[16px]" style={{ color: c as string }}>
              {v}
            </dd>
            <dt className="text-[10px] text-muted">{k}</dt>
          </div>
        ))}
      </dl>
      {total === 0 ? (
        <p className="mt-2 text-[11px] text-muted">No agent actions yet today.</p>
      ) : (
        <>
          <div
            className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2"
            role="img"
            aria-label={`Actions today by agent: ${s.contributions.map((c) => `${agents.get(c.agentId)?.name ?? c.agentId} ${c.count}`).join(', ')}`}
            data-contribution-bar
          >
            {s.contributions.map((c) => (
              <span
                key={c.agentId}
                style={{
                  width: `${(c.count / total) * 100}%`,
                  background: agents.get(c.agentId)?.color ?? 'var(--muted)',
                }}
                data-contribution={c.agentId}
              />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {s.contributions.map((c) => (
              <li key={c.agentId} className="flex items-center gap-1.5">
                <StatusDot color={agents.get(c.agentId)?.color ?? 'var(--muted)'} />
                {agents.get(c.agentId)?.name ?? c.agentId}
                <span className="font-mono text-muted">{c.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
