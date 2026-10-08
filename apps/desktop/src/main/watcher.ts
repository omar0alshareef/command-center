import { watch, type FSWatcher } from 'node:fs';
import { dataVersion, DB_FILENAME, openDbReadonly, type Db } from '@command-center/core';
import type { SyncStatus } from '../shared/ipc';

const POLL_MS = 500;
const DEBOUNCE_MS = 100;
const MAX_BACKOFF_MS = 10_000;

export interface WatcherCallbacks {
  changed(): void;
  status(status: SyncStatus): void;
}

/**
 * Detects writes by other connections/processes (D3). `PRAGMA data_version` polled every 500ms is the
 * authority; fs.watch on the .db/-wal files is only a hint to check sooner. On error: report
 * disconnected and reconnect with exponential backoff.
 */
export function startWatcher(root: string, cb: WatcherCallbacks): () => void {
  let ro: Db | null = null;
  let last = -1;
  let failures = 0;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let fsWatcher: FSWatcher | undefined;

  const emitChanged = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(cb.changed, DEBOUNCE_MS);
  };

  const check = () => {
    if (stopped) return;
    try {
      if (!ro) {
        ro = openDbReadonly(root);
        last = dataVersion(ro);
        if (failures > 0) {
          failures = 0;
          cb.status({ state: 'live' });
          emitChanged(); // we may have missed writes while disconnected
        }
        return;
      }
      const v = dataVersion(ro);
      if (v !== last) {
        last = v;
        emitChanged();
      }
    } catch (e) {
      ro?.close();
      ro = null;
      failures++;
      cb.status({ state: 'disconnected', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const loop = () => {
    check();
    if (stopped) return;
    const delay = ro ? POLL_MS : Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
    pollTimer = setTimeout(loop, delay);
  };

  try {
    fsWatcher = watch(root, (_event, filename) => {
      if (filename?.startsWith(DB_FILENAME)) check();
    });
    fsWatcher.on('error', () => fsWatcher?.close());
  } catch {
    // Hint only; polling still works.
  }
  loop();

  return () => {
    stopped = true;
    clearTimeout(pollTimer);
    clearTimeout(debounceTimer);
    fsWatcher?.close();
    ro?.close();
  };
}
