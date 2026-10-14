import {
  buildProviders,
  getOrchestratorConfig,
  Orchestrator,
  PROVIDER_IDS,
  setOrchestratorConfig,
  systemProviderEnv,
  type Db,
  type ProviderAdapter,
  type ProviderId,
} from '@command-center/core';
import type { OrchestratorView } from '../shared/ipc';
import { getLibrary } from './library-service';
import { readBaseUrl, readProviderKey } from './provider-settings';

// Owns the one Orchestrator for the open project (M14). It rebuilds it when the project changes, ticks it every 5 s
// (D22: the scheduler is plain code), polls for cancel requests from other processes every second, and re-detects the
// providers every minute. All of its writes go through the same core functions as everything else.

const TICK_MS = 5000;
const CANCEL_MS = 1000;
const DETECT_MS = 60_000;

export class OrchestratorLoop {
  private orch: Orchestrator | null = null;
  private forDb: Db | null = null;
  private providers: Record<ProviderId, ProviderAdapter> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private kicking: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(
    private readonly getDb: () => Db,
    private readonly getRoot: () => string | null,
    private readonly emit: (status: OrchestratorView) => void,
  ) {}

  /** The orchestrator for the currently open project, created (and stale runs recovered) on first use. */
  private current(): Orchestrator | null {
    let db: Db;
    try {
      db = this.getDb();
    } catch {
      return null;
    }
    const root = this.getRoot();
    if (!root) return null;
    if (this.orch && this.forDb === db) return this.orch;
    const env = systemProviderEnv({
      baseUrl: (id) => readBaseUrl(db, id),
      apiKey: (id) => readProviderKey(db, id),
    });
    this.providers = buildProviders(env);
    this.orch = new Orchestrator({
      db,
      projectRoot: root,
      providers: this.providers,
      getKey: (id) => readProviderKey(db, id),
      library: this.library(),
    });
    this.forDb = db;
    this.orch.recoverStale();
    void this.orch.refreshProviders().then(() => this.push());
    return this.orch;
  }

  /** A library that cannot open must not stop a project from running: agents the library does not manage still dispatch. */
  private library() {
    try {
      return getLibrary();
    } catch {
      return null;
    }
  }

  /** How many runs are in flight for the open project. */
  runningCount(): number {
    return this.orch?.status().running ?? 0;
  }

  /**
   * Before another project is opened (M15 switcher): stop dispatching for this one, optionally end the runs in flight, wait
   * (bounded) for their last rows, and forget the orchestrator so the next project gets its own. The paused mode stays in
   * this project's database, so coming back finds it paused until the operator resumes.
   */
  async releaseForSwitch(cancelRunning: boolean): Promise<{ running: number; cancelled: boolean }> {
    const o = this.orch;
    if (!o) return { running: 0, cancelled: false };
    const running = o.status().running;
    // The project's database is about to close, so runs cannot be left going: they end (and say so in their task) either way.
    cancelRunning = cancelRunning || running > 0;
    o.pause({ cancelRunning });
    if (cancelRunning) await Promise.race([o.idle(), new Promise((r) => setTimeout(r, 4000))]);
    this.orch = null;
    this.forDb = null;
    return { running, cancelled: cancelRunning && running > 0 };
  }

  /** The orchestrator, for the IPC handlers. Null while no project is open. */
  get(): Orchestrator | null {
    return this.current();
  }

  adapters(): Record<ProviderId, ProviderAdapter> | null {
    this.current();
    return this.providers;
  }

  view(): OrchestratorView | null {
    const o = this.current();
    if (!o) return null;
    const db = this.getDb();
    return { ...o.status(), config: getOrchestratorConfig(db) };
  }

  push(): void {
    const v = this.view();
    if (v) this.emit(v);
  }

  start(): void {
    this.timers.push(
      setInterval(() => {
        try {
          this.current()?.tick();
        } catch {
          /* a closed or busy database: the next tick tries again */
        }
        this.push();
      }, TICK_MS),
      setInterval(() => {
        try {
          this.current()?.checkCancels();
        } catch {
          /* see above */
        }
      }, CANCEL_MS),
      setInterval(() => {
        void this.current()
          ?.refreshProviders()
          .then(() => this.push())
          .catch(() => undefined);
      }, DETECT_MS),
    );
  }

  /** A change to the database (a webhook set a task to todo, a dependency was approved): look again soon. */
  kick(): void {
    if (this.kicking || this.closing) return;
    this.kicking = setTimeout(() => {
      this.kicking = null;
      try {
        this.current()?.tick();
      } catch {
        /* next time */
      }
      this.push();
    }, 400);
  }

  setConfig(patch: unknown) {
    const cfg = setOrchestratorConfig(this.getDb(), patch);
    this.push();
    return cfg;
  }

  ids(): readonly ProviderId[] {
    return PROVIDER_IDS;
  }

  /** On quit: stop the timers, end every provider process tree, and let the runs write their last rows (bounded wait). */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.kicking) clearTimeout(this.kicking);
    const o = this.orch;
    if (!o) return;
    o.abortAll();
    await Promise.race([o.idle(), new Promise((r) => setTimeout(r, 4000))]);
  }
}
