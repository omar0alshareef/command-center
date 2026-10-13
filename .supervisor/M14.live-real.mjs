// REAL `claude` (no stand-in), built app: (1) one orchestrator run on the claude-code provider, (2) one real in-app
// planning session through to approval. Uses the haiku model to keep it quick and cheap.
// usage: node .supervisor/M14.live-real.mjs <emptyProjectFolder>      (after: npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const require = createRequire(`${DESKTOP}/package.json`);
const Database = require('better-sqlite3');
const root = process.argv[2];
mkdirSync(root, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cc-live-profile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${secs()}] ${name}${detail ? '  — ' + detail : ''}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(`${name} [threw]`, false, String(e.message).split('\n')[0]);
  }
};
const env = { ...process.env, PROJECT_ROOT: root };
delete env.ELECTRON_RENDERER_URL;
delete env.COMMAND_CENTER_CLAUDE;
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });

const sql = (q, ...a) => {
  const d = new Database(join(root, 'command-center.db'), { timeout: 5000 });
  try {
    return /^\s*select/i.test(q) ? d.prepare(q).all(...a) : d.prepare(q).run(...a);
  } finally {
    d.close();
  }
};
const waitFor = async (fn, ms, every = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
const ipc = (fn, ...args) => page.evaluate(([f, a]) => f.split('.').reduce((o, k) => o[k], window.api)(...a), [fn, args]);
const shot = (n) => page.screenshot({ path: `${REPO}/.supervisor/M14-real-${n}.png` });

await step('L1 the real claude-code provider: one orchestrator run', async () => {
  sql("INSERT INTO milestones (id, title, planned_start) VALUES ('M1', 'Live', '2026-01-05')");
  sql("INSERT INTO agents (id, name, type) VALUES ('worker', 'Worker', 'sub-agent')");
  await sleep(1500);
  const providers = await ipc('providers.list', true);
  const cc = providers.value.find((p) => p.id === 'claude-code');
  check('L1a claude-code is detected on this machine', cc.available, cc.detail);
  const m = await ipc('models.setAgentModel', { agentId: 'worker', model: 'haiku' });
  check('L1b the agent is set to the haiku alias', m.ok && m.value.model === 'haiku');
  sql(
    `INSERT INTO subtasks (id, milestone_id, label, notes, assignee) VALUES ('LIVE-1', 'M1', 'Say hello', 'Do not create, edit or delete any files. Do not run any commands. Reply with one short sentence, then a last line exactly: SUMMARY: hello from the real claude', 'worker')`,
  );
  const started = await ipc('orchestrator.start', { taskId: 'LIVE-1' });
  check('L1c the manual start (same dispatch path) accepts the task', started.ok, JSON.stringify(started));
  const done = await waitFor(() => sql("SELECT status FROM subtasks WHERE id = 'LIVE-1'")[0].status !== 'in_progress' && sql("SELECT status FROM runs WHERE task_id = 'LIVE-1'")[0]?.status !== 'running', 180_000, 1000);
  const task = sql("SELECT status, blocked_reason FROM subtasks WHERE id = 'LIVE-1'")[0];
  const run = sql("SELECT * FROM runs WHERE task_id = 'LIVE-1'")[0];
  check('L1d the run finished and the task is in Review', done && task.status === 'review', JSON.stringify({ task, status: run?.status, error: run?.error }));
  check('L1e the run is recorded: claude-code / haiku / exit 0 / tokens', run?.provider === 'claude-code' && run.model === 'haiku' && run.exit_code === 0 && run.input_tokens > 0 && run.output_tokens > 0, JSON.stringify({ model: run?.model, in: run?.input_tokens, out: run?.output_tokens }));
  check('L1f the cost is the one claude reported (not an estimate)', run?.cost_basis === 'reported' && run.est_cost_usd > 0, `$${run?.est_cost_usd?.toFixed?.(4)} ${run?.cost_basis}`);
  check('L1g the completion summary came from the agent\'s SUMMARY line', (sql("SELECT description FROM agent_log WHERE action = 'task_completed' AND target_id = 'LIVE-1'")[0]?.description ?? '').includes('hello from the real claude'), run?.output_tail?.slice(-120));
  const files = sql("SELECT COUNT(*) n FROM agent_log WHERE action IN ('file_edited')")[0].n;
  check('L1h the agent made no file edits', files === 0);
});

await step('L2 a real planning session: interview, drafts, validation, approval', async () => {
  const set = await ipc('planning.setSettings', { runner: 'claude-code', model: 'haiku' });
  check('L2a the planner runner is claude-code on haiku', set.ok);
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').waitFor({ timeout: 8000 });
  await page.locator('#plan-idea').fill(
    'A small website for a neighbourhood bakery: a menu page, opening hours, a map, and a form to order a cake for pickup. Two people will build it part-time.',
  );
  await page.locator('#plan-idea').press('Control+Enter');
  // interview rounds: answer whatever is asked, send, repeat until the planner drafts or says it is ready
  let rounds = 0;
  for (; rounds < 3; rounds++) {
    const asked = await waitFor(async () => (await page.locator('[id^=answer-]').count()) > 0, 150_000, 1000);
    if (!asked) break;
    const reviewing = await page.getByRole('button', { name: 'Approve plan' }).count();
    if (reviewing) break;
    const n = await page.locator('[id^=answer-]').count();
    let answered = 0;
    for (let i = 0; i < n; i++) {
      const el = page.locator(`#answer-${i}`);
      if (!(await el.inputValue())) {
        await el.fill(
          [
            'Pickup only, no delivery. Customers are people in the neighbourhood.',
            'Launch in 4 weeks; the cake order form must work by week 3. Budget is small (free hosting).',
            'No on-camera work. Nothing about allergens may be misleading: list them on every cake.',
            'Two part-time builders, one does design and content, one does the code.',
            'Plain HTML and a tiny form handler is fine.',
          ][i % 5],
        );
        answered++;
      }
    }
    if (answered === 0) break;
    await page.locator(`#answer-${n - 1}`).press('Control+Enter');
    console.log(`        interview round ${rounds + 1}: answered ${answered}`);
    await sleep(2000);
    const outcome = await waitFor(async () => {
      if (await page.getByRole('button', { name: 'Approve plan' }).count()) return 'review';
      const busy = await page.getByRole('button', { name: 'Cancel' }).count();
      if (!busy && (await page.locator('[id^=answer-]').count()) > n) return 'more';
      return null;
    }, 240_000, 1500);
    if (outcome === 'review') break;
  }
  // still interviewing? ask for the draft now
  if (!(await page.getByRole('button', { name: 'Approve plan' }).count())) {
    const draft = page.getByRole('button', { name: 'Draft plan now' });
    if (await draft.isEnabled().catch(() => false)) await draft.click();
  }
  const reached = await waitFor(async () => (await page.getByRole('button', { name: 'Approve plan' }).count()) > 0 || (await page.getByText("The planner's output was not used").count()) > 0, 420_000, 2000);
  const failed = (await page.getByText("The planner's output was not used").count()) > 0;
  if (failed) console.log('        planner error:', (await page.locator('[role=alert] pre').first().innerText()).slice(0, 400));
  check('L2b the real planner produced drafts that passed validation (review state)', reached && !failed, `${rounds} interview round(s)`);
  if (!reached || failed) return;
  const counts = await page.locator('footer').last().innerText();
  console.log('        ', counts.replace(/\s+/g, ' ').slice(0, 160));
  const draftTab = (name) => page.locator('[role=tablist][aria-label=Draft] [role=tab]', { hasText: name });
  await draftTab('manifesto').click();
  const manifesto = await page.locator('[role=tabpanel][aria-label=manifesto]').innerText();
  check('L2c a manifesto was written', manifesto.length > 200, `${manifesto.length} characters`);
  await draftTab('milestones').click();
  const ms = await page.locator('[role=tabpanel] tbody tr').count();
  await draftTab('tasks').click();
  const ts = await page.locator('[role=tabpanel] tbody tr').count();
  check('L2d milestones and tasks were drafted', ms >= 2 && ts >= 4, `${ms} milestones, ${ts} tasks`);
  await draftTab('team').click();
  const team = await page.locator('[role=tabpanel] tbody tr').count();
  check('L2e a team roster was proposed', team >= 1, `${team} roles`);
  await shot('planning-team');
  const issues = await page.getByText('Fix before approving').count();
  check('L2f the plan has no blocking validation issue', issues === 0 && !(await page.getByRole('button', { name: 'Approve plan' }).isDisabled()));
  if (issues === 0) {
    await page.getByRole('button', { name: 'Approve plan' }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Approve plan' }).click();
    const approved = await waitFor(() => sql("SELECT status FROM planning_sessions ORDER BY created_at DESC LIMIT 1")[0]?.status === 'approved', 15000, 500);
    const board = sql("SELECT (SELECT COUNT(*) FROM milestones) m, (SELECT COUNT(*) FROM subtasks WHERE id != 'LIVE-1') t, (SELECT COUNT(*) FROM subtasks WHERE due_date IS NOT NULL) d")[0];
    check('L2g approving wrote milestones and tasks to the board', approved && board.m >= 3 && board.t >= 4, JSON.stringify(board));
  }
});

check('L3 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · project ${root} · ${secs()}`);
process.exit(passed === results.length ? 0 : 1);
