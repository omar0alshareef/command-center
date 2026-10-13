import { killTree } from './kill-tree';
import { homedir } from 'node:os';
import * as nodePty from 'node-pty';
import type { ShellInfo } from './shells';
import { detectShells, withPath } from './shells';

export interface PtyEvents {
  data(id: string, data: string): void;
  exit(id: string, exitCode: number): void;
}

export interface SessionInfo {
  id: string;
  pid: number;
  shellId: string;
  name: string;
  cwd: string;
}

interface Live {
  pty: nodePty.IPty;
  info: SessionInfo;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
}

const FLUSH_MS = 6;
const FLUSH_BYTES = 64 * 1024;
const clampDim = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.floor(n) || lo));

/**
 * Owns every PTY. Output is coalesced per session (6 ms / 64 KB) before it crosses IPC. No backpressure:
 * a command that floods output faster than the renderer paints can queue (node-pty pause/resume is the upgrade).
 */
export class PtyManager {
  private readonly sessions = new Map<string, Live>();
  private seq = 0;
  private shells: ShellInfo[] | null = null;

  constructor(
    private readonly events: PtyEvents,
    private readonly cwd: () => string | null,
    /** A folder to put first on PATH in every session (the `command-center` launcher). */
    private readonly extraPath: () => string | null = () => null,
  ) {}

  listShells(): ShellInfo[] {
    return (this.shells ??= detectShells());
  }

  create(shellId: string | undefined, cols: number, rows: number): SessionInfo {
    const shells = this.listShells();
    const shell = shells.find((s) => s.id === shellId) ?? shells[0];
    if (!shell) throw new Error('No shell was found on this machine.');
    const cwd = this.cwd() ?? homedir();
    const id = `term-${++this.seq}`;
    const root = this.cwd();
    const proc = nodePty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clampDim(cols, 2, 500),
      rows: clampDim(rows, 1, 200),
      cwd,
      env: withPath(
        { ...process.env, ...(root ? { PROJECT_ROOT: root } : {}), TERM_PROGRAM: 'command-center' },
        this.extraPath(),
      ) as Record<string, string>,
    });
    const info: SessionInfo = { id, pid: proc.pid, shellId: shell.id, name: shell.name, cwd };
    const live: Live = { pty: proc, info, buffer: '', timer: null, exited: false };
    this.sessions.set(id, live);
    proc.onData((d) => {
      live.buffer += d;
      if (live.buffer.length >= FLUSH_BYTES) this.flush(live);
      else live.timer ??= setTimeout(() => this.flush(live), FLUSH_MS);
    });
    proc.onExit(({ exitCode }) => {
      live.exited = true;
      this.flush(live);
      this.events.exit(id, exitCode);
    });
    return info;
  }

  private flush(live: Live): void {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    if (live.buffer) {
      const data = live.buffer;
      live.buffer = '';
      this.events.data(live.info.id, data);
    }
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (s && !s.exited && data.length <= 1_000_000) s.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || s.exited) return;
    try {
      s.pty.resize(clampDim(cols, 2, 500), clampDim(rows, 1, 200));
    } catch {
      /* the process exited between the check and the call */
    }
  }

  /** Ends one session and its process tree; the entry is dropped. */
  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.terminate(s);
  }

  killAll(): void {
    for (const s of this.sessions.values()) this.terminate(s);
    this.sessions.clear();
  }

  private terminate(s: Live): void {
    if (s.timer) clearTimeout(s.timer);
    if (s.exited) return;
    s.exited = true;
    // Closing the pseudo console does not always take grandchildren with it on Windows: kill the tree.
    killTree(s.info.pid, () => s.pty.kill());
  }

  get count(): number {
    return this.sessions.size;
  }
}
