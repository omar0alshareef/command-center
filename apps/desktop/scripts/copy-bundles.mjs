// Copies the MCP server and operator CLI bundles into out/bundles so a packaged app ships them.
// Always rebuilds them first (esbuild, a second or two), so a stale dist can never ship. usage: node scripts/copy-bundles.mjs (run from apps/desktop)
import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = join(here, '..', 'out', 'bundles');
mkdirSync(out, { recursive: true });

for (const [pkg, name] of [
  ['mcp-server', 'mcp.mjs'],
  ['cli', 'cli.mjs'],
]) {
  const src = join(repo, 'packages', pkg, 'dist', 'index.js');
  const r = spawnSync(`npm run build -w packages/${pkg}`, {
    cwd: repo,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  copyFileSync(src, join(out, name));
  console.log(`bundled ${pkg} -> out/bundles/${name}`);
}
