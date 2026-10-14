import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from './migrations';

export type Db = Database.Database;

export const DB_FILENAME = 'command-center.db';

export function dbPath(projectRoot: string): string {
  return join(projectRoot, DB_FILENAME);
}

/**
 * Open (and migrate) the project database. Shared by the app, MCP server, CLI and webhook (D4).
 * WAL lets readers and one writer coexist; busy_timeout makes writers queue instead of failing.
 */
export function openDb(projectRoot: string): Db {
  mkdirSync(projectRoot, { recursive: true });
  const db = new Database(dbPath(projectRoot));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Read-only connection for change detection (D3). Never migrates; the DB must already exist. */
export function openDbReadonly(projectRoot: string): Db {
  const db = new Database(dbPath(projectRoot), { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(
  db: Db,
  list: readonly { version: number; name: string; sql: string }[] = migrations,
): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  // IMMEDIATE takes the write lock up front, so two processes opening at once serialize here
  // and the second one sees the first one's migrations as applied.
  db.transaction(() => {
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    for (const m of list) {
      if (applied.has(m.version)) continue;
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        nowIso(),
      );
    }
  }).immediate();
}

/**
 * Run `fn` in a write transaction that takes the lock immediately. Read-then-write transactions
 * that start deferred can fail with SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry.
 */
export function write<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/**
 * Changes whenever ANOTHER connection commits (not for this connection's own writes).
 * The app's watcher polls this on a read-only connection (D3).
 */
export function dataVersion(db: Db): number {
  return db.pragma('data_version', { simple: true }) as number;
}

/** All timestamps are stored as UTC ISO strings and rendered local in the UI. */
export function nowIso(): string {
  return new Date().toISOString();
}
