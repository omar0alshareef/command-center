import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

// A project is an independent folder (D31, D32): project.json, README.md, LICENSE, AGENTS.md and details/. The app writes
// the missing ones from templates and NEVER overwrites a file that exists. project.json is validated on open (D36): a
// broken one blocks dispatch for that project only and names the bad field; a missing AGENTS.md is only a warning.

export const PROJECT_FILE = 'project.json';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const rel = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) => !/^([a-zA-Z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..'),
    'use a path inside the project folder',
  );

export const ProjectFileSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'use lowercase letters, digits and -'),
  status: z.enum(['active', 'paused', 'archived']),
  repo_path: z.string().min(1).max(500).nullable(),
  files: z.strictObject({ readme: rel, license: rel, agent_spec: rel, details: rel }),
  created: isoDate,
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export type ProjectFileResult =
  | { ok: true; project: ProjectFile; path: string }
  | { ok: false; issues: string[]; path: string; missing: boolean };

/** Read and validate `<folder>/project.json`. Bad JSON or a bad field comes back as issues naming the field (D36). */
export function readProjectFile(folder: string): ProjectFileResult {
  const path = join(folder, PROJECT_FILE);
  if (!existsSync(path))
    return { ok: false, issues: ['project.json is missing.'], path, missing: true };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      issues: [`project.json is not valid JSON (${e instanceof Error ? e.message : String(e)}).`],
      path,
      missing: false,
    };
  }
  const r = ProjectFileSchema.safeParse(raw);
  if (r.success) return { ok: true, project: r.data, path };
  return {
    ok: false,
    issues: r.error.issues.map((i) => `project.json: ${i.path.join('.') || 'file'}: ${i.message}`),
    path,
    missing: false,
  };
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';

export const DEFAULT_FILES = {
  readme: 'README.md',
  license: 'LICENSE',
  agent_spec: 'AGENTS.md',
  details: 'details/',
} as const;

// ---------------------------------------------------------------- the project spec (AGENTS.md)

export type SpecStatus = 'ok' | 'missing' | 'unreadable';
export interface SpecInfo {
  status: SpecStatus;
  path: string;
  text: string | null;
  /** SHA-256 of the file's bytes, checked at every dispatch so an edit applies to the very next run (no restart). */
  hash: string | null;
}

export function readSpec(folder: string, project: Pick<ProjectFile, 'files'> | null): SpecInfo {
  const path = join(folder, project?.files.agent_spec ?? DEFAULT_FILES.agent_spec);
  if (!existsSync(path)) return { status: 'missing', path, text: null, hash: null };
  try {
    const buf = readFileSync(path);
    return {
      status: 'ok',
      path,
      text: buf.toString('utf8'),
      hash: createHash('sha256').update(buf).digest('hex'),
    };
  } catch {
    return { status: 'unreadable', path, text: null, hash: null };
  }
}

export interface SpecRules {
  /** Tools the spec forbids (`## Forbidden tools`, one backticked or plain name per bullet). Enforced on providers that have tools. */
  forbiddenTools: string[];
}

