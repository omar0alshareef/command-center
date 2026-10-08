import type { Agent, Task } from '@command-center/core';

// One stage = one sub-agent doing one job. The runner decides HOW a stage executes (the Claude Code CLI, a
// deterministic local implementation, ...); this file only says WHAT each stage is and what it must return.

export type StageId =
  'explorer' | 'compressor' | 'optimizer' | 'builder' | 'quality' | 'security' | 'validator';

export interface Stage {
  id: StageId;
  /** The registered agent this stage's log entries are written under. */
  agentId: string;
  title: string;
  /** `agent_log.action` written when the stage finishes (the validator picks validation_passed / validation_failed). */
  doneAction: string;
  system: string;
  /** `{{name}}` placeholders are filled from the stage input. */
  template: string;
}

export const PIPELINE_ORCHESTRATOR = 'operator-cli';

export const PIPELINE_AGENTS: {
  id: string;
  name: string;
  color: string;
  type: Agent['type'];
  permissions: string[];
}[] = [
  {
    id: PIPELINE_ORCHESTRATOR,
    name: 'operator-cli',
    color: '#8286FF',
    type: 'orchestrator',
    permissions: ['read', 'write'],
  },
  {
    id: 'research-explorer',
    name: 'research_explorer',
    color: '#14B8A6',
    type: 'sub-agent',
    permissions: ['read'],
  },
  {
    id: 'token-compressor',
    name: 'token_compressor',
    color: '#0EA5E9',
    type: 'sub-agent',
    permissions: ['read'],
  },
  {
    id: 'prompt-optimizer',
    name: 'prompt_optimizer',
    color: '#A855F7',
    type: 'sub-agent',
    permissions: ['read', 'write'],
  },
  {
    id: 'code-quality',
    name: 'code_quality',
    color: '#EC4899',
    type: 'sub-agent',
    permissions: ['read'],
  },
  {
    id: 'security-auditor',
    name: 'security_auditor',
    color: '#EF4444',
    type: 'sub-agent',
    permissions: ['read'],
  },
  {
    id: 'final-validator',
    name: 'final_validator',
    color: '#22C55E',
    type: 'sub-agent',
    permissions: ['read', 'write'],
  },
];

