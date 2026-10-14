import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sameAgentFamily } from './agents';
import { buildTaskContextMd } from './context';
import { auditCompletedTask } from './lesson-audit';
import { getLibraryAgent } from './library/agents';
import type { LibraryDb } from './library/db';
import { assignmentBlock, syncMirrors } from './project-agents';
import { readProjectFile } from './project-file';
import { buildRunPrompt, type BuiltPrompt } from './prompt';
import type { Db } from './db';
import { CoreError } from './errors';
import { agentProvider, canChooseModel, resolveAgentModel } from './models';
import {
  getOrchestratorConfig,
  getOrchestratorMode,
  setOrchestratorMode,
  type OrchMode,
} from './orchestrator-settings';
import {
  DEFAULT_PROVIDER,
  estimateCostUsd,
  isProviderId,
  ProviderError,
  redact,
  type Detection,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRunResult,
} from './providers';
import { getAgent, getMilestone, getTask, listAgents, listTasks, logAction } from './queries';
import { createRun, finishRun, localDayStartIso, runUsageSince } from './runs';
import { transition } from './state-machine';
import type { Agent, Run, Task } from './types';

// M14 orchestrator. D22: dispatch is plain code, never an LLM: which task runs next is decided by the rules in
// `readyTasks`. An LLM is used only inside a run, to do the task. Every run is a row in `runs` (D26) and every unattended
// run is bounded by the D28 limits. A task finished by agent A is reviewed by someone else (D29).

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface Route {
  agent: Agent;
  provider: ProviderId;
}

/** Who runs this task and on what: the task's override beats the agent's provider. Null when it cannot be routed. */
export function routeTask(db: Db, task: Task, lib: LibraryDb | null = null): Route | null {
  if (task.execution_mode !== 'agent' || !task.assignee) return null;
  const agent = getAgent(db, task.assignee);
  if (!agent || !canChooseModel(agent)) return null;
  // A library agent the project removed or disabled, that may not take this kind of task, or that was archived in the library
  // (D35), receives no dispatches. Agents the library does not manage are unaffected.
  if (assignmentBlock(db, agent.id, getMilestone(db, task.milestone_id)?.domain ?? null))
    return null;
  if (lib && getLibraryAgent(lib, agent.id)?.status === 'archived') return null;
  const wanted = task.provider_override ?? agent.provider ?? DEFAULT_PROVIDER;
  if (!isProviderId(wanted)) return null;
  return { agent, provider: wanted };
}

/**
 * The tasks the orchestrator may start right now (D22): status To Do, an agent assignee that runs on a text provider, every
 * `depends_on` task done, no run already queued or running for it, and its provider available (when `available` is given).
 * Ordered by milestone planned start, then priority, then due date, then id.
 */
export function readyTasks(
  db: Db,
  available: ReadonlySet<ProviderId> | null = null,
  lib: LibraryDb | null = null,
): Task[] {
  const active = new Set(
    (
      db
        .prepare("SELECT DISTINCT task_id FROM runs WHERE status IN ('queued','running')")
        .all() as {
        task_id: string;
      }[]
    ).map((r) => r.task_id),
  );
  const start = new Map<string, string | null>();
  const startOf = (milestoneId: string) => {
    if (!start.has(milestoneId))
      start.set(milestoneId, getMilestone(db, milestoneId)?.planned_start ?? null);
    return start.get(milestoneId) ?? null;
  };
  const ready = listTasks(db, { status: 'todo' }).filter((t) => {
    if (active.has(t.id)) return false;
    const route = routeTask(db, t, lib);
    if (!route) return false;
    if (available && !available.has(route.provider)) return false;
    return t.depends_on.every((id) => getTask(db, id)?.status === 'done');
  });
  const cmp = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  return ready.sort(
    (a, b) =>
      cmp(startOf(a.milestone_id), startOf(b.milestone_id)) ||
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      cmp(a.due_date, b.due_date) ||
      (a.id < b.id ? -1 : 1),
  );
}

export type CapReason = 'hourly' | 'daily' | null;

