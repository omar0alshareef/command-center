import { ArrowUpFromLine, Archive, Pencil, Search, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Lesson, LibraryLesson } from '@command-center/core';
import { Tag } from '../../components/ui/badges';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/overlays';
import { useLibrary } from '../../lib/library';
import { formatDate } from '../../lib/time';
import { useApp } from '../../store';
import { toast } from '../../toast';

// Lessons panel (M15). Project lessons come from the open project; agent- and global-scope lessons live in the app-wide
// library and apply to every project. A lesson with no prevention check stays a draft and cannot leave its project.

type Scope = 'project' | 'agent' | 'global';
type Status = 'draft' | 'active' | 'needs_rewrite' | 'retired';
type CheckType = 'automatic' | 'manual' | 'none';

interface Row {
  key: string;
  source: 'project' | 'library';
  id: number;
  scope: Scope;
  agentId: string | null;
  task: string | null;
  reason: string;
  fix: string;
  prevention: string;
  keywords: string;
  checkText: string;
  checkType: CheckType;
  status: Status;
  occurrences: number;
  createdAt: string;
  promotedTo: string | null;
}

const fromProject = (l: Lesson): Row => ({
  key: `p${l.id}`,
  source: 'project',
  id: l.id,
  scope: 'project',
  agentId: null,
  task: l.subtask_id,
  reason: l.rejection_reason,
  fix: l.fix_applied,
  prevention: l.prevention,
  keywords: l.trigger_keywords,
  checkText: l.check_text,
  checkType: l.check_type,
  status: l.status,
  occurrences: l.occurrences,
  createdAt: l.created_at,
  promotedTo: l.promoted_to,
});
const fromLibrary = (l: LibraryLesson): Row => ({
  key: `l${l.id}`,
  source: 'library',
  id: l.id,
  scope: l.scope,
  agentId: l.agent_id,
  task: l.origin_task,
  reason: l.rejection_reason,
  fix: l.fix_applied,
  prevention: l.prevention,
  keywords: l.trigger_keywords,
  checkText: l.check_text,
  checkType: l.check_type,
  status: l.status,
  occurrences: l.occurrences,
  createdAt: l.created_at,
  promotedTo: null,
});

const STATUS_TAG: Record<Status, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'var(--muted)' },
  active: { label: 'Active', color: 'var(--success)' },
  needs_rewrite: { label: 'Needs rewrite', color: 'var(--warning)' },
  retired: { label: 'Retired', color: 'var(--muted)' },
};
const CHECK_LABEL: Record<CheckType, string> = {
  automatic: 'Automatic check',
  manual: 'Manual check',
  none: 'No check',
};

const NEEDS_CHECK =
  'This lesson has no prevention check, so it can only apply in this project. Add a check (a short, verifiable statement) first.';

const matches = (r: Row, q: string) =>
  [r.task ?? '', r.reason, r.fix, r.prevention, r.keywords, r.checkText].some((f) =>
    f.toLowerCase().includes(q),
  );

function Field({ label, value }: { label: string; value: string }) {
  return (
    <p className="mt-1 text-[12px]">
      <span className="font-semibold text-muted">{label} </span>
      {/* Agent- and user-written text: plain text only. */}
      {value ? (
        <span className="whitespace-pre-wrap">{value}</span>
      ) : (
        <span className="text-muted italic">not recorded yet</span>
      )}
    </p>
  );
}

function Editor({ row, onDone }: { row: Row; onDone: () => void }) {
  const refresh = useApp((s) => s.refresh);
  const [reason, setReason] = useState(row.reason);
  const [fix, setFix] = useState(row.fix);
  const [prevention, setPrevention] = useState(row.prevention);
  const [keywords, setKeywords] = useState(row.keywords);
  const [check, setCheck] = useState(row.checkText);
  const [checkType, setCheckType] = useState<'automatic' | 'manual'>(
    row.checkType === 'automatic' ? 'automatic' : 'manual',
  );
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!reason.trim()) return toast.error('A lesson needs a reason.');
    setBusy(true);
    const patch = {
      rejection_reason: reason,
      fix_applied: fix,
      prevention,
      trigger_keywords: keywords,
      check_text: check,
      ...(check.trim() ? { check_type: checkType } : {}),
    };
    const res =
      row.source === 'project'
        ? await window.api.lessons.update({ id: row.id, patch })
        : await window.api.lessons.updateLibrary({ id: row.id, patch });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    void refresh();
    onDone();
  };
  const area =
    'mt-0.5 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px] text-text';
  return (
    <div className="mt-2 space-y-2">
      <label className="block text-[11px] text-muted">
        What went wrong
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className={area}
          aria-label="Rejection reason"
        />
      </label>
      <label className="block text-[11px] text-muted">
        Fix applied
        <textarea
          value={fix}
          onChange={(e) => setFix(e.target.value)}
          rows={2}
          className={area}
          aria-label="Fix applied"
        />
      </label>
      <label className="block text-[11px] text-muted">
        Prevention
        <textarea
          value={prevention}
          onChange={(e) => setPrevention(e.target.value)}
          rows={2}
          className={area}
          aria-label="Prevention"
        />
      </label>
      <label className="block text-[11px] text-muted">
        Prevention check (giving a draft its first check makes it active)
        <input
          value={check}
          onChange={(e) => setCheck(e.target.value)}
          className={area}
          aria-label="Prevention check"
        />
      </label>
      {check.trim() ? (
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`ct-${row.key}`}
              checked={checkType === 'manual'}
              onChange={() => setCheckType('manual')}
            />
            Manual
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`ct-${row.key}`}
              checked={checkType === 'automatic'}
              onChange={() => setCheckType('automatic')}
            />
            Automatic (file-exists, file-missing, no-match, must-match, command npm run)
          </label>
        </div>
      ) : null}
      <label className="block text-[11px] text-muted">
        Trigger keywords
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          className={area}
          aria-label="Trigger keywords"
        />
      </label>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** Promotion: to one library agent or to everybody. Refused, with the reason shown, while the lesson has no check. */
