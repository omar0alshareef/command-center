// Drives the BUILT app (apps/desktop/out) through the M13 exit criteria with Playwright-for-Electron.
// The planner runs the real child-process path against a scripted `claude` (.supervisor/m13-fake), so
// cancel, process-tree kill, truncation and malformed output are exercised without a Claude login.
// usage: node .supervisor/M13.verify.mjs <screenshotDir>      (after: npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const require = createRequire(`${DESKTOP}/package.json`);
const Database = require('better-sqlite3');
const shots = process.argv[2] ?? join(tmpdir(), 'cc-m13-shots');
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'cc-m13-'));
const profile = mkdtempSync(join(tmpdir(), 'cc-m13-profile-'));
const modeFile = join(root, 'fake-mode.txt');
const pidsFile = join(root, 'fake-pids.json');
const setMode = (m) => writeFileSync(modeFile, m);
setMode('normal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const env = {
  ...process.env,
  PROJECT_ROOT: root,
  COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude.cmd`,
  COMMAND_CENTER_PLANNER_CAP: '6000',
  FAKE_CLAUDE_MODE: modeFile,
  FAKE_CLAUDE_PIDS: pidsFile,
  FAKE_CLAUDE_LOG: join(root, 'fake.log'),
};
delete env.ELECTRON_RENDERER_URL;

let app;
let page;
const errors = [];
async function launch() {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
  await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });
}
const db = () => new Database(join(root, 'command-center.db'), { readonly: true });
const q = (sql, ...a) => {
  const d = db();
  try {
    return d.prepare(sql).all(...a);
  } finally {
    d.close();
  }
};
const board = () => ({
  milestones: q('SELECT COUNT(*) n FROM milestones')[0].n,
  tasks: q('SELECT COUNT(*) n FROM subtasks')[0].n,
  teamAgents: q("SELECT COUNT(*) n FROM agents WHERE id LIKE '%-team' OR id LIKE 'brand%'")[0].n,
});
const waitText = (t, timeout = 15000) => page.getByText(t, { exact: false }).first().waitFor({ timeout });
const draftTab = (name) => page.locator('[role=tablist][aria-label=Draft] [role=tab]', { hasText: name });
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`) });
const alive = (pid) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
  } catch {
    return false;
  }
};
const newSession = async (idea) => {
  await page.getByRole('button', { name: 'New plan' }).click();
  await page.locator('#plan-idea').fill(idea);
  await page.locator('#plan-idea').press('Control+Enter');
};

await launch();
await page.setViewportSize?.({ width: 1280, height: 800 });

await step('V1 six tabs, Ctrl+6 opens Planning', async () => {
  check('V1a six tabs', (await page.locator('[role=tab][id^=tab-]').count()) === 6);
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').waitFor({ timeout: 5000 });
  check('V1b Ctrl+6 shows the Planning composer', true);
});

await step('V2 interview: >= 3 questions before any draft', async () => {
  await page.locator('#plan-idea').fill(
    'A booking app for small yoga studios. Members book classes in two taps, studio owners manage the weekly schedule and see attendance.',
  );
  await page.locator('#plan-idea').press('Control+Enter');
  await page.locator('#answer-2').waitFor({ timeout: 15000 });
  const questions = await page.locator('[id^=answer-]').count();
  check('V2a three planner questions', questions === 3, `${questions} questions`);
  check('V2b no manifesto drafted yet', await page.getByText('No manifesto drafted yet.').isVisible());
  check('V2c board untouched', board().milestones === 0 && board().tasks === 0);
  await shot('01-interview-dark');
});

await step('V3 answers persist and the session resumes after restart', async () => {
  await page.locator('#answer-0').fill('Studio owners and their members');
  await page.locator('#answer-1').fill('Launch in 30 days');
  await page.locator('#answer-2').fill('Web first');
  await page.locator('#answer-2').blur();
  await sleep(500);
  await app.close();
  await launch();
  await page.keyboard.press('Control+6');
  await page.locator('#answer-2').waitFor({ timeout: 8000 });
  const vals = await Promise.all([0, 1, 2].map((i) => page.locator(`#answer-${i}`).inputValue()));
  check('V3 answers survive a restart and the session reopens', vals.join('|') === 'Studio owners and their members|Launch in 30 days|Web first', vals.join('|'));
});

await step('V4 send answers -> planner ready -> drafts in review', async () => {
  await page.locator('#answer-2').focus();
  await page.keyboard.press('Control+Enter'); // keyboard send
  await page.getByRole('button', { name: 'Approve plan' }).waitFor({ timeout: 30000 });
  check('V4a session reaches review', true);
  check('V4b board still untouched before approval (no leak)', board().milestones === 0 && board().tasks === 0 && board().teamAgents === 0, JSON.stringify(board()));
  await draftTab('manifesto').click();
  check('V4c manifesto renders markdown (h1 + strong + list)', (await page.locator('[role=tabpanel][aria-label=manifesto] h1', { hasText: 'Manifesto' }).count()) === 1 && (await page.locator('[role=tabpanel][aria-label=manifesto] strong', { hasText: 'two taps' }).count()) === 1 && (await page.locator('[role=tabpanel][aria-label=manifesto] li').count()) >= 2);
  check('V4d assumptions highlighted', await page.getByText('Studios have fewer than 50 members').isVisible());
  await shot('02-manifesto-dark');
  await draftTab('roadmap').click();
  check('V4e roadmap renders headings', (await page.locator('[role=tabpanel][aria-label=roadmap] h2').count()) === 2);
});

