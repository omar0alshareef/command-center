import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { InvalidInputError } from './errors';

// Automatic prevention checks (D40). A lesson with check_type `automatic` carries one line in this small, safe syntax; the
// audit runs it when a task reaches Review. There is no free-form shell: a check can look at files and run one of the
// project's own `npm run` scripts, nothing else.
//
//   file-exists <path>            the file or folder exists (path relative to the project folder)
//   file-missing <path>           it does not exist
//   no-match <glob> /<regex>/     no file matching the glob contains the pattern
//   must-match <glob> /<regex>/   at least one file matching the glob contains the pattern
//   command npm run <script>      the project script exits 0

export type ParsedCheck =
  | { kind: 'file-exists' | 'file-missing'; path: string }
  | { kind: 'no-match' | 'must-match'; glob: string; pattern: string; flags: string }
  | { kind: 'command'; script: string };

export const CHECK_SYNTAX = [
  'file-exists <path>',
  'file-missing <path>',
  'no-match <glob> /<regex>/[flags imsu]',
  'must-match <glob> /<regex>/[flags imsu]',
  'command npm run <script>',
].join('  |  ');

const bad = (why: string) =>
  new InvalidInputError(`Automatic check not understood (${why}). Use one of: ${CHECK_SYNTAX}`);

export function parseCheck(text: string): ParsedCheck {
  const t = text.trim();
  let m = /^(file-exists|file-missing)\s+(\S.*)$/i.exec(t);
  if (m) {
    const path = (m[2] ?? '').trim();
    if (/^([a-zA-Z]:|[\\/])/.test(path) || path.split(/[\\/]/).includes('..'))
      throw bad('the path must be inside the project folder');
    return { kind: (m[1] ?? '').toLowerCase() as 'file-exists' | 'file-missing', path };
  }
  m = /^(no-match|must-match)\s+(\S+)\s+\/(.+)\/([imsu]*)$/i.exec(t);
  if (m) {
    const pattern = m[3] ?? '';
    const flags = m[4] ?? '';
    try {
      new RegExp(pattern, flags);
    } catch {
      throw bad('the regular expression is not valid');
    }
    return {
      kind: (m[1] ?? '').toLowerCase() as 'no-match' | 'must-match',
      glob: m[2] ?? '',
      pattern,
      flags,
    };
  }
  m = /^command\s+npm\s+run\s+([A-Za-z0-9:_-]+)$/i.exec(t);
  if (m) return { kind: 'command', script: m[1] ?? '' };
  throw bad(t ? 'unknown form' : 'empty');
}

/** Throws InvalidInputError (with the accepted forms) when the text is not a valid automatic check. */
export function validateCheck(text: string): void {
  parseCheck(text);
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'dist',
  'out',
  'release',
  'build',
  '.next',
  'coverage',
]);
const MAX_FILES = 5000;
const MAX_BYTES = 1_000_000;

function globToRegex(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*' && g[i + 1] === '*') {
      re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += g[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Files under `root` whose relative path matches the glob (skipping dependency and build folders; capped). */
export function globFiles(root: string, glob: string): string[] {
  const rx = globToRegex(glob);
  const out: string[] = [];
  const seen = { n: 0 };
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (seen.n >= MAX_FILES) return;
      const abs = join(dir, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs);
      } else {
        seen.n++;
        const rel = relative(root, abs).replace(/\\/g, '/');
        if (rx.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

export interface CheckResult {
  passed: boolean;
  detail: string;
}

/** Run one parsed check in the project folder. A script that cannot start counts as a failure with the reason. */
export function runCheck(
  root: string,
  check: ParsedCheck,
  o: { timeoutMs?: number } = {},
): CheckResult {
  switch (check.kind) {
    case 'file-exists': {
      const ok = existsSync(resolve(root, check.path));
      return { passed: ok, detail: ok ? `${check.path} exists` : `${check.path} does not exist` };
    }
    case 'file-missing': {
      const ok = !existsSync(resolve(root, check.path));
      return {
        passed: ok,
        detail: ok ? `${check.path} is absent` : `${check.path} exists but must not`,
      };
    }
    case 'no-match':
    case 'must-match': {
      const rx = new RegExp(check.pattern, check.flags);
      const hits: string[] = [];
      const files = globFiles(root, check.glob);
      for (const f of files) {
        try {
          const abs = join(root, f);
          if (statSync(abs).size > MAX_BYTES) continue;
          if (rx.test(readFileSync(abs, 'utf8'))) hits.push(f);
        } catch {
          /* unreadable file: skip */
        }
      }
      if (check.kind === 'no-match')
        return hits.length === 0
          ? { passed: true, detail: `no file matching ${check.glob} contains /${check.pattern}/` }
          : {
              passed: false,
              detail: `/${check.pattern}/ found in ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}`,
            };
      return hits.length > 0
        ? { passed: true, detail: `/${check.pattern}/ found in ${hits[0]}` }
        : {
            passed: false,
            detail: `no file matching ${check.glob} contains /${check.pattern}/ (${files.length} files looked at)`,
          };
    }
    case 'command': {
      const r = spawnSync('npm', ['run', check.script], {
        cwd: root,
        encoding: 'utf8',
        timeout: o.timeoutMs ?? 120_000,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      if (r.error)
        return {
          passed: false,
          detail: `npm run ${check.script} could not run: ${r.error.message}`,
        };
      return r.status === 0
        ? { passed: true, detail: `npm run ${check.script} passed` }
        : {
            passed: false,
            detail: `npm run ${check.script} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-200)}`,
          };
    }
  }
}
