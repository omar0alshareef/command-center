import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { CoreError, InvalidInputError } from './errors';
import { getLibraryAgent, type LibraryAgent } from './library/agents';
import type { LibraryDb } from './library/db';
import { getAgent, logAction } from './queries';
import { toJson } from './types';

// Assignment (D33): a project's agent list is a set of LINKS to library agents plus per-project settings. Removing an agent
// from a project removes only the link (the row stays, marked removed, so adding it back restores its settings). The
// project's `agents` row for a linked agent is a mirror of the library profile, refreshed on open and before every run, so
// an edit made once in the library reaches every project.

export const ProjectAgentSchema = z.object({
  library_agent_id: z.string(),
  enabled: z.number().transform((n) => n !== 0),
  allowed_task_types: z
    .string()
    .transform((s) => JSON.parse(s) as unknown)
    .pipe(z.array(z.string())),
  extra_constraints: z
    .string()
    .transform((s) => JSON.parse(s) as unknown)
    .pipe(z.array(z.string())),
  assigned_at: z.string(),
  removed_at: z.string().nullable(),
});
export type ProjectAgent = z.infer<typeof ProjectAgentSchema>;

export function getAssignment(db: Db, libraryAgentId: string): ProjectAgent | null {
  const row = db
    .prepare('SELECT * FROM project_agents WHERE library_agent_id = ?')
    .get(libraryAgentId);
  return row ? ProjectAgentSchema.parse(row) : null;
}

/** Linked agents (not removed), oldest assignment first. `includeRemoved` also returns removed links (settings kept). */
export function listAssignments(db: Db, o: { includeRemoved?: boolean } = {}): ProjectAgent[] {
  return ProjectAgentSchema.array().parse(
    db
      .prepare(
        `SELECT * FROM project_agents ${o.includeRemoved ? '' : 'WHERE removed_at IS NULL'} ORDER BY assigned_at, library_agent_id`,
      )
      .all(),
  );
}

/** Write (or refresh) the project's `agents` row for a library agent. A mirror, not a copy: the library stays the source. */
export function mirrorLibraryAgent(db: Db, a: LibraryAgent): void {
  const parent = a.parent_id && getAgent(db, a.parent_id) ? a.parent_id : null;
  const exists = getAgent(db, a.id);
  if (exists) {
    db.prepare(
      `UPDATE agents SET name = ?, type = ?, parent_id = ?, color = ?, permissions = ?, executor = ?, tool = ?, provider = ?, model = ?
       WHERE id = ?`,
    ).run(
      a.name,
      a.type,
      parent,
      a.color,
      toJson(a.default_permissions),
      a.executor,
      a.tool,
      a.provider,
      a.model,
      a.id,
    );
  } else {
    db.prepare(
      `INSERT INTO agents (id, name, type, parent_id, color, status, permissions, executor, tool, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`,
    ).run(
      a.id,
      a.name,
      a.type,
      parent,
      a.color,
      toJson(a.default_permissions),
      a.executor,
      a.tool,
      a.provider,
      a.model,
      nowIso(),
    );
  }
}

/** Refresh the mirror rows of every linked agent from the library (call on open and before a run). Returns how many changed. */
export function syncMirrors(db: Db, lib: LibraryDb): number {
  let n = 0;
  write(db, () => {
    for (const link of listAssignments(db)) {
      const a = getLibraryAgent(lib, link.library_agent_id);
      if (!a) continue;
      const cur = getAgent(db, a.id);
      const stale =
        !cur ||
        cur.name !== a.name ||
        cur.type !== a.type ||
        cur.color !== a.color ||
        cur.executor !== a.executor ||
        cur.tool !== a.tool ||
        cur.provider !== a.provider ||
        cur.model !== a.model ||
        JSON.stringify(cur.permissions) !== JSON.stringify(a.default_permissions);
      if (stale) {
        mirrorLibraryAgent(db, a);
        n++;
      }
    }
  });
  return n;
}

export interface AssignResult {
  assignment: ProjectAgent;
  /** The agent had been in this project before and its project settings were restored. */
  restored: boolean;
  /** One sentence the app shows: restored or defaults applied. */
  note: string;
}

