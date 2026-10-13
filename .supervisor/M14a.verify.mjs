// Drives the BUILT app and the bundled CLI through the M14 Slice 1 exit criteria (Claude Code model per agent).
// usage: node .supervisor/M14a.verify.mjs <seededProjectRoot>
//   (seed: npx tsx packages/core/src/seed.ts <dir>; build: npm run build -w apps/desktop && npm run bundles -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const require = createRequire(`${DESKTOP}/package.json`);
const Database = require('better-sqlite3');
const root = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'cc-m14a-profile-'));
const logFile = join(profile, 'claude-calls.log');
writeFileSync(logFile, '');
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
const q = (sql, ...a) => {
  const d = new Database(join(root, 'command-center.db'), { readonly: true });
  try {
    return d.prepare(sql).all(...a);
  } finally {
    d.close();
  }
};
const calls = () =>
  readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const modelOf = (c) => {
  const i = c.args.indexOf('--model');
  return i < 0 ? null : c.args[i + 1];
};

const env = { ...process.env, PROJECT_ROOT: root };
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });
const shot = (n) => page.screenshot({ path: `${REPO}/.supervisor/M14a-${n}.png` });
const picker = (id) => page.locator(`select[data-agent-model="${id}"]`);

// The task the CLI prepares: any To Do task.
const task = q("SELECT id FROM subtasks WHERE status = 'todo' ORDER BY id LIMIT 1")[0].id;
const prepare = () => {
  const r = spawnSync(
    process.execPath === undefined ? 'node' : 'node',
    [`${DESKTOP}/out/bundles/cli.mjs`, '--root', root, 'prepare', '--id', task, '--runner', 'claude', '--timeout', '1'],
    {
      env: { ...process.env, COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude-args.cmd`, FAKE_CLAUDE_LOG: logFile },
      encoding: 'utf8',
    },
  );
  return { code: r.status, text: `${r.stdout}\n${r.stderr}` };
};

await step('M1 Agent Hub shows a model dropdown per text-runner agent, not for people or the system', async () => {
  await page.keyboard.press('Control+3');
  await picker('research-explorer').waitFor({ timeout: 10000 });
  await picker('research-explorer').locator('option').nth(3).waitFor({ state: 'attached', timeout: 8000 });
  const options = await picker('research-explorer').locator('option').allInnerTexts();
  check('M1a options: CLI default + the three starter models', options.join(',') === 'CLI default,Haiku (fast),Sonnet (balanced),Opus (strongest)', options.join(','));
  check('M1b the operator and the system have no model dropdown', (await page.locator('select[data-agent-model="operator"], select[data-agent-model="system"]').count()) === 0);
  check('M1c a new agent starts on "CLI default"', (await picker('research-explorer').inputValue()) === '' && (await picker('code-quality').inputValue()) === '');
  await shot('agent-hub-dropdowns');
});

await step('M2 choosing a model writes the agent row and logs it', async () => {
  await picker('research-explorer').selectOption('haiku');
  await picker('code-quality').selectOption('opus');
  await sleep(700);
  const rows = q("SELECT id, model FROM agents WHERE id IN ('research-explorer','code-quality') ORDER BY id");
  check('M2a agents.model written', rows.map((r) => `${r.id}=${r.model}`).join() === 'code-quality=opus,research-explorer=haiku', JSON.stringify(rows));
  const log = q("SELECT description FROM agent_log WHERE action = 'agent_model_changed' ORDER BY rowid");
  check('M2b one agent_log entry per change', log.length === 2 && log[0].description.endsWith('-> haiku'), JSON.stringify(log));
  // the pipeline's other two agents get registered by the first prepare: set them through the same API after.
});

await step('M3 two agents with different models: each run logs and passes its own', async () => {
  // token-compressor / prompt-optimizer are registered on first use: one offline (local runner) prepare does it.
  spawnSync('node', [`${DESKTOP}/out/bundles/cli.mjs`, '--root', root, 'prepare', '--id', task, '--runner', 'local'], { encoding: 'utf8' });
  await sleep(700);
  await picker('token-compressor').waitFor({ timeout: 8000 });
  await picker('token-compressor').selectOption('opus');
  await sleep(500);
  const r = prepare();
  const c = calls();
  check('M3a prepare ran the three analysis stages through `claude`', r.code === 0 && c.length === 3, `exit ${r.code}, ${c.length} calls ${r.text.slice(0, 120)}`);
  check('M3b explorer on haiku, compressor on opus, optimizer (never set) on no flag', modelOf(c[0]) === 'haiku' && modelOf(c[1]) === 'opus' && modelOf(c[2]) === null, c.map((x) => modelOf(x) ?? 'none').join(' / '));
  const feed = q("SELECT agent_id, description, tags FROM agent_log WHERE description LIKE '%[model:%' ORDER BY rowid");
  const byAgent = Object.fromEntries(feed.map((l) => [l.agent_id, l.description.match(/\[model: ([^\]]+)\]/)[1]]));
  check('M3c each agent_log run entry names its model', byAgent['research-explorer'] === 'haiku' && byAgent['token-compressor'] === 'opus' && byAgent['prompt-optimizer'] === 'CLI default', JSON.stringify(byAgent));
  await page.keyboard.press('Control+3');
  await page.getByText('[model: haiku]').first().waitFor({ timeout: 8000 });
  check('M3d the Agent Hub feed shows the model on the run', true);
  await shot('feed-with-models');
});

await step('M4 "CLI default" removes the flag on the next run', async () => {
  await picker('token-compressor').selectOption('');
  await sleep(500);
  const before = calls().length;
  const r = prepare();
  const c = calls().slice(before);
  check('M4 compressor now runs without --model (explorer still haiku)', r.code === 0 && c.length === 3 && modelOf(c[0]) === 'haiku' && modelOf(c[1]) === null, c.map((x) => modelOf(x) ?? 'none').join(' / '));
});

await step('M5 a removed model does not crash dispatch: CLI default, warning on screen and in the log', async () => {
  await page.keyboard.press('Control+,');
  const area = page.locator('#model-list-claude-code');
  await area.waitFor({ timeout: 5000 });
  check('M5a Settings shows the editable model list', (await area.inputValue()).includes('"sonnet"'));
  await area.fill(JSON.stringify([{ id: 'sonnet', label: 'Sonnet (balanced)' }, { id: 'haiku', label: 'Haiku (fast)' }]));
  await page.locator('[data-save-models="claude-code"]').click();
  await sleep(900);
  await page.keyboard.press('Escape');
  // code-quality is on opus, which is no longer listed: the dropdown keeps showing it, marked.
  await page.keyboard.press('Control+3');
  await sleep(500);
  const marked = await picker('code-quality').locator('option:checked').innerText();
  check('M5b the dropdown keeps the stored model, marked "not on the list"', marked === 'opus (not on the list)', marked);
  // audit uses code-quality as its quality stage; run a Review/In Progress task through it.
  const inProgress = q("SELECT id FROM subtasks WHERE status IN ('in_progress','review') ORDER BY id LIMIT 1")[0].id;
  const before = calls().length;
  const r = spawnSync('node', [`${DESKTOP}/out/bundles/cli.mjs`, '--root', root, 'audit', '--id', inProgress, '--runner', 'claude', '--timeout', '1'], {
    env: { ...process.env, COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude-args.cmd`, FAKE_CLAUDE_LOG: logFile },
    encoding: 'utf8',
  });
  const text = `${r.stdout}\n${r.stderr}`;
  const c = calls().slice(before);
  check('M5c the CLI prints a warning, runs every stage, none passes the removed model', /warning: .*"opus" is no longer on the claude-code model list/.test(text) && c.length >= 3 && c.every((x) => modelOf(x) !== 'opus'), `${c.length} calls; ${text.match(/warning:[^\n]*/)?.[0]}`);
  const logged = q("SELECT description FROM agent_log WHERE action = 'model_unavailable'");
  check('M5d a model_unavailable entry is logged', logged.length >= 1 && logged[0].description.includes('opus'), JSON.stringify(logged[0]));
  check('M5e the stored choice is untouched', q("SELECT model FROM agents WHERE id = 'code-quality'")[0].model === 'opus');
  await shot('agent-hub-removed-model');
  // Choosing a model that is not on the list is refused with a message.
  const refused = await page.evaluate(() => window.api.models.setAgentModel({ agentId: 'research-explorer', model: 'gpt-9' }));
  check('M5f a model that is not on the list is refused with a message', !refused.ok && /not on the claude-code model list/.test(refused.error.message), refused.error?.message);
});

await step('M6 the bad cases are refused', async () => {
  const people = await page.evaluate(() => window.api.models.setAgentModel({ agentId: 'operator', model: 'haiku' }));
  const badJson = await page.evaluate(() => window.api.models.setList({ provider: 'claude-code', list: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }));
  check('M6a the operator has no model; a duplicate id is refused', !people.ok && !badJson.ok && /duplicate id/.test(badJson.error.message), `${people.error?.message} | ${badJson.error?.message}`);
});

check('M7 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · project ${root}`);
process.exit(passed === results.length ? 0 : 1);
