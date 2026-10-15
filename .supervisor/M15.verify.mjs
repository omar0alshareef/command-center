// Drives the BUILT app through the M15 exit criteria (agent library, project switcher, spec precedence, lesson scopes,
// recurrence, automatic checks, MCP and CLI) with Playwright-for-Electron. `claude` is the scripted stand-in in
// .supervisor/m13-fake. The agent library is a temp folder (COMMAND_CENTER_LIBRARY), never the real one.
// usage: node .supervisor/M15.verify.mjs <workFolder>
//   (after: npm run build -w packages/core -w packages/mcp-server -w packages/cli && npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const require = createRequire(`${DESKTOP}/package.json`);
const Database = require('better-sqlite3');
const work = process.argv[2];
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const A = join(work, 'project-a');
const B = join(work, 'elsewhere', 'project-b'); // outside the repo and outside project A
const GONE = join(work, 'never-existed');
cpSync(`${REPO}/sample-projects/demo-project`, A, { recursive: true });
const libDir = join(work, 'library');
const profile = mkdtempSync(join(tmpdir(), 'cc-m15-profile-'));
const claudeLog = join(profile, 'claude-calls.log');
writeFileSync(claudeLog, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotDir = `${REPO}/.supervisor`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(`${name} [threw]`, false, String(e.message).split('\n')[0]);
  }
};

