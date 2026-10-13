import { Leaf, Monitor, Moon, MoonStar, Settings, Sun, type LucideIcon } from 'lucide-react';
import { overallProgress, scheduleBadge } from '../../lib/derive';
import { nextThemePref, useApp, type SyncState, type ThemePref } from '../../store';
import { Skeleton } from '../ui/feedback';
import { StatusDot, Tag } from '../ui/badges';
import { Tooltip } from '../ui/overlays';

const THEME_LABEL: Record<ThemePref, string> = {
  dark: 'Dark',
  light: 'Light',
  calm: 'Calm',
  'calm-dark': 'Calm Dark',
  system: 'System',
};
const THEME_ICON: Record<ThemePref, LucideIcon> = {
  dark: Moon,
  light: Sun,
  calm: Leaf,
  'calm-dark': MoonStar,
  system: Monitor,
};

const TONE_COLOR = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
} as const;

function SyncIndicator({ sync }: { sync: SyncState }) {
  const view = {
    live: { color: 'var(--success)', label: 'Live', pulse: false },
    syncing: { color: 'var(--warning)', label: 'Syncing…', pulse: true },
    disconnected: { color: 'var(--danger)', label: 'Disconnected — retrying', pulse: false },
  }[sync.state];
  const tip =
    sync.state === 'disconnected' && sync.error
      ? sync.error
      : sync.lastSyncAt
        ? `Last sync ${new Date(sync.lastSyncAt).toLocaleTimeString()}`
        : 'Not synced yet';
  return (
    <Tooltip content={tip}>
      <span
        role="status"
        className="no-drag inline-flex items-center gap-1.5 text-[12px] text-muted"
      >
        <StatusDot color={view.color} pulse={view.pulse} />
        {view.label}
      </span>
    </Tooltip>
  );
}

export function TitleBar() {
  const tracker = useApp((s) => s.tracker);
  const sync = useApp((s) => s.sync);
  const themePref = useApp((s) => s.themePref);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const openSettings = useApp((s) => s.setSettingsOpen);
  // macOS: leave room for the inset traffic lights (frameless window).
  const darwin = window.api.platform === 'darwin';

  const badge = tracker ? scheduleBadge(tracker.project, tracker.milestones) : null;
  const pct = tracker ? Math.round(overallProgress(tracker.subtasks) * 100) : 0;

  return (
    <header
      className="drag flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3"
      style={darwin ? { paddingLeft: 84 } : undefined}
    >
      {tracker ? (
        <>
          <span className="text-[13px] font-semibold">{tracker.project.name}</span>
          {badge ? <Tag color={TONE_COLOR[badge.tone]}>{badge.label}</Tag> : null}
          <span className="inline-flex items-center gap-2" title={`${pct}% of tasks done`}>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
              <span
                className="block h-full bg-accent transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="font-mono text-[12px]">{pct}%</span>
          </span>
        </>
      ) : (
        <Skeleton className="h-4 w-56" />
      )}
      <span className="flex-1" />
      <SyncIndicator sync={sync} />
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={`Theme: ${THEME_LABEL[themePref]}. Switch to ${THEME_LABEL[nextThemePref(themePref)]}`}
        title={`Theme: ${THEME_LABEL[themePref]}`}
        className="no-drag grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      >
        {(() => {
          const Icon = THEME_ICON[nextThemePref(themePref)];
          return <Icon size={16} aria-hidden />;
        })()}
      </button>
      <button
        type="button"
        onClick={() => openSettings(true)}
        aria-label="Settings (Ctrl+,)"
        className="no-drag grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      >
        <Settings size={16} />
      </button>
    </header>
  );
}
