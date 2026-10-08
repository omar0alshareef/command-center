import { Check, Circle, X } from 'lucide-react';
import { isConnectedAgent } from '../lib/agent-hub';
import { useApp } from '../store';
import { Button } from './ui/button';

/** UI/UX §7.5: a dismissible checklist on the Swim Lane until the four setup steps are done. */
export function FirstRunCard() {
  const tracker = useApp((s) => s.tracker);
  const project = useApp((s) => s.project);
  const dismissed = useApp((s) => s.firstRunDismissed);
  const dismiss = useApp((s) => s.dismissFirstRun);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const setActiveTab = useApp((s) => s.setActiveTab);
  if (dismissed || !tracker || !project?.root) return null;

  const started = tracker.agent_log.some((e) => e.action === 'task_started');
  const steps: { done: boolean; label: string; action?: { label: string; run: () => void } }[] = [
    { done: true, label: 'Pick project folder' },
    {
      done: tracker.agents.some(isConnectedAgent),
      label: 'Add the MCP server to Claude Code',
      action: { label: 'Show command', run: () => setActiveTab('agent-hub') },
    },
    {
      done: tracker.milestones.length > 0,
      label: 'Hydrate with manifesto + roadmap',
      action: { label: 'Settings', run: () => setSettingsOpen(true) },
    },
    {
      done: started,
      label: 'Run your first task',
      action: { label: 'Task Board', run: () => setActiveTab('task-board') },
    },
  ];
  if (steps.every((s) => s.done)) return null;

  return (
    <aside
      aria-label="Getting started"
      className="mx-4 mt-3 flex items-start gap-4 rounded-lg border border-border bg-surface p-3"
    >
      <ul className="flex flex-1 flex-wrap gap-x-6 gap-y-1 text-[13px]">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            {s.done ? (
              <Check size={14} className="text-success" aria-label="done" />
            ) : (
              <Circle size={14} className="text-muted" aria-label="to do" />
            )}
            <span className={s.done ? 'text-muted line-through' : ''}>{s.label}</span>
            {!s.done && s.action ? (
              <Button variant="ghost" onClick={s.action.run}>
                {s.action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={dismiss} aria-label="Dismiss getting started">
        <X size={14} aria-hidden />
      </Button>
    </aside>
  );
}