export interface OrchestratorStatus {
  mode: OrchMode;
  running: number;
  /** Ready tasks that are waiting for a slot, a cap or the orchestrator being switched on. */
  queued: number;
  maxConcurrent: number;
  startedLastHour: number;
  maxPerHour: number;
  spendToday: number;
  dailyCeiling: number;
  /** Why no new run will start, when a cap (not the concurrency limit) is what stops it. */
  pausedByCap: CapReason;
  providers: ({ id: ProviderId } & Detection)[];
  /** Set when this project's project.json is malformed: dispatch is blocked for this project only (D36). */
  projectBlock: string | null;
}

/** Why dispatch is blocked for the project in `folder` (a malformed project.json), or null. A missing file is fine (D36). */
export function projectDispatchBlock(folder: string): string | null {
  const f = readProjectFile(folder);
  return !f.ok && !f.missing
    ? `Dispatch is blocked until project.json is fixed: ${f.issues.join('; ')}`
    : null;
}

export function capReason(db: Db, now: Date): CapReason {
  const cfg = getOrchestratorConfig(db);
  const hour = runUsageSince(db, new Date(now.getTime() - 3_600_000).toISOString());
  if (hour.started >= cfg.maxPerHour) return 'hourly';
  if (
    cfg.dailySpendUsd > 0 &&
    runUsageSince(db, localDayStartIso(now)).costUsd >= cfg.dailySpendUsd
  )
    return 'daily';
  return null;
}

export function orchestratorStatus(
  db: Db,
  availability: ReadonlyMap<ProviderId, Detection> | null = null,
  now = new Date(),
  lib: LibraryDb | null = null,
): OrchestratorStatus {
  const cfg = getOrchestratorConfig(db);
  const running = (
    db.prepare("SELECT COUNT(*) n FROM runs WHERE status = 'running'").get() as { n: number }
  ).n;
  const avail = availability
    ? new Set([...availability].filter(([, d]) => d.available).map(([id]) => id))
    : null;
  return {
    mode: getOrchestratorMode(db),
    running,
    queued: readyTasks(db, avail, lib).length,
    maxConcurrent: cfg.maxConcurrent,
    startedLastHour: runUsageSince(db, new Date(now.getTime() - 3_600_000).toISOString()).started,
    maxPerHour: cfg.maxPerHour,
    spendToday: runUsageSince(db, localDayStartIso(now)).costUsd,
    dailyCeiling: cfg.dailySpendUsd,
    pausedByCap: capReason(db, now),
    providers: availability ? [...availability].map(([id, d]) => ({ id, ...d })) : [],
    projectBlock: db.name ? projectDispatchBlock(dirname(db.name)) : null,
  };
}

export interface OrchestratorDeps {
  db: Db;
  /** The project folder: providers run in it and `.claude/TASK_CONTEXT.md` lives in it. */
  projectRoot: string;
  providers: Record<ProviderId, ProviderAdapter>;
  /** The key for an API provider (decrypted by the app). Never stored by the core. */
  getKey: (id: ProviderId) => string | null;
  now?: () => Date;
  /** The app-wide library: agent profiles (D34), agent- and global-scope lessons (D38), archived agents. Null for a bare project. */
  library?: LibraryDb | null;
}

/** Per-run output cap (characters). */
const MAX_OUTPUT_CHARS = 200_000;

const REVIEW_SYSTEM = (agent: Agent) =>
  `You are ${agent.name}, an independent reviewer. You did NOT do this work. Check the report against the acceptance criteria and reply with a short assessment whose LAST two lines are "VERDICT: APPROVE" or "VERDICT: REJECT", and "REASON: <one sentence>".`;

/** The last `SUMMARY:` line of an agent's report, else its last non-empty line. */
export function extractSummary(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tagged = [...lines].reverse().find((l) => /^SUMMARY:/i.test(l));
  return (tagged ? tagged.replace(/^SUMMARY:\s*/i, '') : (lines.at(-1) ?? 'No output.')).slice(
    0,
    300,
  );
}

