import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { migrate, type Db } from '../db';

// The app-wide library (M15, D30): ONE SQLite file in the app's own data folder, not inside any project. It holds the
// agents every project can use, the registry of known projects, and the lessons that apply beyond one project.

export const LIBRARY_FILENAME = 'library.db';
export type LibraryDb = Db;

/**
 * Where the library lives unless COMMAND_CENTER_LIBRARY says otherwise: a folder named "Command Center" in the OS's per-user
 * application data folder. Spelled out here (not taken from Electron) so the app, the CLI and the MCP server agree.
 *   Windows %APPDATA%\Command Center · macOS ~/Library/Application Support/Command Center · Linux ~/.config/Command Center
 */
export function defaultLibraryDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const given = env['COMMAND_CENTER_LIBRARY']?.trim();
  if (given) return given;
  if (platform === 'win32')
    return join(env['APPDATA']?.trim() || join(home, 'AppData', 'Roaming'), 'Command Center');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Command Center');
  return join(env['XDG_CONFIG_HOME']?.trim() || join(home, '.config'), 'Command Center');
}

export const libraryPath = (dir: string): string => join(dir, LIBRARY_FILENAME);

const sql001 = `
CREATE TABLE library_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'general',
  type TEXT NOT NULL DEFAULT 'sub-agent' CHECK(type IN ('orchestrator','sub-agent','human','external')),
  executor TEXT NOT NULL DEFAULT 'agent' CHECK(executor IN ('agent','external','human')),
  tool TEXT,
  parent_id TEXT,
  color TEXT NOT NULL DEFAULT '#9B9BAA',
  base_instructions TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  default_permissions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_library_agents_role ON library_agents(role, name);

-- Append-only edit history: one snapshot per create or edit, never changed afterwards.
CREATE TABLE library_agent_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, version)
);
CREATE TRIGGER library_agent_versions_no_update BEFORE UPDATE ON library_agent_versions
BEGIN SELECT RAISE(ABORT, 'library_agent_versions is append-only'); END;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  last_opened TEXT,
  created_at TEXT NOT NULL
);

-- Lessons promoted beyond one project (D37): scope agent (one library agent, in every project it is assigned to) or global.
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('agent','global')),
  agent_id TEXT,
  origin_project TEXT,
  origin_lesson_id INTEGER,
  origin_task TEXT,
  trigger_keywords TEXT NOT NULL DEFAULT '',
  rejection_reason TEXT NOT NULL,
  fix_applied TEXT NOT NULL DEFAULT '',
  prevention TEXT NOT NULL DEFAULT '',
  check_text TEXT NOT NULL DEFAULT '',
  check_type TEXT NOT NULL DEFAULT 'none' CHECK(check_type IN ('automatic','manual','none')),
  occurrences INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','needs_rewrite','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE lessons_fts USING fts5(
  rejection_reason, fix_applied, prevention, trigger_keywords,
  content='lessons', content_rowid='id'
);
CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES (new.id, new.rejection_reason, new.fix_applied, new.prevention, new.trigger_keywords);
END;
CREATE TRIGGER lessons_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied, old.prevention, old.trigger_keywords);
END;
CREATE TRIGGER lessons_au AFTER UPDATE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied, old.prevention, old.trigger_keywords);
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES (new.id, new.rejection_reason, new.fix_applied, new.prevention, new.trigger_keywords);
END;
`;

export const libraryMigrations = [{ version: 1, name: 'library', sql: sql001 }] as const;

/** Open (creating and migrating) the library in `dir`. WAL and a busy timeout, like the project database. */
export function openLibrary(dir: string): LibraryDb {
  mkdirSync(dir, { recursive: true });
  const db = new Database(libraryPath(dir));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db, libraryMigrations);
  return db;
}

/** Read-only connection for scanning (usage counts, MCP/CLI reads). Throws when the file does not exist. */
export function openLibraryReadonly(dir: string): LibraryDb {
  const db = new Database(libraryPath(dir), { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
