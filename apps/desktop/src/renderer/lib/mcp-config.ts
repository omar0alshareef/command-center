import type { McpLaunch } from '../../shared/ipc';

const SERVER_NAME = 'command-center';

/** Quote for a shell command line (works in PowerShell, cmd and POSIX shells for these values). */
const quote = (s: string): string => (/^[\w./:@=-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

export interface McpConfig {
  /** `.mcp.json` / client config block. */
  json: string;
  /** One-line Claude Code install command. */
  cli: string;
}

/** The two ways to connect an agent: a config block to paste, or one `claude mcp add` command. */
export function buildMcpConfig(projectRoot: string, launch: McpLaunch): McpConfig {
  const json = JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: launch.command,
          ...(launch.args.length ? { args: launch.args } : {}),
          env: { PROJECT_ROOT: projectRoot },
        },
      },
    },
    null,
    2,
  );
  // Command first, `-e` last, no `--`: PowerShell drops the `--` separator, which broke the old form.
  const cli = [
    'claude mcp add',
    SERVER_NAME,
    quote(launch.command),
    ...launch.args.map(quote),
    '-e',
    quote(`PROJECT_ROOT=${projectRoot}`),
  ].join(' ');
  return { json, cli };
}
