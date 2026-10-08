import { Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AcceptanceCriterion } from '@command-center/core';
import { cn } from '../../lib/cn';
import { toast } from '../../toast';

export function copyText(text: string, what: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.info(`${what} copied`))
    .catch(() => toast.error('Could not copy to the clipboard'));
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-[11px] font-semibold tracking-[0.06em] text-muted uppercase"
    >
      {children}
    </label>
  );
}

/**
 * Autosaves on blur. The draft is only overwritten by outside changes while the field is not
 * focused, so an agent updating the task never eats what the operator is typing.
 */
export function TextField({
  id,
  label,
  value,
  onCommit,
  multiline = false,
  mono = false,
  rows = 3,
  placeholder,
  className,
  hideLabel = false,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
  mono?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
  hideLabel?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const classes = cn(
    'w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 hover:border-border-strong',
    mono && 'font-mono text-[12px]',
    className,
  );
  const onFocus = () => {
    focused.current = true;
  };
  const onBlur = () => {
    focused.current = false;
    if (draft !== value) onCommit(draft);
  };

  return (
    <div>
      {hideLabel ? (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      ) : (
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      )}
      {multiline ? (
        <textarea
          id={id}
          value={draft}
          placeholder={placeholder}
          rows={rows}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(classes, 'resize-y')}
        />
      ) : (
        <input
          id={id}
          value={draft}
          placeholder={placeholder}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(e) => setDraft(e.target.value)}
          className={classes}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
    </div>
  );
}

/** One entry per line. View mode can copy an item on click (context files). */
export function ListField({
  id,
  label,
  items,
  onCommit,
  copyable = false,
  emptyText = 'None',
}: {
  id: string;
  label: string;
  items: readonly string[];
  onCommit: (next: string[]) => void;
  copyable?: boolean;
  emptyText?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const start = () => {
    setDraft(items.join('\n'));
    setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    const next = draft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (next.join('\n') !== items.join('\n')) onCommit(next);
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {!editing ? (
          <button
            type="button"
            aria-label={`Edit ${label.toLowerCase()}`}
            onClick={start}
            className="mb-1 grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
          >
            <Pencil size={12} />
          </button>
        ) : null}
      </div>
      {editing ? (
        <textarea
          id={id}
          autoFocus
          rows={Math.max(3, items.length + 1)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(false))}
          className="w-full resize-y rounded-md border border-border-strong bg-surface-2 p-2 font-mono text-[12px]"
        />
      ) : items.length === 0 ? (
        <p className="text-muted">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-0.5 font-mono text-[12px]">
          {items.map((item) =>
            copyable ? (
              <li key={item}>
                <button
                  type="button"
                  title="Click to copy"
                  onClick={() => copyText(item, 'Path')}
                  className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-surface-2"
                >
                  {item}
                </button>
              </li>
            ) : (
              <li key={item} className="truncate px-1 py-0.5">
                {item}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

export function Checklist({
  items,
  onChange,
}: {
  items: readonly AcceptanceCriterion[];
  onChange: (next: AcceptanceCriterion[]) => void;
}) {
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    onChange([...items, { text: text.trim(), done: false }]);
    setText('');
  };
  return (
    <div>
      <FieldLabel>Acceptance criteria</FieldLabel>
      <ul className="flex flex-col gap-1">
        {items.map((c, i) => (
          <li key={`${i}-${c.text}`} className="group flex items-start gap-2">
            <input
              type="checkbox"
              checked={c.done}
              aria-label={c.text}
              onChange={() =>
                onChange(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))
              }
              className="mt-0.5"
            />
            <span className={cn('flex-1', c.done && 'text-muted line-through')}>{c.text}</span>
            <button
              type="button"
              aria-label={`Remove criterion: ${c.text}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="hidden size-5 place-items-center rounded text-muted group-focus-within:grid group-hover:grid hover:text-danger"
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add a criterion"
          aria-label="Add a criterion"
          className="h-7 flex-1 rounded-md border border-border bg-surface-2 px-2"
        />
        <button
          type="button"
          aria-label="Add criterion"
          onClick={add}
          className="grid size-7 place-items-center rounded-md border border-border-strong text-muted hover:text-text"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
