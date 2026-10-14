import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, type Db } from '../src/db';
import { openLibrary, type LibraryDb } from '../src/library/db';

/** The sample project in the repo (AGENTS.md, README.md, LICENSE, details/, project.json): the first M15 fixture. */
export const DEMO = resolve(__dirname, '../../../sample-projects/demo-project');

export interface Env {
  /** The app-wide library. */
  lib: LibraryDb;
  libDir: string;
  /** Make a project folder from the demo project (own database inside). */
  project(name?: string): { root: string; db: Db };
  /** Make an empty project folder with a database but no project files. */
  bare(name?: string): { root: string; db: Db };
  cleanup(): void;
}

export function tmpEnv(): Env {
  const base = mkdtempSync(join(tmpdir(), 'cc-m15-'));
  const libDir = join(base, 'appdata');
  const lib = openLibrary(libDir);
  const dbs: Db[] = [];
  let n = 0;
  return {
    lib,
    libDir,
    project(name = `proj-${++n}`) {
      const root = join(base, name);
      cpSync(DEMO, root, { recursive: true });
      const db = openDb(root);
      dbs.push(db);
      return { root, db };
    },
    bare(name = `bare-${++n}`) {
      const root = join(base, name);
      mkdirSync(root, { recursive: true });
      const db = openDb(root);
      dbs.push(db);
      return { root, db };
    },
    cleanup() {
      for (const d of dbs) if (d.open) d.close();
      lib.close();
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** A milestone and a task, straight into a project database. */
export function addTask(
  db: Db,
  id: string,
  o: {
    label?: string;
    assignee?: string | null;
    status?: string;
    domain?: string;
    deps?: string[];
    criteria?: string[];
  } = {},
): void {
  db.prepare(
    "INSERT OR IGNORE INTO milestones (id, title, domain, planned_start) VALUES ('M1', 'First', ?, '2026-01-05')",
  ).run(o.domain ?? 'general');
  db.prepare(
    `INSERT INTO subtasks (id, milestone_id, label, status, assignee, depends_on, acceptance_criteria) VALUES (?, 'M1', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.label ?? `Task ${id}`,
    o.status ?? 'todo',
    o.assignee ?? null,
    JSON.stringify(o.deps ?? []),
    JSON.stringify((o.criteria ?? []).map((text) => ({ text, done: false }))),
  );
}
