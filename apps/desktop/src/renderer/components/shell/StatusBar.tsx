import { useEffect, useState, type ReactNode } from 'react';
import type { WebhookStatus } from '../../../shared/ipc';
import { activeAgentCount, taskCounts } from '../../lib/derive';
import { useApp } from '../../store';

function Segment({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-1.5 hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}

export function StatusBar() {
  const project = useApp((s) => s.project);
  const tracker = useApp((s) => s.tracker);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const [hook, setHook] = useState<WebhookStatus | null>(null);
  useEffect(() => void window.api.webhook.status().then(setHook), [project?.root]);
  const counts = tracker ? taskCounts(tracker.subtasks) : null;
  const agents = tracker?.agents ?? [];

  return (
    <footer className="flex h-6 shrink-0 items-center gap-1 border-t border-border bg-surface px-2 font-mono text-[11px] text-muted">
      <Segment>command-center.db · WAL</Segment>
      {hook ? (
        <Segment onClick={() => setActiveTab('agent-hub')}>
          Webhook :{hook.port} {hook.running ? '● running' : '○ ' + (hook.error ?? 'stopped')}
        </Segment>
      ) : null}
      <Segment onClick={() => setActiveTab('agent-hub')}>
        Agents {activeAgentCount(agents)} active / {agents.length}
      </Segment>
      <Segment onClick={() => setActiveTab('task-board')}>Review {counts?.review ?? 0}</Segment>
      <Segment onClick={() => setActiveTab('task-board')}>Blocked {counts?.blocked ?? 0}</Segment>
      <span className="flex-1" />
      <span className="px-1.5" title={project?.dbPath ?? undefined}>
        v{project?.appVersion ?? '—'}
      </span>
    </footer>
  );
}