export function parseVerdict(output: string): {
  verdict: 'APPROVE' | 'REJECT' | null;
  reason: string;
} {
  const v = [...output.matchAll(/^\s*VERDICT:\s*(APPROVE|REJECT)/gim)].at(-1)?.[1]?.toUpperCase();
  const reason = [...output.matchAll(/^\s*REASON:\s*(.+)$/gim)].at(-1)?.[1]?.trim() ?? '';
  return { verdict: v === 'APPROVE' || v === 'REJECT' ? v : null, reason };
}

const fmtDuration = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

interface Inflight {
  abort: AbortController;
  promise: Promise<void>;
  taskId: string;
  agentId: string;
  kind: 'work' | 'review';
  runId: string;
}

export class Orchestrator {
  private readonly db: Db;
  /** One entry per task being worked on or reviewed; `runId` follows the attempt that is running now. */
  private readonly inflight = new Map<string, Inflight>();
  private availability = new Map<ProviderId, Detection>();
  private shuttingDown = false;
  private readonly now: () => Date;
  private readonly lib: LibraryDb | null;

  constructor(private readonly d: OrchestratorDeps) {
    this.db = d.db;
    this.now = d.now ?? (() => new Date());
    this.lib = d.library ?? null;
  }

  // ---- providers ----

  /** Detect every provider (installed, reachable, keyed). Called at startup and from Settings → Providers. */
  async refreshProviders(): Promise<ReadonlyMap<ProviderId, Detection>> {
    const next = new Map<ProviderId, Detection>();
    await Promise.all(
      (Object.values(this.d.providers) as ProviderAdapter[]).map(async (p) => {
        try {
          next.set(p.id, await p.detect());
        } catch (e) {
          next.set(p.id, { available: false, detail: e instanceof Error ? e.message : String(e) });
        }
      }),
    );
    this.availability = next;
    return next;
  }

  providerAvailable(id: ProviderId): boolean {
    return this.availability.get(id)?.available === true;
  }

  private availableSet(): Set<ProviderId> {
    return new Set([...this.availability].filter(([, d]) => d.available).map(([id]) => id));
  }

  // ---- state ----

  status(): OrchestratorStatus {
    return orchestratorStatus(this.db, this.availability, this.now(), this.lib);
  }

  readyTasks(): Task[] {
    return readyTasks(this.db, this.availableSet(), this.lib);
  }

  /** Resolves when no run is in flight (tests; also used when the app quits). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0)
      await Promise.allSettled([...this.inflight.values()].map((r) => r.promise));
  }

  /**
   * A run left `running` by a crash or a quit has no process behind it any more: mark it failed and block its task, so
   * nothing sits In Progress with nobody working on it.
   */
  recoverStale(): number {
    const stale = this.db
      .prepare("SELECT id, task_id, agent_id, kind FROM runs WHERE status IN ('queued','running')")
      .all() as { id: string; task_id: string; agent_id: string; kind: string }[];
    for (const r of stale) {
      if (this.isInflight(r.id)) continue;
      finishRun(this.db, r.id, { status: 'failed', error: 'The app closed during the run.' });
      const t = getTask(this.db, r.task_id);
      if (r.kind === 'work' && t && t.status === 'in_progress')
        transition(this.db, t.id, 'block', {
          actor: r.agent_id,
          reason: 'The app closed during the run.',
        });
    }
    return stale.filter((r) => !this.isInflight(r.id)).length;
  }

  private isInflight(runId: string): boolean {
    return [...this.inflight.values()].some((e) => e.runId === runId);
  }

  // ---- control ----

  /** Pause or stop. `cancelRunning` also aborts runs in flight (their tasks are blocked as "cancelled"). */
  pause(o: { cancelRunning?: boolean } = {}): OrchMode {
    const mode = setOrchestratorMode(this.db, 'paused');
    if (o.cancelRunning) for (const e of this.inflight.values()) e.abort.abort();
    return mode;
  }

  resume(): OrchMode {
    return setOrchestratorMode(this.db, 'running');
  }

  /** No new runs; the mode becomes paused once the last run in flight ends. */
  stopAfterCurrent(): OrchMode {
    return setOrchestratorMode(this.db, this.inflight.size > 0 ? 'draining' : 'paused');
  }

