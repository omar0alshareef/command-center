import {
  dbPath,
  defaultLibraryDir,
  libraryPath,
  openDb,
  openLibraryReadonly,
  type Db,
  type LibraryDb,
} from '@command-center/core';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface Handle {
  root: string;
  db: Db;
}

/**
 * Which project folder to use: `--root`, then PROJECT_ROOT, then the nearest folder at or above `cwd`
 * that holds a command-center.db. Returns null when none is found.
 */
export function findRoot(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const given = explicit?.trim() || env['PROJECT_ROOT']?.trim();
  if (given) return resolve(given);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (exists(dbPath(dir))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The app-wide library, read-only, or null when the app has not created it yet (COMMAND_CENTER_LIBRARY overrides the folder). */
export function openLibraryIfAny(env: NodeJS.ProcessEnv = process.env): LibraryDb | null {
  const dir = defaultLibraryDir(env);
  return existsSync(libraryPath(dir)) ? openLibraryReadonly(dir) : null;
}

/** Opens the project's board. Never creates one: a typo in the folder must not produce an empty database. */
export function openProject(explicit?: string): Handle {
  const root = findRoot(explicit);
  if (!root) {
    throw new CliError(
      'No project found. Run this inside a project folder that has a command-center.db, pass --root <folder>, or set PROJECT_ROOT.',
    );
  }
  if (!existsSync(dbPath(root))) {
    throw new CliError(
      `No command-center.db in ${root}. Open the Command Center app on that folder first, or fix --root / PROJECT_ROOT.`,
    );
  }
  return { root, db: openDb(root) };
}
