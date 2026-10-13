import { execFileSync } from 'node:child_process';

/**
 * End a process and everything it started. On Windows killing the parent (or closing a pseudo console)
 * leaves grandchildren running, so the tree goes through `taskkill /T` first: once the parent is dead
 * taskkill can no longer find its children. Used by the terminal, the planner and the provider adapters (M8, M13, M14).
 */
export function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      /* nothing left to kill */
    }
  }
  try {
    kill();
  } catch {
    /* already gone */
  }
}
