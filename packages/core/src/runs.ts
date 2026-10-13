import { randomUUID } from 'node:crypto';
import { nowIso, write, type Db } from './db';
import { CoreError } from './errors';
import { getRun, logAction } from './queries';
import type { Run, RunStatus } from './types';

// The `runs` table: one row per provider call (D26). The orchestrator writes it; the UI, the MCP server and the CLI read it.

export interface NewRun {
  taskId: string;
  agentId: string;
  provider: string;
  model: string | null;
  kind?: 'work' | 'review';
  attempt?: number;
  status?: 'queued' | 'running';
}

export function createRun(db: Db, o: NewRun, at = nowIso()): Run {
  const id = randomUUID();
  const running = (o.status ?? 'running') === 'running';
  write(db, () =>
    db
      .prepare(
        `INSERT INTO runs (id, task_id, agent_id, provider, model, kind, attempt, status, queued_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.taskId,
        o.agentId,
        o.provider,
        o.model,
        o.kind ?? 'work',
        o.attempt ?? 1,
        o.status ?? 'running',
        at,
        running ? at : null,
      ),
  );
  const run = getRun(db, id);
  if (!run) throw new CoreError('RUN_NOT_FOUND', `Run ${id} was not saved.`);
  return run;
}

export interface RunFinish {
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>;
  exitCode?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
  costBasis?: 'reported' | 'estimate' | null;
  error?: string | null;
  outputTail?: string | null;
  /** The model the provider actually used, when it is known (an API default the agent did not choose). */
  model?: string | null;
}

/** How much of a run's output is kept on its row (the tail: that is where the result and errors are). */
export const OUTPUT_TAIL_CHARS = 4000;

export function finishRun(db: Db, id: string, f: RunFinish, at = nowIso()): Run {
  write(db, () =>
    db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, input_tokens = ?, output_tokens = ?,
           est_cost_usd = ?, cost_basis = ?, error = ?, output_tail = ?, model = COALESCE(?, model) WHERE id = ?`,
      )
      .run(
        f.status,
        at,
        f.exitCode ?? null,
        f.inputTokens ?? null,
        f.outputTokens ?? null,
        f.estCostUsd ?? null,
        f.costBasis ?? null,
        f.error ?? null,
        f.outputTail === undefined || f.outputTail === null
          ? null
          : f.outputTail.slice(-OUTPUT_TAIL_CHARS),
        f.model ?? null,
        id,
      ),
  );
  const run = getRun(db, id);
  if (!run) throw new CoreError('RUN_NOT_FOUND', `Run ${id} does not exist.`);
  return run;
}

/**
 * Ask for a run to stop. A queued run is cancelled on the spot; a running one gets `cancel_requested`, which the
 * orchestrator inside the app sees within a second and answers by killing the provider's process tree. Safe to call
 * from any process (the MCP server, the CLI). Cancelling never approves or completes work.
 */
export function cancelRun(db: Db, runId: string, actor = 'operator'): Run {
  return write(db, () => {
    const run = getRun(db, runId);
    if (!run) throw new CoreError('RUN_NOT_FOUND', `Run ${runId} does not exist.`);
    if (run.status !== 'queued' && run.status !== 'running')
      throw new CoreError('RUN_NOT_ACTIVE', `Run ${runId} is already ${run.status}.`);
    if (run.status === 'queued')
      db.prepare(
        "UPDATE runs SET status = 'cancelled', finished_at = ?, cancel_requested = 1 WHERE id = ?",
      ).run(nowIso(), runId);
    else db.prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(runId);
    logAction(db, {
      agentId: actor,
      action: 'run_cancel_requested',
      targetType: 'subtask',
      targetId: run.task_id,
      description: `${run.task_id}: cancel requested for the ${run.provider} run`,
      tags: ['run', run.provider],
    });
    const updated = getRun(db, runId);
    if (!updated) throw new CoreError('RUN_NOT_FOUND', `Run ${runId} does not exist.`);
    return updated;
  });
}

export interface RunUsageSince {
  /** Runs that started at or after the cut-off (running ones included). */
  started: number;
  /** Estimated spend of those runs in USD. */
  costUsd: number;
}

export function runUsageSince(db: Db, sinceIso: string): RunUsageSince {
  const r = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(est_cost_usd), 0) AS cost FROM runs WHERE started_at >= ?',
    )
    .get(sinceIso) as { n: number; cost: number };
  return { started: r.n, costUsd: r.cost };
}

export function countRuns(db: Db, status: RunStatus, filter: { agentId?: string } = {}): number {
  const r = filter.agentId
    ? db
        .prepare('SELECT COUNT(*) AS n FROM runs WHERE status = ? AND agent_id = ?')
        .get(status, filter.agentId)
    : db.prepare('SELECT COUNT(*) AS n FROM runs WHERE status = ?').get(status);
  return (r as { n: number }).n;
}

/** Local midnight of the day containing `now`, as an ISO string (the daily spend window). */
export function localDayStartIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
