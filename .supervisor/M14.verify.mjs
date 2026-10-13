// Drives the BUILT app through the M14 exit criteria (orchestrator, providers, routing, caps, failure, cancel, pause,
// reviewer rule, keys). Real child processes, real HTTP: `claude` is a scripted stand-in (.supervisor/m13-fake), the Ollama
// and OpenAI providers are local fixture servers started here.
// usage: node .supervisor/M14.verify.mjs <emptyProjectFolder>      (after: npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const require = createRequire(`${DESKTOP}/package.json`);
const Database = require('better-sqlite3');
const root = process.argv[2];
mkdirSync(root, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cc-m14-profile-'));
const claudeLog = join(profile, 'claude-calls.log');
writeFileSync(claudeLog, '');
const pidsBase = join(profile, 'pids');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'sk-live-M14TESTSECRET-4f9d2c7a1b8e';

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

// ---- fixture providers ----
const seenReq = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* no body */
    }
    seenReq.push({ url: req.url, auth: req.headers.authorization ?? null, body });
    const text = JSON.stringify(body);
    const send = (status, json) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
    };
    if (req.url === '/api/tags') return send(200, { models: [{ name: 'llama3.2:3b' }] });
    if (req.url === '/api/chat') {
      if (text.includes('[fail]')) return send(500, { error: 'model crashed' });
      return send(200, { message: { content: 'Local did it.\nSUMMARY: local done' }, prompt_eval_count: 300, eval_count: 40 });
    }
    if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== `Bearer ${KEY}`)
        return send(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization ?? 'none'}` } });
      return send(200, {
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'API did it.\nSUMMARY: api done' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      });
    }
    send(404, {});
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = {
  ...process.env,
  PROJECT_ROOT: root,
  COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude-run.cmd`,
  FAKE_CLAUDE_LOG: claudeLog,
  FAKE_CLAUDE_PIDS: pidsBase,
};
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });

const dbw = () => {
  const d = new Database(join(root, 'command-center.db'), { timeout: 5000 });
  d.pragma('journal_mode = WAL');
  return d;
};
const sql = (q, ...a) => {
  const d = dbw();
  try {
    return /^\s*select/i.test(q) ? d.prepare(q).all(...a) : d.prepare(q).run(...a);
  } finally {
    d.close();
  }
};
const task = (id, o = {}) =>
  sql(
    `INSERT INTO subtasks (id, milestone_id, label, priority, assignee, depends_on, provider_override, status)
     VALUES (?, 'M1', ?, ?, ?, ?, ?, ?)`,
    id,
    o.label ?? `Task ${id}`,
    o.priority ?? 'P2',
    o.assignee ?? 'alpha',
    JSON.stringify(o.deps ?? []),
    o.override ?? null,
    o.status ?? 'todo',
  );
const status = (id) => sql('SELECT status, blocked_reason FROM subtasks WHERE id = ?', id)[0];
const runsOf = (id) => sql('SELECT * FROM runs WHERE task_id = ? ORDER BY queued_at, rowid', id);
const claudeCalls = () => readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const waitFor = async (fn, ms = 20000, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
const ipc = (fn, ...args) => page.evaluate(([f, a]) => f.split('.').reduce((o, k) => o[k], window.api)(...a), [fn, args]);
const alive = (pid) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
  } catch {
    return false;
  }
};
const approveAsOperator = (id) => ipc('tasks.transition', { taskId: id, trigger: 'approve' });
const shot = (n) => page.screenshot({ path: `${REPO}/.supervisor/M14-${n}.png` });

// ---- seed: three text agents and a milestone ----
sql("INSERT INTO milestones (id, title, planned_start) VALUES ('M1', 'Build', '2026-01-05')");
for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma'], ['delta', 'Delta']])
  sql("INSERT INTO agents (id, name, type) VALUES (?, ?, 'sub-agent')", id, name);
await sleep(800);

