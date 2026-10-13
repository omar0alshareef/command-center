import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardList, Plus, Square } from 'lucide-react';
import type { PlannerStage, PlanningSession } from '@command-center/core';
import type { PlannerEvent, PlanningView } from '../../../shared/ipc';
import { Button } from '../../components/ui/button';
import { Tag } from '../../components/ui/badges';
import { EmptyState } from '../../components/ui/feedback';
import { ConfirmDialog } from '../../components/ui/overlays';
import { cn } from '../../lib/cn';
import { toast } from '../../toast';
import { DraftPanel } from './DraftPanel';

const STATUS_COLOR: Record<PlanningSession['status'], string> = {
  interviewing: 'var(--accent)',
  drafting: 'var(--warning)',
  review: 'var(--warning)',
  approved: 'var(--success)',
  abandoned: 'var(--muted)',
};

const STAGE_LABEL: Record<PlannerStage, string> = {
  interview: 'Thinking of questions',
  draft_manifesto: 'Drafting the manifesto',
  draft_roadmap: 'Drafting the roadmap',
  plan_stages: 'Planning milestones and stages',
  plan_tasks: 'Planning tasks',
  propose_team: 'Proposing the team',
};

interface Live {
  stage: PlannerStage | null;
  output: string;
  notice: string | null;
}

/** Last selected session, so a restart resumes where the operator was. Storage may be unavailable. */
const SAVED = 'cc-planning-session';
const loadSaved = () => {
  try {
    return localStorage.getItem(SAVED);
  } catch {
    return null;
  }
};
const save = (id: string | null) => {
  try {
    if (id) localStorage.setItem(SAVED, id);
    else localStorage.removeItem(SAVED);
  } catch {
    /* per-viewer convenience only */
  }
};

/** The session list and, if it still exists, the selected session's detail. */
async function fetchPlans(id: string | null) {
  const list = await window.api.planning.list();
  if (!list.ok) return { list: null, view: null };
  if (!id || !list.value.some((s) => s.id === id)) return { list: list.value, view: null };
  const v = await window.api.planning.get(id);
  return { list: list.value, view: v.ok ? v.value : null };
}

async function call<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
) {
  const r = await p;
  if (!r.ok) {
    toast.error(r.error.message);
    return null;
  }
  return r.value;
}

export function Planning() {
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [selected, setSelected] = useState<string | null>(loadSaved);
  const [view, setView] = useState<PlanningView | null>(null);
  const [composing, setComposing] = useState(false);
  const [live, setLive] = useState<Record<string, Live>>({});
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(() => {
    const id = selectedRef.current;
    void fetchPlans(id).then(({ list, view: v }) => {
      if (selectedRef.current !== id || !list) return;
      setSessions(list);
      setView(v);
      if (id && !list.some((s) => s.id === id)) setSelected(null);
    });
  }, []);

  useEffect(() => {
    let live = true;
    void fetchPlans(selected).then(({ list, view: v }) => {
      if (!live || !list) return;
      setSessions(list);
      setView(v);
    });
    return () => {
      live = false;
    };
  }, [selected]);

  useEffect(() => {
    const offDb = window.api.onDbChanged(load);
    const offEv = window.api.planning.onEvent((e: PlannerEvent) => {
      setLive((prev) => {
        const cur = prev[e.sessionId] ?? { stage: null, output: '', notice: null };
        if (e.type === 'stage')
          return { ...prev, [e.sessionId]: { stage: e.stage, output: '', notice: cur.notice } };
        if (e.type === 'chunk')
          return {
            ...prev,
            [e.sessionId]: { ...cur, output: (cur.output + e.text).slice(-20_000) },
          };
        if (e.type === 'notice') return { ...prev, [e.sessionId]: { ...cur, notice: e.text } };
        return { ...prev, [e.sessionId]: { ...cur, stage: null } };
      });
      if (e.type !== 'chunk') load();
    });
    return () => {
      offDb();
      offEv();
    };
  }, [load]);

  const select = (id: string | null) => {
    setComposing(false);
    setSelected(id);
    save(id);
  };

  return (
    <div className="flex h-full min-h-0">
      <aside
        className="flex w-[232px] shrink-0 flex-col border-r border-border"
        aria-label="Planning sessions"
      >
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
            Plans
          </h2>
          <Button
            variant="ghost"
            onClick={() => setComposing(true)}
            aria-label="New plan"
            title="New plan"
          >
            <Plus size={14} aria-hidden /> New
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => select(s.id)}
                aria-current={s.id === selected && !composing ? 'true' : undefined}
                className={cn(
                  'mb-1 w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2',
                  s.id === selected && !composing && 'bg-surface-2',
                )}
              >
                <span className="block truncate text-[13px]">{s.title}</span>
                <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                  <Tag color={STATUS_COLOR[s.status]}>{s.status}</Tag>
                  {new Date(s.created_at).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {composing || (!view && sessions.length === 0) ? (
        <Composer
          onCreated={(s) => {
            select(s.id);
          }}
        />
      ) : view ? (
        // One key for the pair: a new session remounts both (fresh drafts, fresh edit state).
        <Fragment key={view.session.id}>
          <Interview view={view} live={live[view.session.id]} />
          <DraftPanel view={view} />
        </Fragment>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={ClipboardList}
            title="Pick a plan"
            help="Choose a session on the left, or start a new one."
          />
        </div>
      )}
    </div>
  );
}

