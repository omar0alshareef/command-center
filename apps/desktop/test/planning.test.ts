import { describe, expect, it } from 'vitest';
import type { Proposal } from '@command-center/core';
import {
  addRole,
  countPlan,
  isPastDue,
  removeRole,
  renameRole,
  roadmapSection,
  rolesFor,
} from '../src/renderer/lib/planning';

const p: Proposal = {
  milestones: [
    {
      id: 'M1',
      title: 'Brand',
      domain: 'web',
      planned_start: '2026-01-05',
      planned_end: '2026-01-10',
      capabilities: ['design'],
      dependencies: [],
      is_key_milestone: false,
    },
    {
      id: 'M2',
      title: 'API',
      domain: 'api',
      planned_start: '2026-01-12',
      planned_end: '2026-01-20',
      capabilities: ['backend'],
      dependencies: ['M1'],
      is_key_milestone: false,
    },
  ],
  tasks: [
    {
      key: 'T1',
      milestone: 'M1',
      label: 'Logo',
      priority: 'P1',
      due_date: '2026-01-08',
      capability: 'design',
      depends_on: [],
      assignee: 'design-team',
      acceptance_criteria: [],
    },
    {
      key: 'T2',
      milestone: 'M2',
      label: 'Auth',
      priority: 'P2',
      due_date: null,
      capability: 'backend',
      depends_on: ['T1'],
      assignee: 'backend-team',
      acceptance_criteria: [],
    },
  ],
  team: [
    { id: 'design-team', name: 'Design', capabilities: ['design'], milestones: ['M1'] },
    { id: 'backend-team', name: 'Backend', capabilities: ['backend'], milestones: ['M2'] },
  ],
  assumptions: {},
};

describe('team roster edits', () => {
  it('only the design milestone lists the design role', () => {
    expect(rolesFor(p.team, 'M1').map((r) => r.id)).toEqual(['design-team']);
    expect(rolesFor(p.team, 'M2').map((r) => r.id)).toEqual(['backend-team']);
  });

  it('renaming a role moves its tasks to the new id', () => {
    const next = renameRole(p, 'design-team', { id: 'brand-studio', name: 'Brand studio' });
    expect(next.team[0]).toMatchObject({
      id: 'brand-studio',
      name: 'Brand studio',
      milestones: ['M1'],
    });
    expect(next.tasks[0]?.assignee).toBe('brand-studio');
    expect(next.tasks[1]?.assignee).toBe('backend-team');
  });

  it('removing a role unassigns its tasks; adding gets a unique slug id', () => {
    const next = removeRole(p, 'design-team');
    expect(next.team.map((r) => r.id)).toEqual(['backend-team']);
    expect(next.tasks[0]?.assignee).toBeNull();
    const added = addRole(addRole(p, 'Content & Copy'), 'Content & Copy');
    expect(added.team.slice(-2).map((r) => r.id)).toEqual(['content-copy', 'content-copy-2']);
  });

  it('counts what approval will write', () => {
    expect(countPlan(p)).toEqual({
      milestones: 2,
      tasks: 2,
      withDeadlines: 1,
      dependencies: 1,
      agents: 2,
    });
  });
});

describe('past due', () => {
  it('flags open tasks whose deadline is before today', () => {
    expect(isPastDue({ due_date: '2026-01-01', status: 'todo' }, '2026-01-02')).toBe(true);
    expect(isPastDue({ due_date: '2026-01-02', status: 'todo' }, '2026-01-02')).toBe(false);
    expect(isPastDue({ due_date: '2026-01-01', status: 'done' }, '2026-01-02')).toBe(false);
    expect(isPastDue({ due_date: null, status: 'todo' }, '2026-01-02')).toBe(false);
  });
});

describe('roadmapSection', () => {
  const md = `# Roadmap
Intro.
## M1 — Brand
Logo and colours.
### Deliverables
- logo
## M10 — Later
Not this one.
## M2: API
Auth.`;
  it('takes the heading naming the id up to the next heading of the same level', () => {
    expect(roadmapSection(md, 'M1')).toBe(
      '## M1 — Brand\nLogo and colours.\n### Deliverables\n- logo',
    );
    expect(roadmapSection(md, 'M2')).toBe('## M2: API\nAuth.');
    expect(roadmapSection(md, 'M10')).toBe('## M10 — Later\nNot this one.');
  });
  it('falls back to the exact title, else null', () => {
    expect(roadmapSection('## Launch\nGo.', 'X9', 'Launch')).toBe('## Launch\nGo.');
    expect(roadmapSection(md, 'M7')).toBeNull();
  });
});