  /** The app is closing: end every run in flight. Their tasks are blocked as "app closed", not as an operator cancel. */
  abortAll(): void {
    this.shuttingDown = true;
    for (const e of this.inflight.values()) e.abort.abort();
  }

  /** Abort a run in flight (its provider's process tree is killed). False if it is not running here. */
  cancel(runId: string): boolean {
    const entry = [...this.inflight.values()].find((e) => e.runId === runId);
    if (!entry) return false;
    entry.abort.abort();
    return true;
  }

  /** Abort runs another process asked to cancel (`cancel_run` over MCP, the CLI): polled every second by the app. */
  checkCancels(): void {
    const rows = this.db
      .prepare("SELECT id FROM runs WHERE status = 'running' AND cancel_requested = 1")
      .all() as { id: string }[];
    for (const r of rows) this.cancel(r.id);
  }

  // ---- dispatch ----

  /**
   * One scheduling pass (every 5 s while running): start as many ready tasks as the limits allow, in order. Returns the
   * ids of the runs it started. Stops at once when a cap (hourly / daily) is reached; the concurrency limits just leave
   * tasks queued.
   */
  tick(): string[] {
    this.checkCancels();
    const mode = getOrchestratorMode(this.db);
    if (mode === 'draining' && this.inflight.size === 0) setOrchestratorMode(this.db, 'paused');
    if (mode !== 'running') return [];
    if (projectDispatchBlock(this.d.projectRoot)) return []; // a malformed project.json blocks THIS project's dispatch only
    if (this.lib) syncMirrors(this.db, this.lib); // an agent edited once in the library applies from the next run
    const cfg = getOrchestratorConfig(this.db);
    const started: string[] = [];
    for (const task of this.readyTasks()) {
      if (capReason(this.db, this.now())) break;
      if (this.inflight.size >= cfg.maxConcurrent) break;
      const route = routeTask(this.db, task, this.lib);
      if (!route) continue;
      if (this.agentRunning(route.agent.id) >= route.agent.max_concurrent) continue;
      started.push(this.launch(task, route, {}));
    }
    return started;
  }

  /**
   * Start one task now (the manual Start button). Same path as the loop, but it ignores the orchestrator being paused and
   * the hourly / daily caps: the operator asked for it. Refuses a task that is not To Do, has no agent route, whose provider
   * is not available, or (unless `force`) whose dependencies are not done.
   */
  dispatch(taskId: string, o: { force?: boolean } = {}): string {
    const task = getTask(this.db, taskId);
    if (!task) throw new CoreError('TASK_NOT_FOUND', `Task ${taskId} does not exist.`);
    if (task.status !== 'todo')
      throw new CoreError(
        'NOT_READY',
        `${taskId} is ${task.status}; only a To Do task can be started.`,
      );
    const block = projectDispatchBlock(this.d.projectRoot);
    if (block) throw new CoreError('PROJECT_INVALID', block);
    if (this.lib) syncMirrors(this.db, this.lib);
    const route = routeTask(this.db, task, this.lib);
    if (!route)
      throw new CoreError(
        'NOT_ROUTABLE',
        `${taskId} has no agent to run it: assign an agent that runs on a text provider (not a person or an external tool).`,
      );
    if (!this.providerAvailable(route.provider))
      throw new CoreError(
        'PROVIDER_UNAVAILABLE',
        `${route.provider} is not detected (${this.availability.get(route.provider)?.detail ?? 'not checked yet'}).`,
      );
    if ([...this.inflight.values()].some((r) => r.taskId === taskId))
      throw new CoreError('NOT_READY', `${taskId} already has a run in progress.`);
    if (!o.force) {
      const unmet = task.depends_on.filter((id) => getTask(this.db, id)?.status !== 'done');
      if (unmet.length > 0)
        throw new CoreError(
          'NOT_READY',
          `${taskId} depends on ${unmet.join(', ')}, which are not done. Start it anyway to override.`,
        );
    }
    return this.launch(task, route, { manual: true });
  }

  private agentRunning(agentId: string): number {
    return [...this.inflight.values()].filter((r) => r.agentId === agentId).length;
  }