function Composer({ onCreated }: { onCreated: (s: PlanningSession) => void }) {
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!idea.trim() || busy) return;
    setBusy(true);
    const s = await call(window.api.planning.create({ idea }));
    setBusy(false);
    if (s) onCreated(s);
  };
  return (
    <section className="flex flex-1 flex-col items-center justify-center p-8" aria-label="New plan">
      <div className="w-full max-w-[640px]">
        <h2 className="text-[16px] font-semibold">Start a plan</h2>
        <p className="mt-1 text-muted">
          Describe the idea in a paragraph. The planner asks questions first, then drafts a
          manifesto, roadmap, milestones, tasks and a team. Nothing reaches the board until you
          approve it.
        </p>
        <label htmlFor="plan-idea" className="sr-only">
          Idea
        </label>
        <textarea
          id="plan-idea"
          autoFocus
          rows={7}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
          }}
          placeholder="A booking app for small yoga studios: members book classes, studios manage schedules…"
          className="mt-4 w-full rounded-md border border-border bg-surface-2 px-3 py-2 hover:border-border-strong"
        />
        <div className="mt-3 flex items-center justify-end gap-3">
          <span className="text-[11px] text-muted">Ctrl+Enter</span>
          <Button variant="primary" disabled={!idea.trim() || busy} onClick={() => void submit()}>
            Start interview
          </Button>
        </div>
      </div>
    </section>
  );
}

