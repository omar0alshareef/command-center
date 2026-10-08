import '@xterm/xterm/css/xterm.css';
import { ChevronDown, Eraser, Minus, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { StatusDot } from '../../components/ui/badges';
import { EmptyState } from '../../components/ui/feedback';
import { ContextMenu } from '../../components/ui/menu';
import {
  allInstances,
  FONT_MAX,
  FONT_MIN,
  getInstance,
  useTerminal,
  xtermTheme,
} from '../../lib/terminal';
import { useApp } from '../../store';

const QUICK_ACTIONS = ['command-center status', 'command-center agents', 'claude'];

/** Fits the active xterm to its box (and tells the PTY) whenever the box changes size or becomes visible. */
function Viewport({ activeId, visible }: { activeId: string | null; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const sessions = useTerminal((s) => s.sessions);

  const fit = useCallback(() => {
    const el = host.current;
    if (!el || el.clientWidth < 20 || el.clientHeight < 20 || !activeId) return;
    try {
      getInstance(activeId)?.fit.fit();
    } catch {
      /* xterm is not measurable yet */
    }
  }, [activeId]);

  // Mount every session's element once; only the active one is displayed. Elements are never destroyed on a tab switch.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    for (const s of sessions) {
      const inst = getInstance(s.id);
      if (inst && inst.el.parentElement !== el) el.appendChild(inst.el);
    }
    for (const child of Array.from(el.children) as HTMLElement[]) {
      child.style.display = child.dataset['sessionId'] === activeId ? 'block' : 'none';
    }
  }, [sessions, activeId]);

  useLayoutEffect(() => {
    if (visible) {
      fit();
      if (activeId) getInstance(activeId)?.term.focus();
    }
  }, [visible, fit, activeId, sessions]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [fit]);

  return (
    <div
      ref={host}
      className="term-viewport relative min-h-0 flex-1 overflow-hidden px-2 py-1"
      data-term-viewport
    />
  );
}

/** UI/UX §6.5. Always mounted once visited, so shells and scrollback survive tab switches. */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const t = useTerminal();
  const theme = useApp((s) => s.theme);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const autoSpawned = useRef(false);

  useEffect(() => {
    void t.init();
  }, [t.init]); // eslint-disable-line react-hooks/exhaustive-deps -- init is stable

  // First visit: start a session so the tab is never an empty box.
  useEffect(() => {
    if (visible && !autoSpawned.current && t.sessions.length === 0 && !t.creating) {
      autoSpawned.current = true;
      void t.newSession();
    }
  }, [visible, t.sessions.length, t.creating]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // App sets `data-theme` in its own effect, which runs after this child's: read the tokens a frame later.
    const raf = requestAnimationFrame(() => {
      const colors = xtermTheme(theme);
      for (const { term } of allInstances()) term.options.theme = colors;
    });
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === 't') {
        e.preventDefault();
        void useTerminal.getState().newSession();
      } else if (!e.shiftKey && !e.altKey && k === 'w') {
        const id = useTerminal.getState().activeId;
        if (id) {
          e.preventDefault();
          useTerminal.getState().closeSession(id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  const active = t.sessions.find((s) => s.id === t.activeId) ?? null;

  return (
    <section aria-label="Terminal" className="flex h-full flex-col" data-terminal>
      <h1 className="sr-only">Terminal</h1>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          role="tablist"
          aria-label="Terminal sessions"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {t.sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] ${s.id === t.activeId ? 'border-border-strong bg-surface-2' : 'border-transparent text-muted hover:bg-surface-2'}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={s.id === t.activeId}
                data-term-tab={s.id}
                data-pid={s.pid}
                data-status={s.status}
                onClick={() => t.setActive(s.id)}
                className="flex items-center gap-1.5"
              >
                <TerminalIcon size={12} aria-hidden />
                {s.name}
                <StatusDot color={s.status === 'running' ? 'var(--success)' : 'var(--muted)'} />
                <span className="text-[10px] text-muted">
                  {s.status === 'running' ? 'running' : 'exited'}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Close ${s.name} session`}
                onClick={() => t.closeSession(s.id)}
                className="grid size-4 place-items-center rounded text-muted hover:text-text"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <span className="inline-flex shrink-0">
          <Button
            onClick={() => void t.newSession()}
            disabled={t.creating}
            aria-label="New terminal session"
            title="New session (Ctrl+Shift+T)"
            className="rounded-r-none"
          >
            <Plus size={14} aria-hidden />
          </Button>
          <Button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
            aria-label="Choose shell"
            aria-haspopup="menu"
            className="min-w-0 rounded-l-none border-l-0 px-1.5"
          >
            <ChevronDown size={14} aria-hidden />
          </Button>
        </span>
        <Button variant="ghost" onClick={t.clearActive} disabled={!active} title="Clear">
          <Eraser size={14} aria-hidden /> Clear
        </Button>
        <span className="inline-flex items-center" role="group" aria-label="Font size">
          <Button
            variant="ghost"
            onClick={() => t.changeFont(-1)}
            disabled={t.fontSize <= FONT_MIN}
            aria-label="Smaller font"
          >
            <Minus size={14} aria-hidden />
          </Button>
          <span className="w-7 text-center font-mono text-[11px]" data-font-size={t.fontSize}>
            {t.fontSize}
          </span>
          <Button
            variant="ghost"
            onClick={() => t.changeFont(1)}
            disabled={t.fontSize >= FONT_MAX}
            aria-label="Larger font"
          >
            <Plus size={14} aria-hidden />
          </Button>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11px]">
        <button
          type="button"
          onClick={t.toggleQuickActions}
          aria-expanded={t.quickActionsOpen}
          className="font-semibold tracking-[0.06em] text-muted uppercase hover:text-text"
        >
          Quick actions {t.quickActionsOpen ? '▾' : '▸'}
        </button>
        {t.quickActionsOpen
          ? QUICK_ACTIONS.map((q) => (
              <button
                key={q}
                type="button"
                disabled={!active || active.status !== 'running'}
                onClick={() => t.typeInto(q)}
                title="Types into the session without running it"
                data-quick-action={q}
                className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-mono hover:bg-surface-3 disabled:opacity-50"
              >
                {q}
              </button>
            ))
          : null}
      </div>

      {t.error ? (
        <div role="alert" className="border-b border-danger px-4 py-2 text-danger">
          Could not start a shell: {t.error}. If the native{' '}
          <code className="font-mono">node-pty</code> module failed to load, run{' '}
          <code className="font-mono">npm rebuild node-pty</code> (Windows needs the Visual Studio
          Build Tools; see the README).
        </div>
      ) : null}

      {t.sessions.length === 0 && !t.creating ? (
        <div className="grid flex-1 place-items-center">
          <EmptyState
            icon={TerminalIcon}
            title="No terminal sessions"
            help="Start a shell in your project folder to run the operator CLI or Claude Code."
            action={
              <Button variant="primary" onClick={() => void t.newSession()}>
                New Session
              </Button>
            }
          />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
          <Viewport activeId={t.activeId} visible={visible} />
          {active?.status === 'exited' ? (
            <div
              className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-border-strong bg-surface-2 px-4 py-2"
              data-exited-banner
            >
              <span className="flex-1">Process exited (code {active.exitCode ?? '?'}).</span>
              <Button variant="primary" onClick={() => void t.restartSession(active.id)}>
                Restart
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Choose shell"
          onClose={() => setMenu(null)}
          items={t.shells.map((s) => ({ label: s.name, onSelect: () => void t.newSession(s.id) }))}
        />
      ) : null}
    </section>
  );
}
