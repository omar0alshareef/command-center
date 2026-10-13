// Drives the BUILT app through the M13.1 exit criteria (stage-based roster) with Playwright-for-Electron.
// The planner runs the real child-process path against the scripted `claude` in .supervisor/m13-fake
// (mode "video"), which logs every prompt it receives.
// usage: node .supervisor/M13.1.verify.mjs <screenshotDir>      (after: npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const require = createRequire(`${DESKTOP}/package.json`);
const Database = require('better-sqlite3');
const shots = process.argv[2] ?? join(tmpdir(), 'cc-m131-shots');
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'cc-m131-'));
const profile = mkdtempSync(join(tmpdir(), 'cc-m131-profile-'));
const modeFile = join(root, 'fake-mode.txt');
const logFile = join(root, 'fake.log');
writeFileSync(modeFile, 'video');
writeFileSync(logFile, '');

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
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const env = {
  ...process.env,
  PROJECT_ROOT: root,
  COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude.cmd`,
  FAKE_CLAUDE_MODE: modeFile,
  FAKE_CLAUDE_LOG: logFile,
};
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });
const draftTab = (name) =>
  page.locator('[role=tablist][aria-label=Draft] [role=tab]', { hasText: name });
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`) });
const setTheme = (t) => page.evaluate((x) => (document.documentElement.dataset.theme = x), t);

await step('W1 decision-only interview', async () => {
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').fill(
    'A weekly faceless YouTube explainer channel about money basics, voiced by me, first episode in two weeks.',
  );
  await page.locator('#plan-idea').press('Control+Enter');
  await page.locator('#answer-2').waitFor({ timeout: 15000 });
  const interview = calls().find((c) => c.prompt.includes('Decide whether you know enough'));
  check('W1a interview prompt has no skill or team question', interview && !/skill/i.test(interview.prompt) && !/\bteam\b/i.test(interview.prompt));
  check(
    'W1b it asks for decisions (deadlines, budget, on camera / own voice, content limits, audience)',
    ['deadlines', 'budget', 'on camera', 'own voice', 'content limits', 'target audience'].every((w) => interview?.prompt.includes(w)),
  );
});

await step('W2 draft the video plan', async () => {
  for (const i of [0, 1, 2]) await page.locator(`#answer-${i}`).fill(['Beginners', 'Two weeks', 'YouTube'][i]);
  await page.locator('#answer-2').press('Control+Enter');
  await page.getByRole('button', { name: 'Approve plan' }).waitFor({ timeout: 30000 });
  const stages = calls().map((c) =>
    c.prompt.includes('Decide whether') ? 'interview'
    : c.prompt.includes('project manifesto') ? 'manifesto'
    : c.prompt.includes('roadmap in markdown') ? 'roadmap'
    : c.prompt.includes("List the roadmap's milestones") ? 'stages'
    : c.prompt.includes('Break every milestone') ? 'tasks' : 'other');
  check('W2a runner called once per planning stage, never for the external/human stages', stages.join(',') === 'interview,interview,manifesto,roadmap,stages,tasks', stages.join(','));
  const tasksPrompt = calls().find((c) => c.prompt.includes('Break every milestone'))?.prompt ?? '';
  check('W2b plan_tasks prompt asks for brief + checklist on external/human stages', tasksPrompt.includes('voiceover (Voice tool)') && tasksPrompt.includes('publish (the operator in person)'));
});

await step('W3 roster from stages', async () => {
  await draftTab('milestones').click();
  const rows = page.locator('[role=tabpanel] tbody tr');
  const e2 = await rows.nth(1).locator('td').last().innerText();
  check('W3a only E2 lists Thumbnail; E1 lists the four video roles', /Thumbnail/.test(e2) && !/Thumbnail/.test(await rows.nth(0).locator('td').last().innerText()), e2);
  await draftTab('team').click();
  const doneBy = async (id) => page.getByLabel(`${id} done by`).inputValue();
  check('W3b voiceover-team: external, tool "Voice tool"', (await doneBy('voiceover-team')) === 'external' && (await page.getByLabel('voiceover-team tool').inputValue()) === 'Voice tool');
  check('W3c editing-team external (Video editor), thumbnail external (Image tool)', (await page.getByLabel('editing-team tool').inputValue()) === 'Video editor' && (await page.getByLabel('thumbnail-team tool').inputValue()) === 'Image tool');
  check('W3d publishing-team is done by the operator; script-team is an agent', (await doneBy('publishing-team')) === 'human' && (await doneBy('script-team')) === 'agent');
  await shot('01-team-dark');
});