function Promote({ row, onDone }: { row: Row; onDone: () => void }) {
  const agents = useLibrary((s) => s.agents);
  const refreshLib = useLibrary((s) => s.refresh);
  const refresh = useApp((s) => s.refresh);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => void refreshLib(), [refreshLib]);
  const blocked = row.checkType === 'none' || !row.checkText.trim() || row.status === 'draft';
  if (blocked)
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted" data-promote-blocked>
        <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
        {NEEDS_CHECK}
      </p>
    );
  const go = async () => {
    if (!target) return;
    setBusy(true);
    const res = await window.api.lessons.promote({
      id: row.id,
      target: target === 'global' ? { scope: 'global' } : { scope: 'agent', agentId: target },
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    toast.info(target === 'global' ? 'Promoted to every agent.' : 'Promoted to that agent.');
    void refresh();
    onDone();
  };
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px]" data-promote>
      <select
        aria-label="Promote to"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px]"
      >
        <option value="">Promote to…</option>
        <option value="global">Every agent (global)</option>
        {(agents ?? [])
          .filter((a) => a.status === 'active')
          .map((a) => (
            <option key={a.id} value={a.id}>
              Agent: {a.name}
            </option>
          ))}
      </select>
      <Button variant="primary" disabled={!target || busy} onClick={() => void go()}>
        Promote
      </Button>
      <Button onClick={onDone}>Cancel</Button>
    </div>
  );
}

type Filter = 'all' | 'project' | 'agent' | 'global' | 'needs_rewrite' | 'draft';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'project', label: 'Project' },
  { id: 'agent', label: 'Agent' },
  { id: 'global', label: 'Global' },
  { id: 'needs_rewrite', label: 'Needs rewrite' },
  { id: 'draft', label: 'Draft' },
];

