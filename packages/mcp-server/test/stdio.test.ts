import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTask, openDb } from '@command-center/core';
import { seedDb } from '../../core/src/seed';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

const launches = [
  ['TypeScript source (tsx)', ['--import', 'tsx', 'src/index.ts']],
  ['built bundle (dist/index.js)', ['dist/index.js']],
] as const;

beforeAll(() => {
  // The shipped artifact is the bundle, so build it and test it, not just the source.
  execFileSync(process.execPath, ['build.mjs'], { cwd: pkgDir, stdio: 'pipe' });
  expect(existsSync(join(pkgDir, 'dist/index.js'))).toBe(true);
}, 60_000);

const roots: string[] = [];
const freshRoot = (seed: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'cc-stdio-'));
  roots.push(root);
  const db = openDb(root);
  if (seed) seedDb(db, { now: new Date('2026-03-12T10:00:00Z') });
  db.close();
  return root;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3 });
});

describe.each(launches)('over real stdio: %s', (_name, args) => {
  it('lists 26 tools and runs start -> complete -> reject -> complete -> approve', async () => {
    const root = freshRoot(true);
    const open = async (name: string) => {
      const c = new Client({ name, version: '1.0.0' });
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [...args],
          cwd: pkgDir,
          env: { PROJECT_ROOT: root },
          stderr: 'pipe',
        }),
      );
      const callOn = async (tool: string, a: Record<string, unknown> = {}) => {
        const r = await c.callTool({ name: tool, arguments: a });
        return {
          isError: Boolean(r.isError),
          text: (r.content as { text: string }[])[0]?.text ?? '',
        };
      };
      return { client: c, call: callOn };
    };
    // Two separate server processes on one database: the builder, and an independent reviewer.
    const { client, call } = await open('stdio-client');
    const { client: reviewer, call: reviewCall } = await open('reviewer-client');
    try {
      expect((await client.listTools()).tools).toHaveLength(30);

      const list = JSON.parse((await call('list_tasks', { status: 'todo', limit: 1 })).text) as {
        tasks: { id: string }[];
      };
      const id = list.tasks[0]?.id ?? '';
      expect(id).toMatch(/^TASK-\d+$/);

      expect((await call('start_task', { task_id: id })).isError).toBe(false);
      expect((await call('complete_task', { task_id: id, summary: 'done once' })).isError).toBe(
        false,
      );
      expect(
        (await call('reject_task', { task_id: id, reason: 'Missing keyboard support' })).isError,
      ).toBe(false);
      expect(
        (await call('complete_task', { task_id: id, summary: 'added keyboard support' })).isError,
      ).toBe(false);
      expect((await call('approve_task', { task_id: id })).isError).toBe(true); // not your own work
      expect((await reviewCall('approve_task', { task_id: id })).isError).toBe(false);

      // An invalid move is an error result, and the server keeps working afterwards.
      const bad = await call('approve_task', { task_id: id });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/reset_task/); // already done: the state error comes first
      expect((await call('get_project_status')).isError).toBe(false);

      // Assert on the database itself, through an independent connection.
      const db = openDb(root);
      try {
        expect(getTask(db, id)).toMatchObject({ status: 'done', done: true });
        const log = db
          .prepare(
            "SELECT agent_id, action FROM agent_log WHERE target_id = ? AND agent_id = 'stdio-client' ORDER BY rowid",
          )
          .all(id);
        expect(log.map((r) => (r as { action: string }).action)).toEqual([
          'task_started',
          'task_completed',
          'task_rejected',
          'task_completed',
        ]);
        expect(
          db
            .prepare(
              "SELECT action FROM agent_log WHERE target_id = ? AND agent_id = 'reviewer-client'",
            )
            .all(id),
        ).toEqual([{ action: 'task_approved' }]);
        expect(
          db.prepare('SELECT rejection_reason FROM lessons_learned WHERE subtask_id = ?').all(id),
        ).toEqual([{ rejection_reason: 'Missing keyboard support' }]);
        expect(db.prepare("SELECT type, name FROM agents WHERE id = 'stdio-client'").get()).toEqual(
          { type: 'orchestrator', name: 'stdio-client' },
        );
      } finally {
        db.close();
      }
    } finally {
      await client.close();
      await reviewer.close();
    }
  }, 60_000);

  it('exits with a clear message and writes nothing to stdout when PROJECT_ROOT is missing', () => {
    const r = spawnSync(process.execPath, [...args], {
      cwd: pkgDir,
      env: { ...process.env, PROJECT_ROOT: '' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(''); // stdout is the protocol channel
    expect(r.stderr).toMatch(/PROJECT_ROOT is not set/);
  });

  it('refuses a folder without a database instead of silently creating one', () => {
    const empty = freshRoot(false);
    rmSync(join(empty, 'command-center.db'), { force: true });
    for (const f of readdirSync(empty)) rmSync(join(empty, f), { force: true });
    const r = spawnSync(process.execPath, [...args], {
      cwd: pkgDir,
      env: { ...process.env, PROJECT_ROOT: empty },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/No command-center\.db/);
    expect(readdirSync(empty)).toEqual([]);
  });
});
