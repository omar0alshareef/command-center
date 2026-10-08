import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { ArrowUp, Search } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentLogEntry, TrackerState } from '@command-center/core';
import { AgentAvatar } from '../../components/ui/agent';
import { StatusDot, Tag } from '../../components/ui/badges';
import { Button } from '../../components/ui/button';
import {
  clockTime,
  ENTRY_H,
  flattenFeed,
  isConnectedAgent,
  itemHeight,
  localDay,
  matchesFilter,
  matchesSearch,
  mergeLog,
  type FeedItem,
} from '../../lib/agent-hub';
import { useNow } from '../../lib/hooks';
import { DOMAIN_COLORS } from '../../lib/status';
import { useApp } from '../../store';

const colorFor = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DOMAIN_COLORS[h % DOMAIN_COLORS.length] ?? 'var(--muted)';
};

const lastHeaderAtOrBefore = (headers: readonly number[], index: number): number | undefined => {
  let found: number | undefined;
  for (const h of headers) {
    if (h > index) break;
    found = h;
  }
  return found;
};

const Entry = memo(function Entry({
  entry,
  agent,
  fresh,
  onTask,
  onMilestone,
}: {
  entry: AgentLogEntry;
  agent: Agent | undefined;
  fresh: boolean;
  onTask: (id: string) => void;
  onMilestone: (id: string) => void;
}) {
  const target = entry.target_id;
  const open = target && entry.target_type === 'subtask' ? onTask : target && entry.target_type === 'milestone' ? onMilestone : null;
  const link =
    target && open ? (
      <button type="button" onClick={() => open(target)} className="font-mono text-[11px] text-accent hover:underline">
        {target}
      </button>
    ) : target ? (
      <span className="font-mono text-[11px] text-muted">{target}</span>
    ) : null;
  const name = agent?.name ?? entry.agent_id;
  return (
    <div
      className={`flex h-full items-start gap-2 border-b border-border px-3 py-2 ${fresh ? 'feed-flash' : ''}`}
      data-feed-entry={entry.id}
      data-agent={entry.agent_id}
    >
      <AgentAvatar agent={agent ?? { name, color: 'var(--muted)', type: 'external' }} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold">{name}</span>
          <Tag color={colorFor(entry.action)}>{entry.action}</Tag>
          {entry.tags.slice(0, 3).map((t) => (
            <Tag key={t} color={colorFor(t)}>
              {t}
            </Tag>
          ))}
          <span className="flex-1" />
          {link}
          <span className="font-mono text-[11px] text-muted" title={new Date(entry.timestamp).toLocaleString()}>
            {clockTime(entry.timestamp)}
          </span>
        </div>
        {/* Agent-written text: rendered as plain text only. */}
        <p className="mt-0.5 truncate text-[12px] text-muted" title={entry.description ?? undefined}>
          {entry.description ?? ''}
        </p>
      </div>
    </div>
  );
});

