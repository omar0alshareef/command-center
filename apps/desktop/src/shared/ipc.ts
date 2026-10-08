import type { TrackerState } from '@command-center/core';

// The whole renderer <-> main contract. Named, typed methods only: the renderer never sends SQL (D2).
export const CH = {
  getAll: 'db:getAll',
  projectGet: 'project:get',
  projectChoose: 'project:choose',
  projectRetry: 'project:retry',
  dbChanged: 'db:changed',
  dbStatus: 'db:status',
} as const;

export interface ProjectInfo {
  root: string | null;
  dbPath: string | null;
  /** Set when the DB could not be opened (missing, locked, corrupt). */
  error: string | null;
  appVersion: string;
}

export type SyncStatus = { state: 'live' } | { state: 'disconnected'; error: string };

export interface Api {
  platform: string;
  project: {
    get(): Promise<ProjectInfo>;
    /** Opens a folder picker, then opens (creating if needed) the project DB there. */
    choose(): Promise<ProjectInfo>;
    retry(): Promise<ProjectInfo>;
  };
  db: {
    getAll(): Promise<TrackerState>;
  };
  onDbChanged(cb: () => void): () => void;
  onDbStatus(cb: (status: SyncStatus) => void): () => void;
}
