import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { PlanningKind, PlanMilestone, PlanTask, Proposal } from '@command-center/core';
import type { PlanningView } from '../../../shared/ipc';
import { Button } from '../../components/ui/button';
import { Markdown } from '../../components/ui/markdown';
import { ConfirmDialog } from '../../components/ui/overlays';
import { cn } from '../../lib/cn';
import { addRole, countPlan, removeRole, renameRole, rolesFor } from '../../lib/planning';
import { toast } from '../../toast';

const TABS = ['manifesto', 'roadmap', 'milestones', 'tasks', 'team'] as const;
type DraftTab = (typeof TABS)[number];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

const cell =
  'w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-border-strong disabled:opacity-70';
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Text input that commits on blur or Enter, and follows outside changes while not focused. */
function Cell({
  value,
  onCommit,
  label,
  disabled,
  type = 'text',
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  disabled: boolean;
  type?: 'text' | 'date';
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  const [focused, setFocused] = useState(false);
  // Follow outside changes while the operator is not typing here.
  if (!focused && value !== base) {
    setBase(value);
    setDraft(value);
  }
  return (
    <input
      type={type}
      aria-label={label}
      disabled={disabled}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn(cell, type === 'date' && 'font-mono text-[12px]', className)}
    />
  );
}

function Assumptions({ items }: { items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="mb-3 rounded-md border border-warning/60 bg-warning/10 px-3 py-2" role="note">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-warning">
        <AlertTriangle size={13} aria-hidden /> The planner assumed — correct anything that is wrong
      </p>
      <ul className="mt-1 list-disc pl-5 text-[12px]">
        {items.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn('px-1 py-1 text-left text-[11px] font-semibold text-muted', className)}>
      {children}
    </th>
  );
}

