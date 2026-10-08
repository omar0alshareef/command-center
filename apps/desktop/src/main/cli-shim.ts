import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The operator CLI bundle next to the app (`npm run build -w packages/cli`), or null when it is not built. */
export function cliBundle(): string | null {
  const bundle = resolve(app.getAppPath(), '../../packages/cli/dist/index.js');
  return existsSync(bundle) ? bundle : null;
}

let shimDir: string | null | undefined;

/**
 * A folder holding a `command-center` launcher that runs the bundled CLI with this app's own runtime
 * (Electron as plain node), so the Terminal tab finds the command without a global install or a node on PATH.
 */
export function ensureShimDir(): string | null {
  if (shimDir !== undefined) return shimDir;
  const bundle = cliBundle();
  if (!bundle) return (shimDir = null);
  try {
    const dir = join(app.getPath('userData'), 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'command-center.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${bundle}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
    const sh = join(dir, 'command-center');
    writeFileSync(
      sh,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${bundle}" "$@"\n`,
    );
    chmodSync(sh, 0o755);
    return (shimDir = dir);
  } catch {
    return (shimDir = null);
  }
}
