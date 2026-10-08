import { describe, expect, it, vi } from 'vitest';
import { detectShells } from '../src/main/shells';
import { terminalApi } from '../src/main/terminal-api';
import type { PtyManager } from '../src/main/pty';

// path.join yields the host's separators, so paths are compared with slashes normalised.
const norm = (p: string) => p.split('\\').join('/');
const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.map(norm).includes(norm(p));

describe('detectShells', () => {
  it('Windows: PowerShell first, then cmd; pwsh/Git Bash/WSL only when present', () => {
    const env = {
      SystemRoot: 'C:/Windows',
      ComSpec: 'C:/Windows/System32/cmd.exe',
      PATH: 'C:/tools',
      ProgramFiles: 'C:/Program Files',
    };
    const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    const plain = detectShells('win32', env, has(ps, env.ComSpec));
    expect(plain.map((s) => s.id)).toEqual(['powershell', 'cmd']);
    const full = detectShells(
      'win32',
      env,
      has(
        ps,
        env.ComSpec,
        'C:/tools/pwsh.exe',
        'C:/Program Files/Git/bin/bash.exe',
        'C:/Windows/System32/wsl.exe',
      ),
    );
    expect(full.map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'bash', 'wsl']);
    expect(full.find((s) => s.id === 'bash')?.args).toEqual(['--login', '-i']);
  });
  it('macOS/Linux: the login shell first, then the ones that exist, no duplicates', () => {
    const shells = detectShells(
      'linux',
      { SHELL: '/bin/zsh' },
      has('/bin/zsh', '/bin/bash', '/bin/sh'),
    );
    expect(shells.map((s) => s.id)).toEqual(['zsh', 'bash', 'sh']);
    expect(shells[0]?.args).toEqual(['-l']);
  });
  it('returns nothing when no shell exists', () => {
    expect(detectShells('linux', {}, () => false)).toEqual([]);
  });
});

describe('terminal IPC validation', () => {
  const fake = () => {
    const pty = {
      listShells: vi.fn(() => [
        { id: 'powershell', name: 'PowerShell', file: 'C:/secret/path.exe', args: [] },
      ]),
      create: vi.fn(() => ({
        id: 'term-1',
        pid: 1,
        shellId: 'powershell',
        name: 'PowerShell',
        cwd: 'C:/p',
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    return { pty, api: terminalApi(pty as unknown as PtyManager) };
  };
  it('never exposes executable paths to the renderer', () => {
    const { api } = fake();
    expect(api.shells()).toEqual([{ id: 'powershell', name: 'PowerShell' }]);
  });
  it('rejects bad create requests and passes good ones', () => {
    const { api, pty } = fake();
    expect(api.create({ cols: 1e9, rows: 24 }).ok).toBe(false);
    expect(api.create({ cols: 80, rows: -1 }).ok).toBe(false);
    expect(api.create({ shellId: 'x'.repeat(100), cols: 80, rows: 24 }).ok).toBe(false);
    expect(pty.create).not.toHaveBeenCalled();
    expect(api.create({ shellId: 'powershell', cols: 80, rows: 24 }).ok).toBe(true);
    expect(pty.create).toHaveBeenCalledWith('powershell', 80, 24);
  });
  it('ignores malformed session ids and non-string writes', () => {
    const { api, pty } = fake();
    api.write('../etc', 'x');
    api.write('term-1', 42);
    api.resize('nope', 80, 24);
    api.resize('term-1', '80', 24);
    api.kill({});
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
    api.write('term-1', 'ls\r');
    api.resize('term-1', 100, 30);
    api.kill('term-1');
    expect(pty.write).toHaveBeenCalledWith('term-1', 'ls\r');
    expect(pty.resize).toHaveBeenCalledWith('term-1', 100, 30);
    expect(pty.kill).toHaveBeenCalledWith('term-1');
  });
});