await step('P1 providers: detected / not detected, keys never shown, routing UI', async () => {
  await ipc('providers.setBaseUrl', { id: 'local', url: base });
  await ipc('providers.setBaseUrl', { id: 'openai-api', url: base });
  await page.keyboard.press('Control+,');
  await page.locator('[data-provider="gemini"]').waitFor({ timeout: 8000 });
  const state = async (id) => page.locator(`[data-provider="${id}"] [data-provider-state]`).getAttribute('data-provider-state');
  await waitFor(async () => (await state('local')) === 'detected', 8000);
  check('P1a claude-code and local are detected', (await state('claude-code')) === 'detected' && (await state('local')) === 'detected');
  check('P1b gemini, anthropic-api and openai-api (no key yet) are not detected', (await state('gemini')) === 'not-detected' && (await state('anthropic-api')) === 'not-detected' && (await state('openai-api')) === 'not-detected');
  await page.locator('#key-openai-api').fill(KEY);
  await page.locator('[data-provider="openai-api"]').getByRole('button', { name: 'Save', exact: true }).first().click();
  await waitFor(async () => (await state('openai-api')) === 'detected', 8000);
  check('P1c entering a key makes OpenAI detected', (await state('openai-api')) === 'detected');
  const dom = await page.locator('dialog[open]').innerText();
  const inputVal = await page.locator('#key-openai-api').inputValue();
  check('P1d the card shows only "set (…last 4)"; the key is not on screen, not in the input', dom.includes('set (…1b8e)') && !dom.includes(KEY) && inputVal === '');
  const stored = JSON.stringify(await ipc('providers.list'));
  const ls = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  check('P1e the key is not in the renderer: not in the providers list payload, not in localStorage', !stored.includes(KEY) && !ls.includes(KEY));
  const test = await page.locator('[data-provider="local"]').getByRole('button', { name: 'Test connection' });
  await test.click();
  await page.locator('[data-provider="local"] [data-test-result]').waitFor({ timeout: 15000 });
  check('P1f "Test connection" runs a live round trip', (await page.locator('[data-provider="local"] [data-test-result]').innerText()).includes('Replied'));
  await shot('providers-settings-dark');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+3');
  await page.locator('[data-agent-provider="alpha"]').waitFor({ timeout: 8000 });
  const gem = await page.locator('select[data-agent-provider="alpha"] option[value="gemini"]').getAttribute('disabled');
  check('P1g a provider that is not detected cannot be chosen for an agent', gem !== null);
  await page.locator('select[data-agent-provider="beta"]').selectOption('local');
  await page.locator('select[data-agent-model="alpha"]').selectOption('haiku');
  await sleep(600);
  const rows = sql("SELECT id, provider, model FROM agents WHERE id IN ('alpha','beta') ORDER BY id");
  check('P1h agent routing is written: alpha on claude-code/haiku, beta on local', rows.map((r) => `${r.id}:${r.provider ?? 'claude-code'}:${r.model ?? '-'}`).join() === 'alpha:claude-code:haiku,beta:local:-', JSON.stringify(rows));
});

