import { CalendarClock, Minus, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { TrackerState } from '@command-center/core';
import { HydrationEmptyState } from '../../components/HydrationEmptyState';
import { Button } from '../../components/ui/button';
import { ContextMenu, type MenuItem } from '../../components/ui/menu';
import { monthDay } from './layout';
import { useApp } from '../../store';
import {
  KEY_ROW_H,
  LABEL_W,
  PHASE_H,
  HEADER_H,
  KEY_NODE_R,
  WEEK_W_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  dependencyChain,
  localIsoDate,
  scrollLeftAfterZoom,
  scrollLeftToPlace,
  visibleXRange,
  zoomStep,
} from './layout';
import { buildSwimModel, type SwimNode } from './model';
import {
  AdjacentLines,
  ArrowDefs,
  Connectors,
  DriftGhost,
  KeyMarker,
  MilestoneNode,
  tooltipLines,
  type NodeHandlers,
} from './SvgParts';

const ZOOM_KEY = 'cc-swim-zoom';
/// Above this many milestones, only those near the viewport are rendered.
const WINDOW_THRESHOLD = 40;

function readZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return v ? clampZoom(v) : WEEK_W_DEFAULT;
  } catch {
    return WEEK_W_DEFAULT;
  }
}

/** The current date, refreshed after local midnight so NOW stays on today without a reload. */
function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = new Date();
    const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 5);
    const id = setTimeout(() => setNow(new Date()), next.getTime() - t.getTime());
    return () => clearTimeout(id);
  }, [now]);
  return now;
}