const baseEnv = {
  ...process.env,
  COMMAND_CENTER_LIBRARY: libDir,
  COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude-run.cmd`,
  FAKE_CLAUDE_LOG: claudeLog,
  FAKE_CLAUDE_PIDS: join(profile, 'pids'),
  FAKE_CLAUDE_DELAY_MS: '300',
};
delete baseEnv.ELECTRON_RENDERER_URL;

let app;
let page;
const errors = [];
async function launch(projectRoot) {
  const env = { ...baseEnv };
  if (projectRoot) env.PROJECT_ROOT = projectRoot;
  else delete env.PROJECT_ROOT;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
  await page.waitForSelector('[role=tab][id^=tab-], main', { timeout: 20000 });
}

const dbPathOf = (root) => join(root, 'command-center.db');
const sql = (root, q, ...a) => {
  const d = new Database(dbPathOf(root), { timeout: 5000 });
  d.pragma('journal_mode = WAL');
  try {
    return /^\s*select/i.test(q) ? d.prepare(q).all(...a) : d.prepare(q).run(...a);
  } finally {
    d.close();
  }
};
const libSql = (q, ...a) => {
  const d = new Database(join(libDir, 'library.db'), { timeout: 5000 });
  try {
    return /^\s*select/i.test(q) ? d.prepare(q).all(...a) : d.prepare(q).run(...a);
  } finally {
    d.close();
  }
};
const waitFor = async (fn, ms = 20000, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
const ipc = (fn, ...args) =>
  page.evaluate(([f, a]) => f.split('.').reduce((o, k) => o[k], window.api)(...a), [fn, args]);
const val = async (fn, ...args) => {
  const r = await ipc(fn, ...args);
  if (!r.ok) throw new Error(`${fn}: ${r.error.message}`);
  return r.value;
};
const claudeCalls = () =>
  readFileSync(claudeLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const shot = (n) => page.screenshot({ path: join(shotDir, `M15-${n}.png`) });
// The REAL theme switch (the title-bar button cycles dark > light > calm > calm dark > system), then wait for the colour
// transitions to finish: measuring or photographing mid-transition shows washed-out colours that are not in the theme.
const themeNow = () =>
  page.evaluate(() => {
    const d = document.documentElement.dataset;
    return d.theme === 'calm' ? (d.mode === 'dark' ? 'calm-dark' : 'calm') : (d.theme ?? '');
  });
const setTheme = async (t) => {
  for (let i = 0; i < 6 && (await themeNow()) !== t; i++) {
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await sleep(150);
  }
  await sleep(700);
};
const tabKey = { hub: 'Control+3', agents: 'Control+7', board: 'Control+2' };
const goto = async (k) => {
  await page.keyboard.press(tabKey[k]);
  await sleep(300);
};
const winPath = (p) => p.toLowerCase().replace(/\//g, '\\');
const sameDir = (a, b) => winPath(a) === winPath(b);
const switchTo = async (path, resume = true) => {
  const e = (await val('projects.list')).find((x) => sameDir(x.path, path));
  await val('projects.switchTo', { id: e.id });
  await sleep(1500);
  if (resume) await val('orchestrator.resume');
};
const startOrch = async () => {
  await page.evaluate(() => window.api.orchestrator.resume());
};
const toast = () => page.locator('[role=status]').last().innerText();

// ---- seed project A: one milestone, an operator-created legacy-free board ----
async function seedBoard(root, domain = 'general') {
  sql(root, "INSERT OR IGNORE INTO milestones (id, title, planned_start, domain) VALUES ('M1', 'Build', '2026-01-05', ?)", domain);
}
const addTask = (root, id, o = {}) =>
  sql(
    root,
    `INSERT INTO subtasks (id, milestone_id, label, priority, assignee, depends_on, status)
     VALUES (?, 'M1', ?, 'P2', ?, '[]', ?)`,
    id,
    o.label ?? `Task ${id}`,
    o.assignee ?? 'copywriter',
    o.status ?? 'todo',
  );
const lastRun = (root, id) =>
  sql(root, 'SELECT * FROM runs WHERE task_id = ? ORDER BY queued_at DESC, rowid DESC', id)[0];
const taskRow = (root, id) => sql(root, 'SELECT status, blocked_reason FROM subtasks WHERE id = ?', id)[0];

await launch(A);
await sleep(1200);
await seedBoard(A);

// =================================================================== library scope
await step('L1 library scope: create once, two projects use it, nothing is copied; one edit reaches both', async () => {
  await goto('agents');
  await page.locator('[data-new-agent]').click();
  await page.getByLabel('Template').selectOption('marketing');
  await page.getByLabel('Name').fill('Copywriter');
  await page.getByLabel('Base instructions').fill('Write plainly. Never invent claims. Marker-V1.');
  await shot('agent-editor-dark');
  await page.getByRole('button', { name: 'Create agent' }).click();
  await page.locator('[data-library-agent="copywriter"]').waitFor({ timeout: 8000 });
  check('L1a the agent is in the library list (UI), id is a slug', true);
  await shot('agents-page-dark');
  // Assign in project A through the picker.
  await goto('hub');
  await page.locator('[data-add-agents]').click();
  await page.getByLabel('Add Copywriter').check();
  await shot('picker-dark');
  await page.getByRole('button', { name: /^Add 1 agent/ }).click();
  await page.locator('[data-project-agent="copywriter"]').waitFor({ timeout: 8000 });
  check('L1b the picker offered it and the project now lists it under Project agents', true);
  // Project B: created in a folder the operator chose, outside Command Center's folder.
  const made = await val('projects.create', { path: B, name: 'Second Project' });
  check('L1c New project in a chosen folder writes project.json, README, AGENTS.md and details/ there',
    ['project.json', 'README.md', 'AGENTS.md', 'details/README.md'].every((f) => existsSync(join(B, f))) &&
      !B.toLowerCase().startsWith(REPO.toLowerCase().replace(/\//g, '\\')), made.info.root);
  check('L1d the new project database lives in that folder', existsSync(dbPathOf(B)));
  await seedBoard(B);
  await page.waitForTimeout(600);
  await goto('hub');
  await page.locator('[data-add-agents]').click();
  const offered = await page.getByLabel('Add Copywriter').count();
  check('L1e the same agent appears in the second project’s picker', offered === 1);
  await page.getByLabel('Add Copywriter').check();
  await page.getByRole('button', { name: /^Add 1 agent/ }).click();
  await page.locator('[data-project-agent="copywriter"]').waitFor({ timeout: 8000 });
  const libCount = libSql("SELECT COUNT(*) n FROM library_agents WHERE name = 'Copywriter'")[0].n;
  check('L1f exactly one library row exists (no copy per project)', libCount === 1);
  // Edit once; both mirrors follow.
  await goto('agents');
  await page.getByRole('button', { name: 'Edit Copywriter' }).click();
  await page.getByLabel('Name').fill('Senior copywriter');
  await page.getByLabel('Base instructions').fill('Write plainly. Never invent claims. Marker-V2.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await sleep(800);
  await page.evaluate(() => window.api.projectAgents.list()); // B is open: syncs when listed/ticked
  await sleep(6000); // a scheduling pass syncs mirrors
  const nameB = sql(B, "SELECT name FROM agents WHERE id = 'copywriter'")[0]?.name;
  check('L1g after one edit the second project’s agent row follows', nameB === 'Senior copywriter', nameB);
  // Switch back to A and check its row as well.
  const entries = await val('projects.list');
  const aEntry = entries.find((e) => e.path.toLowerCase() === A.toLowerCase().replace(/\//g, '\\'));
  await val('projects.switchTo', { id: aEntry.id });
  await sleep(6500);
  const nameA = sql(A, "SELECT name FROM agents WHERE id = 'copywriter'")[0]?.name;
  check('L1h and so does the first project’s', nameA === 'Senior copywriter', nameA);
});

// =================================================================== switcher
await step('S1 switcher: lists both, missing folder shows its error and cannot be opened, switching reloads and says it paused dispatch', async () => {
  // register a project whose folder does not exist: add a registry row directly
  libSql("INSERT INTO projects (id, name, slug, path, created_at) VALUES ('ghost', 'Ghost', 'ghost', ?, '2026-01-01T00:00:00Z')", GONE.replace(/\//g, '\\'));
  await page.locator('[data-project-switcher]').click();
  await page.locator('[data-project]').first().waitFor({ timeout: 8000 });
  const rows = await page.locator('[data-project]').count();
  check('S1a the switcher lists the registered projects', rows >= 3, `rows=${rows}`);
  const ghost = page.locator('[data-project="ghost"]');
  const ghostText = await ghost.innerText();
  check('S1b the missing folder shows its error', /does not exist/.test(ghostText));
  check('S1c2 a Locate folder button is offered for it', (await page.getByRole('button', { name: 'Locate the folder of Ghost' }).count()) === 1);
  check('S1c and its Open button is disabled', await page.getByRole('button', { name: 'Open Ghost' }).isDisabled());
  await shot('switcher-dark');
  await page.keyboard.press('Escape');
  await setTheme('calm');
  await page.locator('[data-project-switcher]').click();
  await page.locator('[data-project]').first().waitFor({ timeout: 8000 });
  await sleep(400);
  await shot('switcher-calm');
  await page.keyboard.press('Escape');
  await setTheme('dark');
  await page.locator('[data-project-switcher]').click();
  await page.locator('[data-project]').first().waitFor({ timeout: 8000 });
  // Running dispatch in A, then switch to B: A is paused and the app says so.
  await page.evaluate(() => window.api.orchestrator.resume());
  await sleep(500);
  const modeBefore = sql(A, "SELECT value FROM settings WHERE key = 'orchestrator.mode'")[0]?.value;
  await page.getByRole('button', { name: /^Open Second Project/ }).click();
  await waitFor(async () => (await page.locator('[data-project-switcher]').innerText()).includes('Second Project'), 10000);
  const t = await page.getByText(/Dispatch for .* was paused/).first().innerText();
  check('S1d switching reloads the title to the second project', (await page.locator('[data-project-switcher]').innerText()).includes('Second Project'));
  check('S1e the app says dispatch for the previous project was paused', /Dispatch for .* was paused/.test(t), t);
  const modeAfter = sql(A, "SELECT value FROM settings WHERE key = 'orchestrator.mode'")[0]?.value;
  check('S1f project A’s orchestrator mode is now paused in its own database', modeAfter === 'paused', `${modeBefore} -> ${modeAfter}`);
  const hubB = sql(B, 'SELECT COUNT(*) n FROM subtasks')[0].n;
  check('S1g the views show project B’s data, not A’s', hubB === 0 && (await page.locator('[data-project-switcher]').innerText()).includes('Second Project'));
  await page.locator('[data-project-switcher]').click();
  await page.getByRole('button', { name: /^Open Demo Project/ }).click();
  await waitFor(async () => (await page.locator('[data-project-switcher]').innerText()).includes('Demo Project'), 10000);
  check('S1h switching back restores the first project', (await page.locator('[data-project-switcher]').innerText()).includes('Demo Project'));
});

// =================================================================== precedence + live spec
await step('P1 precedence: the spec forbids a tool, the run record shows the layers and the tool is disallowed; spec removed still runs', async () => {
  writeFileSync(join(A, 'AGENTS.md'), '# Project Spec\n\nRules for copy.\n\n## Forbidden tools\n- Bash\n');
  addTask(A, 'P1');
  await val('orchestrator.resume');
  await waitFor(() => lastRun(A, 'P1')?.status === 'succeeded', 25000);
  const run = lastRun(A, 'P1');
  const layers = JSON.parse(run.layers);
  check('P1a run record stores layers in order: profile, project_spec, task_context', layers.join() === 'profile,project_spec,task_context', run.layers);
  check('P1b run record stores the spec hash and "ok"', /^[0-9a-f]{64}$/.test(run.spec_hash) && run.spec_status === 'ok');
  const call = claudeCalls().find((c) => c.id === 'P1');
  const i = call?.args.indexOf('--disallowedTools');
  check('P1c the provider was started with the forbidden tool disallowed', i >= 0 && call.args[i + 1] === 'Bash', JSON.stringify(call?.args.slice(i, i + 2)));
  const sys = call?.prompt ?? '';
  check('P1d the system prompt carries the agent’s profile before the project rules', sys.indexOf('Marker-V2') > -1 && sys.indexOf('Marker-V2') < sys.indexOf('Project rules'), `len=${sys.length}`);
  // live edit
  writeFileSync(join(A, 'AGENTS.md'), '# Project Spec\n\nRules for copy. One line changed.\n');
  addTask(A, 'P2');
  await waitFor(() => lastRun(A, 'P2')?.status === 'succeeded', 25000);
  check('H1 changing a line of AGENTS.md between runs: the second run records a new hash', lastRun(A, 'P2').spec_hash !== run.spec_hash && lastRun(A, 'P2').spec_hash !== null);
  // remove the spec
  rmSync(join(A, 'AGENTS.md'));
  await sleep(2500);
  await page.locator('[data-notice="no-spec"]').waitFor({ timeout: 10000 });
  check('P1e with the spec removed the project shows the "no project spec" notice', true);
  await shot('no-spec-notice-dark');
  addTask(A, 'P3');
  await waitFor(() => lastRun(A, 'P3')?.status === 'succeeded', 25000);
  const r3 = lastRun(A, 'P3');
  check('P1f the run still starts and records spec_status "missing"', r3.status === 'succeeded' && r3.spec_status === 'missing' && r3.spec_hash === null);
  writeFileSync(join(A, 'AGENTS.md'), '# Project Spec\n\nRestored.\n');
});

// =================================================================== assignment, deletion
await step('A1 assignment and D35 deletion', async () => {
  await goto('hub');
  sql(A, "UPDATE project_agents SET extra_constraints = '[\"Arabic first\"]' WHERE library_agent_id = 'copywriter'");
  await page.getByRole('button', { name: 'Remove Senior copywriter from this project' }).click();
  await page.getByRole('button', { name: 'Remove from project' }).click();
  await sleep(800);
  check('A1a removing leaves the library agent', libSql("SELECT COUNT(*) n FROM library_agents WHERE id = 'copywriter'")[0].n === 1);
  check('A1b and removes only the link', sql(A, "SELECT removed_at FROM project_agents WHERE library_agent_id = 'copywriter'")[0].removed_at !== null);
  await page.locator('[data-add-agents]').click();
  await page.getByLabel('Add Senior copywriter').check();
  await page.getByRole('button', { name: /^Add 1 agent/ }).click();
  await sleep(800);
  const row = sql(A, "SELECT extra_constraints, removed_at FROM project_agents WHERE library_agent_id = 'copywriter'")[0];
  check('A1c adding it back restores its project settings', row.removed_at === null && row.extra_constraints.includes('Arabic first'), JSON.stringify(row));
  // deletion rule: unused agent deletes, an agent with runs archives
  const tmp = await val('library.create', { name: 'Scratch', role: 'general' });
  const del1 = await val('library.remove', tmp.id);
  check('A1d an unassigned agent with no runs is deleted', del1.result === 'deleted' && libSql("SELECT COUNT(*) n FROM library_agents WHERE id = ?", tmp.id)[0].n === 0);
  const del2 = await val('library.remove', 'copywriter');
  check('A1e an agent with runs and a project link is archived, still readable', del2.result === 'archived' && libSql("SELECT status FROM library_agents WHERE id = 'copywriter'")[0].status === 'archived');
  await val('library.restore', 'copywriter');
  await goto('agents');
  await shot('agents-page-dark-2');
});

// =================================================================== lessons
await step('LS lesson scopes, required reading, recurrence, drafts', async () => {
  // a second library agent that never gets the lesson
  await val('library.create', { name: 'Illustrator', role: 'design', base_instructions: 'Draw.' });
  await val('projectAgents.assign', ['illustrator']);
  addTask(A, 'R1', { label: 'Write headline copy for landing page' });
  await waitFor(() => taskRow(A, 'R1').status === 'review', 25000);
  // reject through the real reject dialog, with an automatic check
  await goto('board');
  await page.getByRole('button', { name: 'Reject R1' }).click();
  await page.getByLabel(/What is wrong/).fill('Headline used the word revolutionary');
  await page.getByLabel(/Prevention check/).fill('no-match **/*.md /revolutionary/i');
  await page.getByLabel(/Automatic/).check();
  await page.getByLabel(/Trigger keywords/).fill('headline landing copy');
  await shot('reject-dialog-dark');
  await page.getByRole('button', { name: 'Reject', exact: true }).last().click();
  await sleep(900);
  const les = sql(A, "SELECT * FROM lessons_learned WHERE subtask_id = 'R1' ORDER BY id DESC")[0];
  check('LS1 a rejected task creates a project-scope lesson (active, because a check was given)', les.scope === 'project' && les.status === 'active' && les.check_type === 'automatic', JSON.stringify({ s: les.scope, st: les.status }));
  // a lesson without a check stays a draft
  await ipc('tasks.transition', { taskId: 'R1', trigger: 'start' });
  const afterReject = taskRow(A, 'R1');
  // required reading: next matching run stores the lesson id
  addTask(A, 'R2', { label: 'Write headline copy for the pricing page' });
  await waitFor(() => lastRun(A, 'R2')?.status === 'succeeded', 25000);
  const r2 = lastRun(A, 'R2');
  check('LR1 a run with a matching lesson stores the lesson id', JSON.parse(r2.lesson_ids).includes(`p:${les.id}`), r2.lesson_ids);
  const sysText = claudeCalls().find((c) => c.id === 'R2')?.prompt ?? '';
  check('LR2 and the prompt has the "Before you start" block', /Before you start/.test(sysText));
  addTask(A, 'R3', { label: 'Update the footer links' });
  await waitFor(() => lastRun(A, 'R3')?.status === 'succeeded', 25000);
  check('LR3 a run with no matching lesson stores the lookup with an empty result', lastRun(A, 'R3').lesson_ids === '[]', lastRun(A, 'R3').lesson_ids);
  // promote to agent through the Lessons panel
  await goto('hub');
  await page.locator(`[data-lesson="${les.id}"][data-lesson-source="project"]`).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: `Promote lesson ${les.id}` }).click();
  await page.getByLabel('Promote to').selectOption('copywriter');
  await shot('promote-dark');
  await page.getByRole('button', { name: 'Promote', exact: true }).click();
  await sleep(900);
  const lib1 = libSql("SELECT * FROM lessons WHERE scope = 'agent'")[0];
  check('LS2 promoting to an agent writes an agent-scope library lesson for that agent', lib1?.agent_id === 'copywriter');
  check('LS3 and logs an agent_log entry', sql(A, "SELECT COUNT(*) n FROM agent_log WHERE action LIKE '%lesson%promot%'")[0].n >= 1);
  // second project: create a task for copywriter => lesson applies; for illustrator => not
  await val('projectAgents.assign', ['illustrator']).catch(() => undefined);
  await switchTo(B);
  await val('projectAgents.assign', ['illustrator']);
  addTask(B, 'B1', { label: 'Write headline copy for landing', assignee: 'copywriter' });
  addTask(B, 'B2', { label: 'Write headline copy for landing', assignee: 'illustrator' });
  await waitFor(() => lastRun(B, 'B1')?.status === 'succeeded' && lastRun(B, 'B2')?.status === 'succeeded', 40000);
  check('LS4 the agent-scope lesson reaches a SECOND project for the same agent', JSON.parse(lastRun(B, 'B1').lesson_ids).some((x) => x.startsWith('l:')), lastRun(B, 'B1').lesson_ids);
  check('LS5 and not for a different agent', JSON.parse(lastRun(B, 'B2').lesson_ids).length === 0, lastRun(B, 'B2').lesson_ids);
  // back to A: promote another to global
  await switchTo(A);
  sql(A, "INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied, prevention, created_at, scope, trigger_keywords, check_text, check_type, status, updated_at) VALUES ('R1', 'Footer links must stay lowercase', '', '', '2026-03-01T00:00:00Z', 'project', 'footer links', 'Check the footer wording', 'manual', 'active', '2026-03-01T00:00:00Z')");
  const gl = sql(A, "SELECT id FROM lessons_learned WHERE rejection_reason LIKE 'Footer links%'")[0].id;
  await val('lessons.promote', { id: gl, target: { scope: 'global' } });
  addTask(A, 'G1', { label: 'Update the footer links', assignee: 'copywriter' });
  addTask(A, 'G2', { label: 'Update the footer links', assignee: 'illustrator' });
  await waitFor(() => lastRun(A, 'G1')?.status === 'succeeded' && lastRun(A, 'G2')?.status === 'succeeded', 40000);
  check('LS6 a global lesson appears for both agents', JSON.parse(lastRun(A, 'G1').lesson_ids).some((x) => x.startsWith('l:')) && JSON.parse(lastRun(A, 'G2').lesson_ids).some((x) => x.startsWith('l:')));

  // draft rule
  await ipc('tasks.transition', { taskId: 'G1', trigger: 'reject', payload: { reason: 'Left a TODO in the page', noLesson: false } });
  await sleep(700);
  const draft = sql(A, "SELECT id, status FROM lessons_learned WHERE rejection_reason LIKE 'Left a TODO%'")[0];
  check('DR0 a rejection with no check makes a draft lesson', draft?.status === 'draft');
  await goto('hub');
  await page.getByRole('button', { name: `Promote lesson ${draft.id}` }).click();
  const blocked = await page.locator('[data-promote-blocked]').innerText();
  check('DR1 the UI explains why a draft cannot be promoted', /no prevention check/.test(blocked), blocked.slice(0, 80));
  const refuse = await ipc('lessons.promote', { id: draft.id, target: { scope: 'global' } });
  check('DR2 and the main process refuses it too', refuse.ok === false);
  await shot('lessons-draft-dark');

  // recurrence: same mistake twice after the lesson is active
  addTask(A, 'RC1', { label: 'Write headline copy for faq' });
  await waitFor(() => taskRow(A, 'RC1').status === 'review', 25000);
  const pid = sql(A, "SELECT id FROM lessons_learned WHERE rejection_reason LIKE 'Left a TODO%'")[0].id;
  await val('lessons.update', { id: pid, patch: { check_text: 'Search the page for TODO', check_type: 'manual' } });
  await ipc('tasks.transition', { taskId: 'RC1', trigger: 'reject', payload: { reason: 'TODO again', sameAs: pid } });
  await sleep(500);
  await ipc('tasks.transition', { taskId: 'RC1', trigger: 'start' });
  await ipc('tasks.transition', { taskId: 'RC1', trigger: 'complete', payload: { summary: 'again' } }).catch(() => undefined);
  await ipc('tasks.transition', { taskId: 'RC1', trigger: 'reject', payload: { reason: 'TODO once more', sameAs: pid } });
  await sleep(700);
  const rec = sql(A, 'SELECT occurrences, status FROM lessons_learned WHERE id = ?', pid)[0];
  check('RC1 two repeats make occurrences 2 and the status needs_rewrite', rec.occurrences === 2 && rec.status === 'needs_rewrite', JSON.stringify(rec));
  await goto('hub');
  await page.locator('[data-lesson-filter="needs_rewrite"]').click();
  await page.locator(`[data-lesson="${pid}"] [data-lesson-warning]`).waitFor({ timeout: 8000 });
  check('RC2 the Lessons panel shows it with the warning under the Needs rewrite filter', true);
  await shot('lessons-needs-rewrite-dark');
  await setTheme('calm');
  await shot('lessons-needs-rewrite-calm');
  await setTheme('dark');
  void afterReject;
});

// =================================================================== automatic check
await step('AC automatic check fails a task that breaks it and passes a fixed one', async () => {
  const l = sql(A, "INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied, prevention, created_at, scope, trigger_keywords, check_text, check_type, status, updated_at) VALUES ('P1', 'The release notes file must exist', '', '', '2026-03-02T00:00:00Z', 'project', 'release notes', 'file-exists RELEASE_NOTES.md', 'automatic', 'active', '2026-03-02T00:00:00Z')");
  const lid = Number(l.lastInsertRowid);
  addTask(A, 'AC1', { label: 'Write the release notes' });
  await waitFor(() => lastRun(A, 'AC1')?.status === 'succeeded', 25000);
  await sleep(1200);
  const t = taskRow(A, 'AC1');
  const occ = sql(A, 'SELECT occurrences FROM lessons_learned WHERE id = ?', lid)[0].occurrences;
  check('AC1 the task went back to In Progress and the reason names the lesson', t.status === 'in_progress' || /Automatic check failed.*lesson #/.test(JSON.stringify(sql(A, "SELECT description FROM agent_log WHERE target_id = 'AC1' ORDER BY timestamp DESC LIMIT 3"))), JSON.stringify(t));
  check('AC2 and the lesson’s occurrences increased', occ === 1, `occurrences=${occ}`);
  writeFileSync(join(A, 'RELEASE_NOTES.md'), '# Notes\n');
  await ipc('tasks.transition', { taskId: 'AC1', trigger: 'complete', payload: { summary: 'fixed' } });
  await sleep(1200);
  check('AC3 the same check passes on the fixed task (it stays in Review)', taskRow(A, 'AC1').status === 'review');
  rmSync(join(A, 'RELEASE_NOTES.md'));
});

// =================================================================== malformed project file
await step('MF a malformed project.json blocks dispatch for that project only', async () => {
  const good = readFileSync(join(A, 'project.json'), 'utf8');
  writeFileSync(join(A, 'project.json'), JSON.stringify({ name: 'Demo Project', slug: 'Bad Slug!' }));
  await sleep(2500);
  await page.locator('[data-notice="dispatch-blocked"]').waitFor({ timeout: 10000 });
  const text = await page.locator('[data-notice="dispatch-blocked"]').innerText();
  check('MF1 the notice names the bad field', /slug/.test(text), text.slice(0, 100));
  await shot('dispatch-blocked-dark');
  addTask(A, 'MF1', { label: 'Blocked task' });
  await sleep(9000);
  check('MF2 nothing was dispatched in this project', !lastRun(A, 'MF1'));
  // the switcher still lists it, flagged, so it can be opened to fix it
  const listed = (await val('projects.list')).find((x) => x.current);
  check('MF3 the switcher flags it as dispatch blocked but still lets it be opened', listed?.dispatchBlock && listed.openable);
  await switchTo(B);
  addTask(B, 'MF2', { label: 'Runs fine', assignee: 'copywriter' });
  await waitFor(() => lastRun(B, 'MF2')?.status === 'succeeded', 30000);
  check('MF4 another project keeps running', lastRun(B, 'MF2')?.status === 'succeeded');
  writeFileSync(join(A, 'project.json'), good);
});

// =================================================================== MCP + CLI
await step('MC MCP: a draft only, no way to promote', async () => {
  const sdk = join(REPO, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
  const { Client } = await import(`file:///${sdk}/client/index.js`);
  const { StdioClientTransport } = await import(`file:///${sdk}/client/stdio.js`);
  const entries = await val('projects.list');
  const aE = entries.find((e) => e.path.toLowerCase() === A.toLowerCase().replace(/\//g, '\\'));
  await val('projects.switchTo', { id: aE.id });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [`${REPO}/packages/mcp-server/dist/index.js`],
    env: { ...baseEnv, PROJECT_ROOT: A },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verify-agent', version: '1.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('MC1 the server offers list_library_agents, get_project_spec, get_lessons_for_task, propose_lesson', ['list_library_agents', 'get_project_spec', 'get_lessons_for_task', 'propose_lesson'].every((n) => tools.includes(n)));
  check('MC2 and nothing that creates, promotes or retires', !tools.some((n) => /promote|retire|library_agent$|create_library|assign/.test(n)) && tools.length === 34, `${tools.length} tools`);
  const callTool = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: r.content?.[0]?.text ?? '' };
  };
  const lib = await callTool('list_library_agents', {});
  check('MC3 list_library_agents returns the library', !lib.isError && /copywriter/.test(lib.text));
  const spec = await callTool('get_project_spec', {});
  check('MC4 get_project_spec returns the spec and its hash', /spec_hash/.test(spec.text));
  const p = await callTool('propose_lesson', { task_id: 'P1', reason: 'Agent proposes: keep headings short', check: 'no-match **/*.md /TODO/' });
  const pj = JSON.parse(p.text);
  check('MC5 propose_lesson creates a draft, project scope', pj.status === 'draft' && pj.scope === 'project', p.text);
  const bad = await callTool('propose_lesson', { task_id: 'P1', reason: 'x', scope: 'global', status: 'active' });
  check('MC6 scope and status cannot be passed (strict schema)', bad.isError);
  const row = sql(A, 'SELECT status, scope, check_type FROM lessons_learned WHERE id = ?', pj.lesson_id)[0];
  check('MC7 the row is a draft with no active check', row.status === 'draft' && row.check_type === 'none');
  await client.close();
});