await step('V5 capabilities and team', async () => {
  await draftTab('milestones').click();
  const rows = page.locator('[role=tabpanel] tbody tr');
  check('V5a two milestone rows', (await rows.count()) === 2);
  const m1 = await rows.nth(0).locator('td').last().innerText();
  const m2 = await rows.nth(1).locator('td').last().innerText();
  check('V5b only M1 lists the Design role', m1.includes('Design') && !m2.includes('Design'), `M1: ${m1} | M2: ${m2}`);
  await shot('03-milestones-dark');
  await draftTab('team').click();
  const nameCell = page.getByLabel('design-team name');
  await nameCell.fill('Brand Studio');
  await nameCell.press('Enter');
  await page.getByLabel('brand-studio name').waitFor({ timeout: 5000 });
  check('V5c rename Design -> Brand Studio (id brand-studio)', true);
  await page.getByRole('button', { name: 'Remove role DevOps' }).count().then(() => undefined);
  await page.getByRole('button', { name: 'Add role' }).isDisabled();
  await page.locator('#new-role').fill('Content');
  await page.locator('#new-role').press('Enter');
  await page.getByLabel('content name').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Remove role Content' }).click();
  await sleep(400);
  check('V5d add then remove a role', (await page.getByLabel('content name').count()) === 0);
  await draftTab('tasks').click();
  const t1Assignee = await page.getByLabel('T1 assignee').inputValue();
  check('V5e renamed role carries its task', t1Assignee === 'brand-studio', t1Assignee);
  await shot('04-team-dark');
});

await step('V6 edits persist to the draft and survive restart', async () => {
  await draftTab('manifesto').click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const ta = page.getByLabel('manifesto markdown');
  await ta.fill('# Manifesto\n\nEdited by the operator.');
  await page.getByRole('button', { name: 'Done' }).click();
  await draftTab('tasks').click();
  const due = page.getByLabel('T4 due date');
  await due.fill('2030-01-15');
  await due.press('Enter');
  await sleep(600);
  await app.close();
  await launch();
  await page.keyboard.press('Control+6');
  await draftTab('manifesto').waitFor({ timeout: 8000 });
  await draftTab('manifesto').click();
  check('V6a manifesto edit survived restart', await page.getByText('Edited by the operator.').isVisible());
  await draftTab('tasks').click();
  check('V6b task due-date edit survived restart', (await page.getByLabel('T4 due date').inputValue()) === '2030-01-15');
  check('V6c still nothing on the board', board().tasks === 0);
});

const before = JSON.stringify(board());
await step('V7 validation: malformed outputs never reach the board', async () => {
  setMode('bad-due');
  await newSession('Second idea to test a malformed due date from the planner.');
  await page.locator('#answer-0').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Draft plan now' }).click();
  await page.getByText("The planner's output was not used").waitFor({ timeout: 30000 });
  const err = await page.locator('[role=alert] pre').innerText();
  check('V7a wrong due_date type: error names the field', /plan_tasks: tasks\.0\.due_date/.test(err), err.split('\n')[0]);
  await shot('05-validation-error-dark');

  setMode('bad-dep');
  await page.getByRole('button', { name: 'Redraft' }).click(); // a failed draft leaves the session in drafting
  await page.getByText('Fix before approving').waitFor({ timeout: 30000 });
  const issues = await page.locator('[role=alert]', { hasText: 'Fix before approving' }).innerText();
  check('V7b missing dependency named, Approve disabled', /T2 .*depends on T99, which does not exist/.test(issues) && (await page.getByRole('button', { name: 'Approve plan' }).isDisabled()), issues.split('\n')[1]);

  setMode('cycle');
  await page.getByRole('button', { name: 'Redraft' }).click();
  await page.getByText('Task dependency cycle').waitFor({ timeout: 30000 });
  const cyc = await page.locator('[role=alert]', { hasText: 'Fix before approving' }).innerText();
  check('V7c dependency cycle named', /T1 → T3 → T2 → T1|cycle: T\d → T\d → T\d → T\d/.test(cyc), cyc.match(/cycle:[^\n]*/)?.[0]);
  check('V7d board unchanged by all three', JSON.stringify(board()) === before, JSON.stringify(board()));
});

await step('V8 truncation notice', async () => {
  setMode('big');
  await newSession('Third idea where the planner talks too much.');
  await page.getByText('was truncated').first().waitFor({ timeout: 20000 });
  check('V8 output over the cap shows a visible notice', true, (await page.getByText('was truncated').first().innerText()).slice(0, 80));
});

