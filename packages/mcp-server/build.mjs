// Bundles the server (and @command-center/core, zod, the MCP SDK) into one file. Only the native
// better-sqlite3 stays external; it is this package's one runtime dependency.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  legalComments: 'none',
  banner: {
    js: [
      '#!/usr/bin/env node',
      // Some bundled CommonJS dependencies call require().
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
