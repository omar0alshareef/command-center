import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '../src/shared/ipc';

const h = vi.hoisted(() => ({
  open: vi.fn(),
  version: vi.fn(),
  fsHint: null as null | ((event: string, filename: string | null) => void),
  fsClose: vi.fn(),
}));

vi.mock('@command-center/core', () => ({
  DB_FILENAME: 'command-center.db',
  openDbReadonly: (...a: unknown[]) => h.open(...a),
  dataVersion: (...a: unknown[]) => h.version(...a),
}));
vi.mock('node:fs', () => ({
  watch: (_root: string, cb: (event: string, filename: string | null) => void) => {
    h.fsHint = cb;
    return { on: vi.fn(), close: h.fsClose };
  },
}));

import { startWatcher } from '../src/main/watcher';

const fakeDb = () => ({ close: vi.fn() });

let changed: ReturnType<typeof vi.fn>;
let statuses: SyncStatus[];
const start = () =>
  startWatcher('/proj', { changed: changed as () => void, status: (s) => statuses.push(s) });

beforeEach(() => {
  vi.useFakeTimers();
  h.open.mockReset();
  h.version.mockReset();
  h.fsClose.mockReset();
  h.fsHint = null;
  changed = vi.fn();
  statuses = [];
});
afterEach(() => vi.useRealTimers());

describe('startWatcher: change detection', () => {
  it('polls data_version every 500ms and emits one debounced change (100ms)', () => {
    h.open.mockReturnValue(fakeDb());
    h.version.mockReturnValue(1);
    const stop = start();

    vi.advanceTimersByTime(2000);
    expect(changed).not.toHaveBeenCalled(); // nothing changed

    h.version.mockReturnValue(2);
    vi.advanceTimersByTime(500); // next poll sees it
    vi.advanceTimersByTime(99);
    expect(changed).not.toHaveBeenCalled(); // still inside the debounce window
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
  });

  it('uses the fs.watch hint to check sooner, ignores unrelated files, and still debounces', () => {
    h.open.mockReturnValue(fakeDb());
    h.version.mockReturnValue(1);
    const stop = start();
    vi.advanceTimersByTime(10);

    h.version.mockReturnValue(2);
    h.fsHint?.('change', 'notes.txt'); // not our file
    vi.advanceTimersByTime(150);
    expect(changed).not.toHaveBeenCalled();

    h.fsHint?.('change', 'command-center.db-wal'); // our WAL: check now, not in 500ms
    h.fsHint?.('change', 'command-center.db-wal'); // burst: second sees the same version
    vi.advanceTimersByTime(100);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('startWatcher: disconnect and backoff', () => {
  it('reports disconnected and retries after 1s, 2s, 4s, then reconnects, goes live and refetches', () => {
    const db = fakeDb();
    h.open
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockReturnValue(db);
    h.version.mockReturnValue(1);
    const stop = start();

    const attemptsAt = (ms: number) => {
      vi.advanceTimersByTime(ms);
      return h.open.mock.calls.length;
    };
    expect(h.open).toHaveBeenCalledTimes(1); // t=0 fails
    expect(attemptsAt(999)).toBe(1); // t=999
    expect(attemptsAt(1)).toBe(2); // t=1000 (1s)
    expect(attemptsAt(1999)).toBe(2);
    expect(attemptsAt(1)).toBe(3); // t=3000 (+2s)
    expect(attemptsAt(3999)).toBe(3);
    expect(attemptsAt(1)).toBe(4); // t=7000 (+4s) succeeds

    expect(statuses.map((s) => s.state)).toEqual([
      'disconnected',
      'disconnected',
      'disconnected',
      'live',
    ]);
    expect(statuses[0]).toEqual({ state: 'disconnected', error: 'database is locked' });
    // Writes may have landed while disconnected, so a reconnect always asks for a refetch.
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(changed).toHaveBeenCalledTimes(1);

    // Back to the normal 500ms cadence.
    const before = h.version.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(h.version.mock.calls.length - before).toBe(2);
    stop();
  });

  it('caps the backoff at 10s', () => {
    h.open.mockImplementation(() => {
      throw new Error('gone');
    });
    const stop = start();
    // attempts at 0, 1s, 3s, 7s, 15s, then 10s apart: 25s, 35s
    const calls = (ms: number) => {
      vi.advanceTimersByTime(ms);
      return h.open.mock.calls.length;
    };
    expect(calls(14_999)).toBe(4);
    expect(calls(1)).toBe(5); // 15s
    expect(calls(9_999)).toBe(5);
    expect(calls(1)).toBe(6); // 25s (capped, not 16s)
    expect(calls(9_999)).toBe(6);
    expect(calls(1)).toBe(7); // 35s
    stop();
  });

  it('treats a data_version read error on a live connection as a disconnect and closes it', () => {
    const db = fakeDb();
    h.open.mockReturnValue(db);
    h.version.mockReturnValueOnce(1).mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    const stop = start();
    vi.advanceTimersByTime(500);
    expect(statuses).toEqual([{ state: 'disconnected', error: 'disk I/O error' }]);
    expect(db.close).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('startWatcher: stop', () => {
  it('stops polling, cancels the pending debounce, and closes the connection and fs watcher', () => {
    const db = fakeDb();
    h.open.mockReturnValue(db);
    h.version.mockReturnValue(1);
    const stop = start();
    h.version.mockReturnValue(2);
    vi.advanceTimersByTime(500); // change detected, debounce pending
    stop();
    vi.advanceTimersByTime(5000);
    expect(changed).not.toHaveBeenCalled();
    expect(h.version.mock.calls.length).toBe(2); // initial read + the one poll before stop
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(h.fsClose).toHaveBeenCalledTimes(1);
  });
});
