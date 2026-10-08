import {
  getActivityFeed,
  getProjectStatus,
  getTask,
  getTaskHistory,
  isAgentActive,
  listAgents,
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
  ]);
  out(table(['AGENT', 'TYPE', 'STATE', 'LAST ACTION', 'ACTIONS', 'MODEL'], rows));
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