/** Activity Feed: filter tabs, search, day groups with sticky headers, virtualized rows, "↑ n new" pill, load older. */
export function ActivityFeed({ tracker }: { tracker: TrackerState }) {
  const filter = useApp((s) => s.hubFilter);
  const setFilter = useApp((s) => s.setHubFilter);
  const olderLog = useApp((s) => s.olderLog);
  const olderDone = useApp((s) => s.olderDone);
  const olderLoading = useApp((s) => s.olderLoading);
  const loadOlder = useApp((s) => s.loadOlder);
  const setOpenTaskId = useApp((s) => s.setOpenTaskId);
  const openMilestone = useApp((s) => s.openMilestone);

  const [query, setQuery] = useState('');
  const agentsById = useMemo(() => new Map(tracker.agents.map((a) => [a.id, a])), [tracker.agents]);
  const connected = useMemo(() => tracker.agents.filter(isConnectedAgent).sort((a, b) => a.name.localeCompare(b.name)), [tracker.agents]);

  const all = useMemo(() => mergeLog(tracker.agent_log, olderLog), [tracker.agent_log, olderLog]);
  const rows = useMemo(() => all.filter((e) => matchesFilter(e, filter) && matchesSearch(e, query, agentsById)), [all, filter, query, agentsById]);
  const today = localDay(new Date(useNow(60_000)));
  const items = useMemo<FeedItem[]>(() => flattenFeed(rows, new Date()), [rows, today]); // eslint-disable-line react-hooks/exhaustive-deps -- `today` re-labels the day headers at midnight
  const headers = useMemo(() => items.flatMap((it, i) => (it.kind === 'header' ? [i] : [])), [items]);

  // ----- new-entry pill and scroll anchoring -----
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewKey = `${filter}\u0000${query}`;
  const [atTop, setAtTop] = useState(true);
  const [topSeen, setTopSeen] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState(viewKey);
  const newest = rows[0]?.id ?? null;
  if (lastKey !== viewKey) {
    setLastKey(viewKey);
    setAtTop(true);
    setTopSeen(newest);
  } else if (atTop && topSeen !== newest) setTopSeen(newest);
  const newCount = !atTop && topSeen ? Math.max(0, rows.findIndex((e) => e.id === topSeen)) : 0;

  const prev = useRef({ items, key: viewKey });
  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = { items, key: viewKey };
    const el = scrollRef.current;
    if (!el) return;
    if (p.key !== viewKey) {
      el.scrollTop = 0;
      return;
    }
    if (el.scrollTop <= 8) return;
    // Entries arrived above the viewport: shift by exactly their height so nothing moves under the reader.
    const anchor = p.items.find((i) => i.kind === 'entry');
    if (!anchor || anchor.kind !== 'entry') return;
    const offset = (list: FeedItem[]) => {
      let y = 0;
      for (const it of list) {
        if (it.kind === 'entry' && it.entry.id === anchor.entry.id) return y;
        y += itemHeight(it);
      }
      return -1;
    };
    const before = offset(p.items);
    const after = offset(items);
    if (before >= 0 && after >= 0 && after !== before) el.scrollTop += after - before;
  }, [items, viewKey]);

  // ----- flash for entries that arrive while the hub is open -----
  const [seen, setSeen] = useState<{ all: AgentLogEntry[]; ids: Set<string>; fresh: Set<string> } | null>(null);
  if (seen?.all !== all) {
    const ids = new Set(all.map((e) => e.id));
    // Older pages are not "new": only rows newer than anything seen before count.
    const fresh = seen ? new Set(all.filter((e) => !seen.ids.has(e.id) && e.timestamp >= (seen.all[0]?.timestamp ?? '')).map((e) => e.id)) : new Set<string>();
    setSeen({ all, ids, fresh });
  }
  const freshIds = seen?.fresh;
  useEffect(() => {
    if (!freshIds || freshIds.size === 0) return;
    const t = setTimeout(() => setSeen((s) => (s ? { ...s, fresh: new Set() } : s)), 2500);
    return () => clearTimeout(t);
  }, [freshIds]);

  // ----- virtualization (fixed row heights keep the anchoring math exact) -----
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer's functions are only used inside this component's render
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i] ? itemHeight(items[i]) : ENTRY_H),
    overscan: 8,
    getItemKey: (i) => {
      const it = items[i];
      return it ? (it.kind === 'header' ? `h-${it.key}` : it.entry.id) : i;
    },
    rangeExtractor: (range: Range) => {
      const sticky = lastHeaderAtOrBefore(headers, range.startIndex);
      const base = defaultRangeExtractor(range);
      return sticky !== undefined && !base.includes(sticky) ? [sticky, ...base] : base;
    },
  });
  const stickyIdx = lastHeaderAtOrBefore(headers, virt.range?.startIndex ?? 0);

  const tabs = [
    { id: 'all', label: 'All' },
    ...connected.map((a) => ({ id: a.id, label: a.name })),
    { id: 'manual', label: 'Manual' },
    { id: 'system', label: 'System' },
  ];
  const done = olderDone.includes(filter);

  return (
    <section aria-label="Activity feed" className="flex min-h-[360px] flex-1 flex-col rounded-lg border border-border bg-surface" data-activity-feed>
      <div className="flex items-center gap-2 border-b border-border p-2">
        <div role="tablist" aria-label="Feed filter" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={filter === t.id}
              data-feed-tab={t.id}
              onClick={() => setFilter(t.id)}
              className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium ${filter === t.id ? 'bg-accent text-white' : 'text-muted hover:bg-surface-2 hover:text-text'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="relative">
          <Search size={13} aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search activity…"
            aria-label="Search activity"
            className="w-48 rounded-md border border-border-strong bg-surface-2 py-1 pr-2 pl-7 text-[12px] text-text"
          />
        </label>
      </div>

      <div className="relative min-h-0 flex-1">
        {all.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-muted" data-feed-empty>
            <div>
              <StatusDot color="var(--accent)" pulse className="mb-2 size-3" />
              <p>Waiting for the first agent action…</p>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-muted">No activity matches this filter.</div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={(e) => setAtTop(e.currentTarget.scrollTop <= 8)}
            className="h-full overflow-auto"
            role="list"
            aria-label="Activity entries"
            data-feed-scroller
          >
            <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
              {virt.getVirtualItems().map((v) => {
                const it = items[v.index];
                if (!it) return null;
                const sticky = v.index === stickyIdx;
                const style = sticky
                  ? { position: 'sticky' as const, top: 0, zIndex: 2, height: v.size }
                  : { position: 'absolute' as const, top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` };
                return (
                  <div key={v.key} style={style} role={it.kind === 'entry' ? 'listitem' : undefined}>
                    {it.kind === 'header' ? (
                      <div className="flex h-full items-center border-b border-border bg-surface-2 px-3 text-[11px] font-semibold tracking-[0.06em] text-muted" data-day-header>
                        {it.label}
                      </div>
                    ) : (
                      <Entry
                        entry={it.entry}
                        agent={agentsById.get(it.entry.agent_id)}
                        fresh={freshIds?.has(it.entry.id) ?? false}
                        onTask={setOpenTaskId}
                        onMilestone={openMilestone}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {newCount > 0 ? (
          <button
            type="button"
            onClick={() => scrollRef.current?.scrollTo({ top: 0 })}
            className="absolute top-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-white shadow-pop"
            data-new-pill
          >
            <ArrowUp size={12} aria-hidden /> {newCount} new
          </button>
        ) : null}
      </div>

      <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted">
        <span data-feed-count>
          {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
          {query || filter !== 'all' ? ' (filtered)' : ''}
        </span>
        {done ? (
          <span>Start of log</span>
        ) : (
          <Button variant="ghost" onClick={() => void loadOlder()} disabled={olderLoading || all.length === 0}>
            {olderLoading ? 'Loading…' : 'Load older'}
          </Button>
        )}
      </div>
    </section>
  );
}
