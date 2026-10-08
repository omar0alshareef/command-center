import { getActivityFeed, getTask, listTasks, openDb, type Db } from '@command-center/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRoot } from '../src/context';
import { audit } from '../src/pipeline/audit';
import { claudeArgs, claudeRunner, findClaude } from '../src/pipeline/claude';
import { compress, localRunner } from '../src/pipeline/local';
import { contextPath, CONTEXT_SECTIONS, missingSections, prepare } from '../src/pipeline/prepare';
import { scanText, keywords } from '../src/pipeline/scan';
import { parseFiles, parseVerdict, STAGES } from '../src/pipeline/stages';
import { start } from '../src/pipeline/start';

let root: string;
let db: Db;
const lines: string[] = [];
const out = (l: string) => lines.push(l);
const OK = 'node -e "process.exit(0)"';
const BAD = 'node -e "process.exit(1)"';

const addTask = (
  id: string,
  status: string,
  over: {
    label?: string;
    criteria?: { text: string; done: boolean }[];
    files?: string[];
    assignee?: string | null;
  } = {},
) => {
  db.prepare("INSERT OR IGNORE INTO milestones (id, title) VALUES ('M0', 'Test')").run();
  db.prepare(
    `INSERT INTO subtasks (id, milestone_id, label, status, done, acceptance_criteria, context_files, assignee)
     VALUES (?, 'M0', ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    over.label ?? 'Add login form',
    status,
    JSON.stringify(over.criteria ?? [{ text: 'Form validates input', done: true }]),
    JSON.stringify(over.files ?? []),
    over.assignee ?? null,
  );
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-cli-'));
  db = openDb(root);
  lines.length = 0;
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'login.ts'), 'export const loginForm = 1; // validates input\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'echo ok', lint: 'echo ok' } }),
  );
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const h = () => ({ root, db });
const agentsLogged = (taskId: string) =>
  new Set(getActivityFeed(db, { targetId: taskId }).map((e) => e.agent_id));
const actions = (taskId: string) => getActivityFeed(db, { targetId: taskId }).map((e) => e.action);

describe('project root', () => {
  it('prefers --root, then PROJECT_ROOT, then the nearest parent holding a database', () => {
    const slashes = (p: string) => p.split(String.fromCharCode(92)).join('/');
    const has = (p: string) => slashes(p).endsWith('/a/b/command-center.db');
    expect(findRoot('/x', { PROJECT_ROOT: '/y' }, '/a/b/c', has)).toMatch(/x$/);
    expect(findRoot(undefined, { PROJECT_ROOT: '/y' }, '/a/b/c', has)).toMatch(/y$/);
    expect(slashes(findRoot(undefined, {}, '/a/b/c', has) ?? '')).toMatch(/[/]a[/]b$/);
    expect(findRoot(undefined, {}, '/nowhere/else', () => false)).toBeNull();
  });
});

describe('stage helpers', () => {
  it('reads the last VERDICT line and the file bullets', () => {
    expect(parseVerdict('x\nVERDICT: FAIL\nmore\nVERDICT: PASS')).toBe('PASS');
    expect(parseVerdict('looks fine')).toBeNull();
    expect(parseFiles('## Files\n- `src/a.ts` — why\n* `b/c.ts` — x\n- not a path')).toEqual([
      'src/a.ts',
      'b/c.ts',
    ]);
    expect(keywords('Add the login form for users', 'login')).toEqual(['login', 'form', 'users']);
  });
  it('keeps research inside the token budget and never drops the first three files', () => {
    const research = [
      '## Files',
      ...Array.from(
        { length: 40 },
        (_, i) => `- \`src/file${i}.ts\` — ${'matches many words '.repeat(6)}`,
      ),
      '## Patterns',
      '- p',
      '## Gaps',
      '- g',
    ].join('\n');
    const small = compress(research, 150);
    expect(Math.ceil(small.length / 4)).toBeLessThanOrEqual(160);
    expect(small).toContain('src/file0.ts');
    expect(small).toContain('src/file2.ts');
  });
  it('finds secrets, masks them in the report, and ignores ordinary code', () => {
    const key = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
    const hits = scanText(
      'x.ts',
      `const k = "${key}";\nconst password = "hunter2hunter2";\nconst ok = "nothing here";`,
    );
    expect(hits.map((f) => f.line)).toEqual([1, 2]);
    expect(JSON.stringify(hits)).not.toContain(key);
    expect(JSON.stringify(hits)).not.toContain('hunter2hunter2');
  });
});

