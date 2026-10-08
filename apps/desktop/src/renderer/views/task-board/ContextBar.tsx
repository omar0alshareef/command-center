import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Milestone, Phase, Task } from '@command-center/core';
import { Button } from '../../components/ui/button';
import { ProgressRing } from '../../components/ui/progress-ring';
import { overallProgress } from '../../lib/derive';

/** Milestone carousel (UI/UX §6.2). `selected === null` means all milestones. */
export function ContextBar({
  milestones,
  phases,
  tasks,
  selected,
  color,
  onSelect,
}: {
  milestones: readonly Milestone[];
  phases: readonly Phase[];
  tasks: readonly Task[];
  selected: Milestone | null;
  color: string;
  onSelect: (id: string | null) => void;
}) {
  const scoped = selected ? tasks.filter((t) => t.milestone_id === selected.id) : tasks;
  const done = scoped.filter((t) => t.status === 'done').length;
  const index = selected ? milestones.findIndex((m) => m.id === selected.id) : -1;
  const phase = selected ? phases.find((p) => p.id === selected.phase) : undefined;

  const step = (delta: 1 | -1) => {
    if (milestones.length === 0) return;
    const next = index === -1 ? (delta === 1 ? 0 : milestones.length - 1) : index + delta;
    const m = milestones[Math.min(milestones.length - 1, Math.max(0, next))];
    if (m) onSelect(m.id);
  };

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <button
        type="button"
        aria-label="Previous milestone ([)"
        title="Previous milestone ([)"
        disabled={milestones.length === 0 || index === 0}
        onClick={() => step(-1)}
        className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
      >
        <ChevronLeft size={16} />
      </button>
      <ProgressRing
        size={36}
        value={scoped.length === 0 ? 0 : overallProgress(scoped)}
        color={color}
        label={`${done}/${scoped.length}`}
      />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold">
          {selected ? (
            <>
              <span className="font-mono">{selected.id}</span> · {selected.title}
            </>
          ) : (
            'All milestones'
          )}
        </div>
        <div className="truncate text-[11px] text-muted">
          {selected
            ? `Week ${selected.week}${phase ? ` · ${phase.title}` : ''}`
            : `${milestones.length} milestones`}
        </div>
      </div>
      <button
        type="button"
        aria-label="Next milestone (])"
        title="Next milestone (])"
        disabled={milestones.length === 0 || index === milestones.length - 1}
        onClick={() => step(1)}
        className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
      >
        <ChevronRight size={16} />
      </button>
      <span className="flex-1" />
      <Button
        aria-pressed={selected === null}
        variant={selected === null ? 'primary' : 'default'}
        onClick={() => onSelect(null)}
      >
        All milestones
      </Button>
    </div>
  );
}