/** Self-improving memory: browse, search, edit, promote and retire what past rejections taught (blueprint Phase 12, M15). */
export function Lessons({ lessons }: { lessons: readonly Lesson[] }) {
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const refresh = useApp((s) => s.refresh);
  const libAgents = useLibrary((s) => s.agents);
  const [library, setLibrary] = useState<LibraryLesson[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const loadLibrary = () =>
    void window.api.lessons.library().then((r) => {
      if (r.ok) setLibrary(r.value);
    });
  useEffect(() => {
    loadLibrary();
    return window.api.onDbChanged(loadLibrary);
  }, []);

  const rows = useMemo(
    // A promoted project lesson is shown once, as its library copy.
    () => [...lessons.filter((l) => !l.promoted_to).map(fromProject), ...library.map(fromLibrary)],
    [lessons, library],
  );
  const counts = useMemo(
    () => ({
      needs_rewrite: rows.filter((r) => r.status === 'needs_rewrite').length,
      draft: rows.filter((r) => r.status === 'draft').length,
    }),
    [rows],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === 'all' ||
          (filter === 'needs_rewrite' || filter === 'draft'
            ? r.status === filter
            : r.scope === filter)) &&
        (!q || matches(r, q)),
    );
  }, [rows, query, filter]);
  const agentName = (id: string | null) => libAgents?.find((a) => a.id === id)?.name ?? id ?? '';

  const remove = async (r: Row) => {
    setDeleting(null);
    const res =
      r.source === 'project'
        ? await window.api.lessons.remove(r.id)
        : await window.api.lessons.updateLibrary({ id: r.id, patch: { status: 'retired' } });
    if (!res.ok) return toast.error(res.error.message);
    void refresh();
    loadLibrary();
    toast.info(r.source === 'project' ? 'Lesson deleted' : 'Lesson retired');
  };
  const retire = async (r: Row) => {
    const res =
      r.source === 'project'
        ? await window.api.lessons.retire(r.id)
        : await window.api.lessons.updateLibrary({ id: r.id, patch: { status: 'retired' } });
    if (!res.ok) return toast.error(res.error.message);
    void refresh();
    loadLibrary();
    toast.info('Lesson retired. It is no longer handed to agents.');
  };

  return (
    <section
      aria-label="Lessons learned"
      className="rounded-lg border border-border bg-surface p-3"
      data-lessons
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
          Lessons learned · <span data-lessons-count>{rows.length}</span>
        </h2>
        <label className="relative">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lessons…"
            aria-label="Search lessons"
            className="w-48 rounded-md border border-border-strong bg-surface-2 py-1 pr-2 pl-7 text-[12px] text-text"
          />
        </label>
      </div>
      <div role="group" aria-label="Filter lessons" className="mb-2 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            data-lesson-filter={f.id}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={
              filter === f.id
                ? 'rounded-full border border-accent bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium text-text'
                : 'rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted hover:text-text'
            }
          >
            {f.label}
            {f.id === 'needs_rewrite' && counts.needs_rewrite > 0
              ? ` (${counts.needs_rewrite})`
              : ''}
            {f.id === 'draft' && counts.draft > 0 ? ` (${counts.draft})` : ''}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-muted">
          No lessons yet. When a task is rejected, what went wrong is saved here, written to{' '}
          <code className="font-mono">.claude/LESSONS_LEARNED.md</code> and handed to similar tasks.
        </p>
      ) : shown.length === 0 ? (
        <p className="py-2 text-muted">No lessons match.</p>
      ) : (
        <ul className="max-h-[480px] space-y-2 overflow-auto pr-1">
          {shown.map((r) => {
            const st = STATUS_TAG[r.status];
            const promoted = r.promotedTo !== null;
            return (
              <li
                key={r.key}
                className="rounded-md border border-border bg-surface-2 p-2.5"
                data-lesson={r.id}
                data-lesson-scope={r.scope}
                data-lesson-status={r.status}
                data-lesson-source={r.source}
              >
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {r.task ? (
                    <button
                      type="button"
                      onClick={() => setOpenTaskId(r.task)}
                      className="text-ink-accent font-mono hover:underline"
                    >
                      {r.task}
                    </button>
                  ) : null}
                  <span className="text-muted">{formatDate(r.createdAt.slice(0, 10))}</span>
                  <Tag color="var(--accent)">
                    {r.scope === 'agent'
                      ? `Agent: ${agentName(r.agentId)}`
                      : r.scope === 'global'
                        ? 'Global'
                        : 'Project'}
                  </Tag>
                  <Tag color={st.color}>{st.label}</Tag>
                  <Tag>{CHECK_LABEL[r.checkType]}</Tag>
                  <span
                    className={r.occurrences >= 2 ? 'text-ink-warning font-semibold' : 'text-muted'}
                    title="How many times the same mistake came back after this lesson was written"
                    data-lesson-occurrences
                  >
                    {r.occurrences}× repeated
                  </span>
                  {promoted ? <span className="text-muted">promoted to {r.promotedTo}</span> : null}
                  <span className="flex-1" />
                  {!promoted ? (
                    <>
                      <Button
                        variant="ghost"
                        aria-label={`Edit lesson ${r.id}`}
                        onClick={() => setEditing(editing === r.key ? null : r.key)}
                      >
                        <Pencil size={12} aria-hidden />
                      </Button>
                      {r.source === 'project' && r.status !== 'retired' ? (
                        <Button
                          variant="ghost"
                          aria-label={`Promote lesson ${r.id}`}
                          title="Promote to an agent or to everybody"
                          onClick={() => setPromoting(promoting === r.key ? null : r.key)}
                        >
                          <ArrowUpFromLine size={12} aria-hidden />
                        </Button>
                      ) : null}
                      {r.status !== 'retired' ? (
                        <Button
                          variant="ghost"
                          aria-label={`Retire lesson ${r.id}`}
                          title="Retire: stop handing it to agents"
                          onClick={() => void retire(r)}
                        >
                          <Archive size={12} aria-hidden />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {r.source === 'project' ? (
                    <Button
                      variant="ghost"
                      aria-label={`Delete lesson ${r.id}`}
                      onClick={() => setDeleting(r)}
                    >
                      <Trash2 size={12} aria-hidden />
                    </Button>
                  ) : null}
                </div>
                {r.status === 'needs_rewrite' ? (
                  <p
                    className="text-ink-warning mt-1 flex items-start gap-1.5 text-[12px]"
                    data-lesson-warning
                  >
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                    This mistake came back {r.occurrences} times. The lesson is not working: rewrite
                    it so it is clearer or checkable.
                  </p>
                ) : null}
                {editing === r.key ? (
                  <Editor row={r} onDone={() => setEditing(null)} />
                ) : (
                  <>
                    <p className="mt-1 text-[12px] font-medium whitespace-pre-wrap">{r.reason}</p>
                    <Field label="Fix:" value={r.fix} />
                    <Field label="Prevention:" value={r.prevention} />
                    {r.checkText ? <Field label="Check:" value={r.checkText} /> : null}
                    {r.keywords ? <Field label="Keywords:" value={r.keywords} /> : null}
                  </>
                )}
                {promoting === r.key ? <Promote row={r} onDone={() => setPromoting(null)} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this lesson?"
        body="It is removed from the lessons table and from .claude/LESSONS_LEARNED.md, and will no longer be handed to similar tasks."
        confirmLabel="Delete"
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