describe('claude runner', () => {
  it('builds read-only args for analysis stages and edit args for the builder', () => {
    const a = claudeArgs({ stage: STAGES.explorer, systemFile: 'SYS.txt' }, {});
    expect(a).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'text',
        '--append-system-prompt-file',
        'SYS.txt',
        '--tools',
        'Read',
        'Grep',
        'Glob',
      ]),
    );
    expect(a).not.toContain('Edit');
    const b = claudeArgs(
      { stage: STAGES.builder, systemFile: 'SYS.txt' },
      { COMMAND_CENTER_MODEL: 'm1' },
    );
    expect(b).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Edit',
        '--model',
        'm1',
      ]),
    );
  });
  it('finds the binary from an override, PATH, or the installer folder', () => {
    expect(findClaude({ COMMAND_CENTER_CLAUDE: 'C:/x/claude' })).toBe('C:/x/claude');
    expect(findClaude({ PATH: '' }, () => false)).toBeNull();
  });
  it('runs a stage through a stand-in `claude`: prompt on stdin, output captured', async () => {
    const script = join(root, 'fake-claude.mjs');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=process.argv.slice(2);writeFileSync(${JSON.stringify(join(root, 'seen.json'))}, JSON.stringify({args:a,stdin:s,system:readFileSync(a[a.indexOf('--append-system-prompt-file')+1],'utf8')}));console.log('## Files\\n- \`src/login.ts\` — fake\\nVERDICT: PASS');});\n`,
    );
    const bin = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(
      bin,
      process.platform === 'win32'
        ? `@echo off\r\nnode "${script}" %*\r\n`
        : `#!/bin/sh\nexec node "${script}" "$@"\n`,
      { mode: 0o755 },
    );
    addTask('TASK-001', 'todo');
    const task = getTask(db, 'TASK-001');
    if (!task) throw new Error('task missing');
    const r = await claudeRunner(bin, 20_000).run({
      stage: STAGES.explorer,
      prompt: 'PROMPT BODY',
      system: 'SYS',
      root,
      task,
      data: {},
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('src/login.ts');
    const seen = JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8')) as {
      args: string[];
      stdin: string;
      system: string;
    };
    expect(seen.stdin).toBe('PROMPT BODY');
    expect(seen.args).toContain('-p');
    expect(seen.system).toBe('SYS');
    expect(seen.args).not.toContain('SYS');
  });
  it('reports a missing binary as a failed stage, not a crash', async () => {
    addTask('TASK-001', 'todo');
    const task = getTask(db, 'TASK-001');
    if (!task) throw new Error('task missing');
    const r = await claudeRunner(join(root, 'nope-claude'), 5000).run({
      stage: STAGES.explorer,
      prompt: 'p',
      system: 's',
      root,
      task,
      data: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not run|exited/);
  });
});