/** The machine-readable part of a spec. Everything else is prose the agent reads. */
export function parseSpecRules(md: string): SpecRules {
  const lines = md.split(/\r?\n/);
  const i = lines.findIndex((l) => /^#{1,6}\s+forbidden tools\s*$/i.test(l.trim()));
  const forbiddenTools: string[] = [];
  if (i >= 0) {
    for (const l of lines.slice(i + 1)) {
      if (/^#{1,6}\s/.test(l)) break;
      const m = /^\s*[-*+]\s+`?([A-Za-z][A-Za-z0-9_():*. \-/]*?)`?\s*(?:[:—-].*)?$/.exec(l);
      const name = m?.[1]?.trim();
      if (name && !forbiddenTools.includes(name)) forbiddenTools.push(name);
    }
  }
  return { forbiddenTools };
}

// ---------------------------------------------------------------- scaffolding

export interface ScaffoldInput {
  name: string;
  slug?: string;
  repoPath?: string | null;
  today?: string;
}

export interface ScaffoldItem {
  /** Path relative to the project folder. */
  path: string;
  kind: 'file' | 'dir' | 'license-copy';
  /** create = will be written; same = already there with the same content; differs = already there, different: shown as a diff, kept unless the operator chooses to replace it. */
  action: 'create' | 'same' | 'differs';
  /** What the app would write (absent for directories). */
  template?: string;
  /** What is there now (only for `differs`). */
  current?: string;
}

const README = (n: string) => `# ${n}

## Goal
Describe what this project is for in two or three sentences.

## Domains
- List the areas of work (they become swim lanes).

## Milestones
- M1: first milestone (due YYYY-MM-DD)
`;

const AGENTS = (n: string) => `# Project Spec: ${n}

Read this file before starting any task in this project. These rules add to, and override where they conflict, the general profile of the agent.

## Language and tone
- Describe the language, voice and wording rules here.

## Allowed tools and actions
- May read and write files inside this project folder.
- May NOT publish anything, send messages, or change the license file.

## Forbidden tools
<!-- One tool per bullet, for example \`Bash\`. Providers with tools (Claude Code) are run with these tools disallowed. -->

## Review rule
- An agent may not approve its own work. Finished tasks go to Review, and a different agent or the operator approves them.

## When unsure
- Stop and report the question in the task log. Do not guess product claims, prices or legal text.
`;

const DETAILS_NOTE = `# Details

Put background files for agents here (briefs, research, reference material). Reference them from tasks as context files.
`;

/** What creating or opening a project folder would write, and where it would collide with what is already there. */
export function planScaffold(folder: string, input: ScaffoldInput): ScaffoldItem[] {
  const slug = input.slug ?? slugify(input.name);
  const project: ProjectFile = {
    name: input.name.trim(),
    slug,
    status: 'active',
    repo_path: input.repoPath ?? null,
    files: { ...DEFAULT_FILES },
    created: input.today ?? new Date().toISOString().slice(0, 10),
  };
  const files: { path: string; template: string }[] = [
    { path: PROJECT_FILE, template: `${JSON.stringify(project, null, 2)}\n` },
    { path: DEFAULT_FILES.readme, template: README(project.name) },
    { path: DEFAULT_FILES.agent_spec, template: AGENTS(project.name) },
    { path: join('details', 'README.md'), template: DETAILS_NOTE },
  ];
  const items: ScaffoldItem[] = files.map((f) => {
    const abs = join(folder, f.path);
    if (!existsSync(abs))
      return { path: f.path, kind: 'file', action: 'create', template: f.template };
    const current = readFileSync(abs, 'utf8');
    return current === f.template
      ? { path: f.path, kind: 'file', action: 'same', template: f.template }
      : { path: f.path, kind: 'file', action: 'differs', template: f.template, current };
  });
  // LICENSE: copied from the repo when one is set (never written as independent text, D32); never overwritten.
  const licenseSrc = input.repoPath ? findLicense(input.repoPath) : null;
  if (licenseSrc) {
    const abs = join(folder, DEFAULT_FILES.license);
    items.push({
      path: DEFAULT_FILES.license,
      kind: 'license-copy',
      action: existsSync(abs) ? 'same' : 'create',
    });
  }
  return items;
}

function findLicense(repo: string): string | null {
  for (const n of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    const p = join(repo, n);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * Write the plan. Only `create` items are written, plus any `differs` path the operator explicitly lists in `replace`
 * (after seeing the diff). Existing files are otherwise never touched.
 */
export function applyScaffold(
  folder: string,
  items: readonly ScaffoldItem[],
  o: { replace?: readonly string[]; repoPath?: string | null } = {},
): { written: string[]; kept: string[] } {
  mkdirSync(folder, { recursive: true });
  const written: string[] = [];
  const kept: string[] = [];
  for (const it of items) {
    const abs = resolve(folder, it.path);
    if (!abs.toLowerCase().startsWith(resolve(folder).toLowerCase())) continue;
    const replace = it.action === 'differs' && (o.replace ?? []).includes(it.path);
    if (it.action === 'create' || replace) {
      mkdirSync(dirname(abs), { recursive: true });
      if (it.kind === 'license-copy') {
        const src = o.repoPath ? findLicense(o.repoPath) : null;
        if (src) copyFileSync(src, abs);
        else continue;
      } else if (it.template !== undefined) writeFileSync(abs, it.template, 'utf8');
      written.push(it.path);
    } else kept.push(it.path);
  }
  return { written, kept };
}

/** A small line diff (current -> template) for the "this file already exists" dialog: `-` removed, `+` added, unchanged lines kept. */
export function lineDiff(current: string, next: string): string {
  const a = current.split(/\r?\n/);
  const b = next.split(/\r?\n/);
  // LCS over lines: plenty for files of this size.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    for (let j = b.length - 1; j >= 0; j--)
      row[j] =
        a[i] === b[j]
          ? (dp[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}
