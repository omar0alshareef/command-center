import type { Agent, Task } from '@command-center/core';
import { describe, expect, it } from 'vitest';
import {
  activeAgentCount,
  completedThisWeek,
  initials,
  isAgentActive,
  overallProgress,
  scheduleBadge,
  taskCounts,
} from '../src/renderer/lib/derive';

const task = (status: Task['status'], completed_at: string | null = null) =>
  ({ status, completed_at }) as Task;
const agent = (over: Partial<Agent>) =>
  ({ status: 'idle', last_action_at: null, ...over }) as Agent;

describe('derive', () => {
  it('counts tasks per status, including zeros', () => {
    expect(taskCounts([task('review'), task('review'), task('blocked')])).toEqual({
      todo: 0,
      in_progress: 0,
      review: 2,
      done: 0,
      blocked: 1,
    });
  });

  it('computes overall progress and handles no tasks', () => {
    expect(overallProgress([])).toBe(0);
    expect(overallProgress([task('done'), task('todo'), task('done'), task('todo')])).toBe(0.5);
  });

  it('derives ACTIVE from a 5 minute window or explicit status', () => {
    const now = Date.parse('2026-03-12T10:00:00Z');
    const recent = agent({ last_action_at: '2026-03-12T09:56:00Z' });
    const stale = agent({ last_action_at: '2026-03-12T09:50:00Z' });
    expect(isAgentActive(recent, now)).toBe(true);
    expect(isAgentActive(stale, now)).toBe(false);
    expect(isAgentActive(agent({ status: 'active' }), now)).toBe(true);
    expect(activeAgentCount([recent, stale, agent({})], now)).toBe(1);
  });

  it('builds the schedule pill from status and max drift', () => {
    const ms = [{ drift_days: 2 }, { drift_days: 6 }, { drift_days: -1 }];
    expect(scheduleBadge({ schedule_status: 'behind' }, ms)).toEqual({
      label: 'BEHIND · 6d',
      tone: 'danger',
    });
    expect(scheduleBadge({ schedule_status: 'at_risk' }, ms)).toEqual({
      label: 'AT RISK',
      tone: 'warning',
    });
    expect(scheduleBadge({ schedule_status: 'on_track' }, [])).toEqual({
      label: 'ON TRACK',
      tone: 'success',
    });
  });

  it('counts completions since Monday 00:00 local', () => {
    const now = new Date(2026, 2, 12, 15, 0); // Thu Mar 12 2026 local
    const monday = new Date(2026, 2, 9, 0, 0).toISOString();
    const sundayBefore = new Date(2026, 2, 8, 23, 59).toISOString();
    expect(
      completedThisWeek([task('done', monday), task('done', sundayBefore), task('todo')], now),
    ).toBe(1);
  });

  it('makes two-letter initials', () => {
    expect(initials('claude-code')).toBe('CC');
    expect(initials('research_explorer')).toBe('RE');
    expect(initials('operator')).toBe('OP');
    expect(initials('--')).toBe('??');
  });
});
