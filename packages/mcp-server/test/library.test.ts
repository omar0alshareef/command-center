import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLibraryAgent,
  openLibrary,
  assignLibraryAgent,
  type LibraryDb,
} from '@command-center/core';
import { connect, type Harness } from './harness';

// M15 tools: read the library and the project spec, read required lessons, and propose a lesson that can only be a draft.

const DEMO = resolve(__dirname, '../../../sample-projects/demo-project');
let base: string;
let lib: LibraryDb;
let h: Harness;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'cc-mcp-lib-'));
  lib = openLibrary(join(base, 'appdata'));
  createLibraryAgent(lib, {
    name: 'Copywriter',
    role: 'marketing',
    base_instructions: 'Write plainly.',
  });
  h = await connect({ library: lib });
  // The harness project folder gets the demo project's files so the spec can be read.
  cpSync(DEMO, h.root, { recursive: true, force: true });
});
afterEach(async () => {
  await h.close();
  lib.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

const firstTask = () =>
  (
    h.db.prepare("SELECT id FROM subtasks WHERE status='todo' ORDER BY id LIMIT 1").get() as {
      id: string;
    }
  ).id;

describe('library tools (M15)', () => {
  it('lists library agents and says which are in this project', async () => {
    assignLibraryAgent(h.db, lib, 'copywriter');
    const list = (await h.call('list_library_agents')).json<
      { id: string; in_this_project: boolean; enabled_here: boolean }[]
    >();
    expect(list.find((a) => a.id === 'copywriter')).toMatchObject({
      in_this_project: true,
      enabled_here: true,
    });
  });

  it('returns the project spec with its hash and forbidden tools', async () => {
    const spec = (await h.call('get_project_spec')).json<{
      spec_status: string;
      spec_hash: string;
      spec: string;
    }>();
    expect(spec.spec_status).toBe('ok');
    expect(spec.spec_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.spec.length).toBeGreaterThan(20);
  });

  it('reports a missing spec instead of failing', async () => {
    rmSync(join(h.root, 'AGENTS.md'));
    const spec = (await h.call('get_project_spec')).json<{
      spec_status: string;
      spec: string | null;
    }>();
    expect(spec).toMatchObject({ spec_status: 'missing', spec: null });
  });

  it('returns the lessons a task must read', async () => {
    const id = firstTask();
    await h.call('start_task', { task_id: id });
    const r = (
      await h.call('propose_lesson', { task_id: id, reason: 'Used the word revolutionary in copy' })
    ).json<{
      lesson_id: number;
    }>();
    expect(r.lesson_id).toBeGreaterThan(0);
    const got = (await h.call('get_lessons_for_task', { task_id: id })).json<{ count: number }>();
    expect(got.count).toBeGreaterThanOrEqual(1);
  });

  it('propose_lesson always makes a project-scope draft, even when a check is suggested', async () => {
    const id = firstTask();
    const r = (
      await h.call('propose_lesson', {
        task_id: id,
        reason: 'Left a TODO in the page',
        check: 'no-match **/*.md /TODO/',
      })
    ).json<{ lesson_id: number; status: string; scope: string }>();
    expect(r).toMatchObject({ status: 'draft', scope: 'project' });
    const row = h.db
      .prepare(
        'SELECT status, scope, check_type, check_text, prevention FROM lessons_learned WHERE id = ?',
      )
      .get(r.lesson_id) as Record<string, string>;
    expect(row).toMatchObject({
      status: 'draft',
      scope: 'project',
      check_type: 'none',
      check_text: '',
    });
    expect(row['prevention']).toContain('Proposed check');
  });

  it('has no tool that creates library agents, promotes lessons or changes a scope', async () => {
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const banned of [
      'create_library_agent',
      'delete_library_agent',
      'promote_lesson',
      'retire_lesson',
      'update_lesson',
      'assign_agent',
    ])
      expect(names).not.toContain(banned);
    // And propose_lesson rejects scope/status arguments outright (strict schema).
    const r = await h.call('propose_lesson', {
      task_id: firstTask(),
      reason: 'x',
      scope: 'global',
      status: 'active',
    });
    expect(r.isError).toBe(true);
  });

  it('says plainly when the library is not available', async () => {
    const bare = await connect({ library: null });
    try {
      const r = await bare.call('list_library_agents');
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/library/i);
    } finally {
      await bare.close();
    }
  });
});
