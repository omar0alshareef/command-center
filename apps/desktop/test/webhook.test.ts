import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMilestone, createTask, getTask, openDb, type Db } from '@command-center/core';
import {
  getWebhookToken,
  handleWebhook,
  regenerateWebhookToken,
  WebhookServer,
} from '../src/main/webhook';

let root: string;
let db: Db;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-hook-'));
  db = openDb(root);
  createMilestone(db, { id: 'M1', title: 'Milestone' } as never, 'operator');
  createTask(db, { milestoneId: 'M1', label: 'First' });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const call = (path: string, body: unknown, over: Record<string, unknown> = {}) =>
  handleWebhook(db, {
    method: 'POST',
    path,
    headers: { host: '127.0.0.1:38120', authorization: `Bearer ${getWebhookToken(db)}` },
    remote: '127.0.0.1',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...over,
  });
const status = (id: string) => getTask(db, id)?.status;

describe('handleWebhook', () => {
  it('moves a task through the workflow, logging as the webhook agent', () => {
    expect(
      call('/webhook/task-update', { task_id: 'TASK-001', status: 'in_progress' }).status,
    ).toBe(200);
    expect(status('TASK-001')).toBe('in_progress');
    call('/webhook/task-update', { task_id: 'TASK-001', status: 'review', summary: 'PR opened' });
    expect(status('TASK-001')).toBe('review');
    call('/webhook/task-update', { task_id: 'TASK-001', status: 'done', completed_by: 'github' });
    const t = getTask(db, 'TASK-001');
    expect(t?.status).toBe('done');
    expect(db.prepare("SELECT type FROM agents WHERE id = 'github'").get()).toEqual({
      type: 'external',
    });
  });

  it('allows todo -> done (PR merge) and is a no-op for the same status', () => {
    expect(call('/webhook/task-update', { task_id: 'TASK-001', status: 'done' }).status).toBe(200);
    expect(status('TASK-001')).toBe('done');
    expect(call('/webhook/task-update', { task_id: 'TASK-001', status: 'done' }).status).toBe(200);
  });

  it('rejects bad input with 400, unknown task 404, illegal move 409', () => {
    expect(call('/webhook/task-update', { task_id: 'TASK-001', status: 'finished' }).status).toBe(
      400,
    );
    expect(call('/webhook/task-update', { task_id: 'TASK-001', status: 'done', x: 1 }).status).toBe(
      400,
    );
    expect(call('/webhook/task-update', 'not json').status).toBe(400);
    expect(call('/webhook/task-update', { task_id: 'TASK-999', status: 'done' }).status).toBe(404);
    expect(call('/webhook/task-update', { task_id: 'TASK-001', status: 'blocked' }).status).toBe(
      400,
    ); // reason
    expect(
      call('/webhook/task-update', { task_id: 'TASK-001', status: 'blocked', reason: 'waiting' })
        .status,
    ).toBe(200);
    expect(call('/webhook/task-update', { task_id: 'TASK-001', status: 'review' }).status).toBe(
      409,
    );
    expect(call('/webhook/nope', {}).status).toBe(404);
  });

  it('updates milestone dates and logs agent actions', () => {
    const m = call('/webhook/milestone-update', { milestone_id: 'M1', actual_end: '2026-10-08' });
    expect(m.status).toBe(200);
    expect(
      call('/webhook/milestone-update', { milestone_id: 'M1', actual_end: 'soon' }).status,
    ).toBe(400);
    expect(
      call('/webhook/milestone-update', { milestone_id: 'M9', actual_end: '2026-10-08' }).status,
    ).toBe(404);
    const a = call('/webhook/agent-action', {
      agent_id: 'git-hook',
      action: 'commit',
      description: 'abc123 fix',
    });
    expect(a.status).toBe(200);
    expect(db.prepare("SELECT action FROM agent_log WHERE agent_id = 'git-hook' AND action = 'commit'").get()).toEqual({
      action: 'commit',
    });
  });

  it('enforces token, loopback and Host', () => {
    const noAuth = { headers: { host: 'localhost:38120' } };
    expect(call('/webhook/status', '', noAuth).status).toBe(401);
    expect(
      call('/webhook/status', '', { headers: { host: 'localhost', authorization: 'Bearer wrong' } })
        .status,
    ).toBe(401);
    expect(call('/webhook/status', '', { remote: '192.168.1.5' }).status).toBe(403);
    expect(call('/webhook/status', '', { remote: undefined }).status).toBe(403);
    expect(
      call('/webhook/status', '', {
        headers: { host: 'evil.example', authorization: `Bearer ${getWebhookToken(db)}` },
      }).status,
    ).toBe(403);
    expect(call('/webhook/status', '', { method: 'GET' }).status).toBe(200);
  });

  it('regenerating the token invalidates the old one', () => {
    const old = getWebhookToken(db);
    const fresh = regenerateWebhookToken(db);
    expect(fresh).not.toBe(old);
    const headers = { host: 'localhost', authorization: `Bearer ${old}` };
    expect(call('/webhook/status', '', { method: 'GET', headers }).status).toBe(401);
  });
});

describe('WebhookServer (real socket)', () => {
  it('curl-style flow: 401 without token, 200 with, 400 on bad status, bound to loopback', async () => {
    const port = 38999;
    const server = new WebhookServer(() => db, port);
    server.start();
    await new Promise((r) => setTimeout(r, 100));
    try {
      expect(server.status().running).toBe(true);
      const token = server.status().token ?? '';
      const url = `http://127.0.0.1:${port}/webhook/task-update`;
      const send = (status: string, token?: string) =>
        fetch(url, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: JSON.stringify({ task_id: 'TASK-001', status }),
        });
      expect((await send('in_progress')).status).toBe(401);
      expect((await send('bogus', token)).status).toBe(400);
      expect((await send('in_progress', token)).status).toBe(200);
      expect(status('TASK-001')).toBe('in_progress');
      const big = await fetch(url, { method: 'POST', body: 'x'.repeat(70_000) });
      expect(big.status).toBe(413);
    } finally {
      server.stop();
    }
  });
});
