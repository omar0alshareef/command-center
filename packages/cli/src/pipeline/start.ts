import { getAgent, getTask, logAction, transition } from '@command-center/core';
import { existsSync, readFileSync } from 'node:fs';
import { CliError, type Handle } from '../context';
import { checksText, defaultChecks, runChecks } from './checks';
import { contextPath, prepare } from './prepare';
import type { Runner } from './runner';
import { ensurePipelineAgents, runStage, warnModels, type Out } from './runtime';
import { PIPELINE_ORCHESTRATOR, renderPrompt, STAGES, taskVars } from './stages';

export interface StartOptions {
  runner: Runner;
  dryRun: boolean;
  /** Check commands to run after the build (default: the project's typecheck and lint scripts). */
  checks: string[];
  /** false = someone else already built it: only run the checks. */
  dispatch: boolean;
  budget: number;
  out: Out;
}

export type StartOutcome = 'completed' | 'started' | 'checks-failed' | 'dry-run';

/**
 * start_task, hand TASK_CONTEXT.md to an agent, run the project checks, and complete_task when they pass.
 * Nothing is completed unless an agent actually built it (or `--no-dispatch` says the work is already done).
 */
export async function start(h: Handle, taskId: string, o: StartOptions): Promise<StartOutcome> {
  const { db, root } = h;
  const task = getTask(db, taskId);
  if (!task) throw new CliError(`No task ${taskId}. Try \`command-center status\`.`);
  if (task.status === 'done' || task.status === 'review')
    throw new CliError(`${taskId} is already ${task.status}. Nothing to start.`);
  const checks = o.checks.length ? o.checks : defaultChecks(root);

  const file = contextPath(root);
  const haveContext = existsSync(file) && readFileSync(file, 'utf8').startsWith(`# ${taskId}:`);

  if (o.dryRun) {
    o.out(`# dry run: start ${taskId}\n`);
    o.out(
      `1. start_task ${taskId}${task.status === 'in_progress' ? ' (already in progress: skipped)' : ''}`,
    );
    o.out(`2. ${haveContext ? 'use the existing' : 'run prepare to write'} ${file}`);
    o.out(
      `3. ${o.dispatch ? `dispatch to the agent with this prompt:\n[system] ${STAGES.builder.system}\n\n${renderPrompt(STAGES.builder, { ...taskVars(task), context: haveContext ? readFileSync(file, 'utf8') : '<TASK_CONTEXT.md>' })}` : 'dispatch skipped (--no-dispatch)'}`,
    );
    o.out(`4. checks: ${checks.length ? checks.join(' && ') : '(none configured)'}`);
    o.out(
      `5. all checks pass -> complete_task${o.dispatch ? '' : ' (work assumed done)'}; otherwise the task stays In Progress`,
    );
    return 'dry-run';
  }

  ensurePipelineAgents(db);
  if (o.dispatch) warnModels(db, o.out, [task.assignee ?? STAGES.builder.agentId]);
  if (!haveContext)
    await prepare(h, taskId, { runner: o.runner, dryRun: false, budget: o.budget, out: o.out });

  if (task.status === 'todo' || task.status === 'blocked') {
    transition(db, taskId, task.status === 'todo' ? 'start' : 'unblock', { actor: 'operator' });
    o.out(`${taskId} -> In Progress.`);
  } else o.out(`${taskId} is already In Progress.`);

  let summary = 'Checks passed.';
  if (o.dispatch) {
    if (o.runner.name === 'local') {
      o.out(
        `The local runner does not write code. ${taskId} is started and the context is ready:\n  ${file}\nGive it to your agent, then run \`command-center start --id ${taskId} --no-dispatch\` to run the checks and complete the task.`,
      );
      return 'started';
    }
    o.out('Dispatching the agent with TASK_CONTEXT.md…');
    const built = await runStage(
      db,
      o.runner,
      root,
      getTask(db, taskId) ?? task,
      STAGES.builder,
      { context: readFileSync(file, 'utf8') },
      {},
      (out) => ({
        summary:
          `Dispatched ${task.assignee ?? 'the agent'} on ${taskId}. ${out.split('\n').find((l) => l.startsWith('SUMMARY:')) ?? ''}`.trim(),
        tags: ['build'],
      }),
    );
    if (!built.result.ok)
      throw new CliError(
        `The agent failed: ${built.result.error ?? 'no output'}. ${taskId} stays In Progress.`,
        2,
      );
    summary =
      built.result.output
        .split('\n')
        .find((l) => l.startsWith('SUMMARY:'))
        ?.slice(8)
        .trim() || 'Built by the dispatched agent; checks passed.';
  }

  o.out(
    checks.length
      ? `Running checks: ${checks.join(', ')}`
      : 'No checks are configured for this project.',
  );
  const results = runChecks(checks, root);
  if (results.some((r) => !r.ok)) {
    logAction(db, {
      agentId: PIPELINE_ORCHESTRATOR,
      action: 'checks_failed',
      targetType: 'subtask',
      targetId: taskId,
      description: results
        .filter((r) => !r.ok)
        .map((r) => r.command)
        .join(', ')
        .slice(0, 300),
      tags: ['build'],
    });
    o.out(checksText(results));
    o.out(`\nChecks failed. ${taskId} stays In Progress.`);
    return 'checks-failed';
  }

  const assignee =
    task.assignee && task.assignee !== 'operator' ? getAgent(db, task.assignee) : null;
  const actor = assignee && assignee.type !== 'human' ? assignee.id : PIPELINE_ORCHESTRATOR;
  transition(db, taskId, 'complete', { actor, summary });
  o.out(`Checks passed. ${taskId} -> Review (completed by ${actor}). Approve it in the app.`);
  return 'completed';
}
