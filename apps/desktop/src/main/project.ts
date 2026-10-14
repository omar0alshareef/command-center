import { app } from 'electron';
import {
  dbPath,
  getAllTrackerState,
  openDb,
  projectDispatchBlock,
  readProjectFile,
  readSpec,
  syncMirrors,
  type Db,
  type TrackerState,
} from '@command-center/core';
import type { ProjectInfo, SyncStatus } from '../shared/ipc';
import { getLibrary, libraryDir, registerFolder } from './library-service';
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
  private projectId: string | null = null;
  private projectName: string | null = null;
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
      try {
        const rec = registerFolder(root);
        this.projectId = rec.id;
        this.projectName = rec.name;
        // Library agents edited while this project was closed: bring its copies up to date before any view reads them.
        syncMirrors(this.conn, getLibrary());
      } catch {
        this.projectId = null; // the registry is a convenience: a broken library never stops a project from opening
        this.projectName = null;
      }
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
    const file = this.root ? readProjectFile(this.root) : null;
    const spec = this.root ? readSpec(this.root, file?.ok ? file.project : null) : null;
    return {
      projectId: this.projectId,
      projectName: file?.ok ? file.project.name : this.projectName,
      spec: spec ? { status: spec.status, path: spec.path, hash: spec.hash } : null,
      dispatchBlock: this.root ? projectDispatchBlock(this.root) : null,
      libraryDir: libraryDir(),
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
