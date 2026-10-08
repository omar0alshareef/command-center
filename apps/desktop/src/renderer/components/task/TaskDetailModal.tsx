import { Check, ChevronDown, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskPatch, TaskStatus } from '@command-center/core';
import { cn } from '../../lib/cn';
import { useAgents, useTasksById } from '../../lib/hooks';
import { saveTaskFields, transitionTask } from '../../lib/task-actions';
import { typeInTerminal } from '../../lib/terminal-actions';
import { STATUS_NAME, STATUS_ORDER } from '../../lib/status';
import { useApp } from '../../store';
import { useMoveFlow } from '../../views/task-board/MoveFlow';
import { planMove } from '../../views/task-board/moves';
import { StatusTag } from '../ui/badges';
import { Button } from '../ui/button';
import { ConfirmDialog, Modal, Tooltip } from '../ui/overlays';
import { Checklist, copyText, FieldLabel, ListField, TextField } from './fields';
import { ContextTab, HistoryTab } from './TaskTabs';

type TabKey = 'details' | 'history' | 'context';
const TAB_LABEL: Record<TabKey, string> = {
  details: 'Details',
  history: 'History',
  context: 'Context',
};

/** The same transitions as drag-and-drop, as a menu (UI/UX §6.2: "status pill dropdown"). */
function StatusMenu({ task, onPick }: { task: Task; onPick: (to: TaskStatus) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const byId = useTasksById();
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
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${STATUS_NAME[task.status]}. Change status`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-full hover:bg-surface-2"
      >
        <StatusTag status={task.status} />
        <ChevronDown size={12} className="text-muted" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full left-0 z-30 mt-1 min-w-48 rounded-lg border border-border-strong bg-surface-2 p-1 shadow-pop"
        >
          {STATUS_ORDER.filter((s) => s !== task.status).map((s) => {
            const plan = planMove(task, s, byId);
            const illegal = plan.kind === 'illegal';
            return (
              <button
                key={s}
                role="menuitem"
                type="button"
                aria-disabled={illegal}
                title={illegal ? plan.message : undefined}
                onClick={() => {
                  setOpen(false);
                  onPick(s);
                }}
                className={cn(
                  'block w-full rounded px-2 py-1.5 text-left hover:bg-surface-3',
                  illegal && 'text-muted',
                )}
              >
                {STATUS_NAME[s]}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Details({ task, save }: { task: Task; save: (patch: TaskPatch) => void }) {
  const byId = useTasksById();
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const agents = useAgents();
  const nullable = (v: string) => (v.trim() === '' ? null : v);

  return (
    <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-2">
      <div className="flex flex-col gap-5">
        {task.status === 'blocked' ? (
          <p
            role="status"
            className="rounded-lg border p-3 text-danger"
            style={{
              borderColor: 'var(--danger)',
              background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
            }}
          >
            Blocked{task.blocked_by && task.blocked_by !== 'manual' ? ` by ${task.blocked_by}` : ''}
            {task.blocked_reason ? `: ${task.blocked_reason}` : ''}
          </p>
        ) : null}
        <TextField
          id="f-notes"
          label="Description"
          multiline
          rows={4}
          value={task.notes ?? ''}
          onCommit={(v) => save({ notes: nullable(v) })}
        />
        <TextField
          id="f-prompt"
          label="Prompt"
          multiline
          rows={4}
          mono
          value={task.prompt ?? ''}
          onCommit={(v) => save({ prompt: nullable(v) })}
        />
        <Checklist
          items={task.acceptance_criteria}
          onChange={(acceptance_criteria) => save({ acceptance_criteria })}
        />
      </div>

      <div className="flex flex-col gap-5">
        <ListField
          id="f-constraints"
          label="Constraints"
          items={task.constraints}
          onCommit={(constraints) => save({ constraints })}
        />
        <ListField
          id="f-context"
          label="Context files"
          copyable
          items={task.context_files}
          onCommit={(context_files) => save({ context_files })}
        />
        <ListField
          id="f-refs"
          label="Reference docs"
          items={task.reference_docs}
          onCommit={(reference_docs) => save({ reference_docs })}
        />

        <div>
          <FieldLabel>Dependencies</FieldLabel>
          {task.depends_on.length === 0 ? (
            <p className="text-muted">None</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {task.depends_on.map((id) => {
                const dep = byId.get(id);
                return (
                  <li key={id} className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!dep}
                      onClick={() => setOpenTaskId(id)}
                      className="font-mono text-accent-light hover:underline disabled:text-muted disabled:no-underline"
                    >
                      {id}
                    </button>
                    {dep ? (
                      <StatusTag status={dep.status} />
                    ) : (
                      <span className="text-danger">missing</span>
                    )}
                    <span className="truncate text-muted">{dep?.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-2">
            <ListField
              id="f-deps"
              label="Edit depends on (one task id per line)"
              items={task.depends_on}
              onCommit={(depends_on) => save({ depends_on })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor="f-mode">Execution mode</FieldLabel>
            <select
              id="f-mode"
              value={task.execution_mode}
              onChange={(e) => save({ execution_mode: e.target.value })}
              className="h-8 w-full rounded-md border border-border bg-surface-2 px-2"
            >
              {[...new Set(['agent', 'human', task.execution_mode])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="f-target">Agent target</FieldLabel>
            <select
              id="f-target"
              value={task.agent_target ?? ''}
              onChange={(e) => save({ agent_target: e.target.value || null })}
              className="h-8 w-full rounded-md border border-border bg-surface-2 px-2"
            >
              <option value="">None</option>
              {agents
                .filter((a) => a.type !== 'human')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
        </div>

        <details>
          <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
            Builder prompt
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <TextField
              id="f-builder"
              label="Builder prompt"
              hideLabel
              multiline
              rows={6}
              mono
              value={task.builder_prompt ?? ''}
              onCommit={(v) => save({ builder_prompt: nullable(v) })}
            />
            <div>
              <Button
                disabled={!task.builder_prompt}
                onClick={() =>
                  task.builder_prompt && copyText(task.builder_prompt, 'Builder prompt')
                }
              >
                Copy
              </Button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

/** Near-full-screen task view (UI/UX §6.2). Opens for `openTaskId`; Esc and backdrop click close it. */
export function TaskDetailModal() {
  const openTaskId = useApp((s) => s.openTaskId);
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const task = useApp((s) =>
    s.openTaskId ? (s.tracker?.subtasks.find((t) => t.id === s.openTaskId) ?? null) : null,
  );
  const loaded = useApp((s) => s.tracker !== null);

  // The task was deleted or the project changed under an open modal.
  useEffect(() => {
    if (openTaskId && loaded && !task) setOpenTaskId(null);
  }, [openTaskId, loaded, task, setOpenTaskId]);

  const close = () => setOpenTaskId(null);
  return (
    <Modal
      open={Boolean(task)}
      onClose={close}
      label={task ? `${task.id}: ${task.label}` : 'Task'}
      focusContainer
      className="flex h-[720px] max-h-[94vh] w-[1100px] max-w-[96vw] flex-col"
    >
      {/* Keyed by task: switching tasks (e.g. via a dependency link) resets tab and local state. */}
      {task ? <TaskDetailBody key={task.id} task={task} onClose={close} /> : null}
    </Modal>
  );
}

function TaskDetailBody({ task, onClose: close }: { task: Task; onClose: () => void }) {
  const agents = useAgents();
  const flow = useMoveFlow();
  const [tab, setTab] = useState<TabKey>('details');
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(t);
  }, [saved]);

  const save = (patch: TaskPatch) => {
    void saveTaskFields(task.id, patch).then((t) => t && setSaved(true));
  };

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Tooltip content="Copy task id">
          <button
            type="button"
            onClick={() => copyText(task.id, 'Task id')}
            className="font-mono text-[12px] text-muted hover:text-text"
          >
            {task.id}
          </button>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <TextField
            id="f-label"
            label="Title"
            hideLabel
            value={task.label}
            onCommit={(v) => v.trim() && save({ label: v })}
            className="text-[15px] font-semibold"
          />
        </div>
        <StatusMenu task={task} onPick={(to) => flow.request(task, to)} />
        <label className="sr-only" htmlFor="f-priority">
          Priority
        </label>
        <select
          id="f-priority"
          value={task.priority}
          onChange={(e) => save({ priority: e.target.value as TaskPatch['priority'] })}
          className="h-8 rounded-md border border-border bg-surface-2 px-2 font-mono"
        >
          {['P0', 'P1', 'P2', 'P3'].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-assignee">
          Assignee
        </label>
        <select
          id="f-assignee"
          value={task.assignee ?? ''}
          onChange={(e) => save({ assignee: e.target.value || null })}
          className="h-8 max-w-40 rounded-md border border-border bg-surface-2 px-2"
        >
          <option value="">Unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Tooltip content="Types the command into the Terminal; you press Enter">
          <Button onClick={() => void typeInTerminal(`command-center prepare ${task.id}`)} data-run-prepare>
            <SquareTerminal size={14} aria-hidden /> Run prepare here
          </Button>
        </Tooltip>
        <span
          aria-live="polite"
          className="inline-flex w-14 items-center gap-1 text-[11px] text-success"
        >
          {saved ? (
            <>
              <Check size={12} aria-hidden /> Saved
            </>
          ) : null}
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
        >
          <X size={16} />
        </button>
      </header>

      <div
        role="tablist"
        aria-label="Task sections"
        className="flex gap-1 border-b border-border px-4"
      >
        {(Object.keys(TAB_LABEL) as TabKey[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2',
              tab === k
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-text',
            )}
          >
            {TAB_LABEL[k]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'details' ? <Details task={task} save={save} /> : null}
        {tab === 'history' ? <HistoryTab taskId={task.id} version={task.updated_at} /> : null}
        {tab === 'context' ? <ContextTab taskId={task.id} version={task.updated_at} /> : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" onClick={() => setConfirmReset(true)}>
          Reset
        </Button>
        <span className="flex-1" />
        {task.status === 'todo' ? (
          <>
            <Tooltip content="Arrives with the operator CLI (M9)">
              <Button disabled>Prepare</Button>
            </Tooltip>
            <Button variant="primary" onClick={() => flow.request(task, 'in_progress')}>
              Start
            </Button>
          </>
        ) : null}
        {task.status === 'in_progress' ? (
          <>
            <Button onClick={() => flow.request(task, 'blocked')}>Block</Button>
            <Button variant="primary" onClick={() => flow.request(task, 'review')}>
              Complete
            </Button>
          </>
        ) : null}
        {task.status === 'review' ? (
          <>
            <Button onClick={() => flow.request(task, 'in_progress')}>Reject</Button>
            <Button variant="primary" onClick={() => flow.request(task, 'done')}>
              Approve
            </Button>
          </>
        ) : null}
        {task.status === 'blocked' ? (
          <Button variant="primary" onClick={() => flow.request(task, task.blocked_from ?? 'todo')}>
            Unblock
          </Button>
        ) : null}
      </footer>

      {flow.dialogs}
      <ConfirmDialog
        open={confirmReset}
        title={`Reset ${task.id}?`}
        body="Its status, blockers and run history will be cleared."
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void transitionTask(task, { trigger: 'reset', payload: {} });
        }}
      />
    </>
  );
}
