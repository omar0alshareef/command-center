import { z } from 'zod';
import { nowIso, write } from '../db';
import { CoreError, InvalidInputError } from '../errors';
import { isProviderId } from '../providers/types';
import { toJson } from '../types';
import type { LibraryDb } from './db';

// The global agent library (M15, D30). Agents are created, edited, archived and deleted ONLY here (Agent Hub → Agents);
// projects link to them (D33) and never hold a copy that could drift.

export const AGENT_TYPES = ['orchestrator', 'sub-agent', 'human', 'external'] as const;
export const AGENT_EXECUTORS = ['agent', 'external', 'human'] as const;

const AGENT_COLORS = [
  '#8286FF',
  '#14B8A6',
  '#EC4899',
  '#F97316',
  '#06B6D4',
  '#22C55E',
  '#F59E0B',
  '#6366F1',
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export const LibraryAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  type: z.enum(AGENT_TYPES),
  executor: z.enum(AGENT_EXECUTORS),
  tool: z.string().nullable(),
  parent_id: z.string().nullable(),
  color: z.string(),
  base_instructions: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  default_permissions: z
    .string()
    .transform((s) => JSON.parse(s) as unknown)
    .pipe(z.array(z.string())),
  status: z.enum(['active', 'archived']),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LibraryAgent = z.infer<typeof LibraryAgentSchema>;

export const NewLibraryAgentSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, 'use lowercase letters, digits, . _ - (max 48 chars)')
    .optional(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(40).default('general'),
  type: z.enum(AGENT_TYPES).default('sub-agent'),
  executor: z.enum(AGENT_EXECUTORS).default('agent'),
  tool: z.string().trim().min(1).max(80).nullable().default(null),
  parent_id: z.string().nullable().default(null),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'use a #RRGGBB hex color')
    .optional(),
  base_instructions: z.string().max(20_000).default(''),
  provider: z
    .string()
    .nullable()
    .refine((v) => (v === null ? true : isProviderId(v)), 'unknown provider')
    .default(null),
  model: z.string().max(100).nullable().default(null),
  default_permissions: z.array(z.string().max(40)).max(20).default([]),
});
export type NewLibraryAgent = z.input<typeof NewLibraryAgentSchema>;

export const LibraryAgentPatchSchema = NewLibraryAgentSchema.omit({ id: true }).partial();
export type LibraryAgentPatch = z.input<typeof LibraryAgentPatchSchema>;

export class LibraryAgentNotFoundError extends CoreError {
  constructor(id: string) {
    super('LIBRARY_AGENT_NOT_FOUND', `Library agent '${id}' does not exist.`);
  }
}

function hashColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length] ?? '#9B9BAA';
}

export function getLibraryAgent(lib: LibraryDb, id: string): LibraryAgent | null {
  const row = lib.prepare('SELECT * FROM library_agents WHERE id = ?').get(id);
  return row ? LibraryAgentSchema.parse(row) : null;
}

function need(lib: LibraryDb, id: string): LibraryAgent {
  const a = getLibraryAgent(lib, id);
  if (!a) throw new LibraryAgentNotFoundError(id);
  return a;
}

function snapshot(lib: LibraryDb, a: LibraryAgent, by: string, note: string | null): void {
  const v =
    ((
      lib
        .prepare('SELECT MAX(version) AS v FROM library_agent_versions WHERE agent_id = ?')
        .get(a.id) as { v: number | null }
    ).v ?? 0) + 1;
  lib
    .prepare(
      'INSERT INTO library_agent_versions (agent_id, version, snapshot, changed_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      a.id,
      v,
      JSON.stringify({ ...a, default_permissions: toJson(a.default_permissions) }), // the row's own shape, so it parses back
      by,
      note,
      nowIso(),
    );
}

function checkParent(lib: LibraryDb, id: string, parentId: string | null): void {
  if (!parentId) return;
  if (parentId === id) throw new InvalidInputError('An agent cannot be its own parent.');
  for (let cur: string | null = parentId, n = 0; cur && n < 32; n++) {
    const p = getLibraryAgent(lib, cur);
    if (!p) throw new LibraryAgentNotFoundError(cur);
    if (p.parent_id === id)
      throw new InvalidInputError('That parent would make the agent its own ancestor.');
    cur = p.parent_id;
  }
}