await step('CLI the operator commands', async () => {
  const cli = (...args) =>
    execFileSync('node', [`${REPO}/packages/cli/dist/index.js`, ...args], {
      env: { ...baseEnv, PROJECT_ROOT: A },
      encoding: 'utf8',
    });
  const ps = cli('project', 'status');
  check('CLI1 project status shows folder, spec and agents', /Project spec:/.test(ps) && /Agents:/.test(ps), ps.split('\n').slice(0, 3).join(' | '));
  const pr = cli('projects');
  check('CLI2 projects lists the registry with the missing folder’s error', /Ghost[\s\S]*does not exist/.test(pr) && /Second Project/.test(pr));
  const ag = cli('agents', '--library');
  check('CLI3 agents --library lists library agents', /copywriter/.test(ag) && /illustrator/.test(ag));
  const nr = cli('lessons', '--needs-rewrite');
  check('CLI4 lessons --needs-rewrite lists the lesson that needs a rewrite', /2x/.test(nr), nr.trim().slice(0, 80));
});

// =================================================================== restart: path reopens
await step('F2 the chosen folder is saved and reopens after a restart', async () => {
  const entries = await val('projects.list');
  const bE = entries.find((e) => e.path.toLowerCase() === B.toLowerCase().replace(/\//g, '\\'));
  await val('projects.switchTo', { id: bE.id });
  await sleep(800);
  await app.close();
  await launch(null);
  await sleep(1500);
  const info = await val('project.get').catch(async () => await ipc('project.get'));
  const root = (info.root ?? info.value?.root ?? '').toLowerCase();
  check('F2 after a restart, with no PROJECT_ROOT, the app opens the folder the operator chose', root === B.toLowerCase().replace(/\//g, '\\') || root === B.toLowerCase(), root);
  await shot('after-restart-dark');
});


// =================================================================== UI/UX section 9: contrast in all four themes
// Every visible text element: foreground vs the first opaque background up the tree, WCAG ratio.
const contrastScan = () =>
  page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      let base = { r: 12, g: 20, b: 16, a: 1 };
      for (const l of layers.reverse()) base = blend(l, base);
      return base;
    };
    const bad = [];
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest('.xterm, svg, [aria-hidden=true], script, style')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.offsetParent === null) continue;
      if (el.closest(':disabled') || el.closest('[disabled]')) continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const f = blend({ ...fg, a: fg.a * Number(cs.opacity) }, bg);
      const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      count++;
      if (ratio < 4.5) bad.push(`${ratio.toFixed(2)} "${text.slice(0, 28)}" <${el.tagName.toLowerCase()}>`);
    }
    return { count, bad };
  });