  private launch(task: Task, route: Route, o: { manual?: boolean }): string {
    const abort = new AbortController();
    // The first attempt's row is created synchronously so two ticks can never start the same task twice. The prompt is built
    // here, so the spec file is read at dispatch (an edit applies to the very next run) and the run records what it was built from.
    const built = this.build(task, route.agent);
    const run = this.openRun(task, route, 1, 'work', built);
    const entry: Inflight = {
      abort,
      promise: Promise.resolve(),
      taskId: task.id,
      agentId: route.agent.id,
      kind: 'work',
      runId: run.id,
    };
    this.inflight.set(task.id, entry);
    entry.promise = this.executeWork(task.id, route, run, built, entry, o)
      .catch((e) => {
        // Last resort: an unexpected error must not leave a run "running" forever.
        this.closeRun(entry.runId, {
          status: 'failed',
          error: redact(e instanceof Error ? e.message : String(e), this.secrets()),
        });
      })
      .finally(() => {
        this.inflight.delete(task.id);
        if (getOrchestratorMode(this.db) === 'draining' && this.inflight.size === 0)
          setOrchestratorMode(this.db, 'paused');
      });
    return run.id;
  }

  private secrets(): (string | null)[] {
    return (Object.keys(this.d.providers) as ProviderId[]).map((id) => this.d.getKey(id));
  }

  /** The D34 prompt for this agent and task: library profile, project rules, required lessons, task context. */
  private build(task: Task, agent: Agent): BuiltPrompt {
    return buildRunPrompt({
      db: this.db,
      lib: this.lib,
      projectRoot: this.d.projectRoot,
      task,
      agent,
      now: this.now(),
    });
  }

  private openRun(
    task: Task,
    route: Route,
    attempt: number,
    kind: 'work' | 'review',
    built: BuiltPrompt | null = null,
  ): Run {
    const { model, warning } = resolveAgentModel(this.db, route.agent.id);
    if (warning)
      logAction(this.db, {
        agentId: route.agent.id,
        action: 'model_unavailable',
        targetType: 'subtask',
        targetId: task.id,
        description: warning,
        tags: ['model', 'warning'],
      });
    return createRun(this.db, {
      taskId: task.id,
      agentId: route.agent.id,
      provider: route.provider,
      // The model that will actually be called: the agent's choice, else the adapter's own default (API providers).
      model: model ?? this.d.providers[route.provider].defaultModel,
      kind,
      attempt,
      status: 'running',
      ...(built
        ? {
            layers: built.layers,
            specHash: built.specHash,
            specStatus: built.specStatus,
            lessonIds: built.lessonIds,
          }
        : {}),
    });
  }

  private closeRun(runId: string, f: Parameters<typeof finishRun>[2]): Run {
    return finishRun(this.db, runId, f);
  }

  /** Call the provider for one run; returns its result or throws a ProviderError. Cancel/timeout come through the signal. */
  private async callProvider(
    run: Run,
    system: string,
    prompt: string,
    abort: AbortController,
    allowEdits: boolean,
    disallowedTools: string[] = [],
  ): Promise<ProviderRunResult> {
    const adapter = this.d.providers[run.provider as ProviderId];
    const cfg = getOrchestratorConfig(this.db);
    return adapter.run({
      prompt,
      system,
      workdir: this.d.projectRoot,
      model: run.model,
      timeoutMs: cfg.runTimeoutMin * 60_000,
      signal: abort.signal,
      maxOutputChars: MAX_OUTPUT_CHARS,
      apiKey: this.d.getKey(run.provider as ProviderId),
      allowEdits,
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    });
  }

  /** Close a run from a provider result: tokens, cost (reported or estimated), output tail, one `run_finished` log row (D26). */
  private recordSuccess(run: Run, route: Route, result: ProviderRunResult): Run {
    const u = result.usage;
    const reported = u.costUsd !== null && route.provider !== 'local';
    const used = result.model ?? run.model ?? this.d.providers[route.provider].defaultModel;
    const est = reported
      ? u.costUsd
      : estimateCostUsd(route.provider, used, u.inputTokens, u.outputTokens);
    const closed = this.closeRun(run.id, {
      status: 'succeeded',
      model: used,
      exitCode: result.exitCode,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      estCostUsd: est,
      costBasis: est === null ? null : reported ? 'reported' : 'estimate',
      outputTail: result.output,
    });
    this.logRun(closed, route.agent, result.truncated ? 'output truncated' : '');
    return closed;
  }

