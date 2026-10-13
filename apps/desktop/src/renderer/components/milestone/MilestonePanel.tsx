import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '../ui/button';
import { Markdown } from '../ui/markdown';
import { roadmapSection } from '../../lib/planning';
import { DomainTag, StatusDot, Tag } from '../ui/badges';
import { SlidePanel } from '../ui/overlays';
import { ProgressRing } from '../ui/progress-ring';
import { createTask } from '../../lib/task-actions';
import { domainColor, STATUS_META } from '../../lib/status';
import { formatDate, relativeTime } from '../../lib/time';
import { toast } from '../../toast';
import { useApp } from '../../store';

type DateKey = 'planned_start' | 'planned_end' | 'actual_start' | 'actual_end';
const DATE_FIELDS: { key: DateKey; label: string }[] = [
  { key: 'planned_start', label: 'Planned start' },
  { key: 'planned_end', label: 'Planned end' },
  { key: 'actual_start', label: 'Actual start' },
  { key: 'actual_end', label: 'Actual end' },
];

const H = 'text-[11px] font-semibold tracking-[0.06em] text-muted uppercase';

/** Right-anchored Milestone Panel (UI/UX §6.1): summary, dependencies, tasks, dates and notes. */
export function MilestonePanel() {
  const id = useApp((s) => s.openMilestoneId);
  const intent = useApp((s) => s.panelIntent);
  const tracker = useApp((s) => s.tracker);
  const openMilestone = useApp((s) => s.openMilestone);
  const clearIntent = useApp((s) => s.clearPanelIntent);
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const refresh = useApp((s) => s.refresh);

  // Keep the last milestone while the panel slides out.
  const [shown, setShown] = useState(id);
  if (id && id !== shown) setShown(id);
  const m = tracker?.milestones.find((x) => x.id === shown) ?? null;

  // A milestone deleted underneath the panel closes it.
  useEffect(() => {
    if (id && tracker && !m) openMilestone(null);
  }, [id, tracker, m, openMilestone]);

  const tasks = useMemo(
    () => (tracker && m ? tracker.subtasks.filter((t) => t.milestone_id === m.id) : []),
    [tracker, m],
  );
  const domains = useMemo(
    () => [...new Set((tracker?.milestones ?? []).map((x) => x.domain))],
    [tracker],
  );
  const agents = useMemo(() => new Map((tracker?.agents ?? []).map((a) => [a.id, a])), [tracker]);

  // The approved roadmap's entry for this milestone (M13). Read when the panel opens.
  const [roadmap, setRoadmap] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void window.api.planning.approvedDocuments().then((r) => {
      if (live)
        setRoadmap(r.ok ? (r.value.find((d) => d.kind === 'roadmap')?.content ?? null) : null);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const entry = roadmap && m ? roadmapSection(roadmap, m.id, m.title) : null;

  const addRef = useRef<HTMLInputElement>(null);
  const datesRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!id || !intent) return;
    if (intent === 'add-task') setTimeout(() => addRef.current?.focus(), 220);
    if (intent === 'dates') {
      if (datesRef.current) datesRef.current.open = true;
      setTimeout(() => datesRef.current?.querySelector('input')?.focus(), 220);
    }
    clearIntent();
  }, [id, intent, clearIntent]);

  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [prevId, setPrevId] = useState(id);
  if (id !== prevId) {
    setPrevId(id);
    setLabel('');
    setNote('');
  }

  const done = tasks.filter((t) => t.status === 'done').length;
  const color = m ? domainColor(m.domain, domains) : 'var(--muted)';

  const submitTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!m || !label.trim() || busy) return;
    setBusy(true);
    const t = await createTask(m.id, label.trim());
    setBusy(false);
    if (t) setLabel('');
  };
  const submitNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!m || !note.trim() || busy) return;
    setBusy(true);
    const res = await window.api.milestones.addNote({ milestoneId: m.id, text: note.trim() });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    setNote('');
    void refresh();
  };
  const saveDate = async (key: DateKey, value: string) => {
    if (!m || value === (m[key] ?? '')) return;
    const res = await window.api.milestones.setDates({
      milestoneId: m.id,
      dates: { [key]: value || null },
    });
    if (!res.ok) toast.error(res.error.message);
    void refresh();
  };

  return (
    <SlidePanel
      open={id !== null}
      onClose={() => openMilestone(null)}
      label="Milestone details"
      dim
      className="top-0"
    >
      {m ? (
        <div className="flex h-full flex-col" data-milestone-panel={m.id}>
          <header className="border-b border-border p-5 pr-12">
            <div className="flex items-center gap-3">
              <ProgressRing
                size={44}
                value={tasks.length ? done / tasks.length : 0}
                color={color}
                label={`${done}/${tasks.length}`}
              />
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-muted">{m.id}</div>
                <h2 className="font-display text-[16px] leading-tight font-semibold break-words">
                  {m.title}
                </h2>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DomainTag domain={m.domain} color={color} />
              <Tag>W{m.week}</Tag>
              {m.phase ? <Tag>{m.phase}</Tag> : null}
              {m.is_key_milestone ? (
                <Tag color="var(--warning)">◆ {m.key_milestone_label ?? 'Key'}</Tag>
              ) : null}
              {m.drift_days !== 0 ? (
                <Tag color={m.drift_days > 0 ? 'var(--danger)' : 'var(--success)'}>
                  {m.drift_days > 0 ? `+${m.drift_days}d behind` : `${-m.drift_days}d ahead`}
                </Tag>
              ) : null}
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
            <section aria-label="Dates">
              <h3 className={H}>Dates</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                {DATE_FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt className="text-muted">{f.label}</dt>
                    <dd className="font-mono">{formatDate(m[f.key])}</dd>
                  </div>
                ))}
              </dl>
              <details key={m.id} ref={datesRef} className="mt-2">
                <summary className="cursor-pointer text-[12px] text-accent">Edit dates</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {DATE_FIELDS.map((f) => (
                    <label key={f.key} className="text-[11px] text-muted">
                      {f.label}
                      <input
                        type="date"
                        defaultValue={m[f.key] ?? ''}
                        key={`${m.id}-${f.key}-${m[f.key] ?? ''}`}
                        onChange={(e) =>
                          e.target.validity.valid && void saveDate(f.key, e.target.value)
                        }
                        className="mt-0.5 block w-full rounded-md border border-border-strong bg-surface-2 px-2 py-1 font-mono text-[12px] text-text"
                      />
                    </label>
                  ))}
                </div>
              </details>
            </section>

            {entry ? (
              <section aria-label="Roadmap entry">
                <h3 className={H}>Roadmap</h3>
                <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border p-3">
                  <Markdown source={entry} />
                </div>
              </section>
            ) : null}

            <section aria-label="Dependencies">
              <h3 className={H}>Depends on</h3>
              {m.dependencies.length === 0 ? (
                <p className="mt-1 text-[12px] text-muted">No dependencies.</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {m.dependencies.map((d) => {
                    const dep = tracker?.milestones.find((x) => x.id === d);
                    return (
                      <li key={d}>
                        <Button
                          onClick={() => dep && openMilestone(d)}
                          disabled={!dep}
                          title={dep?.title}
                        >
                          <span className="font-mono">{d}</span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section aria-label="Tasks">
              <h3 className={H}>
                Tasks · {done}/{tasks.length}
              </h3>
              {tasks.length === 0 ? (
                <p className="mt-1 text-[12px] text-muted">No tasks yet.</p>
              ) : null}
              <ul className="mt-2 space-y-1">
                {tasks.map((t) => {
                  const meta = STATUS_META[t.status];
                  const a = t.assignee ? agents.get(t.assignee) : undefined;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setOpenTaskId(t.id)}
                        data-task-row={t.id}
                        className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-left hover:bg-surface-3"
                      >
                        <StatusDot color={meta.color} pulse={t.status === 'in_progress'} />
                        <span className="font-mono text-[11px] text-muted">{t.id}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px]">{t.label}</span>
                        <span className="text-[10px] font-semibold tracking-[0.06em] text-muted">
                          {meta.label}
                        </span>
                        {a ? <span className="text-[11px] text-muted">{a.name}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <form onSubmit={submitTask} className="mt-2 flex gap-2">
                <input
                  ref={addRef}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Add a task…"
                  aria-label="New task label"
                  className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-2.5 py-1.5 text-[12px] text-text"
                />
                <Button type="submit" disabled={!label.trim() || busy}>
                  Add
                </Button>
              </form>
            </section>

            <section aria-label="Notes">
              <h3 className={H}>Notes</h3>
              {m.notes.length === 0 ? (
                <p className="mt-1 text-[12px] text-muted">No notes yet.</p>
              ) : null}
              <ul className="mt-2 space-y-2">
                {m.notes.map((n, i) => (
                  <li
                    key={`${n.at}-${i}`}
                    className="rounded-md border border-border bg-surface-2 px-2.5 py-2"
                  >
                    {/* Agent-written text: rendered as plain text only. */}
                    <p className="text-[12px] break-words whitespace-pre-wrap">{n.text}</p>
                    <p className="mt-1 text-[10px] text-muted">
                      {agents.get(n.author)?.name ?? n.author} · {relativeTime(n.at)}
                    </p>
                  </li>
                ))}
              </ul>
              <form onSubmit={submitNote} className="mt-2 space-y-2">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a note…"
                  aria-label="New note"
                  rows={2}
                  className="w-full resize-y rounded-md border border-border-strong bg-surface-2 px-2.5 py-1.5 text-[12px] text-text"
                />
                <Button type="submit" disabled={!note.trim() || busy}>
                  Add note
                </Button>
              </form>
            </section>
          </div>
        </div>
      ) : null}
    </SlidePanel>
  );
}
