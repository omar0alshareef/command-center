import { capTokens, estimateTokens } from '@command-center/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner, StageRequest, StageResult } from './runner';
import { findRelevantFiles, keywords } from './scan';
import { listText, parseFiles } from './stages';

// Deterministic, offline stand-ins for each stage: no model, no network. Used when no agent CLI is available,
// in tests, and to dry-run the plumbing. They do real work on the real project (file search, secret scan, check
// results); only the "thinking" stages are heuristic.

function explore(req: StageRequest): string {
  const { task, root } = req;
  const words = keywords(
    task.label,
    task.notes ?? '',
    task.acceptance_criteria.map((c) => c.text).join(' '),
  );
  const hits = findRelevantFiles(root, words, 8);
  const known = task.context_files.map((f) => ({ path: f, matched: ['listed on the task'] }));
  const files = [
    ...known,
    ...hits
      .filter((h) => !task.context_files.includes(h.path))
      .map((h) => ({ path: h.path, matched: h.matched })),
  ];
  const patterns: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = Object.keys(pkg.scripts ?? {});
    if (scripts.length) patterns.push(`Project scripts: ${scripts.slice(0, 8).join(', ')}`);
  } catch {
    /* no package.json */
  }
  if (existsSync(join(root, 'tsconfig.json')) || existsSync(join(root, 'tsconfig.base.json')))
    patterns.push('TypeScript project: keep strict typing');
  const matchedAll = new Set(files.flatMap((f) => f.matched));
  const missing = words.filter((w) => !matchedAll.has(w)).slice(0, 6);
  return [
    '## Files',
    ...(files.length
      ? files.map((f) => `- \`${f.path}\` — ${f.matched.slice(0, 5).join(', ')}`)
      : ['- (no matching files found)']),
    '',
    '## Patterns',
    ...(patterns.length ? patterns.map((p) => `- ${p}`) : ['- (none detected)']),
    '',
    '## Gaps',
    ...(missing.length
      ? [`- Nothing in the project mentions: ${missing.join(', ')}`]
      : ['- (none)']),
  ].join('\n');
}

/** Shrinks research to the token budget: bullets are dropped from the bottom (never the first three files). */
export function compress(research: string, budget: number): string {
  const lines = research
    .split('\n')
    .filter((l, i, all) => l.trim() !== '' || all[i - 1]?.trim() !== '');
  const keepFloor = lines.findIndex((l) => l.startsWith('## Patterns'));
  let text = lines.join('\n');
  for (let i = lines.length - 1; estimateTokens(text) > budget && i > 0; i--) {
    const l = lines[i] ?? '';
    const isFileBullet = i < keepFloor && l.startsWith('- `');
    const filesBefore = lines.slice(0, i).filter((x) => x.startsWith('- `')).length;
    if (l.startsWith('- ') && !(isFileBullet && filesBefore < 3)) {
      lines.splice(i, 1);
      text = lines.join('\n');
    }
  }
  return estimateTokens(text) > budget
    ? capTokens(text, budget, 'Re-run prepare with a larger --budget for more.').text
    : text;
}

function optimize(req: StageRequest): string {
  const { task, data } = req;
  const files = parseFiles(data.research ?? '');
  return [
    `## Goal`,
    `${task.label} (${task.id})`,
    '',
    '## Steps',
    '1. Read the files below before changing anything.',
    '2. Implement the task with the smallest change that satisfies every acceptance criterion.',
    '3. Run the project checks (typecheck, lint, tests) and fix what they report.',
    '4. Finish with a one-line summary of what changed.',
    '',
    '## Files to touch',
    listText(files.length ? files : task.context_files),
    '',
    '## Research',
    (data.research ?? '(none)').replace(/^## /gm, '### '),
    '',
    '## Constraints',
    listText(task.constraints),
    '',
    '## Lessons from past rejections',
    data.lessons?.length
      ? data.lessons.map((l) => `- Do not repeat: ${l}`).join('\n')
      : '- None recorded yet.',
  ].join('\n');
}

const verdict = (pass: boolean, lines: string[]) =>
  [...lines, `VERDICT: ${pass ? 'PASS' : 'FAIL'}`].join('\n');

export const localRunner: Runner = {
  name: 'local',
  run(req: StageRequest): Promise<StageResult> {
    const { stage, data, task } = req;
    let output: string;
    switch (stage.id) {
      case 'explorer':
        output = explore(req);
        break;
      case 'compressor':
        output = compress(data.research ?? '', data.budget ?? 500);
        break;
      case 'optimizer':
        output = optimize(req);
        break;
      case 'builder':
        output = 'The local runner does not write code.';
        break;
      case 'quality': {
        const checks = data.checks ?? [];
        const failed = checks.filter((c) => !c.ok);
        output = verdict(failed.length === 0, [
          checks.length
            ? `${checks.length - failed.length}/${checks.length} checks passed.`
            : 'No checks are configured for this project.',
          ...failed.map((c) => `Failed: ${c.command} (exit ${c.exitCode ?? 'none'})`),
        ]);
        break;
      }
      case 'security': {
        const found = data.findings ?? [];
        output = verdict(found.length === 0, [
          `Scanned ${data.files?.length ?? 0} files.`,
          ...(found.length
            ? found.map((f) => `Possible secret: ${f}`)
            : ['No hard-coded secrets found.']),
        ]);
        break;
      }
      case 'validator': {
        const unmet = task.acceptance_criteria.filter((c) => !c.done);
        const failedStages = (data.audit ?? []).filter((a) => a.verdict !== 'PASS');
        output = verdict(unmet.length === 0 && failedStages.length === 0, [
          ...(unmet.length
            ? unmet.map((c) => `Unmet acceptance criterion: ${c.text}`)
            : [`All ${task.acceptance_criteria.length} acceptance criteria are marked done.`]),
          ...failedStages.map((a) => `Audit stage "${a.stage}" did not pass.`),
        ]);
        break;
      }
    }
    return Promise.resolve({ ok: true, output });
  },
};
