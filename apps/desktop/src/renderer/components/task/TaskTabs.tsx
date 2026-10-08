import { useEffect, useState } from 'react';
import type { AgentLogEntry, Lesson, TaskHistory } from '@command-center/core';
import { relativeTime } from '../../lib/time';
import { useApp } from '../../store';
import { AgentAvatar } from '../ui/agent';
import { Tag } from '../ui/badges';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/feedback';
import { Tooltip } from '../ui/overlays';
import { copyText } from './fields';

/** Fetch something per task, refetching when the task changes (`version` = its updated_at). */
function useTaskData<T>(
  load: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
  key: string,
) {
  const [state, setState] = useState<{ value: T | null; error: string | null; loading: boolean }>({
    value: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    void load().then((res) => {
      if (!alive) return;
      setState(
        res.ok
          ? { value: res.value, error: null, loading: false }
          : { value: null, error: res.error.message, loading: false },
      );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is recreated every render; `key` is the real dependency.
  }, [key]);
  return state;
}

function HistoryEntry({ entry, lesson }: { entry: AgentLogEntry; lesson: Lesson | undefined }) {
  const agent = useApp((s) => s.tracker?.agents.find((a) => a.id === entry.agent_id));
  const when = (
    <time dateTime={entry.timestamp} className="shrink-0 font-mono text-[11px] text-muted">
      {relativeTime(entry.timestamp)}
    </time>
  );
  if (lesson) {
    return (
      <li
        className="rounded-lg border p-3"
        style={{
          borderColor: 'var(--warning)',
          background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Tag color="var(--warning)">REJECTED</Tag>
          <Tooltip content={new Date(entry.timestamp).toLocaleString()}>{when}</Tooltip>
        </div>
        <p className="mt-2 font-medium">{lesson.rejection_reason}</p>
        {lesson.fix_applied ? <p className="mt-1 text-muted">Fix: {lesson.fix_applied}</p> : null}
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 py-1.5">
      {agent ? (
        <AgentAvatar agent={agent} size={20} />
      ) : (
        <span className="size-5 shrink-0 rounded-full bg-surface-3" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{agent?.name ?? entry.agent_id}</span>
          <Tag>{entry.action.replace(/_/g, ' ')}</Tag>
        </div>
        {entry.description ? <p className="mt-0.5 text-muted">{entry.description}</p> : null}
      </div>
      <Tooltip content={new Date(entry.timestamp).toLocaleString()}>{when}</Tooltip>
    </li>
  );
}

export function HistoryTab({ taskId, version }: { taskId: string; version: string }) {
  const { value, error, loading } = useTaskData<TaskHistory>(
    () => window.api.tasks.history(taskId),
    `${taskId}:${version}`,
  );
  if (loading && !value) return <Skeleton className="m-5 h-24" />;
  if (error)
    return (
      <p role="alert" className="p-5 text-danger">
        {error}
      </p>
    );
  if (!value || value.log.length === 0) return <p className="p-5 text-muted">No history yet.</p>;
  return (
    <ul className="flex flex-col gap-1 p-5">
      {value.log.map((e) => (
        // The reject log entry and its lesson are written in the same transaction with one timestamp.
        <HistoryEntry
          key={e.id}
          entry={e}
          lesson={
            e.action === 'task_rejected'
              ? value.lessons.find((l) => l.created_at === e.timestamp)
              : undefined
          }
        />
      ))}
    </ul>
  );
}

export function ContextTab({ taskId, version }: { taskId: string; version: string }) {
  const { value, error, loading } = useTaskData<string | null>(
    () => window.api.tasks.contextMd(taskId),
    `${taskId}:${version}`,
  );
  if (loading && value === null) return <Skeleton className="m-5 h-40" />;
  if (error)
    return (
      <p role="alert" className="p-5 text-danger">
        {error}
      </p>
    );
  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <Button disabled={!value} onClick={() => value && copyText(value, 'TASK_CONTEXT')}>
          Copy
        </Button>
        <Tooltip content="Arrives with the embedded terminal (M8)">
          <Button disabled>Open in terminal</Button>
        </Tooltip>
        <span className="text-[11px] text-muted">
          Preview of .claude/TASK_CONTEXT.md as an agent would receive it.
        </span>
      </div>
      <pre className="overflow-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-[12px] whitespace-pre-wrap">
        {value ?? 'No context available.'}
      </pre>
    </div>
  );
}
