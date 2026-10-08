import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgent, getTask, registerAgent } from '@command-center/core';
import { slugAgentId } from '../src/session';
import { connect, type Harness } from './harness';

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

const idWhere = (where: string): string =>
  (
    h.db.prepare(`SELECT id FROM subtasks WHERE ${where} ORDER BY id LIMIT 1`).get() as {
      id: string;
    }
  ).id;

describe('errors are actionable and never crash the server', () => {
  it('illegal transitions name the tool to call next, per current status', async () => {
    const todo = idWhere("status='todo' AND depends_on='[]'");
    const inProgress = idWhere("status='in_progress'");
    const review = idWhere("status='review'");
    const blocked = idWhere("status='blocked'");
    const done = idWhere("status='done'");
    const cases: [string, string, RegExp][] = [
      ['complete_task', todo, /start_task/],
      ['approve_task', inProgress, /complete_task/],
      ['start_task', review, /approve_task|reject_task/],
      ['start_task', blocked, /unblock_task/],
      ['start_task', done, /reset_task/],
    ];
    for (const [tool, id, hint] of cases) {
      const r = await h.call(tool, { task_id: id });
      expect(r.isError, `${tool} ${id}`).toBe(true);
      expect(r.text).toMatch(hint);
      expect(r.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
    }
    expect(getTask(h.db, todo)?.status).toBe('todo'); // nothing changed
  });

  it('unmet dependencies point at force=true, and force works', async () => {
    const id = idWhere("status='todo' AND depends_on != '[]' AND id = 'TASK-037'");
    const blockedStart = await h.call('start_task', { task_id: id });
    expect(blockedStart.isError).toBe(true);
    expect(blockedStart.text).toMatch(/TASK-036/);
    expect(blockedStart.text).toMatch(/force=true/);
    expect((await h.call('start_task', { task_id: id, force: true })).json()).toMatchObject({
      status: 'in_progress',
    });
  });

  it('unknown ids point at the listing tools', async () => {
    expect((await h.call('get_task_summary', { task_id: 'NOPE' })).text).toMatch(/list_tasks/);
    expect((await h.call('start_task', { task_id: 'NOPE' })).text).toMatch(/list_tasks/);
    expect((await h.call('get_milestone_overview', { milestone_id: 'NOPE' })).text).toMatch(
      /get_milestone_overview/,
    );
    expect((await h.call('add_milestone_task', { milestone_id: 'NOPE', label: 'x' })).text).toMatch(
      /get_milestone_overview/,
    );
    expect(
      (await h.call('update_task', { task_id: idWhere("status='todo'"), assignee: 'ghost' })).text,
    ).toMatch(/register_agent/);
  });

  it('bad input is reported, not thrown: missing/empty reason, unknown keys, bad enums, bad dates', async () => {
    const inProgress = idWhere("status='in_progress'");
    const review = idWhere("status='review'");
    expect((await h.call('block_task', { task_id: inProgress, reason: '' })).isError).toBe(true);
    expect((await h.call('reject_task', { task_id: review })).text).toMatch(/reason/i);

    const todo = idWhere("status='todo'");
    const strict = await h.call('update_task', { task_id: todo, status: 'done' });
    expect(strict.isError).toBe(true);
    expect(strict.text).toMatch(/status/);
    expect(getTask(h.db, todo)?.status).toBe('todo');

    expect((await h.call('list_tasks', { status: 'weird' })).isError).toBe(true);
    expect((await h.call('log_action', { action: 'Not Snake Case!' })).isError).toBe(true);
    expect(
      (await h.call('set_milestone_dates', { milestone_id: 'M1', planned_start: '2026-02-30' }))
        .isError,
    ).toBe(true);
    const order = await h.call('set_milestone_dates', {
      milestone_id: 'M1',
      planned_start: '2026-03-10',
      planned_end: '2026-03-01',
    });
    expect(order.isError).toBe(true);
    expect(order.text).toMatch(/planned_end is before planned_start/);
    expect((await h.call('update_drift', { milestone_id: 'M1', drift_days: 1.5 })).isError).toBe(
      true,
    );
    expect((await h.call('create_milestone', { title: 'x', dependencies: ['NOPE'] })).text).toMatch(
      /get_milestone_overview/,
    );
  });

  it('keeps serving after a burst of failures', async () => {
    for (let i = 0; i < 20; i++) await h.call('start_task', { task_id: 'NOPE' });
    await h.call('reject_task', { task_id: 'TASK-001' });
    const ok = await h.call('get_project_status');
    expect(ok.isError).toBe(false);
  });
});

describe('the caller cannot choose who they are', () => {
  it('rejects operator, system and human agents as agent_id, on every kind of write', async () => {
    registerAgent(h.db, { id: 'alice', name: 'Alice', type: 'human' });
    const todo = idWhere("status='todo' AND depends_on='[]'");
    const before = h.db.prepare('SELECT COUNT(*) n FROM agent_log').get();
    for (const who of ['operator', 'system', 'alice']) {
      for (const [tool, args] of [
        ['start_task', { task_id: todo }],
        ['log_action', { action: 'spoofed' }],
        ['update_task', { task_id: todo, priority: 'P0' }],
        ['create_milestone', { title: 'spoof' }],
        ['add_milestone_note', { milestone_id: 'M1', text: 'spoof' }],
      ] as const) {
        const r = await h.call(tool, { ...args, agent_id: who });
        expect(r.isError, `${tool} as ${who}`).toBe(true);
        expect(r.text).toMatch(/Omit agent_id/);
      }
    }
    expect(h.db.prepare('SELECT COUNT(*) n FROM agent_log').get()).toEqual(before); // nothing logged
    expect(getTask(h.db, todo)?.status).toBe('todo');
  });

  it('rejects an unregistered agent_id and points at register_agent', async () => {
    const r = await h.call('log_action', { action: 'x', agent_id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/register_agent/);
    expect(getAgent(h.db, 'ghost')).toBeNull();
  });

  it('register_agent cannot create or overwrite reserved or human identities', async () => {
    for (const id of ['operator', 'system']) {
      expect((await h.call('register_agent', { id, name: 'x', type: 'external' })).isError).toBe(
        true,
      );
    }
    expect(
      (await h.call('register_agent', { id: 'bob', name: 'Bob', type: 'human' })).isError,
    ).toBe(true); // type not offered
    expect(getAgent(h.db, 'operator')?.type).toBe('human');
  });

  it('a client calling itself "operator" gets a different identity, not the human’s', async () => {
    const spoof = await connect({ clientName: 'operator' });
    try {
      await spoof.call('log_action', { action: 'hello' });
      expect(getAgent(spoof.db, 'operator-agent')).toMatchObject({ type: 'orchestrator' });
      expect(spoof.db.prepare("SELECT agent_id FROM agent_log WHERE action='hello'").get()).toEqual(
        { agent_id: 'operator-agent' },
      );
    } finally {
      await spoof.close();
    }
  });

  it('a client whose name collides with a human agent does not take it over', async () => {
    const c = await connect({ clientName: 'Alice' });
    try {
      registerAgent(c.db, { id: 'alice', name: 'Alice', type: 'human' });
      await c.call('log_action', { action: 'hello' });
      expect(c.db.prepare("SELECT agent_id FROM agent_log WHERE action='hello'").get()).toEqual({
        agent_id: 'alice-agent',
      });
      expect(getAgent(c.db, 'alice')?.type).toBe('human');
    } finally {
      await c.close();
    }
  });
});

describe('session identity', () => {
  it('derives the agent from the client name and registers it once', async () => {
    const c = await connect({ clientName: 'Fresh Agent' });
    try {
      await c.call('log_action', { action: 'a' });
      await c.call('log_action', { action: 'b' });
      expect(c.db.prepare("SELECT COUNT(*) n FROM agents WHERE id = 'fresh-agent'").get()).toEqual({
        n: 1,
      });
      expect(
        c.db
          .prepare(
            "SELECT COUNT(*) n FROM agent_log WHERE agent_id='fresh-agent' AND action='agent_registered'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(getAgent(c.db, 'fresh-agent')).toMatchObject({
        name: 'Fresh Agent',
        type: 'orchestrator',
        session_action_count: 3,
      });
    } finally {
      await c.close();
    }
  });

  it('honours COMMAND_CENTER_AGENT_* overrides', async () => {
    const c = await connect({
      env: {
        COMMAND_CENTER_AGENT_ID: 'builder-1',
        COMMAND_CENTER_AGENT_NAME: 'Builder One',
        COMMAND_CENTER_AGENT_MODEL: 'claude-sonnet-5-5',
        COMMAND_CENTER_AGENT_TYPE: 'external',
      },
    });
    try {
      await c.call('log_action', { action: 'a' });
      expect(getAgent(c.db, 'builder-1')).toMatchObject({
        name: 'Builder One',
        type: 'external',
        source_model: 'claude-sonnet-5-5',
      });
    } finally {
      await c.close();
    }
  });

  it('slugAgentId produces valid, non-reserved ids', () => {
    expect(slugAgentId('Claude Code')).toBe('claude-code');
    expect(slugAgentId('  --Weird__Name!!  ')).toBe('weird__name');
    expect(slugAgentId(undefined)).toBe('mcp-agent');
    expect(slugAgentId('')).toBe('mcp-agent');
    expect(slugAgentId('operator')).toBe('operator-agent');
    expect(slugAgentId('System')).toBe('system-agent');
    expect(slugAgentId('x'.repeat(100))).toHaveLength(48);
  });
});
