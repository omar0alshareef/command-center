import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/** Scripts worth running before a task counts as built: `npm run typecheck` / `lint` when the project defines them. */
export function defaultChecks(root: string): string[] {
  const pkg = join(root, 'package.json');
  if (!existsSync(pkg)) return [];
  try {
    const scripts =
      (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    return ['typecheck', 'lint'].filter((s) => s in scripts).map((s) => `npm run ${s}`);
  } catch {
    return [];
  }
}

const TAIL = 4000;

/**
 * Runs each command in the project folder through the shell. The commands come from the operator's own
 * `--check` flags or the project's package.json scripts, never from an agent.
 */
export function runChecks(
  commands: readonly string[],
  cwd: string,
  timeoutMs = 10 * 60_000,
): CheckResult[] {
  return commands.map((command) => {
    const r = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return {
      command,
      ok: r.status === 0 && !r.error,
      exitCode: r.status,
      output: text.length > TAIL ? `…${text.slice(-TAIL)}` : text,
    };
  });
}

export function checksText(results: readonly CheckResult[]): string {
  if (results.length === 0) return '(no checks configured)';
  return results
    .map(
      (r) =>
        `$ ${r.command}\n${r.ok ? 'PASS' : `FAIL (exit ${r.exitCode ?? 'none'})`}${r.output ? `\n${r.output}` : ''}`,
    )
    .join('\n\n');
}
