import { Cpu } from 'lucide-react';
import { useMemo } from 'react';
import type { TrackerState } from '@command-center/core';
import { HydrationEmptyState } from '../../components/HydrationEmptyState';
import { McpConnect } from '../../components/McpConnect';
import { OrchestratorControls } from '../../components/run/OrchestratorControls';
import { EmptyState } from '../../components/ui/feedback';
import { isConnectedAgent, mergeLog, weekStart } from '../../lib/agent-hub';
import { useApp } from '../../store';
import { ActivityFeed } from './ActivityFeed';
import { AgentTree } from './AgentTree';
import { Lessons } from './Lessons';
import { Performance } from './Performance';
import { ProjectAgentsPanel } from './ProjectAgents';
import { ContextPreview, SharedState, TodaySummary } from './SideCards';

/** Agent Hub (UI/UX §6.3): who is doing what, and what has happened. */
export function AgentHub({ tracker }: { tracker: TrackerState }) {
  const olderLog = useApp((s) => s.olderLog);
  const olderDone = useApp((s) => s.olderDone);
  const connected = useMemo(() => tracker.agents.filter(isConnectedAgent), [tracker.agents]);
  const agentsById = useMemo(() => new Map(tracker.agents.map((a) => [a.id, a])), [tracker.agents]);
  const log = useMemo(() => mergeLog(tracker.agent_log, olderLog), [tracker.agent_log, olderLog]);
  // The week's counts are complete only once the loaded log reaches back past Monday (or the log is exhausted).
  const oldest = log[log.length - 1]?.timestamp;
  const truncated =
    !olderDone.includes('all') &&
    oldest !== undefined &&
    Date.parse(oldest) >= weekStart(new Date()).getTime();

  if (connected.length === 0) {
    return (
      <section className="flex h-full flex-col gap-4 overflow-auto p-6">
        <h1 className="font-display text-[18px] font-semibold">Agent Hub</h1>
        <ProjectAgentsPanel />
        <EmptyState
          icon={Cpu}
          title="No agents connected"
          help="Add the MCP server to Claude Code and it registers itself on its first call."
        />
        <McpConnect />
        {tracker.milestones.length === 0 ? <HydrationEmptyState /> : null}
      </section>
    );
  }

  return (
    <section aria-label="Agent Hub" className="grid h-full min-h-0 grid-cols-[340px_minmax(0,1fr)]">
      <h1 className="sr-only">Agent Hub</h1>
      <div
        className="flex min-h-0 flex-col gap-3 overflow-auto border-r border-border p-3"
        data-hub-left
      >
        <section
          aria-label="Orchestrator"
          className="rounded-lg border border-border bg-surface p-3"
          data-orchestrator-card
        >
          <h2 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
            Orchestrator
          </h2>
          <OrchestratorControls />
        </section>
        <ProjectAgentsPanel />
        <AgentTree agents={tracker.agents} />
        <SharedState tracker={tracker} />
        <ContextPreview tracker={tracker} />
        <TodaySummary tracker={tracker} agents={agentsById} />
        <details>
          <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
            Connect another agent
          </summary>
          <div className="mt-3">
            <McpConnect />
          </div>
        </details>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3" data-hub-right>
        <ActivityFeed tracker={tracker} />
        <Lessons lessons={tracker.lessons_learned} />
        <Performance log={log} agents={agentsById} truncated={truncated} />
      </div>
    </section>
  );
}