function Interview({ view, live }: { view: PlanningView; live: Live | undefined }) {
  const { session } = view;
  const id = session.id;
  const open = session.status !== 'approved' && session.status !== 'abandoned';
  const running = view.running;
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live?.output]);

  const value = (i: number) => drafts[i] ?? session.requirements[i]?.answer ?? '';
  const commit = async (i: number) => {
    const d = drafts[i];
    if (d === undefined || d === (session.requirements[i]?.answer ?? '')) return;
    await call(window.api.planning.answer({ id, index: i, answer: d }));
  };
  const commitAll = async () => {
    for (const k of Object.keys(drafts)) await commit(Number(k));
  };
  const send = async () => {
    await commitAll();
    await call(window.api.planning.interview(id));
  };
  const draftNow = async () => {
    await commitAll();
    await call(window.api.planning.draft(id));
  };
  const unanswered = session.requirements.filter(
    (r, i) => !(drafts[i] ?? r.answer ?? '').trim(),
  ).length;

  return (
    <section className="flex min-w-0 flex-1 flex-col border-r border-border" aria-label="Interview">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{session.title}</h2>
        <Tag color={STATUS_COLOR[session.status]}>{session.status}</Tag>
        {open ? (
          <Button variant="ghost" onClick={() => setConfirmAbandon(true)}>
            Abandon
          </Button>
        ) : null}
      </header>
      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-label="Conversation">
        <li className="ml-auto max-w-[85%] rounded-lg bg-accent/15 px-3 py-2 whitespace-pre-wrap">
          {session.idea}
        </li>
        {session.requirements.map((r, i) => (
          <li key={i} className="space-y-1.5">
            <p className="max-w-[85%] rounded-lg bg-surface-2 px-3 py-2">
              <span className="sr-only">Planner asks: </span>
              {r.question}
            </p>
            <label htmlFor={`answer-${i}`} className="sr-only">
              Answer to: {r.question}
            </label>
            <textarea
              id={`answer-${i}`}
              rows={2}
              disabled={!open}
              value={value(i)}
              onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
              onBlur={() => void commit(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !running) void send();
              }}
              placeholder="Your answer"
              className="ml-auto block w-[85%] rounded-md border border-border bg-surface-2 px-2 py-1.5 hover:border-border-strong disabled:opacity-70"
            />
          </li>
        ))}
        {running ? (
          <li aria-live="polite" className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <span className="skeleton inline-block size-2 rounded-full" aria-hidden />
              <span className="flex-1">{STAGE_LABEL[running]}…</span>
              <Button onClick={() => void call(window.api.planning.cancel(id))}>
                <Square size={12} aria-hidden /> Cancel
              </Button>
            </div>
            {live?.output ? (
              <pre
                ref={logRef}
                aria-label="Planner output"
                className="mt-2 max-h-48 overflow-y-auto font-mono text-[11px] whitespace-pre-wrap text-muted"
              >
                {live.output}
              </pre>
            ) : null}
          </li>
        ) : null}
        {live?.notice ? (
          <li role="status" className="rounded-md border border-warning px-3 py-2 text-warning">
            {live.notice}
          </li>
        ) : null}
        {session.last_error && !running ? (
          <li role="alert" className="rounded-md border border-danger px-3 py-2">
            <p className="font-semibold text-danger">The planner's output was not used</p>
            <pre className="mt-1 font-mono text-[12px] whitespace-pre-wrap">
              {session.last_error}
            </pre>
            <p className="mt-1 text-muted">
              Nothing was written to the board. Retry, or edit the drafts by hand.
            </p>
          </li>
        ) : null}
      </ol>
      {open ? (
        <footer className="flex items-center gap-2 border-t border-border px-4 py-2">
          <span className="flex-1 text-[12px] text-muted">
            {session.status === 'interviewing'
              ? unanswered > 0
                ? `${unanswered} unanswered · Ctrl+Enter sends`
                : 'All answered'
              : session.status === 'review'
                ? 'Drafts ready for review'
                : ''}
          </span>
          {session.status === 'interviewing' ? (
            <Button disabled={Boolean(running)} onClick={() => void send()}>
              {session.requirements.length === 0 ? 'Ask questions' : 'Send answers'}
            </Button>
          ) : null}
          <Button
            variant={session.status === 'interviewing' ? 'primary' : 'default'}
            disabled={Boolean(running) || session.requirements.length === 0}
            onClick={() => void draftNow()}
          >
            {session.status === 'interviewing' ? 'Draft plan now' : 'Redraft'}
          </Button>
        </footer>
      ) : null}
      <ConfirmDialog
        open={confirmAbandon}
        title="Abandon this plan?"
        body="The drafts stay readable, the staged proposal is discarded, and nothing is written to the board."
        confirmLabel="Abandon"
        onCancel={() => setConfirmAbandon(false)}
        onConfirm={() => {
          setConfirmAbandon(false);
          void call(window.api.planning.abandon(id));
        }}
      />
    </section>
  );
}