await step('UX contrast: new views meet 4.5:1 in dark, light, calm and calm dark', async () => {
  await switchTo(A, true);
  for (const theme of ['dark', 'light', 'calm', 'calm-dark']) {
    await setTheme(theme);
    await goto('agents');
    await shot(`ux-${theme}-agents`);
    let r = await contrastScan();
    check(`UX ${theme}: Agents page`, r.bad.length === 0, [...new Set(r.bad)].slice(0, 12).join(' | ') || `${r.count} texts`);
    await goto('hub');
    await shot(`ux-${theme}-agent-hub`);
    r = await contrastScan();
    check(`UX ${theme}: Agent Hub (project agents, lessons)`, r.bad.length === 0, [...new Set(r.bad)].slice(0, 12).join(' | ') || `${r.count} texts`);
    await page.locator('[data-project-switcher]').click();
    await sleep(300);
    await shot(`ux-${theme}-switcher`);
    r = await contrastScan();
    check(`UX ${theme}: project switcher`, r.bad.length === 0, [...new Set(r.bad)].slice(0, 12).join(' | ') || `${r.count} texts`);
    await page.keyboard.press('Escape');
    await page.locator('[data-project-switcher]').click();
    await page.getByRole('button', { name: /New project/ }).click();
    await page.getByLabel('Project folder').fill(join(work, 'preview-only'));
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.locator('[data-scaffold-plan]').waitFor({ timeout: 8000 });
    r = await contrastScan();
    check(`UX ${theme}: new project dialog with plan`, r.bad.length === 0, [...new Set(r.bad)].slice(0, 12).join(' | ') || `${r.count} texts`);
    await shot(`ux-${theme}-new-project`);
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  await setTheme('dark');
});

await step('RL a moved project folder can be located again', async () => {
  const moved = join(work, 'moved-here');
  cpSync(A, moved, { recursive: true });
  const ghost = (await val('projects.list')).find((x) => x.id === 'ghost');
  check('RL1 the missing project is listed as not openable', ghost && !ghost.openable);
  const after = await val('projects.relocate', { id: 'ghost', path: moved });
  const g2 = after.find((x) => x.id === 'ghost');
  check('RL2 after locating the new folder it is openable and keeps its entry', g2?.openable && sameDir(g2.path, moved), g2?.path);
  const bad = await ipc('projects.relocate', { id: 'ghost', path: join(work, 'nothing-here') });
  check('RL3 a folder that does not exist is refused', bad.ok === false);
});

await step('X no unexpected console errors', async () => {
  const real = errors.filter((e) => !/Download the React DevTools|ResizeObserver/.test(e));
  check('X1 no console errors or warnings during the run', real.length === 0, real.slice(0, 3).join(' | '));
});

await app.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
