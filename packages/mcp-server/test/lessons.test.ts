import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type Harness } from './harness';

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

const file = () => join(h.root, '.claude', 'LESSONS_LEARNED.md');
const reviewer = () => h.another('reviewer-agent');

async function toReview(id: string, summary = 'built it') {
  expect((await h.call('start_task', { task_id: id })).isError).toBe(false);
  expect((await h.call('complete_task', { task_id: id, summary })).isError).toBe(false);
}
const todo = (n: number) =>
  (
    h.db
      .prepare(
        "SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT ?",
      )
      .all(n) as { id: string }[]
  ).map((r) => r.id);

describe('self-improving memory over MCP', () => {
  it('reject_task saves reason + prevention (and fix) and rewrites LESSONS_LEARNED.md', async () => {
    const [a] = todo(1) as [string];
    await toReview(a);
    const peer = await reviewer();
    const r = await peer.call('reject_task', {
      task_id: a,
      reason: 'Backdrop click did not close the modal',
      prevention: 'Test every dismiss path',
    });
    expect(r.isError).toBe(false);
    expect(existsSync(file())).toBe(true);
    const md = readFileSync(file(), 'utf8');
    expect(md).toContain(`## ${a} Rejection`);
    expect(md).toContain('Backdrop click did not close the modal');
    expect(md).toContain('Test every dismiss path');
    const lessons = (await h.call('get_lessons_learned', { task_id: a })).json<
      { prevention: string }[]
    >();
    expect(lessons[0]?.prevention).toBe('Test every dismiss path');
    await peer.close();
  });

  it('the next complete_task summary becomes the fix, in the table and in the file', async () => {
    const [a] = todo(1) as [string];
    await toReview(a);
    const peer = await reviewer();
    await peer.call('reject_task', { task_id: a, reason: 'Missing keyboard support' });
    await h.call('complete_task', { task_id: a, summary: 'Added Esc and Enter handlers' });
    expect(readFileSync(file(), 'utf8')).toContain('Added Esc and Enter handlers');
    const lessons = (await h.call('get_lessons_learned', { task_id: a })).json<
      { fix_applied: string }[]
    >();
    expect(lessons[0]?.fix_applied).toBe('Added Esc and Enter handlers');
    await peer.close();
  });

  it('rejecting twice with different reasons, then enriching a similar task returns the relevant lessons and get_task_context shows them', async () => {
    const [a, b, c] = todo(3) as [string, string, string];
    h.db.prepare("UPDATE subtasks SET label = 'Modal backdrop close' WHERE id = ?").run(a);
    h.db.prepare("UPDATE subtasks SET label = 'Report export' WHERE id = ?").run(b);
    h.db
      .prepare("UPDATE subtasks SET label = 'Settings modal dismiss behaviour' WHERE id = ?")
      .run(c);
    const peer = await reviewer();
    await toReview(a);
    await peer.call('reject_task', {
      task_id: a,
      reason: 'The modal did not close on backdrop click',
    });
    await toReview(b);
    await peer.call('reject_task', { task_id: b, reason: 'CSV export dropped the header row' });
    const enriched = (
      await h.call('enrich_task', { task_id: c, notes: 'dismiss the settings modal' })
    ).json<{ relevant_lessons: { rejection_reason: string }[] }>();
    expect(enriched.relevant_lessons.map((l) => l.rejection_reason)).toEqual([
      'The modal did not close on backdrop click',
    ]);
    const ctx = (await h.call('get_task_context', { task_id: c })).text;
    expect(ctx).toContain('modal did not close on backdrop click');
    expect(ctx).not.toContain('CSV export');
    await peer.close();
  });
});
