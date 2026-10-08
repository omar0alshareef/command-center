import type { ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useToasts } from '../../toast';

export function EmptyState({
  icon: Icon,
  title,
  help,
  action,
}: {
  icon: LucideIcon;
  title: string;
  help?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon size={48} strokeWidth={1.25} className="text-muted" aria-hidden />
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {help ? <p className="max-w-md text-muted">{help}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} />;
}

/** Bottom-right, max 3, 4s auto-dismiss; errors persist until dismissed. */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-8 z-[60] flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface-2 p-3 shadow-pop',
            t.kind === 'error' ? 'border-danger text-danger' : 'border-border-strong',
          )}
        >
          <span className="flex-1 break-words">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="grid size-6 place-items-center rounded text-muted hover:text-text"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
