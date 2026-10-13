import { spawn } from 'node:child_process';
import { killTree } from '../process';
import { ProviderError, type ProviderRunInput } from './types';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
}

/**
 * Run a CLI with the prompt on stdin (long prompts do not fit a Windows command line). Stdout is capped; a timeout or an
 * abort ends the whole process tree. Rejects with a ProviderError for timeout, cancel or a binary that cannot start.
 */
export function runProcess(
  bin: string,
  args: string[],
  input: Pick<ProviderRunInput, 'workdir' | 'timeoutMs' | 'signal' | 'maxOutputChars' | 'onChunk'>,
  stdin: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const viaShell = bin.toLowerCase().endsWith('.cmd'); // npm's Windows wrapper needs cmd.exe
    const quote = (a: string) =>
      viaShell && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '')}"` : a;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(quote(bin), args.map(quote), {
        cwd: input.workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: viaShell,
        windowsHide: true,
      });
    } catch (e) {
      reject(
        new ProviderError(
          'not_available',
          `Could not start ${bin}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const stop = () => killTree(child.pid, () => child.kill());
    const onAbort = () => {
      stop();
      finish(() => reject(new ProviderError('cancelled', 'Cancelled.')));
    };
    const timer = setTimeout(() => {
      stop();
      finish(() =>
        reject(
          new ProviderError('timeout', `Timed out after ${Math.round(input.timeoutMs / 1000)} s.`),
        ),
      );
    }, input.timeoutMs);
    if (input.signal.aborted) return onAbort();
    input.signal.addEventListener('abort', onAbort);
    child.stdout?.on('data', (d: Buffer) => {
      const room = input.maxOutputChars - stdout.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = d.toString('utf8');
      const kept = text.length > room ? text.slice(0, room) : text;
      if (kept.length < text.length) truncated = true;
      stdout += kept;
      input.onChunk?.(kept);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', (e) =>
      finish(() =>
        reject(new ProviderError('not_available', `Could not run ${bin}: ${e.message}`)),
      ),
    );
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code, truncated })));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });
}
