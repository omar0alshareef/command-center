import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaude } from '@command-center/core';
import type { Runner, StageRequest, StageResult } from './runner';

export { findClaude };

// Runner v1: shell out to the Claude Code CLI in non-interactive mode (`claude -p`). The prompt goes in on stdin
// (long prompts do not fit a Windows command line); the stage's system prompt is appended to Claude's own.

const READ_ONLY = ['Read', 'Grep', 'Glob'];
const BUILD_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(npm run *)',
  'Bash(git status)',
  'Bash(git diff *)',
];

/** The argument list for one stage (exported so tests can pin it). The system prompt travels in a file, not on the command line. */
export function claudeArgs(
  req: Pick<StageRequest, 'stage'> & { systemFile: string },
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const builder = req.stage.id === 'builder';
  const args = [
    '-p',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--append-system-prompt-file',
    req.systemFile,
  ];
  if (builder) args.push('--permission-mode', 'acceptEdits', '--allowedTools', ...BUILD_TOOLS);
  else args.push('--tools', ...READ_ONLY);
  const model = env['COMMAND_CENTER_MODEL']?.trim();
  if (model) args.push('--model', model);
  return args;
}

export function claudeRunner(bin: string, timeoutMs = 15 * 60_000): Runner {
  return {
    name: 'claude',
    run(req: StageRequest): Promise<StageResult> {
      return new Promise((resolve) => {
        const dir = mkdtempSync(join(tmpdir(), 'cc-claude-'));
        const systemFile = join(dir, 'system.txt');
        writeFileSync(systemFile, req.system, 'utf8');
        const viaShell = bin.toLowerCase().endsWith('.cmd'); // npm's Windows wrapper needs cmd.exe
        const quote = (a: string) =>
          viaShell && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '')}"` : a;
        const child = spawn(
          viaShell ? quote(bin) : bin,
          claudeArgs({ stage: req.stage, systemFile }).map(quote),
          {
            cwd: req.root,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: viaShell,
          },
        );
        const done = (r: StageResult) => {
          clearTimeout(timer);
          rmSync(dir, { recursive: true, force: true });
          resolve(r);
        };
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill();
          done({
            ok: false,
            output: out,
            error: `Timed out after ${Math.round(timeoutMs / 60000)} minutes.`,
          });
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
        child.on('error', (e) => {
          done({ ok: false, output: '', error: `Could not run ${bin}: ${e.message}` });
        });
        child.on('close', (code) => {
          done(
            code === 0
              ? { ok: true, output: out.trim() }
              : {
                  ok: false,
                  output: out.trim(),
                  error: `claude exited with code ${code}: ${err.trim().slice(0, 500)}`,
                },
          );
        });
        child.stdin.end(req.prompt);
      });
    },
  };
}
