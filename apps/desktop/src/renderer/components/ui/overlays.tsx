import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './button';

/**
 * Native <dialog>: focus trap, Esc handling and top-layer stacking for free.
 * Backdrop click closes (the content wrapper stops the click from reaching the dialog itself).
 */
export function Modal({
  open,
  onClose,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="modal"
    >
      {open ? <div className={cn('modal-body', className)}>{children}</div> : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} label={title} className="w-[420px] p-5">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <p className="mt-2 text-muted">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button autoFocus onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/** 480px right-anchored panel. Esc and the close button close it; `dim` adds a click-to-close backdrop. */
export function SlidePanel({
  open,
  onClose,
  label,
  dim = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  dim?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      {dim && open ? (
        <div className="fixed inset-0 z-40 bg-[rgba(5,5,10,.4)]" onClick={onClose} aria-hidden />
      ) : null}
      <aside
        role="complementary"
        aria-label={label}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'fixed inset-y-0 right-0 z-40 w-[480px] max-w-full border-l border-border bg-surface shadow-pop transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="absolute top-3 right-3 grid size-7 place-items-center rounded text-muted hover:text-text"
        >
          <X size={16} />
        </button>
        {children}
      </aside>
    </>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enter = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(true), 500);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setShow(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
    >
      {children}
      {show ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] whitespace-nowrap shadow-pop"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