export const STAGES: Record<StageId, Stage> = {
  explorer: {
    id: 'explorer',
    agentId: 'research-explorer',
    title: 'Research Explorer',
    doneAction: 'exploration_complete',
    system:
      'You are the Research Explorer. You only read the codebase: never edit files or run commands. Be concrete and brief. ' +
      'Answer in exactly this markdown shape: a "## Files" section with one bullet per file written as - `relative/path` — why it matters; ' +
      'a "## Patterns" section with the conventions the change must follow; a "## Gaps" section with what is missing or unknown.',
    template: [
      'Task {{id}}: {{label}}',
      '',
      'Description / notes:',
      '{{notes}}',
      '',
      'Acceptance criteria:',
      '{{criteria}}',
      '',
      'Files already listed for this task:',
      '{{files}}',
      '',
      'Find the files and patterns in this project that someone implementing the task needs to know about.',
    ].join('\n'),
  },
  compressor: {
    id: 'compressor',
    agentId: 'token-compressor',
    title: 'Token Compressor',
    doneAction: 'compression_complete',
    system:
      'You are the Token Compressor. Rewrite the research in about 500 tokens (roughly 2000 characters). Keep every file path and every ' +
      'concrete convention; drop repetition and prose. Keep the "## Files", "## Patterns" and "## Gaps" sections.',
    template:
      'Compress this research for task {{id}} ({{label}}) to about {{budget}} tokens:\n\n{{research}}',
  },
  optimizer: {
    id: 'optimizer',
    agentId: 'prompt-optimizer',
    title: 'Prompt Optimizer',
    doneAction: 'prompt_optimized',
    system:
      'You are the Prompt Optimizer. Write the final instructions for the agent that will build this task: a short goal, the steps in order, ' +
      'the files to touch, the constraints, and a "Lessons from past rejections" list that repeats each lesson as a rule. No preamble.',
    template: [
      'Task {{id}}: {{label}}',
      '',
      'Acceptance criteria:',
      '{{criteria}}',
      '',
      'Compressed research:',
      '{{research}}',
      '',
      'Constraints:',
      '{{constraints}}',
      '',
      'Lessons from similar past tasks:',
      '{{lessons}}',
    ].join('\n'),
  },
  builder: {
    id: 'builder',
    agentId: PIPELINE_ORCHESTRATOR,
    title: 'Builder',
    doneAction: 'agent_dispatched',
    system:
      'You are building one task in this repository. Follow the context file exactly, keep changes minimal, and run the checks you are given. ' +
      'End with one line: SUMMARY: <what you changed>.',
    template: '{{context}}',
  },
  quality: {
    id: 'quality',
    agentId: 'code-quality',
    title: 'Code Quality',
    doneAction: 'quality_check',
    system:
      'You are the Code Quality auditor. You are given the output of the project checks. Decide whether quality is acceptable. ' +
      'List problems briefly, then end with exactly one line: VERDICT: PASS or VERDICT: FAIL.',
    template: 'Task {{id}}: {{label}}\n\nCheck results:\n{{checks}}',
  },
  security: {
    id: 'security',
    agentId: 'security-auditor',
    title: 'Security',
    doneAction: 'security_scan',
    system:
      'You are the Security auditor. You are given a scan for hard-coded secrets in the files this task touched. Decide whether any finding ' +
      'is real. End with exactly one line: VERDICT: PASS or VERDICT: FAIL.',
    template: 'Task {{id}}: {{label}}\n\nFiles scanned: {{files}}\n\nFindings:\n{{findings}}',
  },
  validator: {
    id: 'validator',
    agentId: 'final-validator',
    title: 'Final Validator',
    doneAction: 'validation_complete',
    system:
      'You are the Final Validator. Decide whether every acceptance criterion is met, using the earlier audit results. ' +
      'List each unmet criterion, then end with exactly one line: VERDICT: PASS or VERDICT: FAIL.',
    template: [
      'Task {{id}}: {{label}}',
      '',
      'Acceptance criteria (done flags as recorded):',
      '{{criteria}}',
      '',
      'Earlier audit stages:',
      '{{audit}}',
    ].join('\n'),
  },
};

export type StageVars = Record<string, string>;

export function renderPrompt(stage: Stage, vars: StageVars): string {
  return stage.template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

export const criteriaText = (t: Task): string =>
  t.acceptance_criteria.length === 0
    ? '(none recorded)'
    : t.acceptance_criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n');

export const listText = (items: readonly string[]): string =>
  items.length === 0 ? '(none)' : items.map((i) => `- ${i}`).join('\n');

export function taskVars(t: Task): StageVars {
  return {
    id: t.id,
    label: t.label,
    notes: [t.notes, t.prompt].filter(Boolean).join('\n\n') || '(none)',
    criteria: criteriaText(t),
    files: listText(t.context_files),
    constraints: listText(t.constraints),
  };
}

/** `VERDICT: PASS|FAIL` from a stage's output (the last one wins); null when the stage gave none. */
export function parseVerdict(output: string): 'PASS' | 'FAIL' | null {
  const all = [...output.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\b/gim)];
  const last = all[all.length - 1]?.[1];
  return last ? (last.toUpperCase() as 'PASS' | 'FAIL') : null;
}

export const FILE_BULLET = /^\s*[-*]\s+`([^`]+)`/gm;

/** File paths from an explorer/compressor "## Files" section. */
export function parseFiles(output: string): string[] {
  return [...new Set([...output.matchAll(FILE_BULLET)].map((m) => m[1] as string))];
}