/** Create a library agent. The id defaults to a slug of the name (made unique). Writes version 1. */
export function createLibraryAgent(
  lib: LibraryDb,
  raw: NewLibraryAgent,
  actor = 'operator',
): LibraryAgent {
  const input = NewLibraryAgentSchema.parse(raw);
  if (input.executor === 'external' && !input.tool)
    throw new InvalidInputError('An agent done by an external tool needs the name of that tool.');
  return write(lib, () => {
    let id = input.id ?? (slug(input.name) || 'agent');
    if (!input.id)
      for (let i = 2; getLibraryAgent(lib, id); i++) id = `${slug(input.name) || 'agent'}-${i}`;
    else if (getLibraryAgent(lib, id))
      throw new InvalidInputError(`An agent with id '${id}' already exists.`);
    if (['operator', 'system'].includes(id)) throw new InvalidInputError(`'${id}' is reserved.`);
    checkParent(lib, id, input.parent_id);
    const at = nowIso();
    lib
      .prepare(
        `INSERT INTO library_agents (id, name, role, type, executor, tool, parent_id, color, base_instructions, provider,
           model, default_permissions, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.role,
        input.type,
        input.executor,
        input.executor === 'agent' ? null : input.tool,
        input.parent_id,
        input.color ?? hashColor(id),
        input.base_instructions,
        input.provider,
        input.model,
        toJson(input.default_permissions),
        at,
        at,
      );
    const created = need(lib, id);
    snapshot(lib, created, actor, 'created');
    return created;
  });
}

/** Edit a library agent once; every project that uses it picks the new profile up on its next run. Writes a new version. */
export function updateLibraryAgent(
  lib: LibraryDb,
  id: string,
  rawPatch: LibraryAgentPatch,
  actor = 'operator',
): LibraryAgent {
  const patch = LibraryAgentPatchSchema.parse(rawPatch);
  return write(lib, () => {
    const cur = need(lib, id);
    const next = {
      ...cur,
      ...patch,
      default_permissions: patch.default_permissions ?? cur.default_permissions,
    };
    if (next.executor === 'external' && !next.tool)
      throw new InvalidInputError('An agent done by an external tool needs the name of that tool.');
    if (next.executor === 'agent') next.tool = null;
    if (patch.parent_id !== undefined) checkParent(lib, id, patch.parent_id);
    lib
      .prepare(
        `UPDATE library_agents SET name = ?, role = ?, type = ?, executor = ?, tool = ?, parent_id = ?, color = ?,
           base_instructions = ?, provider = ?, model = ?, default_permissions = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.role,
        next.type,
        next.executor,
        next.tool,
        next.parent_id,
        next.color,
        next.base_instructions,
        next.provider,
        next.model,
        toJson(next.default_permissions),
        nowIso(),
        id,
      );
    const updated = need(lib, id);
    snapshot(lib, updated, actor, `edited: ${Object.keys(patch).join(', ') || 'nothing'}`);
    return updated;
  });
}

