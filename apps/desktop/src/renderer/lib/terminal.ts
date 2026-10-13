import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ShellInfo } from '../../shared/ipc';
import { toast } from '../toast';

// Terminal sessions live outside React: an xterm instance (with its scrollback) and its PTY survive tab switches
// and component unmounts. The store only mirrors what the UI needs to draw tabs and banners.

export interface Session {
  id: string;
  name: string;
  shellId: string;
  pid: number;
  status: 'running' | 'exited';
  exitCode: number | null;
}

interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const instances = new Map<string, Instance>();
/** Output that arrives before its xterm exists (the IPC reply and the first data can race). */
const pending = new Map<string, string[]>();
let wired = false;

export const FONT_MIN = 9;
export const FONT_MAX = 24;
const FONT_FAMILY = "'JetBrains Mono', Consolas, 'Courier New', monospace";

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const DARK_ANSI: ITheme = {
  black: '#1c1c28',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#6d71ff',
  magenta: '#ec4899',
  cyan: '#14b8a6',
  white: '#d4d4e0',
  brightBlack: '#6b6b7b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#8286ff',
  brightMagenta: '#f472b6',
  brightCyan: '#2dd4bf',
  brightWhite: '#ffffff',
};
const LIGHT_ANSI: ITheme = {
  black: '#0f0f18',
  red: '#c62828',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#3438c8',
  magenta: '#a21caf',
  cyan: '#0e7490',
  white: '#6b6b7b',
  brightBlack: '#52525f',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#b45309',
  brightBlue: '#4549d6',
  brightMagenta: '#c026d3',
  brightCyan: '#0891b2',
  brightWhite: '#0f0f18',
};

/** xterm colours from the design tokens, so the terminal follows the theme. */
export function xtermTheme(theme: 'dark' | 'light' | 'calm' | 'calm-dark'): ITheme {
  const accent = cssVar('--accent') || '#585cf0';
  return {
    ...(theme === 'dark' || theme === 'calm-dark' ? DARK_ANSI : LIGHT_ANSI),
    background: cssVar('--bg') || '#0a0a10',
    foreground: cssVar('--text') || '#e8e8f0',
    cursor: accent,
    cursorAccent: cssVar('--bg') || '#0a0a10',
    selectionBackground: `color-mix(in srgb, ${accent} 40%, transparent)`,
  };
}

interface TerminalState {
  sessions: Session[];
  activeId: string | null;
  shells: ShellInfo[];
  creating: boolean;
  error: string | null;
  /** The Terminal tab has been opened at least once (it auto-spawns a session then). */
  visited: boolean;
  fontSize: number;
  /** Shell id new sessions use when none is picked (Settings); null = the detected default. */
  defaultShell: string | null;
  quickActionsOpen: boolean;

  init: () => Promise<void>;
  markVisited: () => void;
  newSession: (shellId?: string) => Promise<string | null>;
  closeSession: (id: string) => void;
  restartSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  changeFont: (delta: number) => void;
  setDefaultShell: (id: string | null) => void;
  toggleQuickActions: () => void;
  clearActive: () => void;
  /** Types text into the active session without pressing Enter. */
  typeInto: (text: string) => void;
}

const send = (id: string, data: string) => window.api.terminal.write(id, data);

