import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { isFiltering, NO_FILTERS, type Filters, type Segment } from './filters';

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'My Tasks' },
  { id: 'agent', label: 'Agent Tasks' },
  { id: 'blocked', label: 'Blocked' },
];

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        {selected.length > 0 ? (
          <span className="font-mono text-accent-light">{selected.length}</span>
        ) : null}
        <ChevronDown size={12} aria-hidden />
      </Button>
      {open ? (
        <div
          role="group"
          aria-label={label}
          className="absolute top-full left-0 z-30 mt-1 max-h-72 min-w-44 overflow-auto rounded-lg border border-border-strong bg-surface-2 p-1 shadow-pop"
        >
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-3"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, o.value]
                      : selected.filter((v) => v !== o.value),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FilterBar({
  filters,
  onChange,
  assigneeOptions,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  assigneeOptions: { value: string; label: string }[];
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-4">
      <div
        role="group"
        aria-label="Task segment"
        className="inline-flex rounded-md border border-border-strong p-0.5"
      >
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={filters.segment === s.id}
            onClick={() => onChange({ ...filters, segment: s.id })}
            className={cn(
              'min-h-6 rounded px-2.5 text-[12px] font-medium',
              filters.segment === s.id ? 'bg-surface-3 text-text' : 'text-muted hover:text-text',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <label className="relative">
        <span className="sr-only">Search tasks</span>
        <Search
          size={13}
          aria-hidden
          className="absolute top-1/2 left-2 -translate-y-1/2 text-muted"
        />
        <input
          id="board-search"
          type="search"
          value={filters.search}
          placeholder="Search tasks  ( / )"
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
          className="h-7 w-56 rounded-md border border-border-strong bg-surface-2 pr-2 pl-7"
        />
      </label>

      <MultiSelect
        label="Priority"
        options={['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p }))}
        selected={filters.priorities}
        onChange={(priorities) => onChange({ ...filters, priorities })}
      />
      <MultiSelect
        label="Assignee"
        options={assigneeOptions}
        selected={filters.assignees}
        onChange={(assignees) => onChange({ ...filters, assignees })}
      />

      {isFiltering(filters) ? (
        <Button variant="ghost" onClick={() => onChange(NO_FILTERS)}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
