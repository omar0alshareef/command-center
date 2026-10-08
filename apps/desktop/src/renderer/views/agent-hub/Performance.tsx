import { useMemo } from 'react';
import type { Agent, AgentLogEntry } from '@command-center/core';
import { AgentAvatar } from '../../components/ui/agent';
import { weeklyPerformance, weekStart } from '../../lib/agent-hub';

/** Per-agent action totals and tag breakdown for the current calendar week (Monday start). */
export function Performance({ log, agents, truncated }: { log: readonly AgentLogEntry[]; agents: ReadonlyMap<string, Agent>; truncated: boolean }) {
  const rows = useMemo(() => weeklyPerformance(log), [log]);
  const from = weekStart(new Date()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <section aria-label="Agent performance this week" className="rounded-lg border border-border bg-surface p-3">
      <h2 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        Agent performance · week of {from}
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted">No agent actions this week.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" data-performance>
          {rows.map((r) => {
            const agent = agents.get(r.agentId);
            const max = Math.max(1, ...r.tags.map((t) => t.count));
            return (
              <div key={r.agentId} className="rounded-md border border-border bg-surface-2 p-2.5" data-perf-agent={r.agentId}>
                <div className="flex items-center gap-2">
                  <AgentAvatar agent={agent ?? { name: r.agentId, color: 'var(--muted)', type: 'external' }} size={20} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{agent?.name ?? r.agentId}</span>
                  <span className="font-mono text-[20px] leading-none" title="Actions this week">
                    {r.total}
                  </span>
                </div>
                <ul className="mt-2 space-y-1">
                  {r.tags.map((t) => (
                    <li key={t.tag} className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 truncate text-muted">{t.tag}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                        <span className="block h-full rounded-full" style={{ width: `${(t.count / max) * 100}%`, background: agent?.color ?? 'var(--accent)' }} />
                      </span>
                      <span className="w-5 text-right font-mono">{t.count}</span>
                    </li>
                  ))}
                  {r.tags.length === 0 ? <li className="text-[11px] text-muted">No tags</li> : null}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {truncated ? <p className="mt-2 text-[11px] text-muted">Counts cover the loaded log entries; use Load older in the feed for more.</p> : null}
    </section>
  );
}
