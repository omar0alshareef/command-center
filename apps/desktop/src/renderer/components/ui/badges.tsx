import type { ReactNode } from 'react';
import type { TaskStatus } from '@command-center/core';
import { cn } from '../../lib/cn';
import { PRIORITY_COLOR, STATUS_META } from '../../lib/status';

/** 10px pill: text in the semantic color, 10% background, 20% border (UI/UX §5). */
export function Tag({
  color = 'var(--muted)',
  children,
  className,
  'aria-label': ariaLabel,
}: {
  color?: string;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none font-semibold whitespace-nowrap',
        className,
      )}
      style={{
        // Light themes pull the hue toward the text colour so palette-coloured tags stay readable.
        color: `color-mix(in srgb, ${color} var(--tag-ink), var(--text))`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export function StatusDot({
  color,
  pulse = false,
  className,
}: {
  color: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', pulse && 'pulse-dot', className)}
      style={{ background: color }}
    />
  );
}

/** Status is never color-only: label text always accompanies the dot. */
export function StatusTag({ status }: { status: TaskStatus }) {
  const { label, color } = STATUS_META[status];
  return (
    <Tag color={color}>
      <StatusDot color={color} pulse={status === 'in_progress'} />
      {label}
    </Tag>
  );
}

export function PriorityPill({ priority }: { priority: string }) {
  return (
    <Tag color={PRIORITY_COLOR[priority] ?? 'var(--muted)'} className="font-mono">
      {priority}
    </Tag>
  );
}

export function DomainTag({ domain, color }: { domain: string; color: string }) {
  return (
    <span data-domain={domain} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <StatusDot color={color} />
      {domain}
    </span>
  );
}