describe('prepare', () => {
  it('writes a TASK_CONTEXT.md with all six sections and logs each stage under its own agent', async () => {
    addTask('TASK-001', 'todo');
    const file = await prepare(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      budget: 500,
      out,
    });
    expect(file).toBe(contextPath(root));
    const md = readFileSync(contextPath(root), 'utf8');
    expect(missingSections(md)).toEqual([]);
    for (const s of CONTEXT_SECTIONS) expect(md).toContain(`## ${s}`);
    expect(md).toContain('src/login.ts');
    expect(md.match(/^## /gm)?.length).toBe(6); // the optimizer's own headings are demoted, so only the six sections remain
    expect(actions('TASK-001')).toEqual(
      expect.arrayContaining([
        'exploration_complete',
        'compression_complete',
        'prompt_optimized',
        'task_context_written',
      ]),
    );
    expect([...agentsLogged('TASK-001')]).toEqual(
      expect.arrayContaining(['research-explorer', 'token-compressor', 'prompt-optimizer']),
    );
    expect(getTask(db, 'TASK-001')?.status).toBe('todo');
    expect(getTask(db, 'TASK-001')?.context_files).toContain('src/login.ts');
  });
  it('--dry-run prints the three prompts and changes nothing', async () => {
    addTask('TASK-001', 'todo');
    const before = getActivityFeed(db).length;
    await prepare(h(), 'TASK-001', { runner: localRunner, dryRun: true, budget: 500, out });
    expect(lines.join('\n')).toMatch(
      /Research Explorer[\s\S]*Token Compressor[\s\S]*Prompt Optimizer/,
    );
    expect(existsSync(contextPath(root))).toBe(false);
    expect(getActivityFeed(db).length).toBe(before);
  });
  it('rejects an unknown task without touching anything', async () => {
    await expect(
      prepare(h(), 'TASK-404', { runner: localRunner, dryRun: false, budget: 500, out }),
    ).rejects.toThrow(/No task TASK-404/);
  });
});

describe('audit', () => {
  it('FAIL on a reviewed task sends it back to In Progress with the reason and a lesson', async () => {
    addTask('TASK-001', 'review', { criteria: [{ text: 'Form validates input', done: false }] });
    const r = await audit(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [OK],
      out,
    });
    expect(r?.pass).toBe(false);
    expect(r?.rejected).toBe(true);
    expect(getTask(db, 'TASK-001')?.status).toBe('in_progress');
    const rejected = getActivityFeed(db, { targetId: 'TASK-001' }).find(
      (e) => e.action === 'task_rejected',
    );
    expect(rejected?.agent_id).toBe('final-validator');
    expect(rejected?.description).toMatch(/Audit failed.*not met/);
    expect((db.prepare('SELECT COUNT(*) c FROM lessons_learned').get() as { c: number }).c).toBe(1);
    expect(actions('TASK-001')).toEqual(
      expect.arrayContaining(['quality_check', 'security_scan', 'validation_failed']),
    );
    expect([...agentsLogged('TASK-001')]).toEqual(
      expect.arrayContaining(['code-quality', 'security-auditor', 'final-validator']),
    );
  });
  it('PASS leaves the task in review for the human to approve', async () => {
    addTask('TASK-001', 'review');
    const r = await audit(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [OK],
      out,
    });
    expect(r?.pass).toBe(true);
    expect(getTask(db, 'TASK-001')?.status).toBe('review');
    expect(actions('TASK-001')).toContain('validation_passed');
  });
  it('a failing check fails the audit even though the criteria are met', async () => {
    addTask('TASK-001', 'review');
    const r = await audit(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [BAD],
      out,
    });
    expect(r?.pass).toBe(false);
    expect(r?.stages[0]?.summary).toMatch(/checks failed/);
    expect(getTask(db, 'TASK-001')?.status).toBe('in_progress');
  });
  it('a hard-coded secret in a task file fails the security stage, and the report masks it', async () => {
    const key = 'sk-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1';
    writeFileSync(join(root, 'src', 'login.ts'), `export const k = "${key}";\n`);
    addTask('TASK-001', 'review', { files: ['src/login.ts'] });
    const r = await audit(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [OK],
      out,
    });
    expect(r?.stages[1]?.verdict).toBe('FAIL');
    expect(JSON.stringify(getActivityFeed(db))).not.toContain(key);
    expect(lines.join('\n')).not.toContain(key);
  });
  it('a model cannot talk a deterministic failure into a PASS', async () => {
    addTask('TASK-001', 'review');
    const agreeable = {
      name: 'agreeable',
      run: () => Promise.resolve({ ok: true, output: 'all good\nVERDICT: PASS' }),
    };
    const r = await audit(h(), 'TASK-001', {
      runner: agreeable,
      dryRun: false,
      checks: [BAD],
      out,
    });
    expect(r?.stages[0]?.verdict).toBe('FAIL');
    expect(r?.pass).toBe(false);
  });
  it('a stage that returns no verdict counts as FAIL; a runner error leaves the task alone', async () => {
    addTask('TASK-001', 'review');
    const mute = {
      name: 'mute',
      run: () => Promise.resolve({ ok: true, output: 'no verdict here' }),
    };
    expect(
      (await audit(h(), 'TASK-001', { runner: mute, dryRun: false, checks: [OK], out }))?.pass,
    ).toBe(false);
    expect(getTask(db, 'TASK-001')?.status).toBe('in_progress');
    addTask('TASK-002', 'review');
    const broken = {
      name: 'broken',
      run: () => Promise.resolve({ ok: false, output: '', error: 'boom' }),
    };
    await expect(
      audit(h(), 'TASK-002', { runner: broken, dryRun: false, checks: [OK], out }),
    ).rejects.toThrow(/could not run: boom/);
    expect(getTask(db, 'TASK-002')?.status).toBe('review');
  });
  it('refuses tasks that are not in progress or review; --dry-run changes nothing', async () => {
    addTask('TASK-001', 'todo');
    await expect(
      audit(h(), 'TASK-001', { runner: localRunner, dryRun: false, checks: [], out }),
    ).rejects.toThrow(/Audit runs on tasks/);
    addTask('TASK-002', 'review');
    const before = getActivityFeed(db).length;
    await audit(h(), 'TASK-002', { runner: localRunner, dryRun: true, checks: [], out });
    expect(getActivityFeed(db).length).toBe(before);
    expect(getTask(db, 'TASK-002')?.status).toBe('review');
  });
});

