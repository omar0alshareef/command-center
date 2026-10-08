import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

export interface ShellInfo {
  id: string;
  name: string;
  file: string;
  args: string[];
}

interface Env {
  [key: string]: string | undefined;
}

/** First match of `names` in PATH (Windows file names, so PATHEXT is not needed). */
function onPath(names: string[], env: Env, exists: (p: string) => boolean): string | null {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) for (const n of names) if (exists(join(dir, n))) return join(dir, n);
  return null;
}

/**
 * Shells that exist on this machine, default first (D8). Only these ids can be spawned: the renderer
 * picks one by id and never supplies an executable path.
 */
export function detectShells(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
): ShellInfo[] {
  const out: ShellInfo[] = [];
  const add = (id: string, name: string, file: string | null, args: string[] = []) => {
    if (file && !out.some((s) => s.id === id)) out.push({ id, name, file, args });
  };
  if (platform === 'win32') {
    const root = env['SystemRoot'] ?? 'C:\\Windows';
    const ps5 = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    add('pwsh', 'PowerShell 7', onPath(['pwsh.exe'], env, exists), ['-NoLogo']);
    add('powershell', 'PowerShell', exists(ps5) ? ps5 : onPath(['powershell.exe'], env, exists), [
      '-NoLogo',
    ]);
    add(
      'cmd',
      'Command Prompt',
      env['ComSpec'] && exists(env['ComSpec']) ? env['ComSpec'] : join(root, 'System32', 'cmd.exe'),
    );
    const gitBash = ['ProgramFiles', 'ProgramFiles(x86)']
      .map((k) => env[k])
      .filter((p): p is string => Boolean(p))
      .map((p) => join(p, 'Git', 'bin', 'bash.exe'))
      .find((p) => exists(p));
    add('bash', 'Git Bash', gitBash ?? null, ['--login', '-i']);
    const wsl = join(root, 'System32', 'wsl.exe');
    add('wsl', 'WSL', exists(wsl) ? wsl : null);
    return out;
  }
  const login = env['SHELL'];
  if (login && exists(login)) add(basename(login), basename(login), login, ['-l']);
  for (const [id, path] of [
    ['zsh', '/bin/zsh'],
    ['bash', '/bin/bash'],
    ['bash', '/usr/bin/bash'],
    ['fish', '/usr/bin/fish'],
    ['sh', '/bin/sh'],
  ] as const) {
    if (exists(path)) add(id, id, path, id === 'sh' ? [] : ['-l']);
  }
  return out;
}

/** `env` with `dir` first on PATH (whatever case the platform spells the variable). */
export function withPath(env: NodeJS.ProcessEnv, dir: string | null): NodeJS.ProcessEnv {
  if (!dir) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: `${dir}${delimiter}${env[key] ?? ''}` };
}
