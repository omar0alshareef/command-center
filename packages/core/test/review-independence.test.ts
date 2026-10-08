import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentLineage, registerAgent, sameAgentFamily } from '../src/agents';
import { SelfApprovalError } from '../src/errors';
import { getActivityFeed, getTask } from '../src/queries';
import { transition } from '../src/state-machine';
import { addTask, tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
  registerAgent(t.db, { id: 'builder', name: 'Builder', type: 'orchestrator' });
  registerAgent(t.db, {
    id: 'builder-kid',
    name: 'Builder kid',
    type: 'sub-agent',
    parent_id: 'builder',
  });
  registerAgent(t.db, {
    id: 'builder-kid-kid',
    name: 'Grandkid',
    type: 'sub-agent',
    parent_id: 'builder-kid',
  });
  registerAgent(t.db, { id: 'reviewer', name: 'Reviewer', type: 'orchestrator' });
  registerAgent(t.db, {
    id: 'reviewer-kid',
    name: 'Reviewer kid',
    type: 'sub-agent',
    parent_id: 'reviewer',
  });
});
afterEach(() => t.cleanup());

/** A task that `submitter` has taken from todo to review. */
function submitted(id: string, submitter: string): void {
  addTask(t.db, id, 'todo');
  transition(t.db, id, 'start', { actor: submitter });
  transition(t.db, id, 'complete', { actor: submitter });
}

describe('independent review', () => {
  it('an agent cannot approve what it submitted; nothing changes', () => {
    submitted('T1', 'builder');
    const before = getActivityFeed(t.db).length;
    const err = (() => {
      try {
        transition(t.db, 'T1', 'approve', { actor: 'builder' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SelfApprovalError);
    expect((err as Error).message).toMatch(/Ask the operator or a different agent/);
    expect(getTask(t.db, 'T1')?.status).toBe('review');
    expect(getActivityFeed(t.db)).toHaveLength(before);
  });

  it('an unrelated agent or the human operator can approve', () => {
    submitted('T1', 'builder');
    submitted('T2', 'builder');
    expect(transition(t.db, 'T1', 'approve', { actor: 'reviewer' }).status).toBe('done');
    expect(transition(t.db, 'T2', 'approve', { actor: 'operator' }).status).toBe('done');
  });

  it('closes the sub-agent bypass: a child or parent of the submitter cannot approve either', () => {
    submitted('T1', 'builder');
    for (const actor of ['builder-kid', 'builder-kid-kid']) {
      expect(() => transition(t.db, 'T1', 'approve', { actor })).toThrow(SelfApprovalError);
    }
    submitted('T2', 'builder-kid');
    expect(() => transition(t.db, 'T2', 'approve', { actor: 'builder' })).toThrow(
      SelfApprovalError,
    );
    expect(() => transition(t.db, 'T2', 'approve', { actor: 'builder-kid-kid' })).toThrow(
      SelfApprovalError,
    );
    // siblings or cousins are different agents
    registerAgent(t.db, {
      id: 'builder-kid2',
      name: 'Sibling',
      type: 'sub-agent',
      parent_id: 'builder',
    });
    expect(transition(t.db, 'T2', 'approve', { actor: 'builder-kid2' }).status).toBe('done');
  });

  it('the LATEST submitter counts: reject-then-resubmit by the same agent is still blocked', () => {
    submitted('T1', 'builder');
    transition(t.db, 'T1', 'reject', { actor: 'reviewer', reason: 'fix it' });
    transition(t.db, 'T1', 'complete', { actor: 'builder' });
    expect(() => transition(t.db, 'T1', 'approve', { actor: 'builder' })).toThrow(
      SelfApprovalError,
    );
    expect(transition(t.db, 'T1', 'approve', { actor: 'reviewer' }).status).toBe('done');
  });

  it('a different agent finishing the work makes the original agent eligible', () => {
    submitted('T1', 'builder');
    transition(t.db, 'T1', 'reject', { actor: 'operator', reason: 'redo' });
    transition(t.db, 'T1', 'complete', { actor: 'reviewer' });
    expect(transition(t.db, 'T1', 'approve', { actor: 'builder' }).status).toBe('done');
  });

  it('reset does not erase who submitted', () => {
    submitted('T1', 'builder');
    transition(t.db, 'T1', 'reset', { actor: 'builder' });
    transition(t.db, 'T1', 'start', { actor: 'reviewer' });
    transition(t.db, 'T1', 'complete', { actor: 'builder' }); // reviewer started it, builder submits it
    expect(() => transition(t.db, 'T1', 'approve', { actor: 'builder' })).toThrow(
      SelfApprovalError,
    );
  });

  it('a review task with no recorded submission can be approved by an agent', () => {
    addTask(t.db, 'T1', 'review');
    expect(transition(t.db, 'T1', 'approve', { actor: 'builder' }).status).toBe('done');
  });

  it('only approve is restricted: an agent can still reject or reset its own submission', () => {
    submitted('T1', 'builder');
    expect(
      transition(t.db, 'T1', 'reject', { actor: 'builder', reason: 'found a bug myself' }).status,
    ).toBe('in_progress');
    expect(transition(t.db, 'T1', 'reset', { actor: 'builder' }).status).toBe('todo');
  });
});

describe('agent families', () => {
  it('lineage is nearest-first, cycle-safe, and sameAgentFamily is symmetric', () => {
    expect(agentLineage(t.db, 'builder-kid-kid')).toEqual([
      'builder-kid-kid',
      'builder-kid',
      'builder',
    ]);
    expect(agentLineage(t.db, 'nobody')).toEqual(['nobody']);
    expect(sameAgentFamily(t.db, 'builder', 'builder-kid-kid')).toBe(true);
    expect(sameAgentFamily(t.db, 'builder-kid-kid', 'builder')).toBe(true);
    expect(sameAgentFamily(t.db, 'builder', 'reviewer')).toBe(false);
    expect(sameAgentFamily(t.db, 'builder-kid', 'reviewer-kid')).toBe(false);
  });
});