describe('start', () => {
  it('with the local runner it starts the task and prepares context, but completes nothing', async () => {
    addTask('TASK-001', 'todo');
    const r = await start(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [OK],
      dispatch: true,
      budget: 500,
      out,
    });
    expect(r).toBe('started');
    expect(getTask(db, 'TASK-001')?.status).toBe('in_progress');
    expect(existsSync(contextPath(root))).toBe(true);
  });
  it('--no-dispatch runs the checks and completes the task when they pass', async () => {
    addTask('TASK-001', 'todo');
    const r = await start(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [OK],
      dispatch: false,
      budget: 500,
      out,
    });
    expect(r).toBe('completed');
    expect(getTask(db, 'TASK-001')?.status).toBe('review');
    expect(actions('TASK-001')).toEqual(expect.arrayContaining(['task_started', 'task_completed']));
  });
  it('failing checks keep the task In Progress and say so in the log', async () => {
    addTask('TASK-001', 'todo');
    const r = await start(h(), 'TASK-001', {
      runner: localRunner,
      dryRun: false,
      checks: [BAD],
      dispatch: false,
      budget: 500,
      out,
    });
    expect(r).toBe('checks-failed');
    expect(getTask(db, 'TASK-001')?.status).toBe('in_progress');
    expect(actions('TASK-001')).toContain('checks_failed');
  });
  it('dispatches to the agent (claude runner stand-in), then completes with its summary', async () => {
    addTask('TASK-001', 'todo');
    const builder = {
      name: 'claude',
      run: () =>
        Promise.resolve({ ok: true, output: 'edited things\nSUMMARY: added the login form' }),
    };
    const r = await start(h(), 'TASK-001', {
      runner: builder,
      dryRun: false,
      checks: [OK],
      dispatch: true,
      budget: 500,
      out,
    });
    expect(r).toBe('completed');
    const done = getActivityFeed(db, { targetId: 'TASK-001' }).find(
      (e) => e.action === 'task_completed',
    );
    expect(done?.description).toContain('added the login form');
  });
  it('a dispatch failure leaves the task In Progress and exits with an error', async () => {
    addTask('TASK-001', 'todo');
    await prepare(h(), 'TASK-001', { runner: localRunner, dryRun: false, budget: 500, out });
    const broken = {
      name: 'claude',
      run: () => Promise.resolve({ ok: false, output: '', error: 'agent crashed' }),
    };
    await expect(
      start(h(), 'TASK-001', {
        runner: broken,
        dryRun: false,
        checks: [OK],
        dispatch: true,
        budget: 500,
        out,
      }),
    ).rejects.toThrow(/agent crashed/);
    expect(getTask(db, 'TASK-001')?.status).toBe('in_progress');
  });
  it('--dry-run touches nothing; tasks already in review or done are refused', async () => {
    addTask('TASK-001', 'todo');
    expect(
      await start(h(), 'TASK-001', {
        runner: localRunner,
        dryRun: true,
        checks: [OK],
        dispatch: true,
        budget: 500,
        out,
      }),
    ).toBe('dry-run');
    expect(getTask(db, 'TASK-001')?.status).toBe('todo');
    expect(existsSync(contextPath(root))).toBe(false);
    addTask('TASK-002', 'review');
    await expect(
      start(h(), 'TASK-002', {
        runner: localRunner,
        dryRun: false,
        checks: [],
        dispatch: true,
        budget: 500,
        out,
      }),
    ).rejects.toThrow(/already review/);
    expect(listTasks(db).length).toBe(2);
  });
});

describe('memory', () => {
  it('an audit FAIL stores what would have prevented it, and LESSONS_LEARNED.md matches the table', async () => {
    addTask('TASK-001', 'review', { criteria: [{ text: 'Form validates input', done: false }] });
    await audit(h(), 'TASK-001', { runner: localRunner, dryRun: false, checks: [BAD], out });
    const lesson = db.prepare('SELECT * FROM lessons_learned').get() as {
      prevention: string;
      rejection_reason: string;
    };
    expect(lesson.prevention).toMatch(/Verify before review: Form validates input/);
    expect(lesson.prevention).toMatch(/Run node -e .* until it passes/);
    const md = readFileSync(join(root, '.claude', 'LESSONS_LEARNED.md'), 'utf8');
    expect(md).toContain('## TASK-001 Rejection');
    expect(md).toContain(lesson.rejection_reason);
    expect(md).toContain('Verify before review: Form validates input');
  });

  it('prepare hands the lessons from an earlier rejection to a similar task', async () => {
    addTask('TASK-001', 'review', { label: 'Modal backdrop close' });
    db.prepare(
      "INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied, prevention) VALUES ('TASK-001', 'The modal did not close on backdrop click', 'added a handler', 'test every dismiss path')",
    ).run();
    addTask('TASK-002', 'todo', { label: 'Settings modal dismiss' });
    await prepare(h(), 'TASK-002', { runner: localRunner, dryRun: false, budget: 500, out });
    const md = readFileSync(contextPath(root), 'utf8');
    const lessons = md.slice(md.indexOf('## Relevant lessons'));
    expect(lessons).toContain('modal did not close on backdrop click');
    expect(lessons).toContain('prevention: test every dismiss path');
    expect(md).toContain('Do not repeat: The modal did not close'); // the optimizer repeated it as a rule
    expect(existsSync(join(root, '.claude', 'LESSONS_LEARNED.md'))).toBe(true);
  });
});
