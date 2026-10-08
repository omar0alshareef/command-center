import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Inbox, SearchX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Task, TaskStatus, TrackerState } from '@command-center/core';
import { HydrationEmptyState } from '../../components/HydrationEmptyState';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/feedback';
import { createTask } from '../../lib/task-actions';
import { domainColor, STATUS_ORDER } from '../../lib/status';
import { useApp } from '../../store';
import {
  announcements,
  collisionDetection,
  columnKeyboardCoordinates,
  screenReaderInstructions,
} from './dnd';
import { ContextBar } from './ContextBar';
import { applyFilters, compareTasks, NO_FILTERS, UNASSIGNED, type Filters } from './filters';
import { FilterBar } from './FilterBar';
import { KanbanColumn, type DropState } from './KanbanColumn';
import { useMoveFlow } from './MoveFlow';
import { planMove, unmetDependencies } from './moves';
import { CardBody, TaskCard } from './TaskCard';

// Module-level on purpose. dnd-kit derives its context from these by reference; fresh object
// literals on every render give every draggable a new context and defeat React.memo on the cards.
const POINTER_OPTIONS = { activationConstraint: { distance: 5 } };
const KEYBOARD_OPTIONS = {
  keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
  coordinateGetter: columnKeyboardCoordinates,
};
const ACCESSIBILITY = { announcements, screenReaderInstructions };

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function TaskBoard({ tracker }: { tracker: TrackerState }) {
  const selectedId = useApp((s) => s.selectedMilestoneId);
  const setSelected = useApp((s) => s.setSelectedMilestoneId);
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const holdSync = useApp((s) => s.holdSync);
  const releaseSync = useApp((s) => s.releaseSync);

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);
  const flow = useMoveFlow();

  const milestone = tracker.milestones.find((m) => m.id === selectedId) ?? null;
  const domains = useMemo(
    () => [...new Set(tracker.milestones.map((m) => m.domain))],
    [tracker.milestones],
  );
  const msInfo = useMemo(
    () =>
      new Map(
        tracker.milestones.map((m) => [
          m.id,
          { domain: m.domain, color: domainColor(m.domain, domains) },
        ]),
      ),
    [tracker.milestones, domains],
  );
  const agentsById = useMemo(() => new Map(tracker.agents.map((a) => [a.id, a])), [tracker.agents]);
  const tasksById = useMemo(
    () => new Map(tracker.subtasks.map((t) => [t.id, t])),
    [tracker.subtasks],
  );
  const scoped = useMemo(
    () =>
      milestone
        ? tracker.subtasks.filter((t) => t.milestone_id === milestone.id)
        : tracker.subtasks,
    [tracker.subtasks, milestone],
  );
  const visible = useMemo(
    () => applyFilters(scoped, agentsById, filters),
    [scoped, agentsById, filters],
  );
  const columns = useMemo(() => {
    const by: Record<TaskStatus, Task[]> = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      blocked: [],
    };
    for (const t of visible) by[t.status].push(t);
    for (const s of STATUS_ORDER) by[s].sort(compareTasks);
    return by;
  }, [visible]);
  const assigneeOptions = useMemo(
    () => [
      { value: UNASSIGNED, label: 'Unassigned' },
      ...tracker.agents.map((a) => ({ value: a.id, label: a.name })),
    ],
    [tracker.agents],
  );

  // Stable callbacks keep memoized cards from re-rendering.
  const { request } = flow;
  const onOpen = useCallback((id: string) => setOpenTaskId(id), [setOpenTaskId]);
  const onApprove = useCallback((t: Task) => request(t, 'done'), [request]);
  const onReject = useCallback((t: Task) => request(t, 'in_progress'), [request]);

  // Keyboard: "/" focuses search, "[" and "]" step through milestones.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        isTyping(e.target) ||
        document.querySelector('dialog[open]')
      )
        return;
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('board-search')?.focus();
      } else if (e.key === '[' || e.key === ']') {
        const ms = tracker.milestones;
        const i = ms.findIndex((m) => m.id === selectedId);
        const next = e.key === ']' ? (i === -1 ? 0 : i + 1) : i === -1 ? ms.length - 1 : i - 1;
        const m = ms[Math.min(ms.length - 1, Math.max(0, next))];
        if (m) setSelected(m.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tracker.milestones, selectedId, setSelected]);

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
  );

  const asStatus = (id: unknown): TaskStatus | null =>
    STATUS_ORDER.includes(id as TaskStatus) ? (id as TaskStatus) : null;
  const endDrag = () => {
    setActiveId(null);
    setOverStatus(null);
    releaseSync();
  };
  const onDragStart = (e: DragStartEvent) => {
    holdSync(); // nothing reorders under the cursor mid-drag
    setActiveId(String(e.active.id));
  };
  const onDragOver = (e: DragOverEvent) => setOverStatus(asStatus(e.over?.id));
  const onDragEnd = (e: DragEndEvent) => {
    const task = tasksById.get(String(e.active.id));
    const to = asStatus(e.over?.id);
    if (task && to) request(task, to); // takes its own sync hold before the drag's is released
    endDrag();
  };

  const activeTask = activeId ? (tasksById.get(activeId) ?? null) : null;
  const dropStateFor = (status: TaskStatus): DropState => {
    if (!activeTask || overStatus !== status || activeTask.status === status) return 'idle';
    return planMove(activeTask, status, tasksById).kind === 'illegal' ? 'illegal' : 'allowed';
  };

  const quickAddReason = milestone ? undefined : 'Select a milestone to add tasks';
  const addTask = async (label: string) => {
    if (milestone) await createTask(milestone.id, label);
  };
  const startAdding = () => {
    const first = tracker.milestones[0];
    if (!milestone && first) setSelected(first.id);
    setQuickAddOpen(true);
  };

  const renderCard = (t: Task) => {
    const info = msInfo.get(t.milestone_id);
    return (
      <TaskCard
        key={t.id}
        task={t}
        agent={t.assignee ? (agentsById.get(t.assignee) ?? null) : null}
        domain={info?.domain ?? '—'}
        domainColor={info?.color ?? 'var(--muted)'}
        locked={t.status !== 'done' && unmetDependencies(t, tasksById).length > 0}
        onOpen={onOpen}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
  };

  let body;
  if (tracker.milestones.length === 0) {
    body = <HydrationEmptyState />;
  } else if (scoped.length === 0 && !quickAddOpen) {
    body = (
      <EmptyState
        icon={Inbox}
        title="No tasks in this milestone"
        help="Add a task here, or ask an agent to call add_milestone_task."
        action={
          <Button variant="primary" onClick={startAdding}>
            Add task
          </Button>
        }
      />
    );
  } else if (scoped.length > 0 && visible.length === 0) {
    body = (
      <EmptyState
        icon={SearchX}
        title="No tasks match"
        help="No task fits the current filters."
        action={<Button onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>}
      />
    );
  } else {
    body = (
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={ACCESSIBILITY}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          {STATUS_ORDER.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              count={columns[status].length}
              dropState={dropStateFor(status)}
              {...(status === 'todo'
                ? {
                    onQuickAdd: addTask,
                    quickAddDisabledReason: quickAddReason,
                    quickAddOpen,
                    onQuickAddOpenChange: setQuickAddOpen,
                  }
                : {})}
            >
              {columns[status].map(renderCard)}
            </KanbanColumn>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <CardBody
              task={activeTask}
              agent={activeTask.assignee ? (agentsById.get(activeTask.assignee) ?? null) : null}
              domain={msInfo.get(activeTask.milestone_id)?.domain ?? '—'}
              domainColor={msInfo.get(activeTask.milestone_id)?.color ?? 'var(--muted)'}
              locked={false}
              onOpen={onOpen}
              onApprove={onApprove}
              onReject={onReject}
              className="rotate-2 cursor-grabbing bg-surface-3 shadow-pop"
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ContextBar
        milestones={tracker.milestones}
        phases={tracker.phases}
        tasks={tracker.subtasks}
        selected={milestone}
        color={milestone ? (msInfo.get(milestone.id)?.color ?? 'var(--accent)') : 'var(--accent)'}
        onSelect={setSelected}
      />
      <FilterBar filters={filters} onChange={setFilters} assigneeOptions={assigneeOptions} />
      {body}
      {flow.dialogs}
    </div>
  );
}