await step('V9 cancel kills the child process tree', async () => {
  setMode('hang');
  writeFileSync(pidsFile, '[]');
  await newSession('Fourth idea; the planner will hang and the operator cancels.');
  let pids = [];
  for (let i = 0; i < 40 && pids.length < 2; i++) {
    await sleep(250);
    try {
      pids = JSON.parse(readFileSync(pidsFile, 'utf8'));
    } catch {
      /* not yet */
    }
  }
  check('V9a fake planner and its grandchild are running', pids.length === 2 && pids.every(alive), pids.join(','));
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByText('Cancelled.').waitFor({ timeout: 8000 });
  await sleep(1000);
  check('V9b no orphans after cancel (tasklist)', pids.every((p) => !alive(p)), pids.map((p) => `${p}:${alive(p)}`).join(' '));
});

await step('V10 approval writes everything in one go', async () => {
  setMode('normal');
  await page.locator('aside[aria-label="Planning sessions"] li button').last().click(); // the first (oldest) session
  await page.getByRole('button', { name: 'Approve plan' }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Approve plan' }).focus();
  await page.keyboard.press('Enter');
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor({ timeout: 5000 });
  const body = await dlg.innerText();
  check('V10a confirm lists counts', /2 milestones, 4 tasks \(4 with deadlines\), 2 dependencies and 3 agents/.test(body), body.replace(/\s+/g, ' ').slice(0, 160));
  await shot('06-approve-dialog-dark');
  // keyboard: focus starts on Cancel; Tab to Approve; Enter.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.getByText('Approved — this plan is on the board.').waitFor({ timeout: 8000 });
  const ms = q('SELECT id, planned_start, planned_end FROM milestones ORDER BY id');
  const ts = q('SELECT id, label, status, assignee, due_date, depends_on FROM subtasks ORDER BY id');
  check('V10b milestones with planned dates', ms.length === 2 && ms.every((m) => m.planned_start && m.planned_end), JSON.stringify(ms));
  check('V10c tasks in To Do with assignees and due dates', ts.length === 4 && ts.every((t) => t.status === 'todo') && ts[0].assignee === 'brand-studio' && ts[3].due_date === '2030-01-15', ts.map((t) => `${t.id}:${t.assignee}:${t.due_date}`).join(' '));
  check('V10d dependencies mapped to TASK ids', ts[1].depends_on === JSON.stringify([ts[0].id]), ts[1].depends_on);
  check('V10e team agents registered', q("SELECT id FROM agents WHERE id IN ('brand-studio','frontend-team','backend-team')").length === 3);
  check('V10f docs approved', q("SELECT kind FROM planning_documents WHERE status='approved'").length === 2);
  check('V10g session batches logged', q("SELECT COUNT(*) n FROM agent_log WHERE action LIKE 'plan_%'")[0].n === 5);
});

await step('V11 board after approval', async () => {
  await page.keyboard.press('Control+2');
  await page.waitForSelector('[data-task-id]', { timeout: 8000 });
  check('V11a four cards in To Do', (await page.locator('[data-task-id]').count()) === 4);
  check('V11b past-due task flagged on its card', (await page.getByText('past due', { exact: false }).count()) === 1);
  await shot('07-board-past-due-dark');
  await page.locator('[data-task-id]').first().dblclick().catch(() => undefined);
  await page.keyboard.press('Control+1');
  await page.locator('[data-milestone-id="M1"], [aria-label*="M1"]').first().waitFor({ timeout: 8000 });
  check('V11c M1 and M2 on the Swim Lane', (await page.locator('[data-milestone-id]').count()) >= 2 || (await page.getByText('Booking API').count()) > 0);
  await page.locator('[data-milestone-id="M1"]').first().click();
  await page.getByRole('heading', { name: 'Roadmap' }).waitFor({ timeout: 5000 });
  check('V11d milestone panel shows its roadmap entry', await page.getByText('Logo, colours, landing page by').isVisible());
  await shot('08-milestone-roadmap-dark');
  await page.keyboard.press('Escape');
});

await step('V12 settings: runner and approved documents', async () => {
  await page.keyboard.press('Control+,');
  await page.getByText('Approved plan').waitFor({ timeout: 5000 });
  await page.locator('section[aria-label=Planner]').getByRole('button', { name: 'Roadmap' }).click();
  await page.locator('dialog[open] h2', { hasText: 'Booking API' }).waitFor({ timeout: 5000 });
  check('V12 approved roadmap viewable from Settings', true);
  await shot('09-settings-roadmap-dark');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

await step('V13 light theme screenshots', async () => {
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.keyboard.press('Control+6');
  await page.locator('aside[aria-label="Planning sessions"] li button').nth(1).click();
  await sleep(500);
  await shot('10-planning-light');
  await page.locator('aside[aria-label="Planning sessions"] li button').last().click();
  await draftTab('milestones').click();
  await sleep(300);
  await shot('11-milestones-light');
  await page.keyboard.press('Control+2');
  await sleep(300);
  await shot('12-board-light');
  check('V13 light screenshots taken', true);
});

check('V14 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · project ${root} · screenshots ${shots}`);
process.exit(passed === results.length ? 0 : 1);
