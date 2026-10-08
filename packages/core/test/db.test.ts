import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataVersion, openDb } from '../src/db';
import { logAction } from '../src/queries';
import { transition } from '../src/state-machine';
import { addTask, tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

describe('openDb', () => {
  it('applies migrations 1 and 2, sets pragmas, seeds project and built-in agents', () => {
    const versions = t.db.prepare('SELECT version FROM schema_version ORDER BY version').all();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
    expect(t.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(t.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(t.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(t.db.prepare('SELECT COUNT(*) n FROM project').get()).toEqual({ n: 1 });
    expect(t.db.prepare('SELECT id FROM agents ORDER BY id').all()).toEqual([
      { id: 'operator' },
      { id: 'system' },
    ]);
  });

  it('is idempotent: reopening does not re-run migrations', () => {
    const again = openDb(t.root);
    expect(again.prepare('SELECT COUNT(*) n FROM schema_version').get()).toEqual({ n: 2 });
    expect(again.prepare('SELECT COUNT(*) n FROM agents').get()).toEqual({ n: 2 });
    again.close();
  });

  it('enforces the status CHECK constraint', () => {
    expect(() => addTask(t.db, 'T1', 'bogus' as never)).toThrow();
  });
});

describe('dataVersion', () => {
  it('changes when another connection commits', () => {
    const other = openDb(t.root);
    const before = dataVersion(t.db);
    logAction(other, { agentId: 'system', action: 'ping' });
    expect(dataVersion(t.db)).not.toBe(before);
    other.close();
  });
});

describe('concurrent writers', () => {
  it('three processes writing the same DB never hit SQLITE_BUSY', async () => {
    const writer = fileURLToPath(new URL('./fixtures/writer.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const ITER = 100;
    addTask(t.db, 'T-a');
    addTask(t.db, 'T-b');
    addTask(t.db, 'T-main');

    const children = ['a', 'b'].map((name) =>
      spawn(process.execPath, ['--import', 'tsx', writer, t.root, name, String(ITER)], { cwd }),
    );
    const errors: string[] = [];
    for (const c of children) c.stderr.on('data', (d: Buffer) => errors.push(d.toString()));
    const exits = children.map((c) => once(c, 'exit'));
    await Promise.all(children.map((c) => waitFor(c, 'ready')));

    for (const c of children) c.stdin.write('go\n');
    for (let i = 0; i < ITER; i++) {
      logAction(t.db, { agentId: 'system', action: 'stress', description: `main-${i}` });
      transition(t.db, 'T-main', 'start');
      transition(t.db, 'T-main', 'reset');
    }

    const codes = (await Promise.all(exits)).map(([code]) => code);
    expect({ codes, stderr: errors.join('') }).toEqual({ codes: [0, 0], stderr: '' });
    expect(t.db.prepare("SELECT COUNT(*) n FROM agent_log WHERE action = 'stress'").get()).toEqual({
      n: 3 * ITER,
    });
    expect(t.db.prepare('SELECT COUNT(*) n FROM agent_log').get()).toEqual({ n: 3 * ITER * 3 });
  }, 60_000);
});

function waitFor(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => d.toString().includes(text) && resolve());
    child.once('exit', (code) => reject(new Error(`writer exited early with code ${code}`)));
  });
}