/** Link a library agent to this project. Adding back a removed agent restores its project settings; otherwise defaults apply and `note` says so. */
export function assignLibraryAgent(
  db: Db,
  lib: LibraryDb,
  libraryAgentId: string,
  actor = 'operator',
): AssignResult {
  const a = getLibraryAgent(lib, libraryAgentId);
  if (!a)
    throw new CoreError(
      'LIBRARY_AGENT_NOT_FOUND',
      `Library agent '${libraryAgentId}' does not exist.`,
    );
  if (a.status === 'archived')
    throw new InvalidInputError(`${a.name} is archived: restore it in the library first.`);
  return write(db, () => {
    const cur = getAssignment(db, libraryAgentId);
    let restored = false;
    let note: string;
    if (cur && !cur.removed_at) note = `${a.name} is already in this project.`;
    else if (cur) {
      db.prepare('UPDATE project_agents SET removed_at = NULL WHERE library_agent_id = ?').run(
        libraryAgentId,
      );
      restored = true;
      note = `${a.name} was added back with the project settings it had before.`;
    } else {
      db.prepare(
        'INSERT INTO project_agents (library_agent_id, enabled, allowed_task_types, extra_constraints, assigned_at) VALUES (?, 1, ?, ?, ?)',
      ).run(libraryAgentId, '[]', '[]', nowIso());
      note = `${a.name} was added with default project settings.`;
    }
    mirrorLibraryAgent(db, a);
    if (!cur || cur.removed_at)
      logAction(db, {
        agentId: actor,
        action: 'agent_assigned',
        targetType: 'agent',
        targetId: libraryAgentId,
        description: `${a.name} was added to this project${restored ? ' (settings restored)' : ''}`,
        tags: ['assignment', libraryAgentId],
      });
    return { assignment: getAssignment(db, libraryAgentId) as ProjectAgent, restored, note };
  });
}

/** Unlink an agent from this project. Only the link goes: the library agent stays, its history stays, its project settings are kept. */
export function removeLibraryAgent(
  db: Db,
  libraryAgentId: string,
  actor = 'operator',
): ProjectAgent {
  return write(db, () => {
    const cur = getAssignment(db, libraryAgentId);
    if (!cur || cur.removed_at)
      throw new CoreError('NOT_ASSIGNED', `'${libraryAgentId}' is not in this project.`);
    db.prepare('UPDATE project_agents SET removed_at = ? WHERE library_agent_id = ?').run(
      nowIso(),
      libraryAgentId,
    );
    logAction(db, {
      agentId: actor,
      action: 'agent_unassigned',
      targetType: 'agent',
      targetId: libraryAgentId,
      description: `${getAgent(db, libraryAgentId)?.name ?? libraryAgentId} was removed from this project (it stays in the library)`,
      tags: ['assignment', libraryAgentId],
    });
    return getAssignment(db, libraryAgentId) as ProjectAgent;
  });
}

export const AssignmentPatchSchema = z
  .strictObject({
    enabled: z.boolean(),
    /** Task types the agent may take: the milestone domains (swim lanes). Empty = any. */
    allowed_task_types: z.array(z.string().trim().min(1).max(60)).max(30),
    extra_constraints: z.array(z.string().trim().min(1).max(500)).max(30),
  })
  .partial();
export type AssignmentPatch = z.infer<typeof AssignmentPatchSchema>;

export function updateAssignment(
  db: Db,
  libraryAgentId: string,
  rawPatch: unknown,
  actor = 'operator',
): ProjectAgent {
  const patch = AssignmentPatchSchema.parse(rawPatch);
  return write(db, () => {
    const cur = getAssignment(db, libraryAgentId);
    if (!cur || cur.removed_at)
      throw new CoreError('NOT_ASSIGNED', `'${libraryAgentId}' is not in this project.`);
    db.prepare(
      'UPDATE project_agents SET enabled = ?, allowed_task_types = ?, extra_constraints = ? WHERE library_agent_id = ?',
    ).run(
      (patch.enabled ?? cur.enabled) ? 1 : 0,
      toJson(patch.allowed_task_types ?? cur.allowed_task_types),
      toJson(patch.extra_constraints ?? cur.extra_constraints),
      libraryAgentId,
    );
    logAction(db, {
      agentId: actor,
      action: 'agent_settings_changed',
      targetType: 'agent',
      targetId: libraryAgentId,
      description: `${getAgent(db, libraryAgentId)?.name ?? libraryAgentId}: project settings changed (${Object.keys(patch).join(', ') || 'none'})`,
      tags: ['assignment', libraryAgentId],
    });
    return getAssignment(db, libraryAgentId) as ProjectAgent;
  });
}

/**
 * May this project's orchestrator give a task of `domain` to this agent? Agents the library does not manage (created by MCP
 * sessions, the planner, older projects) are unaffected. A linked agent must be enabled, still linked, and allowed the task type.
 */
export function assignmentBlock(db: Db, agentId: string, domain: string | null): string | null {
  const row = getAssignment(db, agentId);
  if (!row) return null;
  if (row.removed_at) return 'removed from this project';
  if (!row.enabled) return 'disabled in this project';
  if (
    row.allowed_task_types.length > 0 &&
    !row.allowed_task_types.some((t) => t.toLowerCase() === (domain ?? '').toLowerCase())
  )
    return `not allowed to take ${domain ?? 'untyped'} tasks`;
  return null;
}