await step('W4 the operator changes executor and tool before approval', async () => {
  await page.getByLabel('editing-team tool').fill('DaVinci Resolve');
  await page.getByLabel('editing-team tool').press('Enter');
  await page.getByLabel('script-team done by').selectOption('human');
  await page.getByLabel('script-team tool').waitFor({ timeout: 5000 });
  await page.getByLabel('thumbnail-team tool').fill('');
  await page.getByLabel('thumbnail-team tool').press('Enter');
  await page.getByText('an external role needs the name of its tool').waitFor({ timeout: 5000 });
  check('W4a an external role without a tool blocks approval, naming the role', await page.getByRole('button', { name: 'Approve plan' }).isDisabled());
  await page.getByLabel('thumbnail-team tool').fill('Canva');
  await page.getByLabel('thumbnail-team tool').press('Enter');
  await page.getByText('Fix before approving').waitFor({ state: 'detached', timeout: 5000 });
  check('W4b fixed by naming the tool', !(await page.getByRole('button', { name: 'Approve plan' }).isDisabled()));
  await setTheme('light');
  await shot('02-team-light');
  await setTheme('dark');
});

await step('W5 approval with mixed executors', async () => {
  await page.getByRole('button', { name: 'Approve plan' }).click();
  const body = await page.locator('dialog[open]').innerText();
  check('W5a approve dialog counts stages by executor', /Stages: 0 by agents, 3 with external tools, 2 by you/.test(body), body.match(/Stages:[^\n]*/)?.[0]);
  await page.locator('dialog[open]').getByRole('button', { name: 'Approve plan' }).click();
  await page.getByText('Approved — this plan is on the board.').waitFor({ timeout: 8000 });
  const agents = Object.fromEntries(q("SELECT id, executor, tool FROM agents WHERE id LIKE '%-team'").map((a) => [a.id, `${a.executor}:${a.tool}`]));
  check('W5b executor and tool written per agent', agents['voiceover-team'] === 'external:Voice tool' && agents['editing-team'] === 'external:DaVinci Resolve' && agents['thumbnail-team'] === 'external:Canva' && agents['publishing-team'] === 'human:null' && agents['script-team'] === 'human:null', JSON.stringify(agents));
  const vo = q("SELECT prompt, acceptance_criteria FROM subtasks WHERE label = 'Record the voice-over'")[0];
  check('W5c the voice-over task has the brief (prompt) and checklist (criteria)', vo?.prompt?.startsWith('Read the approved script') && JSON.parse(vo.acceptance_criteria).map((c) => c.text).join('|') === 'WAV 48 kHz|no clipping|matches the script', vo?.acceptance_criteria);
  check('W5d no runner call after approval', calls().length === 6, `${calls().length} calls`);
});

await step('W6 Agent Hub shows the executor', async () => {
  await page.keyboard.press('Control+3');
  await page.locator('[data-agent-row="voiceover-team"]').waitFor({ timeout: 8000 });
  const vo = await page.locator('[data-agent-row="voiceover-team"] [data-executor]').innerText();
  const pub = await page.locator('[data-agent-row="publishing-team"] [data-executor]').innerText();
  check('W6 chips: "external · Voice tool" and "done by you"', vo === 'external · Voice tool' && pub === 'done by you', `${vo} | ${pub}`);
  await shot('03-agent-hub-dark');
});

check('W7 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · project ${root} · screenshots ${shots}`);
process.exit(passed === results.length ? 0 : 1);
