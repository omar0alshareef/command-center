import { memo, type KeyboardEvent, type MouseEvent } from 'react';
import { formatDate } from '../../lib/time';
import { KEY_NODE_R, NODE_PITCH, NODE_R, connectorPath, type Edge } from './layout';
import type { SwimNode } from './model';

// The SVG building blocks of the Swim Lane. Interaction handlers come from the parent and are stable,
// so a hover or selection change re-renders only the nodes whose props actually changed.

const RING_R = NODE_R - 3;
const RING_C = 2 * Math.PI * RING_R;

export interface NodeHandlers {
  onOpen: (id: string) => void;
  onJump: (id: string) => void;
  onHover: (id: string | null, e?: MouseEvent) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onKey: (e: KeyboardEvent, id: string) => void;
  onFocusNode: (id: string) => void;
}

export interface NodeViewProps extends NodeHandlers {
  node: SwimNode;
  color: string;
  selected: boolean;
  dimmed: boolean;
  roving: boolean;
  entering: boolean;
}

export const ariaLabel = (n: SwimNode): string =>
  `${n.id} ${n.title}, ${n.done} of ${n.total} tasks${
    n.drift === 0 ? '' : `, ${Math.abs(n.drift)} day${Math.abs(n.drift) === 1 ? '' : 's'} ${n.drift > 0 ? 'behind' : 'ahead'}`
  }${n.status === 'blocked' ? ', has blocked tasks' : n.status === 'review' ? ', awaiting review' : ''}`;

const driftText = (d: number): string => `${d > 0 ? '+' : '−'}${Math.abs(d)}d`;

function useHandlers(id: string, h: NodeHandlers) {
  return {
    onClick: () => h.onOpen(id),
    onDoubleClick: () => h.onJump(id),
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      h.onMenu(id, e.clientX, e.clientY);
    },
    onMouseEnter: (e: MouseEvent) => h.onHover(id, e),
    onMouseMove: (e: MouseEvent) => h.onHover(id, e),
    onMouseLeave: () => h.onHover(null),
    onFocus: () => h.onFocusNode(id),
    onKeyDown: (e: KeyboardEvent) => h.onKey(e, id),
  };
}

/** A lane milestone: progress ring, status styling, drift badge, label and date. */
export const MilestoneNode = memo(function MilestoneNode({ node: n, color, selected, dimmed, roving, entering, ...h }: NodeViewProps) {
  const ringColor = n.status === 'blocked' ? 'var(--danger)' : n.status === 'done' ? 'var(--success)' : color;
  const pct = n.total === 0 ? 0 : n.done / n.total;
  return (
    <g
      transform={`translate(${n.x} ${n.y})`}
      className={`node cursor-pointer ${entering ? 'node-enter' : ''}`}
      style={{ opacity: dimmed ? 0.35 : 1, transition: 'opacity 150ms' }}
      role="button"
      tabIndex={roving ? 0 : -1}
      aria-label={ariaLabel(n)}
      aria-current={selected ? 'true' : undefined}
      data-milestone-id={n.id}
      data-x={n.x}
      data-planned-x={n.plannedX}
      data-y={n.y}
      data-lane={n.lane}
      data-status={n.status}
      data-drift={n.drift}
      {...useHandlers(n.id, h)}
    >
      <circle className="node-focus" r={NODE_R + 10} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {selected ? <circle r={NODE_R + 6} fill="none" stroke="var(--accent)" strokeWidth={2} opacity={0.9} data-halo /> : null}
      {n.status === 'review' ? (
        <circle r={NODE_R + 3} fill="none" stroke="var(--warning)" strokeWidth={2} className="pulse-dot" data-review-pulse />
      ) : null}
      <circle r={NODE_R} fill={n.status === 'done' ? 'var(--success)' : 'var(--surface)'} stroke="var(--border-strong)" strokeWidth={1} />
      {n.status !== 'done' ? (
        <>
          <circle r={RING_R} fill="none" stroke="var(--border)" strokeWidth={3} />
          <circle
            r={RING_R}
            fill="none"
            stroke={ringColor}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - pct)}
            transform="rotate(-90)"
            style={{ transition: 'stroke-dashoffset 400ms' }}
          />
          <text textAnchor="middle" dominantBaseline="central" className="fill-text font-mono" fontSize={9}>
            {n.done}/{n.total}
          </text>
        </>
      ) : (
        <path d="M -7 0 L -2 5 L 8 -5" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" data-check />
      )}
      {n.status === 'blocked' ? (
        <g transform={`translate(${NODE_R - 3} ${-NODE_R + 3})`} data-blocked-badge>
          <circle r={8} fill="var(--danger)" />
          <text textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={11} fontWeight={700}>
            !
          </text>
        </g>
      ) : null}
      {n.drift !== 0 ? (
        <g transform={`translate(${NODE_R + 2} ${-NODE_R - 6})`} data-drift-badge>
          <rect x={-2} y={-9} width={32} height={16} rx={8} fill={n.drift > 0 ? 'var(--danger)' : 'var(--success)'} />
          <text x={14} y={-1} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={10} fontWeight={600} className="font-mono">
            {driftText(n.drift)}
          </text>
        </g>
      ) : null}
      <foreignObject x={-NODE_PITCH / 2 + 4} y={NODE_R + 4} width={NODE_PITCH - 8} height={46} style={{ pointerEvents: 'none', overflow: 'hidden' }}>
        <div className="text-center">
          <div className="line-clamp-2 text-[11px] leading-[1.25] font-medium">{n.title}</div>
          <div className="font-mono text-[10px] text-muted">{n.plannedStart ? n.plannedStart.slice(5) : `W${n.week}`}</div>
        </div>
      </foreignObject>
    </g>
  );
});

