import { z } from 'zod';
import type { Result, ShellInfo, TerminalSessionInfo } from '../shared/ipc';
import type { PtyManager } from './pty';
import { run } from './task-api';

const Create = z.object({
  shellId: z.string().min(1).max(40).optional(),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
});
const Id = z.string().regex(/^term-\d+$/);

/**
 * Terminal IPC. By design the renderer can run commands in a shell the user is looking at, but it can only
 * pick a detected shell by id; it never names an executable, and every argument is validated.
 */
export function terminalApi(pty: PtyManager) {
  return {
    shells: (): ShellInfo[] => pty.listShells().map((s) => ({ id: s.id, name: s.name })),
    create: (req: unknown): Result<TerminalSessionInfo> =>
      run(() => {
        const r = Create.parse(req);
        return pty.create(r.shellId, r.cols, r.rows);
      }),
    write: (id: unknown, data: unknown) => {
      const i = Id.safeParse(id);
      if (i.success && typeof data === 'string') pty.write(i.data, data);
    },
    resize: (id: unknown, cols: unknown, rows: unknown) => {
      const i = Id.safeParse(id);
      if (i.success && typeof cols === 'number' && typeof rows === 'number')
        pty.resize(i.data, cols, rows);
    },
    kill: (id: unknown) => {
      const i = Id.safeParse(id);
      if (i.success) pty.kill(i.data);
    },
  };
}
