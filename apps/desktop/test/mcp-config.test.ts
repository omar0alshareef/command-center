import { describe, expect, it } from 'vitest';
import { buildMcpConfig } from '../src/renderer/lib/mcp-config';

describe('buildMcpConfig', () => {
  it('builds a valid config block that round-trips Windows paths', () => {
    const root = 'C:\\Users\\me\\My Project';
    const bundle = 'C:\\repo\\packages\\mcp-server\\dist\\index.js';
    const { json } = buildMcpConfig(root, { command: 'node', args: [bundle], bundled: true });
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        'command-center': { command: 'node', args: [bundle], env: { PROJECT_ROOT: root } },
      },
    });
  });

  it('builds a one-line claude mcp add command, quoting only what needs it', () => {
    const { cli } = buildMcpConfig('/home/me/proj', {
      command: 'node',
      args: ['/opt/cc/dist/index.js'],
      bundled: true,
    });
    expect(cli).toBe(
      'claude mcp add command-center --env PROJECT_ROOT=/home/me/proj -- node /opt/cc/dist/index.js',
    );

    const spaced = buildMcpConfig('C:\\Users\\me\\My Project', {
      command: 'node',
      args: ['C:\\cc\\dist\\index.js'],
      bundled: true,
    });
    expect(spaced.cli).toBe(
      'claude mcp add command-center --env "PROJECT_ROOT=C:\\Users\\me\\My Project" -- node "C:\\cc\\dist\\index.js"',
    );
  });

  it('falls back to the global command with no args', () => {
    const { json, cli } = buildMcpConfig('/p', {
      command: 'command-center-mcp',
      args: [],
      bundled: false,
    });
    expect(JSON.parse(json).mcpServers['command-center']).toEqual({
      command: 'command-center-mcp',
      env: { PROJECT_ROOT: '/p' },
    });
    expect(cli).toBe('claude mcp add command-center --env PROJECT_ROOT=/p -- command-center-mcp');
  });
});
