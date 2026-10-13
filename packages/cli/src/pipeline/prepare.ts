import {
  buildTaskContextMd,
  capTokens,
  enrichTask,
  estimateTokens,
  getLessonsForTask,
  lessonLine,
  syncLessonsFile,
  getTask,
  logAction,
} from '@command-center/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, type Handle } from '../context';
import type { Runner } from './runner';
import { ensurePipelineAgents, firstLine, runStage, warnModels, type Out } from './runtime';
import { parseFiles, renderPrompt, STAGES, taskVars } from './stages';

export const CONTEXT_FILE = ['.claude', 'TASK_CONTEXT.md'] as const;
export const contextPath = (root: string): string => join(root, ...CONTEXT_FILE);

/** The six sections every TASK_CONTEXT.md carries (blueprint, Phase 11). */
export const CONTEXT_SECTIONS = [
  'Task description',
  'Acceptance criteria',
  'Context files',
  'Reference docs',
  'Constraints',
  'Relevant lessons',
] as const;

export interface PrepareOptions {
  runner: Runner;
  dryRun: boolean;
  /** Token budget for the compressed research (default ~500). */
  budget: number;
  out: Out;
}

/** The optimized prompt lives inside the "Task description" section: its own headings must not read as extra sections. */
export function demoteHeadings(md: string): string {
  return md.replace(/^#{1,2} /gm, '### ');
}

export function missingSections(md: string): string[] {
  return CONTEXT_SECTIONS.filter((s) => !new RegExp(`^## ${s}\\b`, 'm').test(md));
}

/**
 * Research Explorer -> Token Compressor -> Prompt Optimizer, then `.claude/TASK_CONTEXT.md`.
 * With `dryRun` it prints each stage's prompt and touches nothing.
 */
export async function prepare(
  h: Handle,
  taskId: string,
  o: PrepareOptions,
): Promise<string | null> {
  const { db, root } = h;
  const task = getTask(db, taskId);
  if (!task)
    throw new CliError(
      `No task ${taskId}. Try \`command-center status\` or pick an id from the board.`,
    );
  if (task.status === 'done') o.out(`note: ${taskId} is already done; preparing anyway.`);

  if (o.dryRun) {
    const vars = taskVars(task);
    o.out(`# dry run: ${taskId} would go through 3 stages, then write ${join(...CONTEXT_FILE)}\n`);
    o.out(
      `## 1. ${STAGES.explorer.title} (${STAGES.explorer.agentId})\n[system] ${STAGES.explorer.system}\n\n${renderPrompt(STAGES.explorer, vars)}\n`,
    );
    o.out(
      `## 2. ${STAGES.compressor.title} (${STAGES.compressor.agentId})\n[system] ${STAGES.compressor.system}\n\n${renderPrompt(STAGES.compressor, { ...vars, budget: String(o.budget), research: '<output of stage 1>' })}\n`,
    );
    o.out(
      `## 3. ${STAGES.optimizer.title} (${STAGES.optimizer.agentId})\n[system] ${STAGES.optimizer.system}\n\n${renderPrompt(STAGES.optimizer, { ...vars, research: '<output of stage 2>', lessons: '<lessons from past rejections>' })}`,
    );
    return null;
  }

  ensurePipelineAgents(db);
  warnModels(db, o.out, [
    STAGES.explorer.agentId,
    STAGES.compressor.agentId,
    STAGES.optimizer.agentId,
  ]);
  syncLessonsFile(db); // LESSONS_LEARNED.md exists and matches the table before agents read it
  const fail = (what: string, error: string | undefined): never => {
    throw new CliError(`${what} failed: ${error ?? 'no output'}. The task was not changed.`, 2);
  };

  o.out(`[1/3] ${STAGES.explorer.title}…`);
  const explored = await runStage(db, o.runner, root, task, STAGES.explorer, {}, {}, (out) => ({
    summary: `Explored for ${taskId}: ${parseFiles(out).length} relevant files. ${firstLine(out)}`,
    tags: ['research'],
  }));
  if (!explored.result.ok) fail(STAGES.explorer.title, explored.result.error);

  o.out(`[2/3] ${STAGES.compressor.title}…`);
  let compressed = '';
  const before = estimateTokens(explored.result.output);
  const compress = await runStage(
    db,
    o.runner,
    root,
    task,
    STAGES.compressor,
    { budget: String(o.budget), research: explored.result.output },
    { research: explored.result.output, budget: o.budget },
    (out) => {
      // The budget is a promise to the next stage: enforce it whatever the runner returned.
      const capped =
        estimateTokens(out) > o.budget * 1.15
          ? capTokens(out, o.budget, 'Compressed to the token budget.').text
          : out;
      compressed = capped;
      return {
        summary: `Compressed research ~${before} -> ~${estimateTokens(capped)} tokens (budget ${o.budget}).`,
        tags: ['compress'],
      };
    },
  );
  if (!compress.result.ok) fail(STAGES.compressor.title, compress.result.error);

  o.out(`[3/3] ${STAGES.optimizer.title}…`);
  const lessons = getLessonsForTask(
    db,
    taskId,
    task.label,
    5,
    task.acceptance_criteria.map((c) => c.text),
  ).map(lessonLine);
  const optimized = await runStage(
    db,
    o.runner,
    root,
    task,
    STAGES.optimizer,
    {
      research: compressed,
      lessons: lessons.length ? lessons.map((l) => `- ${l}`).join('\n') : '(none recorded)',
    },
    { research: compressed, lessons },
    () => ({
      summary: `Built the final prompt for ${taskId} with ${lessons.length} lesson${lessons.length === 1 ? '' : 's'}.`,
      tags: ['prompt'],
    }),
  );
  if (!optimized.result.ok) fail(STAGES.optimizer.title, optimized.result.error);

  enrichTask(
    db,
    taskId,
    { prompt: demoteHeadings(optimized.result.output), context_files: parseFiles(compressed) },
    STAGES.optimizer.agentId,
  );
  const md = buildTaskContextMd(db, taskId);
  const missing = md ? missingSections(md) : [...CONTEXT_SECTIONS];
  if (!md || missing.length)
    throw new CliError(`TASK_CONTEXT.md is missing sections: ${missing.join(', ')}.`, 2);

  const file = contextPath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, md, 'utf8');
  logAction(db, {
    agentId: STAGES.optimizer.agentId,
    action: 'task_context_written',
    targetType: 'subtask',
    targetId: taskId,
    description: `Wrote ${join(...CONTEXT_FILE)} (~${estimateTokens(md)} tokens).`,
    tags: ['context'],
  });
  o.out(`Wrote ${file} (~${estimateTokens(md)} tokens, ${CONTEXT_SECTIONS.length} sections).`);
  return file;
}
