import { CalendarDays, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Task, TrackerState } from '@command-center/core';
import { HydrationEmptyState } from '../../components/HydrationEmptyState';
import { AgentAvatar } from '../../components/ui/agent';
import { DomainTag } from '../../components/ui/badges';
import { Button } from '../../components/ui/button';
import { addDays, buildWeek, clock, dayKey, parseDayKey } from '../../lib/calendar';
import { useNow } from '../../lib/hooks';
import { domainColor } from '../../lib/status';
import { useApp } from '../../store';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

function Chip({
  task,
  domain,
  color,
  agent,
  onOpen,
}: {
  task: Task;
  domain: string;
  color: string;
  agent: Agent | undefined;
  onOpen: (id: string) => void;
}) {
  const when = task.completed_at ? clock(task.completed_at) : '';
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      title={`${task.label} · ${task.id} · done ${when}`}
      data-chip={task.id}
      className="flex w-full flex-col gap-1 rounded-md border border-border bg-surface-2 py-1.5 pr-2 pl-2.5 text-left hover:bg-surface-3"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <span className="flex items-center gap-1.5">
        <Check size={12} aria-hidden className="shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{task.label}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <DomainTag domain={domain} color={color} />
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted">{when}</span>
        {agent ? <AgentAvatar agent={agent} size={20} /> : null}
      </span>
    </button>
  );
}

/** Calendar (UI/UX §6.4): what did we actually finish, and when? Done tasks by local completion day. */
export function Calendar({ tracker }: { tracker: TrackerState }) {
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const nowMs = useNow(60_000);
  const todayKey = dayKey(new Date(nowMs));
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // `todayKey` is the only part of "now" the grid needs: it moves the today marker at local midnight.
  const week = useMemo(
    () => buildWeek(tracker.subtasks, anchor, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- todayKey re-evaluates "today" at local midnight
    [tracker.subtasks, anchor, todayKey],
  );
  const milestones = useMemo(
    () => new Map(tracker.milestones.map((m) => [m.id, m])),
    [tracker.milestones],
  );
  const domains = useMemo(
    () => [...new Set(tracker.milestones.map((m) => m.domain))],
    [tracker.milestones],
  );
  const agents = useMemo(() => new Map(tracker.agents.map((a) => [a.id, a])), [tracker.agents]);

  const go = (days: number) => setAnchor((a) => addDays(a, days));

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
      if (e.key === 'ArrowLeft') setAnchor((a) => addDays(a, -7));
      else if (e.key === 'ArrowRight') setAnchor((a) => addDays(a, 7));
      else if (e.key === 't' || e.key === 'T') setAnchor(new Date());
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) =>
      !pickerRef.current?.contains(e.target as Node) && setPickerOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [pickerOpen]);

  if (tracker.milestones.length === 0) {
    return (
      <section className="h-full p-6">
        <h1 className="sr-only">Calendar</h1>
        <HydrationEmptyState />
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col" aria-label="Calendar">
      <h1 className="sr-only">Calendar</h1>
      <header className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button
          variant="ghost"
          onClick={() => go(-7)}
          aria-label="Previous week"
          title="Previous week (←)"
        >
          <ChevronLeft size={16} aria-hidden />
        </Button>
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-expanded={pickerOpen}
          aria-haspopup="dialog"
          className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[14px] font-semibold hover:bg-surface-2"
          data-week-label
        >
          <CalendarDays size={14} aria-hidden className="text-muted" />
          {week.label}
          <span className="font-normal text-muted" data-week-count>
            · {week.total} completed
          </span>
        </button>
        <Button variant="ghost" onClick={() => go(7)} aria-label="Next week" title="Next week (→)">
          <ChevronRight size={16} aria-hidden />
        </Button>
        <Button onClick={() => setAnchor(new Date())} title="Jump to this week (T)">
          Today
        </Button>
        {pickerOpen ? (
          <div
            ref={pickerRef}
            role="dialog"
            aria-label="Choose a date"
            className="absolute top-11 left-14 z-30 rounded-lg border border-border-strong bg-surface-2 p-3 shadow-pop"
          >
            <label className="block text-[11px] text-muted">
              Go to the week containing
              <input
                type="date"
                autoFocus
                defaultValue={dayKey(anchor)}
                onChange={(e) => {
                  const d = parseDayKey(e.target.value);
                  if (d) {
                    setAnchor(d);
                    setPickerOpen(false);
                  }
                }}
                className="mt-1 block rounded-md border border-border-strong bg-surface px-2 py-1 font-mono text-[12px] text-text"
              />
            </label>
          </div>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="grid min-h-full min-w-[980px] grid-cols-7" data-week-grid>
          {week.days.map((d) => (
            <div
              key={d.key}
              data-day={d.key}
              data-today={d.isToday ? 'true' : undefined}
              data-weekend={d.isWeekend ? 'true' : undefined}
              className={`flex min-w-0 flex-col border-r border-border last:border-r-0 ${d.isToday ? 'bg-surface-2' : ''}`}
              style={d.isWeekend ? { opacity: 0.8 } : undefined}
            >
              <div
                className={`sticky top-0 z-10 border-b border-border bg-bg px-3 py-2 ${d.isToday ? 'border-t-2 border-t-accent' : 'border-t-2 border-t-transparent'}`}
                data-day-header
              >
                <span className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
                  {d.dow}
                </span>
                <span className={`ml-1.5 font-mono text-[16px] ${d.isToday ? 'text-accent' : ''}`}>
                  {d.date.getDate()}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-2">
                {d.tasks.length === 0 ? (
                  <span className="py-2 text-center text-muted">—</span>
                ) : null}
                {d.tasks.map((t) => {
                  const domain = milestones.get(t.milestone_id)?.domain ?? 'general';
                  return (
                    <Chip
                      key={t.id}
                      task={t}
                      domain={domain}
                      color={domainColor(domain, domains)}
                      agent={t.assignee ? agents.get(t.assignee) : undefined}
                      onOpen={setOpenTaskId}
                    />
                  );
                })}
              </div>
              <div
                className="border-t border-border px-3 py-1.5 text-[11px] text-muted"
                data-day-count
              >
                {d.tasks.length} done
              </div>
            </div>
          ))}
        </div>
        {week.total === 0 ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-2 text-center"
            data-calendar-empty
          >
            <p className="text-[14px] font-semibold">Nothing completed this week</p>
            <Button className="pointer-events-auto" onClick={() => go(-7)}>
              <ChevronLeft size={14} aria-hidden /> Previous week
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