  private recordFailure(
    run: Run,
    route: Route,
    e: unknown,
  ): { run: Run; cancelled: boolean; message: string } {
    const err =
      e instanceof ProviderError
        ? e
        : new ProviderError('failed', e instanceof Error ? e.message : String(e));
    const cancelled = err.code === 'cancelled';
    const message = redact(err.message, this.secrets()).slice(0, 500);
    const closed = this.closeRun(run.id, {
      status: cancelled ? 'cancelled' : 'failed',
      exitCode: err.exitCode,
      error: message,
    });
    this.logRun(closed, route.agent, message);
    return { run: closed, cancelled, message };
  }

  private logRun(run: Run, agent: Agent, note: string): void {
    const ms =
      run.started_at && run.finished_at
        ? Date.parse(run.finished_at) - Date.parse(run.started_at)
        : 0;
    const tokens =
      run.input_tokens !== null || run.output_tokens !== null
        ? ` · ${run.input_tokens ?? '?'} in / ${run.output_tokens ?? '?'} out tokens`
        : '';
    const cost =
      run.est_cost_usd !== null
        ? ` · $${run.est_cost_usd.toFixed(4)} (${run.cost_basis === 'reported' ? 'reported' : 'estimate'})`
        : '';
    logAction(this.db, {
      agentId: agent.id,
      action: 'run_finished',
      targetType: 'subtask',
      targetId: run.task_id,
      description:
        `${run.task_id}: ${run.kind} run ${run.status} on ${run.provider}/${run.model ?? 'default'} in ${fmtDuration(ms)}` +
        `${run.exit_code !== null ? ` · exit ${run.exit_code}` : ''}${tokens}${cost}${note ? ` · ${note}` : ''}`.slice(
          0,
          480,
        ),
      tags: ['run', run.provider, run.id],
    });
  }

