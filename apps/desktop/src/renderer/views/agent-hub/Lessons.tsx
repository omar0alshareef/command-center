import { Pencil, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Lesson } from '@command-center/core';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/overlays';
import { formatDate } from '../../lib/time';
import { useApp } from '../../store';
import { toast } from '../../toast';

const matches = (l: Lesson, q: string) =>
  [l.subtask_id, l.rejection_reason, l.fix_applied, l.prevention].some((f) =>
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

function Editor({ lesson, onDone }: { lesson: Lesson; onDone: () => void }) {
  const refresh = useApp((s) => s.refresh);
  const [reason, setReason] = useState(lesson.rejection_reason);
  const [fix, setFix] = useState(lesson.fix_applied);
  const [prevention, setPrevention] = useState(lesson.prevention);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!reason.trim()) return toast.error('A lesson needs a reason.');
    setBusy(true);
    const res = await window.api.lessons.update({
      id: lesson.id,
      patch: { rejection_reason: reason, fix_applied: fix, prevention },
    });
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
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** Self-improving memory: browse, search, edit and delete what past rejections taught (blueprint Phase 12). */
export function Lessons({ lessons }: { lessons: readonly Lesson[] }) {
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const refresh = useApp((s) => s.refresh);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Lesson | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? lessons.filter((l) => matches(l, q)) : lessons;
  }, [lessons, query]);

  const remove = async (l: Lesson) => {
    setDeleting(null);
    const res = await window.api.lessons.remove(l.id);
    if (!res.ok) return toast.error(res.error.message);
    void refresh();
    toast.info('Lesson deleted');
  };

  return (
    <section
      aria-label="Lessons learned"
      className="rounded-lg border border-border bg-surface p-3"
      data-lessons
    >
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
          Lessons learned · <span data-lessons-count>{lessons.length}</span>
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
      {lessons.length === 0 ? (
        <p className="py-2 text-muted">
          No lessons yet. When a task is rejected, what went wrong is saved here, written to{' '}
          <code className="font-mono">.claude/LESSONS_LEARNED.md</code> and handed to similar tasks.
        </p>
      ) : shown.length === 0 ? (
        <p className="py-2 text-muted">No lessons match “{query}”.</p>
      ) : (
        <ul className="max-h-[420px] space-y-2 overflow-auto pr-1">
          {shown.map((l) => (
            <li
              key={l.id}
              className="rounded-md border border-border bg-surface-2 p-2.5"
              data-lesson={l.id}
            >
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => setOpenTaskId(l.subtask_id)}
                  className="font-mono text-accent hover:underline"
                >
                  {l.subtask_id}
                </button>
                <span className="text-muted">{formatDate(l.created_at.slice(0, 10))}</span>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  aria-label={`Edit lesson ${l.id}`}
                  onClick={() => setEditing(editing === l.id ? null : l.id)}
                >
                  <Pencil size={12} aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete lesson ${l.id}`}
                  onClick={() => setDeleting(l)}
                >
                  <Trash2 size={12} aria-hidden />
                </Button>
              </div>
              {editing === l.id ? (
                <Editor lesson={l} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <p className="mt-1 text-[12px] font-medium whitespace-pre-wrap">
                    {l.rejection_reason}
                  </p>
                  <Field label="Fix:" value={l.fix_applied} />
                  <Field label="Prevention:" value={l.prevention} />
                </>
              )}
            </li>
          ))}
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