/** Where a drifting milestone was planned: dashed outline plus a dashed link to the forecast. */
export const DriftGhost = memo(function DriftGhost({ node: n, color }: { node: SwimNode; color: string }) {
  const dir = Math.sign(n.x - n.plannedX);
  return (
    <g data-drift-ghost={n.id} style={{ pointerEvents: 'none' }}>
      <line
        x1={n.plannedX + dir * NODE_R}
        y1={n.y}
        x2={n.x - dir * NODE_R}
        y2={n.y}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        opacity={0.5}
      />
      <circle cx={n.plannedX} cy={n.y} r={NODE_R} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.4} />
    </g>
  );
});

/** Key milestone diamond with a label flag, in the dedicated Key row. */
export const KeyMarker = memo(function KeyMarker({
  node: n,
  y,
  color,
  selected,
  dimmed,
  ...h
}: Omit<NodeViewProps, 'roving' | 'entering'> & { y: number }) {
  const r = KEY_NODE_R;
  return (
    <g
      transform={`translate(${n.x} ${y})`}
      className="node cursor-pointer"
      style={{ opacity: dimmed ? 0.35 : 1, transition: 'opacity 150ms' }}
      role="button"
      tabIndex={-1}
      aria-label={`Key milestone: ${n.keyLabel}. ${ariaLabel(n)}`}
      data-key-milestone-id={n.id}
      data-x={n.x}
      data-y={y}
      {...useHandlers(n.id, h)}
    >
      {selected ? <polygon points={`0,${-r - 6} ${r + 6},0 0,${r + 6} ${-r - 6},0`} fill="none" stroke="var(--accent)" strokeWidth={2} /> : null}
      <polygon
        points={`0,${-r} ${r},0 0,${r} ${-r},0`}
        fill={`color-mix(in srgb, ${color} 28%, var(--surface))`}
        stroke={color}
        strokeWidth={2}
      />
      <foreignObject x={-68} y={r + 4} width={136} height={34} style={{ pointerEvents: 'none', overflow: 'hidden' }}>
        <div className="text-center text-[11px] leading-[1.25] font-semibold">{n.keyLabel}</div>
      </foreignObject>
    </g>
  );
});

export interface EdgesProps {
  edges: Edge[];
  byId: ReadonlyMap<string, SwimNode>;
  hot: ReadonlySet<string>;
  hasHover: boolean;
}

/** Curved dependency connectors with arrowheads. Dim by default; the hovered node's chain is accent 2px. */
export const Connectors = memo(function Connectors({ edges, byId, hot, hasHover }: EdgesProps) {
  return (
    <g fill="none" data-connectors>
      {edges.map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const isHot = hot.has(`${e.from}>${e.to}`);
        return (
          <path
            key={`${e.from}>${e.to}`}
            d={connectorPath(a.x + NODE_R, a.y, b.x - NODE_R - 7, b.y)}
            stroke={isHot ? 'var(--accent)' : 'var(--muted)'}
            strokeWidth={isHot ? 2 : 1.25}
            opacity={isHot ? 1 : hasHover ? 0.12 : 0.35}
            markerEnd={isHot ? 'url(#cc-arrow-hot)' : 'url(#cc-arrow)'}
            data-edge={`${e.from}>${e.to}`}
            data-hot={isHot ? 'true' : undefined}
          />
        );
      })}
    </g>
  );
});

/** Subtle solid line between consecutive milestones of one lane. */
export const AdjacentLines = memo(function AdjacentLines({ edges, byId }: { edges: Edge[]; byId: ReadonlyMap<string, SwimNode> }) {
  return (
    <g stroke="var(--border-strong)" strokeWidth={1} opacity={0.6} data-adjacent>
      {edges.map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        return a && b ? <line key={`${e.from}-${e.to}`} x1={a.x + NODE_R} y1={a.y} x2={b.x - NODE_R} y2={b.y} /> : null;
      })}
    </g>
  );
});

export function ArrowDefs() {
  return (
    <defs>
      <marker id="cc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
      </marker>
      <marker id="cc-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
      </marker>
    </defs>
  );
}

/** Tooltip text lines for a node (hover). */
export function tooltipLines(n: SwimNode, now: Date): string[] {
  const planned = `${formatDate(n.plannedStart, now)} → ${formatDate(n.plannedEnd, now)}`;
  const actual = n.actualStart || n.actualEnd ? `${formatDate(n.actualStart, now)} → ${formatDate(n.actualEnd, now)}` : null;
  return [
    `${n.id} · ${n.title}`,
    `Planned ${planned}`,
    ...(actual ? [`Actual ${actual}`] : []),
    `${n.done}/${n.total} tasks done`,
    n.drift === 0 ? 'On plan' : `${driftText(n.drift)} ${n.drift > 0 ? 'behind' : 'ahead'}`,
  ];
}
