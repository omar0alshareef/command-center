import {
  getActivityFeed,
  getLessonsForTask,
  getRelevantLessons,
  getProjectStatus,
  getTask,
  getTaskHistory,
  isAgentActive,
  listAgents,
  listLessons,
  listRuns,
  orchestratorStatus,
  setOrchestratorMode,
  getOrchestratorConfig,
  type OrchestratorStatus,
} from '@command-center/core';
import { CliError, type Handle } from './context';
import { ago, clip, table } from './format';

export type Out = (line: string) => void;

export function statusCommand({ db }: Handle, json: boolean, out: Out): void {
  const s = getProjectStatus(db);
  if (json) return out(JSON.stringify(s, null, 2));
  out(`${s.name}: ${s.context}`);
  out(`Schedule ${s.schedule_status} (max drift ${s.max_drift_days}d), ${s.progress_pct}% done`);
  out(
    `Tasks (${s.total_tasks}): ` +
      Object.entries(s.tasks)
        .map(([k, v]) => `${k.replace('_', ' ')} ${v}`)
        .join(', '),
  );
  out(`Agents: ${s.agents.active} active of ${s.agents.total}`);
  if (s.awaiting_review.length) {
    out('\nAwaiting your review:');
    for (const t of s.awaiting_review) out(`  ${t.id}  ${clip(t.label, 70)}`);
  }
  if (s.blocked.length) {
    out('\nBlocked:');
    for (const t of s.blocked)
      out(`  ${t.id}  ${clip(t.label, 50)}  (${t.reason ?? 'no reason given'})`);
  }
}

export function agentsCommand({ db }: Handle, json: boolean, out: Out): void {
  const agents = listAgents(db).filter((a) => a.id !== 'operator' && a.id !== 'system');
  if (json) return out(JSON.stringify(agents, null, 2));
  if (agents.length === 0) return out('No agents have connected yet.');
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rows = agents.map((a) => [
    a.parent_id && byId.has(a.parent_id) ? `  ${a.id}` : a.id,
    a.type,
    isAgentActive(a) ? 'ACTIVE' : a.status === 'error' ? 'ERROR' : 'IDLE',
    ago(a.last_action_at),
    String(a.session_action_count),
    a.source_model ?? '',
    a.executor === 'agent'
      ? `${a.provider ?? 'claude-code'}${a.model ? `/${a.model}` : ''}`
      : a.executor,
  ]);
  out(table(['AGENT', 'TYPE', 'STATE', 'LAST ACTION', 'ACTIONS', 'MODEL', 'RUNS ON'], rows));
}

export function logCommand(
  { db }: Handle,
  o: { task?: string; agent?: string; limit: number; json: boolean },
  out: Out,
): void {
  if (o.task && !getTask(db, o.task))
    throw new CliError(`No task ${o.task}. Try \`command-center status\`.`);
  const entries = o.task
    ? getTaskHistory(db, o.task, o.limit).log.filter((e) => !o.agent || e.agent_id === o.agent)
    : getActivityFeed(db, { limit: o.limit, agentId: o.agent });
  if (o.json) return out(JSON.stringify(entries, null, 2));
  if (entries.length === 0) return out('No log entries.');
  for (const e of entries) {
    const when = new Date(e.timestamp).toLocaleString();
    out(
      `${when}  ${e.agent_id}  ${e.action}${e.target_id ? `  ${e.target_id}` : ''}${e.description ? `  ${clip(e.description, 90)}` : ''}`,
    );
  }
}

