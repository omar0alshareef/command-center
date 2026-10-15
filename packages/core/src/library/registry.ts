import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { nowIso, openDbReadonly, write } from '../db';
import { CoreError, InvalidInputError } from '../errors';
import { readProjectFile, slugify, type ProjectFileResult } from '../project-file';
import type { AgentUsage } from './agents';
import type { LibraryDb } from './db';

// The registry of known projects (M15). It is the only place that lists them all. Removing a project from it never deletes
// files. A project is just a folder with a project.json and its own command-center.db (D31).

const ProjectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  path: z.string(),
  last_opened: z.string().nullable(),
  created_at: z.string(),
});
export type ProjectRecord = z.infer<typeof ProjectRowSchema>;

/** One canonical spelling per folder (Windows paths are case-insensitive). */
export const normalizePath = (p: string): string => {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\//g, '\\') : r;
};
const sameDir = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function listProjects(lib: LibraryDb): ProjectRecord[] {
  return ProjectRowSchema.array().parse(
    lib
      .prepare('SELECT * FROM projects ORDER BY COALESCE(last_opened, created_at) DESC, name')
      .all(),
  );
}

export function getProjectByPath(lib: LibraryDb, path: string): ProjectRecord | null {
  const want = normalizePath(path);
  return listProjects(lib).find((p) => sameDir(normalizePath(p.path), want)) ?? null;
}

export function getProjectRecord(lib: LibraryDb, id: string): ProjectRecord | null {
  const row = lib.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? ProjectRowSchema.parse(row) : null;
}

/** Register a folder (idempotent by path). The id is the slug, made unique. */
export function registerProject(
  lib: LibraryDb,
  o: { name: string; slug?: string; path: string; opened?: boolean },
): ProjectRecord {
  const path = normalizePath(o.path);
  const name = z.string().trim().min(1).max(120).parse(o.name);
  return write(lib, () => {
    const existing = getProjectByPath(lib, path);
    if (existing) {
      lib
        .prepare(
          'UPDATE projects SET name = ?, last_opened = COALESCE(?, last_opened) WHERE id = ?',
        )
        .run(name, o.opened ? nowIso() : null, existing.id);
      return getProjectRecord(lib, existing.id) as ProjectRecord;
    }
    const base = o.slug ?? slugify(name);
    let id = base;
    for (let i = 2; getProjectRecord(lib, id); i++) id = `${base}-${i}`;
    lib
      .prepare(
        'INSERT INTO projects (id, name, slug, path, last_opened, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, base, path, o.opened ? nowIso() : null, nowIso());
    return getProjectRecord(lib, id) as ProjectRecord;
  });
}

export function touchProject(lib: LibraryDb, id: string): void {
  lib.prepare('UPDATE projects SET last_opened = ? WHERE id = ?').run(nowIso(), id);
}

/** Forget a project. The folder and its files are never touched. */
export function removeProjectRecord(lib: LibraryDb, id: string): void {
  if (!getProjectRecord(lib, id))
    throw new CoreError('PROJECT_NOT_FOUND', `Project ${id} is not registered.`);
  lib.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/**
 * The folder of a registered project moved: point the registry at the new place. The new folder must exist, must not already
 * be registered under another entry, and (like "Add existing") must hold a valid project.json or at least a command-center.db.
 * Nothing on disk is touched.
 */
export function relocateProject(lib: LibraryDb, id: string, newPath: string): ProjectRecord {
  const rec = getProjectRecord(lib, id);
  if (!rec) throw new CoreError('PROJECT_NOT_FOUND', `Project ${id} is not registered.`);
  const path = normalizePath(newPath);
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new InvalidInputError(`The folder ${path} does not exist.`);
  const other = getProjectByPath(lib, path);
  if (other && other.id !== id)
    throw new InvalidInputError(`That folder is already in the list as "${other.name}".`);
  const file = readProjectFile(path);
  if (!file.ok && !existsSync(resolve(path, 'command-center.db')))
    throw new InvalidInputError(
      file.missing
        ? `${path} has no project.json or database: pick the project's own folder.`
        : file.issues.join('; '),
    );
  lib.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path, id);
  return getProjectRecord(lib, id) as ProjectRecord;
}

export interface ProjectHealth {
  /** Can the switcher open it? False when the folder is missing or its database cannot be opened. */
  openable: boolean;
  /** Why not (shown in the switcher next to the project). */
  error: string | null;
  /** Dispatch is blocked for this project (a malformed project.json); it can still be opened to fix it (D36). */
  dispatchBlock: string | null;
  projectFile: ProjectFileResult | null;
  hasDb: boolean;
}

export function projectHealth(path: string): ProjectHealth {
  const folder = normalizePath(path);
  if (!existsSync(folder) || !statSync(folder).isDirectory())
    return {
      openable: false,
      error: `The folder ${folder} does not exist.`,
      dispatchBlock: null,
      projectFile: null,
      hasDb: false,
    };
  const projectFile = readProjectFile(folder);
  const db = resolve(folder, 'command-center.db');
  const hasDb = existsSync(db);
  if (hasDb) {
    try {
      openDbReadonly(folder).close();
    } catch (e) {
      return {
        openable: false,
        error: `The database cannot be opened: ${e instanceof Error ? e.message : String(e)}`,
        dispatchBlock: null,
        projectFile,
        hasDb,
      };
    }
  }
  const dispatchBlock =
    !projectFile.ok && !projectFile.missing
      ? `Dispatch is blocked: ${projectFile.issues.join('; ')}`
      : null;
  return { openable: true, error: null, dispatchBlock, projectFile, hasDb };
}

/**
 * Where a library agent is used, across every registered project (read-only): links that are not removed and runs
 * recorded for it. The D35 delete-or-archive rule is decided from this.
 */
export function agentUsage(lib: LibraryDb, agentId: string): AgentUsage {
  let links = 0;
  let runs = 0;
  const projects: string[] = [];
  for (const p of listProjects(lib)) {
    if (!existsSync(resolve(p.path, 'command-center.db'))) continue;
    try {
      const db = openDbReadonly(p.path);
      try {
        const l = (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM project_agents WHERE library_agent_id = ? AND removed_at IS NULL',
            )
            .get(agentId) as { n: number }
        ).n;
        const r = (
          db.prepare('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?').get(agentId) as {
            n: number;
          }
        ).n;
        if (l > 0 || r > 0) projects.push(p.name);
        links += l;
        runs += r;
      } finally {
        db.close();
      }
    } catch {
      // A project that cannot be read cannot prove the agent unused: count it as a link so nothing is deleted by mistake.
      links += 1;
      projects.push(`${p.name} (unreadable)`);
    }
  }
  return { links, runs, projects };
}

export const assertName = (n: string): string => {
  if (!n.trim()) throw new InvalidInputError('Give the project a name.');
  return n.trim();
};