export function DraftPanel({ view }: { view: PlanningView }) {
  const [tab, setTab] = useState<DraftTab>('manifesto');
  const [issues, setIssues] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const { session, proposal, documents } = view;
  const id = session.id;
  const editable =
    (session.status === 'review' || session.status === 'interviewing') && !view.running;

  useEffect(() => {
    if (session.status !== 'review') return;
    let live = true;
    void window.api.planning
      .validate(id)
      .then((r) => live && setIssues(r.ok ? r.value : [r.error.message]));
    return () => {
      live = false;
    };
  }, [id, session.status, proposal]);

  const save = async (next: Proposal) => {
    const r = await window.api.planning.saveProposal({ id, proposal: next });
    if (!r.ok) toast.error(r.error.message);
  };
  const p: Proposal = proposal ?? { milestones: [], tasks: [], team: [], assumptions: {} };
  const setMilestone = (i: number, patch: Partial<PlanMilestone>) =>
    void save({ ...p, milestones: p.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setTask = (i: number, patch: Partial<PlanTask>) =>
    void save({ ...p, tasks: p.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const counts = countPlan(p);

  const approve = async () => {
    setConfirm(false);
    const r = await window.api.planning.approve(id);
    if (r.ok)
      toast.info(
        `Plan approved: ${r.value.milestones} milestones and ${r.value.tasks} tasks are on the board`,
      );
    else {
      toast.error('Plan not approved');
      setIssues(r.error.message.split('\n'));
    }
  };

  const doc = (kind: PlanningKind) => documents.find((d) => d.kind === kind);

  return (
    <section className="flex w-[54%] min-w-[520px] shrink-0 flex-col" aria-label="Drafts">
      <div role="tablist" aria-label="Draft" className="flex gap-1 border-b border-border px-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (!d) return;
              const next = TABS[(TABS.indexOf(t) + d + TABS.length) % TABS.length] ?? t;
              setTab(next);
              (
                e.currentTarget.parentElement?.querySelector(
                  `[data-tab="${next}"]`,
                ) as HTMLElement | null
              )?.focus();
            }}
            data-tab={t}
            tabIndex={tab === t ? 0 : -1}
            className={cn(
              'border-b-2 px-2 py-2 text-[13px] capitalize',
              tab === t
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-text',
            )}
          >
            {t}
            {t === 'milestones' || t === 'tasks' || t === 'team' ? (
              <span className="ml-1 font-mono text-[11px] text-muted">
                {t === 'milestones'
                  ? counts.milestones
                  : t === 'tasks'
                    ? counts.tasks
                    : counts.agents}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab} className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'manifesto' || tab === 'roadmap' ? (
          <DocEditor
            key={`${id}-${tab}`}
            kind={tab}
            content={doc(tab)?.content ?? null}
            version={doc(tab)?.version ?? null}
            status={doc(tab)?.status ?? null}
            editable={editable}
            assumptions={p.assumptions[tab]}
            onSave={async (content) => {
              const r = await window.api.planning.saveDocument({ id, kind: tab, content });
              if (!r.ok) toast.error(r.error.message);
            }}
          />
        ) : tab === 'milestones' ? (
          <>
            <Assumptions items={p.assumptions['milestones']} />
            {p.milestones.length === 0 ? (
              <p className="text-muted">No milestones drafted yet.</p>
            ) : (
              <table className="w-full table-fixed text-[12px]">
                <thead>
                  <tr>
                    <Th className="w-14">Id</Th>
                    <Th>Title</Th>
                    <Th className="w-24">Domain</Th>
                    <Th className="w-32">Start</Th>
                    <Th className="w-32">End</Th>
                    <Th className="w-28">Capabilities</Th>
                    <Th className="w-28">Roles</Th>
                  </tr>
                </thead>
                <tbody>
                  {p.milestones.map((m, i) => (
                    <tr key={m.id} className="border-t border-border align-top">
                      <td className="px-1 py-1 font-mono">{m.id}</td>
                      <td>
                        <Cell
                          label={`${m.id} title`}
                          value={m.title}
                          disabled={!editable}
                          onCommit={(v) => setMilestone(i, { title: v })}
                        />
                      </td>
                      <td>
                        <Cell
                          label={`${m.id} domain`}
                          value={m.domain}
                          disabled={!editable}
                          onCommit={(v) => setMilestone(i, { domain: v })}
                        />
                      </td>
                      <td>
                        <Cell
                          type="date"
                          label={`${m.id} planned start`}
                          value={m.planned_start}
                          disabled={!editable}
                          onCommit={(v) => setMilestone(i, { planned_start: v })}
                        />
                      </td>
                      <td>
                        <Cell
                          type="date"
                          label={`${m.id} planned end`}
                          value={m.planned_end}
                          disabled={!editable}
                          onCommit={(v) => setMilestone(i, { planned_end: v })}
                        />
                      </td>
                      <td className="px-1 py-1 text-muted">
                        {m.capabilities.join(', ') || 'none'}
                      </td>
                      <td className="px-1 py-1">
                        {rolesFor(p.team, m.id)
                          .map((r) => r.name)
                          .join(', ') || <span className="text-muted">none</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : tab === 'tasks' ? (
          <>
            <Assumptions items={p.assumptions['tasks']} />
            {p.tasks.length === 0 ? (
              <p className="text-muted">No tasks drafted yet.</p>
            ) : (
              <table className="w-full table-fixed text-[12px]">
                <thead>
                  <tr>
                    <Th className="w-12">Key</Th>
                    <Th className="w-20">Milestone</Th>
                    <Th>Task</Th>
                    <Th className="w-14">Priority</Th>
                    <Th className="w-32">Due</Th>
                    <Th className="w-28">Assignee</Th>
                    <Th className="w-20">Depends on</Th>
                  </tr>
                </thead>
                <tbody>
                  {p.tasks.map((t, i) => (
                    <tr key={t.key} className="border-t border-border align-top">
                      <td className="px-1 py-1 font-mono">{t.key}</td>
                      <td>
                        <select
                          aria-label={`${t.key} milestone`}
                          disabled={!editable}
                          value={t.milestone}
                          onChange={(e) => setTask(i, { milestone: e.target.value })}
                          className={cell}
                        >
                          {[...new Set([t.milestone, ...p.milestones.map((m) => m.id)])].map(
                            (mid) => (
                              <option key={mid} value={mid}>
                                {mid}
                              </option>
                            ),
                          )}
                        </select>
                      </td>
                      <td>
                        <Cell
                          label={`${t.key} label`}
                          value={t.label}
                          disabled={!editable}
                          onCommit={(v) => setTask(i, { label: v })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`${t.key} priority`}
                          disabled={!editable}
                          value={t.priority}
                          onChange={(e) =>
                            setTask(i, { priority: e.target.value as PlanTask['priority'] })
                          }
                          className={cell}
                        >
                          {PRIORITIES.map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Cell
                          type="date"
                          label={`${t.key} due date`}
                          value={t.due_date ?? ''}
                          disabled={!editable}
                          onCommit={(v) => setTask(i, { due_date: v || null })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`${t.key} assignee`}
                          disabled={!editable}
                          value={t.assignee ?? ''}
                          onChange={(e) => setTask(i, { assignee: e.target.value || null })}
                          className={cell}
                        >
                          <option value="">Unassigned</option>
                          {[
                            ...new Set([
                              ...(t.assignee ? [t.assignee] : []),
                              ...p.team.map((r) => r.id),
                            ]),
                          ].map((rid) => (
                            <option key={rid} value={rid}>
                              {p.team.find((r) => r.id === rid)?.name ?? rid}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Cell
                          label={`${t.key} depends on`}
                          value={t.depends_on.join(', ')}
                          disabled={!editable}
                          onCommit={(v) => setTask(i, { depends_on: list(v) })}
                          className="font-mono"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <TeamEditor p={p} editable={editable} save={(next) => void save(next)} />
        )}
      </div>
      <footer className="border-t border-border px-4 py-2">
        {session.status === 'review' && issues.length > 0 ? (
          <div
            role="alert"
            className="mb-2 max-h-28 overflow-y-auto rounded-md border border-danger px-3 py-2 text-[12px]"
          >
            <p className="font-semibold text-danger">Fix before approving</p>
            <ul className="list-disc pl-5">
              {issues.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[12px] text-muted">
            {session.status === 'approved'
              ? 'Approved — this plan is on the board.'
              : `${counts.milestones} milestones · ${counts.tasks} tasks · ${counts.withDeadlines} with deadlines · ${counts.dependencies} dependencies · ${counts.agents} agents`}
          </span>
          {session.status === 'review' ? (
            <Button
              variant="primary"
              disabled={issues.length > 0 || Boolean(view.running)}
              onClick={() => setConfirm(true)}
            >
              Approve plan
            </Button>
          ) : null}
        </div>
      </footer>
      <ConfirmDialog
        open={confirm}
        title="Approve this plan?"
        body={`This writes ${counts.milestones} milestones, ${counts.tasks} tasks (${counts.withDeadlines} with deadlines), ${counts.dependencies} dependencies and ${counts.agents} agents to the board in one step, and marks the manifesto and roadmap approved.`}
        confirmLabel="Approve plan"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void approve()}
      />
    </section>
  );
}

function DocEditor({
  kind,
  content,
  version,
  status,
  editable,
  assumptions,
  onSave,
}: {
  kind: PlanningKind;
  content: string | null;
  version: number | null;
  status: string | null;
  editable: boolean;
  assumptions: string[] | undefined;
  onSave: (content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content ?? '');
  const [base, setBase] = useState(content);
  if (!editing && content !== base) {
    setBase(content);
    setDraft(content ?? '');
  }
  if (content === null) return <p className="text-muted">No {kind} drafted yet.</p>;
  const finish = async () => {
    if (draft !== content) await onSave(draft);
    setEditing(false);
  };
  return (
    <>
      <Assumptions items={assumptions} />
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="flex-1">
          v{version} · {status}
        </span>
        {editable ? (
          editing ? (
            <Button onClick={() => void finish()}>Done</Button>
          ) : (
            <Button onClick={() => setEditing(true)}>Edit</Button>
          )
        ) : null}
      </div>
      {editing ? (
        <textarea
          aria-label={`${kind} markdown`}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void (draft !== content ? onSave(draft) : undefined)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              void finish();
            }
          }}
          className="h-[calc(100%-2rem)] min-h-[360px] w-full rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px]"
        />
      ) : (
        <Markdown source={content} />
      )}
    </>
  );
}

function TeamEditor({
  p,
  editable,
  save,
}: {
  p: Proposal;
  editable: boolean;
  save: (next: Proposal) => void;
}) {
  const [name, setName] = useState('');
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  return (
    <>
      <p className="mb-3 text-[12px] text-muted">
        One agent per role, derived from the capabilities each milestone needs. Confirm the roster
        before approving: rename, remove or add roles. Removing a role unassigns its tasks.
      </p>
      <table className="w-full table-fixed text-[12px]">
        <thead>
          <tr>
            <Th>Role</Th>
            <Th className="w-36">Agent id</Th>
            <Th className="w-32">Capabilities</Th>
            <Th className="w-28">Milestones</Th>
            <Th className="w-12">Tasks</Th>
            <Th className="w-10">
              <span className="sr-only">Remove</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {p.team.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              <td>
                <Cell
                  label={`${r.id} name`}
                  value={r.name}
                  disabled={!editable}
                  onCommit={(v) => {
                    const id = slug(v) || r.id;
                    if (id !== r.id && p.team.some((x) => x.id === id))
                      return toast.error(`A role with id ${id} already exists`);
                    save(renameRole(p, r.id, { id, name: v.trim() || r.name }));
                  }}
                />
              </td>
              <td className="px-1 py-1 font-mono">{r.id}</td>
              <td className="px-1 py-1 text-muted">{r.capabilities.join(', ') || '—'}</td>
              <td className="px-1 py-1 font-mono">{r.milestones.join(', ') || '—'}</td>
              <td className="px-1 py-1 font-mono">
                {p.tasks.filter((t) => t.assignee === r.id).length}
              </td>
              <td>
                {editable ? (
                  <Button
                    variant="ghost"
                    aria-label={`Remove role ${r.name}`}
                    title="Remove role"
                    onClick={() => save(removeRole(p, r.id))}
                  >
                    <Trash2 size={13} aria-hidden />
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            save(addRole(p, name));
            setName('');
          }}
        >
          <label htmlFor="new-role" className="sr-only">
            New role name
          </label>
          <input
            id="new-role"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New role, e.g. Content"
            className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1"
          />
          <Button type="submit" disabled={!name.trim()}>
            Add role
          </Button>
        </form>
      ) : null}
    </>
  );
}
