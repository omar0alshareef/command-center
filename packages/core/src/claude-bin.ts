import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** `claude` from COMMAND_CENTER_CLAUDE, PATH, or the installer's usual folder; null if it cannot be found. */
export function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const override = env['COMMAND_CENTER_CLAUDE']?.trim();
  if (override) return override;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [
    ...(env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean),
    join(homedir(), '.local', 'bin'),
  ];
  for (const d of dirs) for (const n of names) if (exists(join(d, n))) return join(d, n);
  return null;
}