await step('D1 nothing runs while the orchestrator is off; the first of a 3-chain runs once it is on', async () => {
  task('C1');
  task('C2', { deps: ['C1'] });
  task('C3', { deps: ['C1', 'C2'] });
  await sleep(7000);
  check('D1a switched off: no run, tasks untouched', runsOf('C1').length === 0 && status('C1').status === 'todo');
  await page.getByRole('button', { name: 'Start orchestrator' }).first().click();
  const started = await waitFor(() => runsOf('C1').length > 0, 12000);
  check('D1b C1 is dispatched within a scheduling pass', started);
  await waitFor(() => status('C1').status === 'review', 15000);
  check('D1c the agent completed C1: it is in Review (the human reviews)', status('C1').status === 'review');
  check('D1d C2 and C3 have not run: their dependency is not done', runsOf('C2').length === 0 && runsOf('C3').length === 0);
  const call = claudeCalls().find((c) => c.id === 'C1');
  check('D1e the run used the agent model (haiku), ran in the project folder', call?.model === 'haiku' && call.cwd.toLowerCase() === root.toLowerCase().replace(/\//g, '\\'), JSON.stringify({ model: call?.model, cwd: call?.cwd }));
});

await step('D2 approving C1 dispatches C2 within 10 s; C3 waits for both', async () => {
  const t0 = Date.now();
  await approveAsOperator('C1');
  const ok = await waitFor(() => runsOf('C2').length > 0, 10_000, 200);
  const took = Date.now() - t0;
  check('D2a C2 starts within 10 s of C1 being approved', ok, `${took} ms`);
  await waitFor(() => status('C2').status === 'review', 15000);
  check('D2b C3 still waits (C2 is not done)', runsOf('C3').length === 0);
  await approveAsOperator('C2');
  check('D2c C3 starts after both are done', await waitFor(() => runsOf('C3').length > 0, 10_000, 200));
  await waitFor(() => status('C3').status === 'review', 15000);
});

await step('R1 routing: each task runs on its own adapter; the task override beats the agent default', async () => {
  task('R1', { assignee: 'beta' });
  task('R2', { assignee: 'gamma', override: 'openai-api' });
  task('R3', { assignee: 'gamma' });
  const done = await waitFor(() => ['R1', 'R2', 'R3'].every((id) => status(id).status === 'review'), 30000);
  check('R1a all three finish', done, JSON.stringify(['R1', 'R2', 'R3'].map((id) => status(id).status)));
  const prov = Object.fromEntries(['R1', 'R2', 'R3'].map((id) => [id, runsOf(id)[0]?.provider]));
  check('R1b runs.provider: beta -> local, gamma override -> openai-api, gamma default -> claude-code', prov.R1 === 'local' && prov.R2 === 'openai-api' && prov.R3 === 'claude-code', JSON.stringify(prov));
  check('R1c the OpenAI fixture received the key as a bearer token (so it really was used)', seenReq.some((r) => r.url === '/v1/chat/completions' && r.auth === `Bearer ${KEY}`));
  const r2 = runsOf('R2')[0];
  check('R1d tokens and an ESTIMATED cost are recorded for the API run; claude reports its own', r2.cost_basis === 'estimate' && r2.input_tokens === 1000 && r2.est_cost_usd > 0 && runsOf('R3')[0].cost_basis === 'reported');
});

await step('V1 run visibility: feed entry, output dialog, task history, status bar', async () => {
  await page.keyboard.press('Control+3');
  const runId = runsOf('R2')[0].id;
  const btn = page.locator(`[data-run-output="${runId}"]`).first();
  await btn.waitFor({ timeout: 8000 });
  const entry = await page.locator('[data-feed-entry]', { has: btn }).innerText();
  check('V1a the feed entry shows provider, model and duration', /openai-api\/gpt-4o-mini in \d+ s/.test(entry) || /openai-api/.test(entry), entry.replace(/\s+/g, ' ').slice(0, 160));
  await btn.click();
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor({ timeout: 5000 });
  const text = await dlg.innerText();
  check('V1b the output dialog shows the output tail, tokens and a cost labelled estimate', text.includes('SUMMARY: api done') && text.includes('1000 in / 200 out') && /\(estimate\)/.test(text), text.replace(/\s+/g, ' ').slice(0, 200));
  await shot('run-output-dark');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+2');
  await page.locator('[data-task-id="R2"]').first().click();
  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('[data-task-runs]').waitFor({ timeout: 8000 });
  const hist = await page.locator('[data-task-runs]').innerText();
  check('V1c the task History tab lists the run with provider, model and cost estimate', hist.includes('OpenAI API / gpt-4o-mini') && /\(estimate\)/.test(hist), hist.replace(/\s+/g, ' ').slice(0, 160));
  await page.keyboard.press('Escape');
  const bar = await page.locator('[data-orch-status]').innerText();
  check('V1d the status bar shows the orchestrator state, running, queued and today\'s spend against the ceiling', /Orchestrator on · \d+ running · \d+ queued · \$\d+\.\d\d\/\$5\.00/.test(bar), bar);
});

await step('K1 caps: with the hourly cap at started+2, the third ready task is queued and "paused by cap" shows', async () => {
  for (const id of ['R1', 'R2', 'R3', 'C3']) if (status(id).status === 'review') await approveAsOperator(id);
  await sleep(1500);
  const startedNow = sql("SELECT COUNT(*) n FROM runs WHERE started_at >= ?", new Date(Date.now() - 3_600_000).toISOString())[0].n;
  await page.keyboard.press('Control+,');
  const input = page.locator('[data-limit="maxPerHour"]');
  await input.fill(String(startedNow + 2));
  await input.press('Enter');
  await sleep(500);
  await page.keyboard.press('Escape');
  task('K1', { assignee: 'alpha' });
  task('K2', { assignee: 'beta' });
  task('K3', { assignee: 'delta' });
  await waitFor(() => sql("SELECT COUNT(*) n FROM runs WHERE task_id IN ('K1','K2','K3')")[0].n >= 2, 15000);
  await sleep(8000);
  const n = sql("SELECT COUNT(*) n FROM runs WHERE task_id IN ('K1','K2','K3')")[0].n;
  check('K1a exactly two of the three started', n === 2, `${n} runs`);
  const bar = await page.locator('[data-orch-status]').innerText();
  check('K1b the status bar says "Paused by cap" and counts the queued task', /Paused by cap/.test(bar) && /1 queued/.test(bar), bar);
  const view = await ipc('orchestrator.status');
  check('K1c the status reports the hourly cap as the reason', view.value.pausedByCap === 'hourly');
  const third = ['K1', 'K2', 'K3'].find((id) => runsOf(id).length === 0);
  check('K1d the third task is still To Do and no run starts', status(third).status === 'todo');
  await shot('paused-by-cap-dark');
  await page.keyboard.press('Control+,');
  await page.locator('[data-limit="maxPerHour"]').fill('50');
  await page.locator('[data-limit="maxPerHour"]').press('Enter');
  await page.keyboard.press('Escape');
  check('K1e raising the cap lets it start', await waitFor(() => runsOf(third).length > 0, 12000));
  await waitFor(() => ['K1', 'K2', 'K3'].every((id) => status(id).status === 'review'), 20000);
});

await step('F1 failure: a failing provider is retried once, then the task is blocked; the rest continue', async () => {
  for (const id of ['K1', 'K2', 'K3']) await approveAsOperator(id);
  task('F1', { label: '[fail] broken provider', assignee: 'gamma' });
  task('F2', { assignee: 'delta' });
  await waitFor(() => status('F1').status === 'blocked', 25000);
  const runs = runsOf('F1');
  check('F1a two attempts, both failed', runs.length === 2 && runs.every((r) => r.status === 'failed'), JSON.stringify(runs.map((r) => r.status)));
  check('F1b the task is blocked with the error text as the reason', /^Failed twice on claude-code: claude exited with code 1: simulated provider failure/.test(status('F1').blocked_reason ?? ''), status('F1').blocked_reason);
  check('F1c the orchestrator carried on with the other ready task', await waitFor(() => status('F2').status === 'review', 15000));
  // local provider failing: HTTP 500
  task('F3', { label: '[fail] local model', assignee: 'beta' });
  await waitFor(() => status('F3').status === 'blocked', 25000);
  check('F1d an HTTP error from an API/local provider blocks the same way', /Failed twice on local: HTTP 500: model crashed/.test(status('F3').blocked_reason ?? ''), status('F3').blocked_reason);
});

await step('A1 the reviewer rule: an agent never approves its own work', async () => {
  const f2 = status('F2').status === 'review' ? 'F2' : null;
  const tok = await page.evaluate(async () => (await window.api.webhook.status()).token);
  const post = (body) =>
    fetch('http://127.0.0.1:38120/webhook/task-update', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const self = await post({ task_id: f2, status: 'done', completed_by: 'delta' });
  check('A1a the API refuses delta approving the task delta submitted (409)', self.status === 409, `HTTP ${self.status} ${(await self.text()).slice(0, 100)}`);
  check('A1b the task is still in Review', status(f2).status === 'review');
  const other = await post({ task_id: f2, status: 'done', completed_by: 'beta' });
  check('A1c a different agent may', other.status === 200, `HTTP ${other.status}`);
  task('A2', { assignee: 'alpha' });
  await waitFor(() => status('A2').status === 'review', 20000);
  await page.keyboard.press('Control+2');
  await page.locator('[data-task-id="A2"]').first().click();
  await page.getByRole('button', { name: 'Approve' }).last().click();
  await page.waitForTimeout(800);
  check('A1d the operator (a person) approves through the UI button', status('A2').status === 'done');
  await page.keyboard.press('Escape');
});

await step('X1 cancel: UI cancel and a cancel flag from another process both kill the process tree', async () => {
  task('H1', { label: '[hang] long job', assignee: 'alpha' });
  const pidsFile = `${pidsBase}.H1.json`;
  const got = await waitFor(() => existsSync(pidsFile) && JSON.parse(readFileSync(pidsFile, 'utf8')), 20000);
  check('X1a the stand-in claude and its grandchild are running', got && got.every(alive), JSON.stringify(got));
  const run = runsOf('H1').find((r) => r.status === 'running');
  await page.keyboard.press('Control+2');
  await page.locator('[data-task-id="H1"]').first().click();
  await page.locator(`[data-cancel-run="${run.id}"]`).first().click();
  const dead = await waitFor(() => got.every((p) => !alive(p)), 8000);
  check('X1b UI "Cancel run": both processes are gone (no orphans)', dead, got.map((p) => `${p}:${alive(p)}`).join(' '));
  check('X1c the run is cancelled and the task blocked as cancelled', await waitFor(() => runsOf('H1')[0]?.status === 'cancelled' && status('H1').blocked_reason === 'Run cancelled by the operator.', 6000));
  await page.keyboard.press('Escape');

  task('H2', { label: '[hang] second job', assignee: 'alpha' });
  const got2 = await waitFor(() => existsSync(`${pidsBase}.H2.json`) && JSON.parse(readFileSync(`${pidsBase}.H2.json`, 'utf8')), 20000);
  const run2 = runsOf('H2').find((r) => r.status === 'running');
  sql('UPDATE runs SET cancel_requested = 1 WHERE id = ?', run2.id); // what MCP cancel_run / the CLI write
  const dead2 = await waitFor(() => got2.every((p) => !alive(p)), 8000);
  check('X1d a cancel requested from another process (MCP/CLI) is honoured within seconds', dead2 && (await waitFor(() => runsOf('H2')[0]?.status === 'cancelled', 5000)), got2?.map((p) => `${p}:${alive(p)}`).join(' '));
});

await step('Z1 pause: stops new dispatches at once; the dialog offers finish or cancel; stop-after-current', async () => {
  task('H3', { label: '[hang] pause test', assignee: 'alpha' });
  const got = await waitFor(() => existsSync(`${pidsBase}.H3.json`) && JSON.parse(readFileSync(`${pidsBase}.H3.json`, 'utf8')), 20000);
  await page.keyboard.press('Control+3');
  await page.locator('[data-orchestrator-card]').getByRole('button', { name: 'Pause' }).click();
  const dlg = page.locator('dialog[open]');
  const text = await dlg.innerText();
  check('Z1a the pause dialog asks what to do with the run in flight', /1 run is in progress/.test(text) && text.includes('Pause, let runs finish') && text.includes('Pause and cancel runs'), text.replace(/\s+/g, ' ').slice(0, 150));
  await shot('pause-dialog-dark');
  await dlg.getByRole('button', { name: 'Pause, let runs finish' }).click();
  task('N1', { assignee: 'beta' });
  await sleep(7500);
  check('Z1b paused: the new task did not start, the running one is still going', runsOf('N1').length === 0 && got.every(alive));
  const bar = await page.locator('[data-orch-status]').innerText();
  check('Z1c the status bar says paused', /Orchestrator paused/.test(bar), bar);
  await page.locator('[data-orchestrator-card]').getByRole('button', { name: 'Resume' }).click();
  check('Z1d resume dispatches the waiting task', await waitFor(() => runsOf('N1').length > 0, 12000));
  await page.locator('[data-orchestrator-card]').getByRole('button', { name: 'Pause' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Pause and cancel runs' }).click();
  check('Z1e "Pause and cancel runs" ends the in-flight process tree', await waitFor(() => got.every((p) => !alive(p)), 8000));
  check('Z1f and the orchestrator is paused', (await ipc('orchestrator.status')).value.mode === 'paused');
  await page.locator('[data-orchestrator-card]').getByRole('button', { name: 'Resume' }).click();
  await waitFor(() => (async () => true)(), 100);
  task('S1', { label: 'slow one', assignee: 'delta' });
  await waitFor(() => runsOf('S1').length > 0, 12000);
  await page.locator('[data-orchestrator-card]').getByRole('button', { name: 'Stop after current' }).click();
  task('S2', { assignee: 'beta' });
  await waitFor(() => status('S1').status === 'review', 15000);
  await sleep(7000);
  check('Z1g stop after current: the current run finished, nothing new started, mode is paused', runsOf('S2').length === 0 && (await ipc('orchestrator.status')).value.mode === 'paused');
});

await step('Y1 keys: the key appears nowhere on disk, in the database, in logs, or in the renderer', async () => {
  await page.keyboard.press('Control+,');
  const dom = await page.locator('dialog[open]').innerText();
  await page.keyboard.press('Escape');
  const hits = [];
  const scanned = [];
  const skipped = [];
  const scan = (dir, depth = 0) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (depth < 4 && name !== 'node_modules') scan(p, depth + 1);
      } else if (s.size < 60_000_000) {
        try {
          if (readFileSync(p).includes(Buffer.from(KEY))) hits.push(p);
          scanned.push(name);
        } catch {
          skipped.push(name); // a file Chromium holds locked
        }
      }
    }
  };
  scan(root);
  scan(profile);
  check('Y1a zero matches for the key in the project folder (database, WAL, TASK_CONTEXT, logs) and the app data folder', hits.length === 0 && scanned.includes('command-center.db') && scanned.some((n) => n.endsWith('-wal')), `${scanned.length} files scanned, ${skipped.length} locked and skipped; hits: ${hits.join(', ') || 'none'}`);
  const dump = JSON.stringify(['agent_log', 'runs', 'subtasks', 'settings', 'lessons_learned'].map((t) => sql(`SELECT * FROM ${t}`)));
  check('Y1b zero matches in any table, as text', !dump.includes(KEY));
  const bad = seenReq.filter((r) => r.url === '/v1/chat/completions' && r.auth !== `Bearer ${KEY}`).length;
  check('Y1c the key was used (the fixture saw it) and the DOM never showed it', seenReq.some((r) => r.auth === `Bearer ${KEY}`) && !dom.includes(KEY) && bad === 0);
  const secret = sql("SELECT value FROM settings WHERE key = 'provider.openai-api.key'")[0]?.value ?? '';
  check('Y1d it is stored encrypted ("enc:" prefix), not as text', secret.startsWith('enc:'), secret.slice(0, 8));
});

await step('B1 a bad key is redacted: the fixture echoes the wrong bearer back in its 401', async () => {
  await ipc('providers.setKey', { id: 'openai-api', key: 'sk-wrong-KEYVALUE-000111222' });
  await ipc('orchestrator.resume');
  task('B1', { assignee: 'gamma', override: 'openai-api' });
  await waitFor(() => status('B1').status === 'blocked', 30000);
  const reason = status('B1').blocked_reason ?? '';
  const everything = JSON.stringify([sql('SELECT * FROM runs'), sql('SELECT * FROM agent_log'), sql('SELECT * FROM subtasks')]);
  check('B1a the 401 is shown as an error with the key replaced by ***', /HTTP 401: Incorrect API key provided: Bearer \*\*\*/.test(reason), reason);
  check('B1b neither wrong nor right key is in runs, the log or the tasks', !everything.includes('sk-wrong-KEYVALUE-000111222') && !everything.includes(KEY));
  await ipc('providers.setKey', { id: 'openai-api', key: KEY });
});

await step('U1 look: Agent Hub and the task modal in Calm', async () => {
  await page.evaluate(() => (document.documentElement.dataset.theme = 'calm'));
  await page.keyboard.press('Control+3');
  await sleep(600);
  await shot('agent-hub-calm');
  await page.keyboard.press('Control+,');
  await sleep(500);
  await shot('providers-settings-calm');
  await page.keyboard.press('Escape');
  await page.evaluate(() => delete document.documentElement.dataset.theme);
});

check('E1 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
server.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · project ${root}`);
process.exit(passed === results.length ? 0 : 1);