/** Archived agents stop receiving dispatches and disappear from pickers; their history stays readable (D35). */
export function setLibraryAgentStatus(
  lib: LibraryDb,
  id: string,
  status: 'active' | 'archived',
  actor = 'operator',
): LibraryAgent {
  return write(lib, () => {
    const cur = need(lib, id);
    if (cur.status === status) return cur;
    lib
      .prepare('UPDATE library_agents SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
    const updated = need(lib, id);
    snapshot(lib, updated, actor, status === 'archived' ? 'archived' : 'restored');
    return updated;
  });
}

export interface AgentUsage {
  /** Projects that currently link to this agent (not removed). */
  links: number;
  /** Runs recorded for it in any project. */
  runs: number;
  projects: string[];
}

/**
 * Delete an unused agent, otherwise archive it (D35): an agent with no project links and no run history may be deleted;
 * any other agent is archived so its history stays readable. `usage` comes from `agentUsage` (registry.ts).
 */
export function deleteOrArchiveLibraryAgent(
  lib: LibraryDb,
  id: string,
  usage: AgentUsage,
  actor = 'operator',
): { result: 'deleted' | 'archived'; agent: LibraryAgent | null } {
  need(lib, id);
  if (usage.links === 0 && usage.runs === 0) {
    write(lib, () => {
      lib.prepare('DELETE FROM library_agent_versions WHERE agent_id = ?').run(id);
      lib.prepare('DELETE FROM library_agents WHERE id = ?').run(id);
    });
    return { result: 'deleted', agent: null };
  }
  return { result: 'archived', agent: setLibraryAgentStatus(lib, id, 'archived', actor) };
}

export interface LibraryAgentFilter {
  role?: string;
  status?: 'active' | 'archived' | 'all';
  provider?: string;
  search?: string;
}

/** Sorted by role, then name; filter by role, status (default active) and provider; `search` matches name, role and instructions. */
export function listLibraryAgents(lib: LibraryDb, f: LibraryAgentFilter = {}): LibraryAgent[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if ((f.status ?? 'active') !== 'all') {
    where.push('status = ?');
    params.push(f.status ?? 'active');
  }
  if (f.role) {
    where.push('role = ?');
    params.push(f.role);
  }
  if (f.provider) {
    where.push(
      f.provider === 'claude-code'
        ? "(provider IS NULL OR provider = 'claude-code')"
        : 'provider = ?',
    );
    if (f.provider !== 'claude-code') params.push(f.provider);
  }
  if (f.search?.trim()) {
    where.push('(name LIKE ? OR role LIKE ? OR base_instructions LIKE ? OR id LIKE ?)');
    const q = `%${f.search.trim()}%`;
    params.push(q, q, q, q);
  }
  const sql = `SELECT * FROM library_agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY role COLLATE NOCASE, name COLLATE NOCASE`;
  return LibraryAgentSchema.array().parse(lib.prepare(sql).all(...params));
}

export interface AgentVersion {
  version: number;
  changed_by: string;
  note: string | null;
  created_at: string;
  snapshot: LibraryAgent;
}

export function listAgentVersions(lib: LibraryDb, id: string): AgentVersion[] {
  return (
    lib
      .prepare('SELECT * FROM library_agent_versions WHERE agent_id = ? ORDER BY version DESC')
      .all(id) as {
      version: number;
      changed_by: string;
      note: string | null;
      created_at: string;
      snapshot: string;
    }[]
  ).map((r) => ({ ...r, snapshot: LibraryAgentSchema.parse(JSON.parse(r.snapshot)) }));
}

// ---------------------------------------------------------------- starter templates

export interface AgentTemplate {
  role: string;
  name: string;
  instructions: string;
  permissions: string[];
}

/** Starter profiles by role. The create flow offers them; once created they are ordinary, fully editable agents. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    role: 'frontend',
    name: 'Frontend developer',
    instructions:
      "You build user interfaces. Match the project's existing components, tokens and conventions before adding new ones. Keep accessibility (labels, focus, contrast) in every change, and check the result in the running app when you can.",
    permissions: ['read', 'write'],
  },
  {
    role: 'backend',
    name: 'Backend developer',
    instructions:
      'You build server-side logic and APIs. Validate input at every boundary, keep changes small and covered by tests, and never weaken error handling or security checks to make something pass.',
    permissions: ['read', 'write'],
  },
  {
    role: 'database',
    name: 'Database engineer',
    instructions:
      'You design schemas and queries. Changes to existing data go through numbered, append-only migrations; never edit a shipped migration. Explain any index or constraint you add.',
    permissions: ['read', 'write'],
  },
  {
    role: 'security',
    name: 'Security reviewer',
    instructions:
      'You look for vulnerabilities and unsafe defaults: injection, secrets in code or logs, missing authorisation, unsafe file or shell use. Report findings with the file and line and a concrete fix; do not make unrelated changes.',
    permissions: ['read'],
  },
  {
    role: 'design',
    name: 'Designer',
    instructions:
      "You shape layout, type, colour and copy. Use the project's design tokens, keep text readable (contrast, size) and consistent, and describe each decision briefly so a developer can build it.",
    permissions: ['read', 'write'],
  },
  {
    role: 'marketing',
    name: 'Marketer',
    instructions:
      "You write clear, honest copy for the target audience. Do not invent claims, prices or testimonials; flag anything that needs a source or the owner's approval before it is published.",
    permissions: ['read', 'write'],
  },
  {
    role: 'reviewer',
    name: 'Reviewer',
    instructions:
      'You review finished work independently. You did not do it. Check it against the acceptance criteria and the project rules, say plainly what is wrong or missing, and never approve work you cannot verify.',
    permissions: ['read'],
  },
];

/** A new-agent input pre-filled from a template (the operator edits it before saving). */
export function fromTemplate(role: string): NewLibraryAgent | null {
  const t = AGENT_TEMPLATES.find((x) => x.role === role);
  return t
    ? {
        name: t.name,
        role: t.role,
        base_instructions: t.instructions,
        default_permissions: t.permissions,
      }
    : null;
}
