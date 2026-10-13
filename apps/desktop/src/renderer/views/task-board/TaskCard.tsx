import { useDraggable } from '@dnd-kit/core';
import { motion } from 'framer-motion';
import {
  CalendarClock,
  Check,
  Copy,
  Link2,
  Lock,
  Maximize2,
  SquareTerminal,
  X,
} from 'lucide-react';
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Agent, Task } from '@command-center/core';
import { AssigneeChip } from '../../components/ui/agent';
import { DomainTag, PriorityPill, StatusDot } from '../../components/ui/badges';
import { cn } from '../../lib/cn';
import { isPastDue } from '../../lib/planning';
import { elapsed } from '../../lib/time';
import { STATUS_META } from '../../lib/status';
import { toast } from '../../toast';

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.info(`${what} copied`))
    .catch(() => toast.error('Could not copy to the clipboard'));
}

/** Elapsed time since the task started; ticks on its own so the card does not re-render. */
function ElapsedTime({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return <span className="font-mono">{elapsed(since)}</span>;
}

export interface CardProps {
  task: Task;
  agent: Agent | null;
  domain: string;
  domainColor: string;
  /** Has unmet depends_on entries. */
  locked: boolean;
  onOpen: (id: string) => void;
  onApprove: (task: Task) => void;
  onReject: (task: Task) => void;
}

/** Presentational card. Also rendered (rotated) inside the DragOverlay. */
export function CardBody({
  task,
  agent,
  domain,
  domainColor,
  locked,
  onOpen,
  onApprove,
  onReject,
  className,
  flash,
}: CardProps & { className?: string; flash?: boolean }) {
  const meta = STATUS_META[task.status];
  const done = task.acceptance_criteria.filter((c) => c.done).length;
  const total = task.acceptance_criteria.length;
  return (
    <div
      className={cn(
        'group relative min-h-[84px] rounded-lg border border-border bg-surface-2 p-3 text-left',
        'hover:border-border-strong',
        flash && 'flash',
        className,
      )}
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <DomainTag domain={domain} color={domainColor} />
        <PriorityPill priority={task.priority} />
      </div>

      <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug font-medium">{task.label}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted">
        <span>{task.id}</span>
        {task.depends_on.length > 0 ? (
          <span
            className="inline-flex items-center gap-0.5"
            title={`Depends on ${task.depends_on.join(', ')}`}
          >
            <Link2 size={11} aria-hidden /> {task.depends_on.length} deps
          </span>
        ) : null}
        {task.due_date ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5',
              isPastDue(task) && 'font-semibold text-danger',
            )}
            title={isPastDue(task) ? `Past due (was due ${task.due_date})` : `Due ${task.due_date}`}
          >
            <CalendarClock size={11} aria-hidden /> {isPastDue(task) ? 'past due' : 'due'}{' '}
            {task.due_date.slice(5)}
          </span>
        ) : null}
        {locked ? (
          <span
            className="inline-flex items-center gap-0.5 text-warning"
            title="Dependencies incomplete"
          >
            <Lock size={11} aria-hidden /> locked
          </span>
        ) : null}
        {task.status === 'in_progress' && task.started_at ? (
          <span className="inline-flex items-center gap-1 text-accent-light">
            <StatusDot color="var(--accent)" pulse /> <ElapsedTime since={task.started_at} />
          </span>
        ) : null}
      </div>

      {task.status === 'blocked' && task.blocked_reason ? (
        <p className="mt-1.5 truncate text-[11px] text-danger" title={task.blocked_reason}>
          {task.blocked_reason}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <AssigneeChip agent={agent} />
        {total > 0 ? (
          <span className="shrink-0 font-mono text-[11px] text-muted">
            ▸ {done}/{total} criteria
          </span>
        ) : null}
      </div>

      {task.status === 'review' ? (
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <span className="text-[11px] font-medium text-warning">Awaiting your review</span>
          <span className="flex gap-1">
            <button
              type="button"
              aria-label={`Approve ${task.id}`}
              title="Approve"
              onClick={(e) => {
                e.stopPropagation();
                onApprove(task);
              }}
              className="grid size-7 place-items-center rounded-md border border-border-strong text-success hover:bg-surface-3"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              aria-label={`Reject ${task.id}`}
              title="Reject"
              onClick={(e) => {
                e.stopPropagation();
                onReject(task);
              }}
              className="grid size-7 place-items-center rounded-md border border-border-strong text-danger hover:bg-surface-3"
            >
              <X size={14} />
            </button>
          </span>
        </div>
      ) : null}

      {/* Hover / focus quick actions */}
      <div className="absolute top-1.5 right-1.5 hidden gap-0.5 rounded-md bg-surface-2 group-focus-within:flex group-hover:flex">
        {[
          { label: 'Open', icon: Maximize2, run: () => onOpen(task.id) },
          { label: 'Copy task id', icon: Copy, run: () => copy(task.id, 'Task id') },
          {
            label: 'Copy prepare command',
            icon: SquareTerminal,
            run: () => copy(`command-center prepare --id ${task.id}`, 'Command'),
          },
        ].map(({ label, icon: Icon, run }) => (
          <button
            key={label}
            type="button"
            aria-label={`${label}: ${task.id}`}
            title={label}
            onClick={(e) => {
              e.stopPropagation();
              run();
            }}
            className="grid size-6 place-items-center rounded text-muted hover:bg-surface-3 hover:text-text"
          >
            <Icon size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Draggable card. Memoized: with structural sharing in the store, an external write re-renders only
 * the cards whose task row actually changed.
 */
export const TaskCard = memo(function TaskCard(props: CardProps) {
  const { task, onOpen } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  // Flash (surface-3 -> base, 600ms) when this task changes after first render, e.g. by an agent.
  const seen = useRef(task.updated_at);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (seen.current === task.updated_at) return;
    seen.current = task.updated_at;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(t);
  }, [task.updated_at]);

  // Test hook: set `window.__ccRenders = {}` to count commits per task. Production builds have no
  // React Profiler, and this is how the "no re-render storm on db:changed" check is made.
  useEffect(() => {
    const counts = (window as { __ccRenders?: Record<string, number> }).__ccRenders;
    if (counts) counts[task.id] = (counts[task.id] ?? 0) + 1;
  });

  // dnd-kit's KeyboardSensor takes Space; Enter opens the task.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(task.id);
    }
  };

  return (
    <motion.div
      layout="position"
      layoutId={task.id}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    >
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={() => onOpen(task.id)}
        onKeyDown={(e) => {
          onKeyDown(e);
          listeners?.['onKeyDown']?.(e);
        }}
        data-task-id={task.id}
        aria-label={`${task.id}: ${task.label}. ${STATUS_META[task.status].label}.`}
        className="cursor-grab touch-none outline-offset-2 active:cursor-grabbing"
      >
        <CardBody
          {...props}
          flash={flash}
          className={isDragging ? 'border-dashed opacity-40' : undefined}
        />
      </div>
    </motion.div>
  );
});