function build(
  id: string,
  fontSize: number,
  theme: 'dark' | 'light' | 'calm' | 'calm-dark',
): Instance {
  const el = document.createElement('div');
  el.className = 'term-host';
  el.dataset.sessionId = id;
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: xtermTheme(theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  term.onData((d) => send(id, d));
  term.onResize(({ cols, rows }) => {
    el.dataset.cols = String(cols);
    el.dataset.rows = String(rows);
    window.api.terminal.resize(id, cols, rows);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey && e.shiftKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'c' && term.hasSelection()) {
      void navigator.clipboard
        .writeText(term.getSelection())
        .catch(() => toast.error('Could not copy to the clipboard'));
      return false;
    }
    if (mod && k === 'v') {
      void navigator.clipboard
        .readText()
        .then((t) => term.paste(t))
        .catch(() => toast.error('Could not read the clipboard'));
      return false;
    }
    // App shortcuts bubble to the window handler instead of reaching the shell.
    if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && k === 't') || (!e.shiftKey && k === 'w')))
      return false;
    return true;
  });
  return { term, fit, el };
}

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeId: null,
      shells: [],
      creating: false,
      error: null,
      visited: false,
      fontSize: 13,
      defaultShell: null,
      quickActionsOpen: true,

      init: async () => {
        if (wired) return;
        wired = true;
        window.api.terminal.onData(({ id, data }) => {
          const inst = instances.get(id);
          if (inst) inst.term.write(data);
          else pending.set(id, [...(pending.get(id) ?? []), data]);
        });
        window.api.terminal.onExit(({ id, exitCode }) =>
          set((s) => ({
            sessions: s.sessions.map((x) =>
              x.id === id ? { ...x, status: 'exited', exitCode } : x,
            ),
          })),
        );
        set({ shells: await window.api.terminal.shells() });
      },

      markVisited: () => !get().visited && set({ visited: true }),

      newSession: async (shellId) => {
        if (get().creating) return null;
        set({ creating: true, error: null });
        try {
          const chosen = shellId ?? get().defaultShell ?? undefined;
          const res = await window.api.terminal.create({
            shellId: get().shells.some((x) => x.id === chosen) ? chosen : shellId,
            cols: 80,
            rows: 24,
          });
          if (!res.ok) {
            set({ error: res.error.message });
            return null;
          }
          const info = res.value;
          const d = document.documentElement.dataset;
          const theme = d['theme'] === 'dark' || d['mode'] === 'dark' ? 'dark' : 'light';
          const inst = build(info.id, get().fontSize, theme);
          instances.set(info.id, inst);
          for (const chunk of pending.get(info.id) ?? []) inst.term.write(chunk);
          pending.delete(info.id);
          set((s) => ({
            sessions: [
              ...s.sessions,
              {
                id: info.id,
                name: info.name,
                shellId: info.shellId,
                pid: info.pid,
                status: 'running',
                exitCode: null,
              },
            ],
            activeId: info.id,
          }));
          return info.id;
        } catch (e) {
          set({ error: e instanceof Error ? e.message : String(e) });
          return null;
        } finally {
          set({ creating: false });
        }
      },

      closeSession: (id) => {
        void window.api.terminal.kill(id);
        const inst = instances.get(id);
        inst?.term.dispose();
        inst?.el.remove();
        instances.delete(id);
        pending.delete(id);
        set((s) => {
          const i = s.sessions.findIndex((x) => x.id === id);
          const sessions = s.sessions.filter((x) => x.id !== id);
          const activeId =
            s.activeId === id
              ? (sessions[Math.min(i, sessions.length - 1)]?.id ?? null)
              : s.activeId;
          return { sessions, activeId };
        });
      },

      restartSession: async (id) => {
        const old = get().sessions.find((s) => s.id === id);
        get().closeSession(id);
        await get().newSession(old?.shellId);
      },

      setActive: (id) => set({ activeId: id }),

      changeFont: (delta) => {
        const fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, get().fontSize + delta));
        set({ fontSize });
        for (const { term, fit } of instances.values()) {
          term.options.fontSize = fontSize;
          try {
            fit.fit();
          } catch {
            /* hidden: fits when shown */
          }
        }
      },

      setDefaultShell: (defaultShell) => set({ defaultShell }),

      toggleQuickActions: () => set((s) => ({ quickActionsOpen: !s.quickActionsOpen })),

      clearActive: () => {
        const id = get().activeId;
        if (id) instances.get(id)?.term.clear();
      },

      typeInto: (text) => {
        const s = get();
        const target = s.sessions.find((x) => x.id === s.activeId && x.status === 'running');
        if (target) {
          send(target.id, text);
          instances.get(target.id)?.term.focus();
        }
      },
    }),
    {
      name: 'cc-terminal',
      partialize: (s) => ({
        fontSize: s.fontSize,
        defaultShell: s.defaultShell,
        quickActionsOpen: s.quickActionsOpen,
      }),
    },
  ),
);

export const getInstance = (id: string): Instance | undefined => instances.get(id);
export const allInstances = (): IterableIterator<Instance> => instances.values();
