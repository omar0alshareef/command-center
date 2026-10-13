import {
  getAgent,
  logAction,
  registerAgent,
  resolveAgentModel,
  type Db,
  type Task,
} from '@command-center/core';
import { CliError } from '../context';
import { claudeRunner, findClaude } from './claude';
import { localRunner } from './local';
import type { Runner, StageData, StageResult } from './runner';
import {
  PIPELINE_AGENTS,
  PIPELINE_ORCHESTRATOR,
  renderPrompt,
  taskVars,
  type Stage,
  type StageVars,
} from './stages';

export type Out = (line: string) => void;

/** `--runner claude|local|auto`. Auto picks Claude Code when it can be found, else the offline runner. */
export function resolveRunner(name: string, out: Out, timeoutMinutes = 15): Runner {
  if (name === 'local') return localRunner;
  const bin = findClaude();
  if (name === 'claude') {
    if (!bin)
      throw new CliError(
        'The `claude` CLI was not found. Install Claude Code, set COMMAND_CENTER_CLAUDE to its path, or use --runner local.',
      );
    return claudeRunner(bin, timeoutMinutes * 60_000);
  }
  if (name !== 'auto') throw new CliError(`Unknown runner "${name}". Use claude, local or auto.`);
  if (bin) return claudeRunner(bin, timeoutMinutes * 60_000);
  out(
    'note: the `claude` CLI was not found, using the offline local runner (heuristics, no model).',
  );
  return localRunner;
}

/** Registers the pipeline's agents once; existing agents (for example ones the seed or an operator set up) are left alone. */
export function ensurePipelineAgents(db: Db): void {
  for (const a of PIPELINE_AGENTS) {
    if (getAgent(db, a.id)) continue;
    registerAgent(db, {
      id: a.id,
      name: a.name,
      type: a.type,
      color: a.color,
      permissions: a.permissions,
      parent_id: a.id === PIPELINE_ORCHESTRATOR ? null : PIPELINE_ORCHESTRATOR,
      source_model: null,
    });
  }
}

export interface StageRun {
  stage: Stage;
  result: StageResult;
  prompt: string;
  /** The model the run used (null = CLI default) and, when the agent's model was removed from the list, why it fell back. */
  model: string | null;
  warning: string | null;
}

/** Tells the operator up front when an agent's model has been removed from the model list (the run uses the CLI default). */
export function warnModels(db: Db, out: Out, agentIds: readonly string[]): void {
  for (const id of new Set(agentIds)) {
    const { warning } = resolveAgentModel(db, id);
    if (warning) out(`warning: ${warning}`);
  }
}

/** Runs one stage and, when it succeeded, writes its `doneAction` to the activity feed under the stage's agent. */
export async function runStage(
  db: Db,
  runner: Runner,
  root: string,
  task: Task,
  stage: Stage,
  extraVars: StageVars,
  data: StageData,
  describe: (output: string) => { action?: string; summary: string; tags?: string[] },
): Promise<StageRun> {
  const prompt = renderPrompt(stage, { ...taskVars(task), ...extraVars });
  // The agent doing the work chooses the model: the builder runs as the task's assignee, every other stage
  // as its own sub-agent. A model that was removed from the list falls back to the CLI default with a warning.
  const worker = stage.id === 'builder' && task.assignee ? task.assignee : stage.agentId;
  const { model, warning } = resolveAgentModel(db, worker);
  if (warning)
    logAction(db, {
      agentId: stage.agentId,
      action: 'model_unavailable',
      targetType: 'subtask',
      targetId: task.id,
      description: warning,
      tags: ['model', 'warning'],
    });
  const result = await runner.run({ stage, prompt, system: stage.system, root, task, data, model });
  if (result.ok) {
    const d = describe(result.output);
    // Every run records the model it used (or "CLI default") in its log entry.
    logAction(db, {
      agentId: stage.agentId,
      action: d.action ?? stage.doneAction,
      targetType: 'subtask',
      targetId: task.id,
      description: `${d.summary.slice(0, 270)} [model: ${model ?? 'CLI default'}]`,
      tags: d.tags ?? [stage.id],
    });
  }
  return { stage, result, prompt, model, warning };
}

export const firstLine = (s: string, n = 140): string =>
  (s.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? s).trim().slice(0, n);
