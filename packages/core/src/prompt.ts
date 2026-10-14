import { buildTaskContextMd } from './context';
import type { Db } from './db';
import { formatLessonsBlock, getRequiredLessons, type RequiredLesson } from './lessons-scope';
import { getLibraryAgent, type LibraryAgent } from './library/agents';
import type { LibraryDb } from './library/db';
import { getAssignment } from './project-agents';
import { parseSpecRules, readProjectFile, readSpec, type SpecStatus } from './project-file';
import type { Agent, Task } from './types';

// The prompt builder (D34): the agent's library profile, then the project's AGENTS.md, then the lessons that apply (D38),
// then the task's context. Later layers add to or override earlier ones only where they say so. The run record stores which
// layers were used, the spec file's hash and the ids of the lessons injected.

export const PROMPT_LAYERS = ['profile', 'project_spec', 'lessons', 'task_context'] as const;
export type PromptLayer = (typeof PROMPT_LAYERS)[number];

export interface BuiltPrompt {
  /** profile + project rules + lessons: what frames the work. */
  system: string;
  /** the task's context (`TASK_CONTEXT.md` content). */
  prompt: string;
  /** Layers that actually contributed text. */
  layers: PromptLayer[];
  specStatus: SpecStatus;
  /** SHA-256 of AGENTS.md as read for this run; null when there is none. */
  specHash: string | null;
  /** Ids (`p:12`, `l:3`) of the lessons injected. `[]` = the lookup ran and nothing matched. */
  lessonIds: string[];
  lessons: RequiredLesson[];
  /** Tools the spec forbids; enforced where the provider has tools. */
  forbiddenTools: string[];
}

const BASE_SYSTEM = (name: string) =>
  `You are ${name}, an agent working for the operator inside Command Center. Do only the task below, in the project folder you are running in, and keep changes small and relevant. When you finish, reply with a short report whose LAST line is "SUMMARY: <one sentence saying what you did>". If you cannot complete the task, explain why and end with "SUMMARY: BLOCKED - <reason>".`;

export function buildRunPrompt(o: {
  db: Db;
  lib: LibraryDb | null;
  projectRoot: string;
  task: Task;
  agent: Pick<Agent, 'id' | 'name'>;
  now?: Date;
}): BuiltPrompt {
  const layers: PromptLayer[] = ['profile'];
  const profile: LibraryAgent | null = o.lib ? getLibraryAgent(o.lib, o.agent.id) : null;
  const parts: string[] = [BASE_SYSTEM(profile?.name ?? o.agent.name)];
  if (profile?.base_instructions.trim())
    parts.push(`## Your role (${profile.role})\n${profile.base_instructions.trim()}`);

  const file = readProjectFile(o.projectRoot);
  const spec = readSpec(o.projectRoot, file.ok ? file.project : null);
  const specStatus: BuiltPrompt['specStatus'] = spec.status;
  let forbiddenTools: string[] = [];
  if (spec.status === 'ok' && spec.text) {
    layers.push('project_spec');
    parts.push(
      `## Project rules (${spec.path.split(/[\\/]/).pop()})\nThese add to, and override where they conflict, your general role above.\n${spec.text.trim()}`,
    );
    forbiddenTools = parseSpecRules(spec.text).forbiddenTools;
    if (forbiddenTools.length > 0)
      parts.push(`The project forbids these tools: ${forbiddenTools.join(', ')}. Do not use them.`);
  }

  const link = getAssignment(o.db, o.agent.id);
  if (link && link.extra_constraints.length > 0)
    parts.push(
      `## Extra constraints for you in this project\n${link.extra_constraints.map((c) => `- ${c}`).join('\n')}`,
    );

  const lessons = getRequiredLessons(o.db, o.lib, {
    agentId: o.agent.id,
    taskId: o.task.id,
    label: o.task.label,
    keywords: o.task.acceptance_criteria.map((c) => c.text),
  });
  const block = formatLessonsBlock(lessons);
  if (block) {
    layers.push('lessons');
    parts.push(block);
  }
  layers.push('task_context');
  return {
    system: parts.join('\n\n'),
    prompt: buildTaskContextMd(o.db, o.task.id, o.now ?? new Date()) ?? `# ${o.task.id}`,
    layers,
    specStatus,
    specHash: spec.hash,
    lessonIds: lessons.map((l) => l.key),
    lessons,
    forbiddenTools,
  };
}
