import { runProcess } from './spawn';
import {
  capText,
  ProviderError,
  type ProviderAdapter,
  type ProviderEnv,
  type ProviderRunInput,
  type ProviderRunResult,
} from './types';
import { num } from './http';

// `claude -p` (Claude Code in non-interactive mode) as a child process in the project folder, prompt on stdin.
// `--output-format json` returns the answer together with exact token usage and the cost Claude Code computed.

const EDIT_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(npm run *)',
  'Bash(git status)',
  'Bash(git diff *)',
];
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * Forbidding one shell tool forbids the family: on Windows Claude Code also has a `PowerShell` tool, and with only `Bash`
 * disallowed a run still executed shell commands (verified live with the real CLI, 2026-10-15).
 */
export function withShellFamily(tools: readonly string[]): string[] {
  const shell = (t: string) => /^(bash|powershell)(\(|$)/i.test(t.trim());
  const out = [...tools];
  if (tools.some(shell))
    for (const t of ['Bash', 'PowerShell'])
      if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

/** The argument list for one run (exported so tests pin it). The prompt travels on stdin, never in the arguments. */
export function claudeCodeArgs(
  input: Pick<ProviderRunInput, 'model' | 'allowEdits' | 'disallowedTools'>,
): string[] {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (input.model) args.push('--model', input.model);
  if (input.allowEdits)
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', ...EDIT_TOOLS);
  else args.push('--tools', ...READ_ONLY_TOOLS);
  if (input.disallowedTools?.length)
    args.push('--disallowedTools', ...withShellFamily(input.disallowedTools));
  return args;
}

export function claudeCodeAdapter(env: ProviderEnv): ProviderAdapter {
  const adapter: ProviderAdapter = {
    id: 'claude-code',
    label: 'Claude Code (CLI)',
    kind: 'cli',
    needsKey: false,
    defaultModel: null,
    detect() {
      const bin = env.findBinary('claude');
      return Promise.resolve(
        bin
          ? { available: true, detail: `claude found: ${bin}` }
          : {
              available: false,
              detail: '`claude` was not found. Install Claude Code or set COMMAND_CENTER_CLAUDE.',
            },
      );
    },
    async test(signal) {
      try {
        const r = await adapter.run({
          prompt: 'Reply with the single word ok.',
          workdir: process.cwd(),
          model: null,
          timeoutMs: 60_000,
          signal,
          maxOutputChars: 2000,
        });
        return { ok: true, detail: `Replied "${r.output.trim().slice(0, 40)}"` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    async run(input): Promise<ProviderRunResult> {
      const bin = env.findBinary('claude');
      if (!bin) throw new ProviderError('not_available', 'The `claude` CLI was not found.');
      const prompt = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;
      const p = await runProcess(bin, claudeCodeArgs(input), input, prompt);
      if (p.code !== 0)
        throw new ProviderError(
          'failed',
          `claude exited with code ${p.code}: ${(p.stderr || p.stdout).trim().slice(0, 500)}`,
          p.code,
        );
      let parsed: Record<string, unknown> | null = null;
      try {
        const j: unknown = JSON.parse(p.stdout);
        if (j && typeof j === 'object') parsed = j as Record<string, unknown>;
      } catch {
        /* plain text: keep it as the output, with no usage */
      }
      if (!parsed) {
        const c = capText(p.stdout.trim(), input.maxOutputChars);
        return {
          output: c.text,
          truncated: c.truncated || p.truncated,
          exitCode: p.code,
          usage: { inputTokens: null, outputTokens: null, costUsd: null },
        };
      }
      const result = typeof parsed['result'] === 'string' ? parsed['result'] : '';
      if (parsed['is_error'] === true)
        throw new ProviderError(
          'failed',
          result.trim().slice(0, 500) || 'claude reported an error.',
          p.code,
        );
      const u = (parsed['usage'] ?? {}) as Record<string, unknown>;
      const inTok =
        (num(u['input_tokens']) ?? 0) +
        (num(u['cache_creation_input_tokens']) ?? 0) +
        (num(u['cache_read_input_tokens']) ?? 0);
      const c = capText(result.trim(), input.maxOutputChars);
      input.onChunk?.(c.text);
      return {
        output: c.text,
        truncated: c.truncated,
        exitCode: p.code,
        usage: {
          inputTokens: num(u['input_tokens']) === null ? null : inTok,
          outputTokens: num(u['output_tokens']),
          costUsd: num(parsed['total_cost_usd']),
        },
      };
    },
  };
  return adapter;
}