export function SwimLane({ tracker }: { tracker: TrackerState }) {
  const selectedId = useApp((s) => s.selectedMilestoneId);
  const scrollToId = useApp((s) => s.scrollToMilestoneId);
  const openMilestone = useApp((s) => s.openMilestone);
  const scrollToMilestone = useApp((s) => s.scrollToMilestone);
  const setSelected = useApp((s) => s.setSelectedMilestoneId);
  const setActiveTab = useApp((s) => s.setActiveTab);

  const today = useToday();
  const [weekW, setWeekW] = useState(readZoom);
  const model = useMemo(() => buildSwimModel(tracker, weekW, today), [tracker, weekW, today]);

  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [rovingId, setRovingId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  const byId = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);
  const chain = useMemo(() => (hoverId ? dependencyChain(hoverId, model.edges) : null), [hoverId, model.edges]);
  const hotNodes = useMemo(() => (hoverId && chain ? new Set([hoverId, ...chain.upstream, ...chain.downstream]) : null), [hoverId, chain]);
  const hotEdges = useMemo(() => new Set((chain?.edges ?? []).map((e) => `${e.from}>${e.to}`)), [chain]);

  // Nodes that appear after the first paint (e.g. an agent calls create_milestone) animate in.
  const [seen, setSeen] = useState<{ nodes: SwimNode[]; ids: Set<string>; fresh: Set<string> } | null>(null);
  if (seen?.nodes !== model.nodes) {
    const ids = new Set(model.nodes.map((n) => n.id));
    setSeen({ nodes: model.nodes, ids, fresh: seen ? new Set([...ids].filter((id) => !seen.ids.has(id))) : new Set() });
  }
  const entering = { fresh: seen?.fresh ?? new Set<string>() };

  // ----- scrolling: initial NOW placement, "Today", zoom, scroll-to-milestone -----
  const viewWidth = () => (scroller.current?.clientWidth ?? 1200) - LABEL_W;
  const placeNow = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = scrollLeftToPlace(model.nowPos, weekW, viewWidth());
  }, [model.nowPos, weekW]);

  const initialised = useRef(false);
  useLayoutEffect(() => {
    if (initialised.current || model.nodes.length === 0) return;
    initialised.current = true;
    placeNow();
  }, [model.nodes.length, placeNow]);

  const pendingZoom = useRef<{ old: number; next: number } | null>(null);
  const requestZoom = useCallback(
    (dir: 1 | -1) => {
      const next = zoomStep(weekW, dir);
      if (next === weekW) return;
      pendingZoom.current = { old: weekW, next };
      setWeekW(next);
      try {
        localStorage.setItem(ZOOM_KEY, String(next));
      } catch {
        /* zoom just won't persist */
      }
    },
    [weekW],
  );
  useLayoutEffect(() => {
    const z = pendingZoom.current;
    const el = scroller.current;
    if (!z || !el) return;
    pendingZoom.current = null;
    el.scrollLeft = scrollLeftAfterZoom(el.scrollLeft, z.old, z.next, model.nowPos); // NOW stays put
  }, [weekW, model.nowPos]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) >= 40) {
        requestZoom(acc < 0 ? 1 : -1);
        acc = 0;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [requestZoom]);

  const revealX = useCallback(
    (x: number) => {
      const el = scroller.current;
      if (!el) return;
      const w = viewWidth();
      if (x < el.scrollLeft + 80 || x > el.scrollLeft + w - 80) el.scrollLeft = Math.max(0, x - w / 2);
    },
    [],
  );
  useEffect(() => {
    if (!scrollToId) return;
    const n = byId.get(scrollToId);
    if (n) revealX(n.x);
    scrollToMilestone(null);
  }, [scrollToId, byId, revealX, scrollToMilestone]);

  const updateView = useCallback(() => {
    const el = scroller.current;
    if (el) setView({ left: el.scrollLeft, width: Math.max(0, el.clientWidth - LABEL_W) });
  }, []);
  const raf = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(updateView);
    setTip(null);
  };
  useLayoutEffect(updateView, [updateView, weekW]);
  useEffect(() => {
    window.addEventListener('resize', updateView);
    return () => window.removeEventListener('resize', updateView);
  }, [updateView]);

  // ----- windowing for big plans -----
  const windowed = model.nodes.length > WINDOW_THRESHOLD;
  const [x0, x1] = visibleXRange(view.left, view.width);
  const near = (x: number) => !windowed || (x >= x0 && x <= x1);
  const nodes = windowed ? model.nodes.filter((n) => near(n.x) || near(n.plannedX)) : model.nodes;
  const edges = windowed
    ? model.edges.filter((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        return a && b && Math.max(a.x, b.x) >= x0 && Math.min(a.x, b.x) <= x1;
      })
    : model.edges;
  const keyNodes = windowed ? model.keyNodes.filter((n) => near(n.x)) : model.keyNodes;
  const adjacent = windowed ? model.adjacent.filter((e) => near(byId.get(e.from)?.x ?? Infinity) || near(byId.get(e.to)?.x ?? Infinity)) : model.adjacent;

  // ----- interactions -----
  const open = useCallback((id: string) => openMilestone(id), [openMilestone]);
  const jump = useCallback(
    (id: string) => {
      setSelected(id);
      openMilestone(null);
      setActiveTab('task-board');
    },
    [setSelected, openMilestone, setActiveTab],
  );
  const hover = useCallback((id: string | null, e?: MouseEvent) => {
    setHoverId(id);
    setTip(id && e ? { id, x: e.clientX, y: e.clientY } : null);
  }, []);
  const showMenu = useCallback((id: string, x: number, y: number) => {
    setTip(null);
    setMenu({ id, x, y });
  }, []);
  const focusNode = useCallback((id: string) => {
    setRovingId(id);
    setHoverId(id); // keyboard focus highlights the chain too
  }, []);

  const lane = (n: SwimNode) => model.nodes.filter((x) => x.lane === n.lane).sort((a, b) => a.x - b.x);
  const onKey = useCallback(
    (e: KeyboardEvent, id: string) => {
      const n = byId.get(id);
      if (!n) return;
      const row = lane(n);
      const i = row.findIndex((x) => x.id === id);
      let target: SwimNode | undefined;
      if (e.key === 'ArrowRight') target = row[i + 1];
      else if (e.key === 'ArrowLeft') target = row[i - 1];
      else if (e.key === 'Home') target = row[0];
      else if (e.key === 'End') target = row[row.length - 1];
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const other = model.nodes.filter((x) => x.lane === n.lane + (e.key === 'ArrowDown' ? 1 : -1));
        target = other.sort((a, b) => Math.abs(a.x - n.x) - Math.abs(b.x - n.x))[0];
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(id);
        return;
      } else return;
      e.preventDefault();
      if (target) {
        revealX(target.x);
        setFocusRequest(target.id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lane` closes over model.nodes
    [byId, model.nodes, open, revealX],
  );
  useEffect(() => {
    if (!focusRequest) return;
    const el = scroller.current?.querySelector<SVGGElement>(`[data-milestone-id="${focusRequest}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      setFocusRequest(null);
    }
  }, [focusRequest, nodes, view]);

  const handlers: NodeHandlers = { onOpen: open, onJump: jump, onHover: hover, onMenu: showMenu, onKey, onFocusNode: focusNode };

  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const el = scroller.current;
    if (e.button !== 0 || !el || (e.target as Element).closest('[data-milestone-id],[data-key-milestone-id]')) return;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const p = pan.current;
    const el = scroller.current;
    if (!p || !el) return;
    el.scrollLeft = p.left - (e.clientX - p.x);
    el.scrollTop = p.top - (e.clientY - p.y);
  };
  const endPan = () => {
    pan.current = null;
    setPanning(false);
  };

  const menuItems = (id: string): MenuItem[] => [
    { label: 'Open', onSelect: () => openMilestone(id) },
    { label: 'View tasks', onSelect: () => jump(id) },
    { label: 'Add task', onSelect: () => openMilestone(id, 'add-task') },
    { label: 'Set dates…', onSelect: () => openMilestone(id, 'dates') },
  ];

  if (tracker.milestones.length === 0) {
    return (
      <section className="h-full p-6">
        <h1 className="sr-only">Swim Lane</h1>
        <HydrationEmptyState />
      </section>
    );
  }

  const roving = rovingId && byId.has(rovingId) ? rovingId : (model.nodes[0]?.id ?? null);
  const tipNode = tip ? byId.get(tip.id) : undefined;
  const keyY = KEY_ROW_H / 2 - 8;

  return (
    <section className="flex h-full flex-col" aria-label="Swim Lane">
      <h1 className="sr-only">Swim Lane</h1>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button onClick={placeNow} aria-label="Scroll to today" title="Scroll to today (T)">
          <CalendarClock size={14} aria-hidden /> Today
        </Button>
        <span className="ml-2 inline-flex items-center gap-1" role="group" aria-label="Zoom">
          <Button variant="ghost" onClick={() => requestZoom(-1)} disabled={weekW <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (Ctrl+scroll)">
            <Minus size={14} aria-hidden />
          </Button>
          <span className="w-12 text-center font-mono text-[12px]" data-zoom={weekW} aria-live="polite">
            {Math.round((weekW / WEEK_W_DEFAULT) * 100)}%
          </span>
          <Button variant="ghost" onClick={() => requestZoom(1)} disabled={weekW >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (Ctrl+scroll)">
            <Plus size={14} aria-hidden />
          </Button>
        </span>
        <span className="flex-1" />
        <span className="hidden text-[11px] text-muted lg:inline">Drag to pan · Ctrl+scroll to zoom · double-click a milestone for its tasks</span>
      </div>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto bg-bg" data-swim-scroller>
        <div style={{ width: LABEL_W + model.totalW, minWidth: '100%' }}>
          {/* Sticky header: weeks, phases and the NOW flag */}
          <div className="sticky top-0 z-20 flex border-b border-border bg-bg" style={{ height: HEADER_H + PHASE_H }} data-swim-header>
            <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-bg" style={{ width: LABEL_W }} />
            <div className="relative" style={{ width: model.totalW }}>
              <div className="relative" style={{ height: HEADER_H }}>
                {model.weeks.map((w) => (
                  <div
                    key={w.n}
                    className="absolute top-0 border-l border-border px-1.5 pt-1"
                    style={{ left: w.x, width: model.weekW, height: HEADER_H }}
                    data-week={w.n}
                  >
                    <div className="text-[11px] font-semibold">W{w.n}</div>
                    <div className="font-mono text-[10px] text-muted">{monthDay(w.startIso)}</div>
                  </div>
                ))}
                <div
                  className="absolute top-0 z-10 -translate-x-1/2 rounded-b bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  style={{ left: model.nowX }}
                  data-now-flag
                >
                  NOW
                </div>
              </div>
              <div className="relative" style={{ height: PHASE_H }}>
                {model.phases.map((p) => (
                  <div
                    key={p.id}
                    className="absolute top-0 truncate border-l px-1.5 text-[10px] leading-5 font-medium"
                    style={{
                      left: p.x,
                      width: p.w,
                      height: PHASE_H,
                      color: p.color,
                      borderColor: p.color,
                      background: `color-mix(in srgb, ${p.color} 14%, transparent)`,
                    }}
                    data-phase={p.id}
                  >
                    {p.title}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex" style={{ height: model.bodyH }}>
            {/* Sticky label column: Key row + one row per domain */}
            <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-bg" style={{ width: LABEL_W, height: model.bodyH }} data-swim-labels>
              <div className="absolute inset-x-0 top-0 flex items-center gap-2 px-3 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase" style={{ height: KEY_ROW_H }}>
                <span className="inline-block size-2 rotate-45 border border-muted" aria-hidden />
                Key
              </div>
              {model.lanes.map((l) => (
                <div key={l.domain} className="absolute inset-x-0 flex border-t border-border" style={{ top: l.top, height: l.height }} data-lane-label={l.domain}>
                  <div className="w-1.5 shrink-0" style={{ background: l.color }} />
                  <div className="min-w-0 px-2.5 py-2">
                    <div className="truncate text-[12px] font-semibold">{l.domain}</div>
                    <div className="font-mono text-[11px] text-muted">
                      {l.done}/{l.total}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <svg
              width={model.totalW}
              height={model.bodyH}
              className={`block select-none ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              data-swim-canvas
            >
              <ArrowDefs />
              {model.phases.map((p) => (
                <rect key={p.id} x={p.x} y={0} width={p.w} height={model.bodyH} fill={p.color} opacity={0.06} data-phase-band={p.id} />
              ))}
              {model.weeks.map((w) => (
                <line key={w.n} x1={w.x} x2={w.x} y1={0} y2={model.bodyH} stroke="var(--border)" strokeWidth={1} opacity={0.7} />
              ))}
              <line x1={0} x2={model.totalW} y1={KEY_ROW_H} y2={KEY_ROW_H} stroke="var(--border-strong)" />
              {model.lanes.map((l) => (
                <rect key={l.domain} x={0} y={l.top} width={model.totalW} height={l.height} fill={l.color} opacity={0.025} data-lane={l.domain} />
              ))}
              {model.lanes.map((l) => (
                <line key={`s-${l.domain}`} x1={0} x2={model.totalW} y1={l.top + l.height} y2={l.top + l.height} stroke="var(--border)" />
              ))}

              <line x1={model.nowX} x2={model.nowX} y1={0} y2={model.bodyH} stroke="var(--accent)" strokeWidth={1.5} data-now-line data-now-x={model.nowX} />

              <AdjacentLines edges={adjacent} byId={byId} />
              <Connectors edges={edges} byId={byId} hot={hotEdges} hasHover={hotNodes !== null} />
              {nodes.filter((n) => n.drift !== 0).map((n) => (
                <DriftGhost key={n.id} node={n} color={model.lanes[n.lane]?.color ?? 'var(--muted)'} />
              ))}
              {nodes.map((n) => (
                <MilestoneNode
                  key={n.id}
                  node={n}
                  color={model.lanes[n.lane]?.color ?? 'var(--muted)'}
                  selected={selectedId === n.id}
                  dimmed={hotNodes !== null && !hotNodes.has(n.id)}
                  roving={roving === n.id}
                  entering={entering.fresh.has(n.id)}
                  {...handlers}
                />
              ))}
              {keyNodes.map((n) => (
                <KeyMarker
                  key={n.id}
                  node={n}
                  y={keyY + KEY_NODE_R - KEY_NODE_R}
                  color={model.lanes[n.lane]?.color ?? 'var(--muted)'}
                  selected={selectedId === n.id}
                  dimmed={hotNodes !== null && !hotNodes.has(n.id)}
                  {...handlers}
                />
              ))}
            </svg>
          </div>
        </div>
      </div>

      {tip && tipNode ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-72 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-[11px] shadow-pop"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}
          data-swim-tooltip
        >
          {tooltipLines(tipNode, today).map((line, i) => (
            <div key={line} className={i === 0 ? 'font-semibold' : 'text-muted'}>
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {menu ? <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.id}`} items={menuItems(menu.id)} onClose={() => setMenu(null)} /> : null}
      <span className="sr-only" aria-live="polite">
        Today is {localIsoDate(today)}
      </span>
    </section>
  );
}
