import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { McpLaunch } from '../shared/ipc';

/**
 * Where the MCP server bundle lives. Packaged installs ship it inside the app (out/bundles, copied by
 * `npm run bundles -w apps/desktop`) and run it with the app's own Electron as plain node, so no Node
 * install is needed. In the monorepo it is packages/mcp-server/dist/index.js. Otherwise assume
 * `command-center-mcp` is on PATH.
 */
export function mcpLaunch(): McpLaunch {
  if (app.isPackaged) {
    const bundle = join(app.getAppPath(), 'out', 'bundles', 'mcp.mjs');
    if (existsSync(bundle))
      return {
        command: process.execPath,
        args: [bundle],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        bundled: true,
      };
  }
  const bundle = resolve(app.getAppPath(), '../../packages/mcp-server/dist/index.js');
  return existsSync(bundle)
    ? { command: 'node', args: [bundle], bundled: true }
    : { command: 'command-center-mcp', args: [], bundled: false };
}
