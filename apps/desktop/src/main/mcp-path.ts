import { app } from 'electron';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpLaunch } from '../shared/ipc';

/**
 * Where the MCP server bundle lives relative to the app. In the monorepo it is
 * packages/mcp-server/dist/index.js (build it with `npm run build -w packages/mcp-server`); packaged
 * installs (M12) will ship it with the app. Otherwise assume `command-center-mcp` is on PATH.
 */
export function mcpLaunch(): McpLaunch {
  const bundle = resolve(app.getAppPath(), '../../packages/mcp-server/dist/index.js');
  return existsSync(bundle)
    ? { command: 'node', args: [bundle], bundled: true }
    : { command: 'command-center-mcp', args: [], bundled: false };
}
