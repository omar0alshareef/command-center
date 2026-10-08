import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.claude',
  '.supervisor',
  'release',
]);
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml|toml|sql|sh|ps1|py|rs|go|java|txt)$/i;
const MAX_FILE = 200 * 1024;

const STOP_WORDS = new Set(
  'the and for with from this that into than then via per new add make use using get set run are its'.split(
    ' ',
  ),
);

/** Lower-case words (3+ letters) from free text, without filler and duplicates. */
export function keywords(...texts: string[]): string[] {
  const words = texts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

export interface FileHit {
  path: string;
  score: number;
  matched: string[];
}

function* walk(root: string, dir = root, depth = 0): Generator<string> {
  if (depth > 8) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, join(dir, e.name), depth + 1);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) yield join(dir, e.name);
  }
}

/** Project files ranked by how many task keywords appear in their path (weighted) and contents. */
export function findRelevantFiles(root: string, words: readonly string[], limit = 8): FileHit[] {
  const hits: FileHit[] = [];
  let scanned = 0;
  for (const abs of walk(root)) {
    if (++scanned > 4000) break;
    const rel = relative(root, abs).split(sep).join('/');
    const lowerPath = rel.toLowerCase();
    const matched = new Set<string>();
    let score = 0;
    for (const w of words) {
      if (lowerPath.includes(w)) {
        score += 3;
        matched.add(w);
      }
    }
    try {
      if (statSync(abs).size <= MAX_FILE) {
        const text = readFileSync(abs, 'utf8').toLowerCase();
        for (const w of words) {
          if (text.includes(w) && !matched.has(w)) {
            score += 1;
            matched.add(w);
          }
        }
      }
    } catch {
      /* unreadable file: ignore */
    }
    if (score > 0) hits.push({ path: rel, score, matched: [...matched] });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['API key (sk-...)', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  [
    'hard-coded credential',
    /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  ],
];

export interface Finding {
  file: string;
  line: number;
  kind: string;
  /** The matched text with its middle masked: findings are logged, so they must not repeat the secret. */
  sample: string;
}

const mask = (s: string) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`);

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.length > 2000) return;
    for (const [kind, re] of SECRET_PATTERNS) {
      const m = re.exec(line);
      if (m) out.push({ file, line: i + 1, kind, sample: mask(m[0]) });
    }
  });
  return out;
}

/** Files this task touched: its context files plus whatever git reports as changed (when the folder is a repo). */
export function filesToScan(root: string, contextFiles: readonly string[]): string[] {
  const files = new Set<string>();
  const base = resolve(root);
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  for (const f of contextFiles) {
    const abs = resolve(base, f);
    if (abs.startsWith(base) && existsSync(abs) && isFile(abs))
      files.add(relative(base, abs).split(sep).join('/'));
  }
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: base, encoding: 'utf8' });
  if (git.status === 0) {
    for (const line of git.stdout.split('\n')) {
      const p = line.slice(3).trim().replace(/^"|"$/g, '');
      if (p && isFile(join(base, p))) files.add(p);
    }
  }
  return [...files].slice(0, 200);
}

export function scanFiles(root: string, files: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const abs = join(root, f);
    try {
      if (statSync(abs).size > 512 * 1024) continue;
      out.push(...scanText(f, readFileSync(abs, 'utf8')));
    } catch {
      /* unreadable file: ignore */
    }
  }
  return out;
}

export const findingText = (f: Finding): string => `${f.file}:${f.line} ${f.kind} (${f.sample})`;