  private ensureContextFile(md: string): void {
    const file = join(this.d.projectRoot, '.claude', 'TASK_CONTEXT.md');
    try {
      if (existsSync(file)) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, md, 'utf8');
    } catch {
      /* the prompt carries the context; the file is a convenience */
    }
  }

  /** The work of one task: start it, run the provider (once more on failure), then complete it or block it. */
  private async executeWork(
    taskId: string,
    route: Route,
    first: Run,
    firstBuilt: BuiltPrompt,
    entry: Inflight,
    o: { manual?: boolean },
  ): Promise<void> {
    const agent = route.agent;
    const abort = entry.abort;
    try {
      const t = getTask(this.db, taskId);
      if (t?.status === 'todo')
        transition(this.db, taskId, 'start', { actor: agent.id, force: o.manual === true });
    } catch (e) {
      this.closeRun(first.id, {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    this.ensureContextFile(firstBuilt.prompt);

    let run = first;
    let built = firstBuilt;
    let lastError = 'The run failed.';
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) {
        const t = getTask(this.db, taskId);
        if (!t || t.status !== 'in_progress') return;
        built = this.build(t, agent); // the spec may have changed since the first attempt
        run = this.openRun(t, route, 2, 'work', built);
        entry.runId = run.id;
      }
      try {
        const result = await this.callProvider(
          run,
          built.system,
          built.prompt,
          abort,
          route.provider === 'claude-code',
          built.forbiddenTools,
        );
        const closed = this.recordSuccess(run, route, result);
        const summary = extractSummary(result.output);
        if (/^BLOCKED\b/i.test(summary)) {
          transition(this.db, taskId, 'block', {
            actor: agent.id,
            reason:
              summary.replace(/^BLOCKED\s*[-:]?\s*/i, '') || 'The agent reported it is blocked.',
          });
          return;
        }
        transition(this.db, taskId, 'complete', { actor: agent.id, summary });
        // Automatic lesson checks run when a task reaches Review (D40): a failed one sends it back to In Progress.
        const audit = auditCompletedTask(this.db, this.lib, {
          taskId,
          agentId: agent.id,
          projectRoot: this.d.projectRoot,
        });
        if (audit.sentBack) return;
        if (getOrchestratorConfig(this.db).autoReview) await this.review(taskId, agent, closed);
        return;
      } catch (e) {
        const f = this.recordFailure(run, route, e);
        lastError = f.message;
        if (f.cancelled) {
          transition(this.db, taskId, 'block', {
            actor: agent.id,
            reason: this.shuttingDown
              ? 'The app closed during the run.'
              : 'Run cancelled by the operator.',
          });
          return;
        }
      }
    }
    // Failed twice: block the task with the error (D22 failure path); the orchestrator moves on to other ready tasks.
    const t = getTask(this.db, taskId);
    if (t && t.status === 'in_progress')
      transition(this.db, taskId, 'block', {
        actor: agent.id,
        reason: `Failed twice on ${route.provider}: ${lastError}`,
      });
  }

  // ---- review (D29) ----

  /** The agent that should review work done by `submitter`: a text agent outside its family, another provider first. */
  pickReviewer(submitter: Agent): Route | null {
    const candidates = listAgents(this.db)
      .filter((a) => canChooseModel(a) && !sameAgentFamily(this.db, a.id, submitter.id))
      .map((a) => ({ agent: a, provider: agentProvider(a) }))
      .filter((c) => this.providerAvailable(c.provider));
    candidates.sort(
      (x, y) =>
        Number(x.provider === agentProvider(submitter)) -
          Number(y.provider === agentProvider(submitter)) || (x.agent.id < y.agent.id ? -1 : 1),
    );
    return candidates[0] ?? null;
  }

  /**
   * Have a different agent review a task that reached Review. The verdict is applied through the same state machine as a
   * person's click, so the independence rule (an agent never approves work of its own family) applies here too. No reviewer
   * available, or no clear verdict: the task simply waits in Review for the operator.
   */
  async review(taskId: string, submitter: Agent, workRun: Run): Promise<void> {
    const reviewer = this.pickReviewer(submitter);
    const task = getTask(this.db, taskId);
    if (!reviewer || !task || task.status !== 'review') return;
    const abort = new AbortController();
    const run = this.openRun(task, reviewer, 1, 'review');
    const md = buildTaskContextMd(this.db, taskId, this.now()) ?? `# ${taskId}`;
    let diff = '';
    try {
      diff = execFileSync('git', ['diff', '--stat'], {
        cwd: this.d.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
      }).slice(0, 4000);
    } catch {
      /* not a git repository */
    }
    const prompt = `${md}\n\n## The work\n${submitter.name} reported: ${workRun.output_tail?.slice(-1500) ?? '(no output)'}\n${diff ? `\n## Files changed\n${diff}\n` : ''}\nJudge whether the acceptance criteria are met.`;
    const key = `review:${taskId}`;
    this.inflight.set(key, {
      abort,
      promise: Promise.resolve(),
      taskId,
      agentId: reviewer.agent.id,
      kind: 'review',
      runId: run.id,
    });
    try {
      const result = await this.callProvider(
        run,
        REVIEW_SYSTEM(reviewer.agent),
        prompt,
        abort,
        false,
      );
      this.recordSuccess(run, reviewer, result);
      const { verdict, reason } = parseVerdict(result.output);
      if (verdict === 'APPROVE')
        transition(this.db, taskId, 'approve', {
          actor: reviewer.agent.id,
          summary: reason || 'Approved by the reviewer.',
        });
      else if (verdict === 'REJECT')
        transition(this.db, taskId, 'reject', {
          actor: reviewer.agent.id,
          reason: reason || 'Rejected by the reviewer.',
        });
      else
        logAction(this.db, {
          agentId: reviewer.agent.id,
          action: 'review_inconclusive',
          targetType: 'subtask',
          targetId: taskId,
          description: `${taskId}: the reviewer gave no clear verdict; it waits for the operator.`,
          tags: ['review'],
        });
    } catch (e) {
      this.recordFailure(run, reviewer, e);
    } finally {
      this.inflight.delete(key);
    }
  }
}
