import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { isAgentActive, registerAgent, RESERVED_AGENT_IDS } from '../src/agents';
import {
  AgentNotFoundError,
  CoreError,
  InvalidInputError,
  MilestoneNotFoundError,
  ReservedAgentError,
} from '../src/errors';
import {
  addMilestoneNote,
  createMilestone,
  scheduleStatusFor,
  setMilestoneDates,
  updateDrift,
} from '../src/milestones';
import { getActivityFeed, getAgent, getMilestone, getProject } from '../src/queries';
import { tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

describe('registerAgent', () => {
  it('registers a new agent with defaults, logs it, and returns it', () => {
    const a = registerAgent(t.db, {
      id: 'claude-code',
      name: 'Claude Code',
      type: 'orchestrator',
      source_model: 'claude-sonnet-5-5',
    });
    expect(a).toMatchObject({
      id: 'claude-code',
      type: 'orchestrator',
      status: 'idle',
      source_model: 'claude-sonnet-5-5',
      permissions: [],
    });
    expect(a.color).toMatch(/^#[0-9A-F]{6}$/i);
    const log = getActivityFeed(t.db)[0];
    expect(log).toMatchObject({
      agent_id: 'claude-code',
      action: 'agent_registered',
      target_id: 'claude-code',
    });
  });

  it('is an upsert: updates only provided fields and logs agent_updated', () => {
    registerAgent(t.db, {
      id: 'a1',
      name: 'One',
      type: 'sub-agent',
      color: '#112233',
      permissions: ['read'],
    });
    const updated = registerAgent(t.db, {
      id: 'a1',
      name: 'Renamed',
      type: 'sub-agent',
      source_model: 'm',
    });
    expect(updated).toMatchObject({
      name: 'Renamed',
      color: '#112233',
      permissions: ['read'],
      source_model: 'm',
    });
    expect(getActivityFeed(t.db)[0]?.action).toBe('agent_updated');
  });

  it('refuses reserved ids', () => {
    for (const id of RESERVED_AGENT_IDS) {
      expect(() => registerAgent(t.db, { id, name: 'x', type: 'external' })).toThrow(
        ReservedAgentError,
      );
    }
    expect(getAgent(t.db, 'operator')?.type).toBe('human'); // untouched
  });

  it('validates the id, color and parent', () => {
    expect(() => registerAgent(t.db, { id: 'Bad Id', name: 'x', type: 'external' })).toThrow(
      ZodError,
    );
    expect(() =>
      registerAgent(t.db, { id: 'ok', name: 'x', type: 'external', color: 'red' }),
    ).toThrow(ZodError);
    expect(() =>
      registerAgent(t.db, { id: 'ok', name: 'x', type: 'sub-agent', parent_id: 'ghost' }),
    ).toThrow(AgentNotFoundError);
  });

  it('rejects parent cycles', () => {
    registerAgent(t.db, { id: 'a', name: 'A', type: 'orchestrator' });
    registerAgent(t.db, { id: 'b', name: 'B', type: 'sub-agent', parent_id: 'a' });
    const err = (() => {
      try {
        registerAgent(t.db, { id: 'a', name: 'A', type: 'orchestrator', parent_id: 'b' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe('AGENT_CYCLE');
    expect(getAgent(t.db, 'a')?.parent_id).toBeNull();
  });

  it('isAgentActive: explicit status or acted within 5 minutes', () => {
    const now = Date.parse('2026-03-12T10:00:00Z');
    expect(isAgentActive({ status: 'active', last_action_at: null }, now)).toBe(true);
    expect(isAgentActive({ status: 'idle', last_action_at: '2026-03-12T09:56:00Z' }, now)).toBe(
      true,
    );
    expect(isAgentActive({ status: 'idle', last_action_at: '2026-03-12T09:50:00Z' }, now)).toBe(
      false,
    );
    expect(isAgentActive({ status: 'idle', last_action_at: null }, now)).toBe(false);
  });
});

describe('milestones', () => {
  const make = (over: Record<string, unknown> = {}) =>
    createMilestone(t.db, { title: 'Auth', week: 3, ...over }, 'operator');

  it('creates with the next M<n> id, derives dates from the project start and week, logs it', () => {
    t.db.prepare("UPDATE project SET start_date = '2026-01-05' WHERE id = 1").run();
    const m = make();
    expect(m).toMatchObject({
      id: 'M1',
      title: 'Auth',
      domain: 'general',
      week: 3,
      planned_start: '2026-01-19',
      planned_end: '2026-01-25',
      dependencies: [],
      is_key_milestone: false,
    });
    expect(make({ title: 'Next' }).id).toBe('M2');
    expect(getActivityFeed(t.db).some((e) => e.action === 'milestone_created')).toBe(true);
  });

  it('validates dependencies, phase, explicit id and date order', () => {
    make({ id: 'AUTH' });
    expect(() => make({ id: 'AUTH' })).toThrow(InvalidInputError);
    expect(() => make({ dependencies: ['NOPE'] })).toThrow(MilestoneNotFoundError);
    expect(make({ id: 'B', dependencies: ['AUTH'] }).dependencies).toEqual(['AUTH']);
    expect(() => make({ id: 'C', phase: 'no-such-phase' })).toThrow(InvalidInputError);
    expect(() => make({ id: 'D', dependencies: ['D'] })).toThrow(InvalidInputError);
    expect(() => make({ id: 'E', planned_start: '2026-02-10', planned_end: '2026-02-01' })).toThrow(
      InvalidInputError,
    );
  });

  it('key milestones default their label to the title', () => {
    expect(make({ is_key_milestone: true })).toMatchObject({
      is_key_milestone: true,
      key_milestone_label: 'Auth',
    });
  });

  it('adds notes with author and timestamp', () => {
    make({ id: 'M1' });
    const m = addMilestoneNote(t.db, 'M1', '  Blocked on design  ', 'operator');
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toMatchObject({ text: 'Blocked on design', author: 'operator' });
    expect(() => addMilestoneNote(t.db, 'NOPE', 'x', 'operator')).toThrow(MilestoneNotFoundError);
    expect(() => addMilestoneNote(t.db, 'M1', '   ', 'operator')).toThrow(ZodError);
  });

  it('sets dates partially and rejects impossible ones', () => {
    make({ id: 'M1', planned_start: '2026-02-01', planned_end: '2026-02-07' });
    const m = setMilestoneDates(t.db, 'M1', { actual_start: '2026-02-03' }, 'operator');
    expect(m).toMatchObject({
      planned_start: '2026-02-01',
      actual_start: '2026-02-03',
      actual_end: null,
    });
    expect(() => setMilestoneDates(t.db, 'M1', { planned_end: '2026-01-01' }, 'operator')).toThrow(
      InvalidInputError,
    );
    expect(() =>
      setMilestoneDates(t.db, 'M1', { planned_start: '2026-02-30' }, 'operator'),
    ).toThrow(ZodError);
    expect(() => setMilestoneDates(t.db, 'M1', {}, 'operator')).toThrow(InvalidInputError);
    expect(() => setMilestoneDates(t.db, 'M1', { bogus: '2026-01-01' }, 'operator')).toThrow(
      ZodError,
    );
    expect(getMilestone(t.db, 'M1')?.planned_end).toBe('2026-02-07');
  });

  it('records drift with a reason note and refreshes the project schedule status', () => {
    make({ id: 'M1' });
    make({ id: 'M2' });
    expect(updateDrift(t.db, 'M1', 3, 'operator', 'waiting on review')).toMatchObject({
      drift_days: 3,
    });
    expect(getMilestone(t.db, 'M1')?.notes[0]?.text).toContain('+3d: waiting on review');
    expect(getProject(t.db).schedule_status).toBe('at_risk');
    updateDrift(t.db, 'M2', 9, 'operator');
    expect(getProject(t.db).schedule_status).toBe('behind');
    updateDrift(t.db, 'M1', 0, 'operator');
    updateDrift(t.db, 'M2', -2, 'operator');
    expect(getProject(t.db).schedule_status).toBe('on_track');
    expect(() => updateDrift(t.db, 'M1', 1.5, 'operator')).toThrow(ZodError);
    expect(() => updateDrift(t.db, 'NOPE', 1, 'operator')).toThrow(MilestoneNotFoundError);
  });

  it('scheduleStatusFor thresholds', () => {
    expect([0, 1, 6, 7, 30].map(scheduleStatusFor)).toEqual([
      'on_track',
      'at_risk',
      'at_risk',
      'behind',
      'behind',
    ]);
  });
});