export function lessonsCommand(
  { db }: Handle,
  o: { task?: string; query?: string; limit: number; json: boolean },
  out: Out,
): void {
  let lessons;
  if (o.task) {
    const t = getTask(db, o.task);
    if (!t) throw new CliError(`No task ${o.task}. Try \`command-center status\`.`);
    lessons = getLessonsForTask(
      db,
      t.id,
      t.label,
      o.limit,
      t.acceptance_criteria.map((c) => c.text),
    );
  } else if (o.query) lessons = getRelevantLessons(db, o.query, [], o.limit);
  else lessons = listLessons(db).slice(0, o.limit);
  if (o.json) return out(JSON.stringify(lessons, null, 2));
  if (lessons.length === 0) return out('No lessons recorded yet. A rejected task adds one.');
  for (const l of lessons) {
    out(`${l.subtask_id}  ${l.created_at.slice(0, 10)}  ${l.rejection_reason}`);
    if (l.fix_applied) out(`    fix: ${l.fix_applied}`);
    if (l.prevention) out(`    prevention: ${l.prevention}`);
  }
}

const money = (n: number) => `$${n.toFixed(n >= 0.01 || n === 0 ? 2 : 4)}`;

function statusLines(s: OrchestratorStatus, ceiling: number): string[] {
  const lines = [
    `Orchestrator: ${s.mode}`,
    `Running ${s.running} / ${s.maxConcurrent} · queued ${s.queued}`,
    `Started in the last hour: ${s.startedLastHour} / ${s.maxPerHour}`,
    `Spent today (estimate): ${money(s.spendToday)}${ceiling > 0 ? ` / ${money(ceiling)}` : ' (no ceiling)'}`,
  ];
  if (s.pausedByCap)
    lines.push(
      `PAUSED BY CAP (${s.pausedByCap}): no new run starts until the window clears or you raise the cap.`,
    );
  return lines;
}

/**
 * The orchestrator itself runs inside the app; this only reads its state and flips the mode in the shared database, which the
 * app sees within seconds. Provider detection is the app's, so `queued` here counts every ready task.
 */
export function orchestrateCommand(
  { db }: Handle,
  o: { status?: boolean; pause?: boolean; resume?: boolean; json?: boolean },
  out: Out,
): void {
  const chosen = [o.status, o.pause, o.resume].filter(Boolean).length;
  if (chosen > 1) throw new CliError('Use only one of --status, --pause, --resume.');
  if (o.pause) setOrchestratorMode(db, 'paused');
  if (o.resume) setOrchestratorMode(db, 'running');
  const s = orchestratorStatus(db);
  if (o.json)
    return out(
      JSON.stringify({ ...s, providers: undefined, config: getOrchestratorConfig(db) }, null, 2),
    );
  if (o.pause)
    out('Paused: no new runs will start (runs in flight finish, or cancel them in the app).');
  if (o.resume)
    out('Resumed: the app starts ready tasks within a few seconds (it must be running).');
  for (const line of statusLines(s, getOrchestratorConfig(db).dailySpendUsd)) out(line);
}

export function runsCommand(
  { db }: Handle,
  o: { task?: string; limit: number; json?: boolean },
  out: Out,
): void {
  const taskId = o.task?.trim().toUpperCase();
  if (taskId && !getTask(db, taskId)) throw new CliError(`Task ${taskId} does not exist.`);
  const runs = listRuns(db, { ...(taskId ? { taskId } : {}), limit: o.limit });
  if (o.json) return out(JSON.stringify(runs, null, 2));
  if (runs.length === 0) return out(taskId ? `No runs for ${taskId} yet.` : 'No runs yet.');
  out(
    table(
      ['RUN', 'TASK', 'AGENT', 'PROVIDER / MODEL', 'STATUS', 'TIME', 'TOKENS', 'COST'],
      runs.map((r) => [
        r.id.slice(0, 8),
        r.task_id,
        r.agent_id,
        `${r.provider}/${r.model ?? 'default'}`,
        r.status + (r.kind === 'review' ? ' (review)' : r.attempt > 1 ? ` (try ${r.attempt})` : ''),
        r.started_at && r.finished_at
          ? `${Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000))}s`
          : '',
        r.input_tokens === null && r.output_tokens === null
          ? ''
          : `${r.input_tokens ?? '?'}/${r.output_tokens ?? '?'}`,
        r.est_cost_usd === null
          ? ''
          : `${money(r.est_cost_usd)} ${r.cost_basis === 'reported' ? '' : '(est.)'}`.trim(),
      ]),
    ),
  );
}
