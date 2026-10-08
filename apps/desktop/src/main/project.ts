import { app } from 'electron';
import {
  dbPath,
  getAllTrackerState,
  openDb,
  type Db,
  type TrackerState,
} from '@command-center/core';
import type { ProjectInfo, SyncStatus } from '../shared/ipc';
import { mcpLaunch } from './mcp-path';
import { saveRoot } from './settings';
import { startWatcher } from './watcher';

export interface ProjectEvents {
  changed(): void;
  status(status: SyncStatus): void;
}

/** Owns the writer DB connection and the change watcher for the currently open project. */
export class ProjectService {
  private root: string | null = null;
  private conn: Db | null = null;
  private error: string | null = null;
  private stopWatcher: (() => void) | null = null;

  constructor(private readonly events: ProjectEvents) {}

  open(root: string, persist = false): ProjectInfo {
    this.close();
    this.root = root;
    try {
      this.conn = openDb(root);
      this.error = null;
      this.stopWatcher = startWatcher(root, this.events);
      if (persist) saveRoot(root);
    } catch (e) {
      this.conn = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    return this.info();
  }

  retry(): ProjectInfo {
    return this.root ? this.open(this.root) : this.info();
  }

  info(): ProjectInfo {
    return {
      root: this.root,
      dbPath: this.root ? dbPath(this.root) : null,
      error: this.error,
      appVersion: app.getVersion(),
      mcp: mcpLaunch(),
    };
  }

  /** The open writer connection. Throws if no project is open (callers map it to an error). */
  db(): Db {
    if (!this.conn) throw new Error(this.error ?? 'No project is open.');
    return this.conn;
  }

  getAll(): TrackerState {
    return getAllTrackerState(this.db());
  }

  close(): void {
    this.stopWatcher?.();
    this.stopWatcher = null;
    this.conn?.close();
    this.conn = null;
  }
}
