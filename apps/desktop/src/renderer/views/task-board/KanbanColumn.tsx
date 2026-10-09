import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TaskStatus } from '@command-center/core';
import { StatusDot } from '../../components/ui/badges';
import { Tooltip } from '../../components/ui/overlays';
import { cn } from '../../lib/cn';
import { STATUS_META } from '../../lib/status';

export type DropState = 'idle' | 'allowed' | 'illegal';

export function KanbanColumn({
  status,
  count,
  dropState,
  children,
  onQuickAdd,
  quickAddDisabledReason,
  quickAddOpen,
  onQuickAddOpenChange,
}: {
  status: TaskStatus;
  count: number;
  dropState: DropState;
  children: ReactNode;
  /** To Do only: create a task with this label. */
  onQuickAdd?: (label: string) => Promise<void> | void;
  quickAddDisabledReason?: string;
  quickAddOpen?: boolean;
  onQuickAddOpenChange?: (open: boolean) => void;
}) {
  const { setNodeRef } = useDroppable({ id: status });
  const meta = STATUS_META[status];
  const attention = (status === 'review' || status === 'blocked') && count > 0;

  return (
    <section
      aria-label={`${meta.label}, ${count} tasks`}
      className="flex min-h-0 min-w-[216px] flex-1 flex-col rounded-lg border border-border bg-surface"
    >
      <header className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-2 px-3 focus-within:z-20 hover:z-20">
        <StatusDot color={meta.color} />
        <h2 className="text-[11px] font-semibold tracking-[0.06em] uppercase">{meta.label}</h2>
        <span
          className={cn(
            'rounded-full px-1.5 font-mono text-[11px]',
            attention ? 'font-semibold text-bg' : 'text-muted',
          )}
          style={attention ? { background: meta.color } : undefined}
        >
          {count}
        </span>
        <span className="flex-1" />
        {onQuickAdd ? (
          <Tooltip content={quickAddDisabledReason ?? 'Add task'}>
            <button
              type="button"
              aria-label="Add task"
              disabled={Boolean(quickAddDisabledReason)}
              onClick={() => onQuickAddOpenChange?.(!quickAddOpen)}
              className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        ) : null}
      </header>

      <div
        ref={setNodeRef}
        data-column={status}
        data-drop-state={dropState}
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto rounded-b-lg border-2 border-transparent p-2',
          dropState === 'allowed' && 'border-dashed',
          dropState === 'illegal' && 'cursor-not-allowed border-dashed',
        )}
        style={
          dropState === 'allowed'
            ? {
                borderColor: meta.color,
                background: `color-mix(in srgb, ${meta.color} 4%, transparent)`,
              }
            : dropState === 'illegal'
              ? {
                  borderColor: 'var(--danger)',
                  background: 'color-mix(in srgb, var(--danger) 4%, transparent)',
                }
              : undefined
        }
      >
        {quickAddOpen && onQuickAdd ? (
          <QuickAdd onSubmit={onQuickAdd} onClose={() => onQuickAddOpenChange?.(false)} />
        ) : null}
        {children}
        {count === 0 && !quickAddOpen ? (
          <p className="rounded-md border border-dashed border-border-strong p-3 text-center text-muted">
            Nothing here
          </p>
        ) : null}
      </div>
    </section>
  );
}

function QuickAdd({
  onSubmit,
  onClose,
}: {
  onSubmit: (label: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <input
      ref={input}
      value={label}
      placeholder="Task title, then Enter"
      aria-label="New task title"
      onChange={(e) => setLabel(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
        if (e.key === 'Enter' && label.trim() && !busy.current) {
          busy.current = true;
          void Promise.resolve(onSubmit(label.trim())).finally(() => {
            busy.current = false;
            setLabel('');
          });
        }
      }}
      onBlur={() => !label.trim() && onClose()}
      className="shrink-0 rounded-md border border-border-strong bg-surface-2 px-2 py-1.5"
    />
  );
}
