import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hydrate, hydrationPrompt } from '../src/hydrate';
import { listMilestones, listPhases } from '../src/queries';
import { tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

const plan = {
  project: { name: 'Acme', start_date: '2026-01-05', target_date: '2026-06-30' },
  phases: [{ id: 'P1', title: 'Foundation', start_week: 1, end_week: 4 }],
  agents: [{ id: 'builder', name: 'Builder', type: 'orchestrator' as const }],
  milestones: [
    {
      id: 'M1',
      title: 'Auth',
      domain: 'backend',
      week: 1,
      phase: 'P1',
      tasks: [
        { label: 'Login', priority: 'P0' as const, acceptance_criteria: ['logs in'] },
        { label: 'Logout', assignee: 'builder' },
      ],
    },
    { id: 'M2', title: 'UI', domain: 'frontend', week: 3, dependencies: ['M1'], tasks: [] },
  ],
};
const count = (table: string) =>
  (t.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

describe('hydrate', () => {
  it('creates phases, agents, milestones and subtasks and reports counts', () => {
    const s = hydrate(t.db, plan);
    expect(s).toEqual({ phases: 1, agents: 1, milestones: 2, tasks: 2, dryRun: false });
    expect(listPhases(t.db).map((p) => p.id)).toEqual(['P1']);
    expect(listMilestones(t.db).map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(count('subtasks')).toBe(2);
    expect(t.db.prepare('SELECT name FROM project').get()).toEqual({ name: 'Acme' });
    expect(
      t.db.prepare("SELECT acceptance_criteria a FROM subtasks WHERE label = 'Login'").get(),
    ).toEqual({ a: '[{"text":"logs in","done":false}]' });
  });

  it('dry run validates and changes nothing', () => {
    expect(hydrate(t.db, plan, { dryRun: true }).dryRun).toBe(true);
    expect(count('milestones')).toBe(0);
    expect(count('subtasks')).toBe(0);
    expect(count('agents')).toBe(2); // only the built-in operator and system
  });

  it('is all-or-nothing: a bad reference rolls everything back', () => {
    const bad = { ...plan, milestones: [...plan.milestones, { title: 'X', phase: 'NOPE' }] };
    expect(() => hydrate(t.db, bad)).toThrow(/Unknown phase/);
    expect(count('milestones')).toBe(0);
    expect(count('phases')).toBe(0);
    expect(count('subtasks')).toBe(0);
  });

  it('rejects unknown keys and bad dates', () => {
    expect(() => hydrate(t.db, { ...plan, extra: 1 })).toThrow();
    expect(() => hydrate(t.db, { project: { start_date: 'soon' } })).toThrow();
  });

  it('builds a prompt holding both documents and the schema', () => {
    const p = hydrationPrompt('VISION', 'ROADMAP');
    expect(p).toContain('VISION');
    expect(p).toContain('ROADMAP');
    expect(p).toContain('"milestones"');
  });
});
