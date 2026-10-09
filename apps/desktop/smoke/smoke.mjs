/* global document, getComputedStyle */
// Playwright-for-Electron smoke test: launch, hydrate through the bundled CLI, switch tabs, drag a card,
// open the task modal, palette, settings, shortcuts, spawn a terminal.
// usage (from apps/desktop, after `npm run build` and `npm run bundles`):
//   node smoke/smoke.mjs                      # the built app (out/)
//   node smoke/smoke.mjs --exe "<path to Command Center.exe>"   # a packaged app
import { _electron as electron } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const exeIdx = process.argv.indexOf('--exe');
const exe = exeIdx > 0 ? process.argv[exeIdx + 1] : null;
const root = mkdtempSync(join(tmpdir(), 'cc-smoke-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name + ' [threw]', false, String(e.message).split('\n')[0]);
  }
};

const env = { ...process.env, PROJECT_ROOT: root };
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch(
  exe ? { executablePath: exe, env } : { args: ['.'], cwd: desktop, env },
);
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
const appPath = await app.evaluate(({ app }) => app.getAppPath());

await step('S1 window shows the app shell', async () => {
  await page.waitForSelector('[role=tab]', { timeout: 20000 });
  check(
    'S1 window shows the app shell',
    (await page.locator('[role=tab][id^=tab-]').count()) === 5,
  );
});

await step('S2 hydrate through the bundled CLI fills the board live', async () => {
  const plan = {
    // Target long before today on purpose: NOW then falls past the plan's own end (the Swim Lane must cope).
    project: { name: 'Smoke', start_date: '2026-01-05', target_date: '2026-02-01' },
    milestones: [
      {
        id: 'M1',
        title: 'Smoke milestone',
        domain: 'backend',
        week: 1,
        tasks: [{ label: 'First card' }, { label: 'Second card' }],
      },
    ],
  };
  const planFile = join(root, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const cli = exe
    ? join(appPath, 'out', 'bundles', 'cli.mjs')
    : join(desktop, 'out', 'bundles', 'cli.mjs');
  const node = exe ?? (await app.evaluate(() => process.execPath));
  const r = spawnSync(node, [cli, '--root', root, 'hydrate', '--plan', planFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  check('S2a hydrate exits 0', r.status === 0, (r.stdout + r.stderr).trim().slice(0, 160));
  await page.keyboard.press('Control+2');
  await page.waitForSelector('[data-task-id]', { timeout: 8000 });
  check(
    'S2b both cards appear without a reload',
    (await page.locator('[data-task-id]').count()) === 2,
  );
});

await step(
  'S2c the Swim Lane opens at the left and its grid reaches NOW and the screen edge',
  async () => {
    await page.keyboard.press('Control+1');
    await page.waitForSelector('[data-now-x]', { state: 'attached', timeout: 5000 });
    const m = await page.evaluate(() => {
      const section = document.querySelector('section[aria-label="Swim Lane"]');
      const scroller = [...section.querySelectorAll('*')].find(
        (e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth,
      );
      const nowX = Number(document.querySelector('[data-now-x]').getAttribute('data-now-x'));
      const labelW = 140;
      return {
        scrollLeft: scroller ? scroller.scrollLeft : -1,
        // content (labels + week columns) vs what the scroller shows
        scrollWidth: scroller ? scroller.scrollWidth : 0,
        clientWidth: scroller ? scroller.clientWidth : 0,
        nowX,
        gridW: scroller ? scroller.scrollWidth - labelW : 0,
      };
    });
    check('S2c opens scrolled to the left edge', m.scrollLeft === 0, JSON.stringify(m));
    check(
      'S2c the grid extends past the NOW marker',
      m.gridW > m.nowX,
      `nowX ${m.nowX}, grid ${m.gridW}`,
    );
    check(
      'S2c the grid is at least as wide as the screen (nothing ends early)',
      m.scrollWidth >= m.clientWidth,
      `${m.scrollWidth} vs ${m.clientWidth}`,
    );
  },
);

await step('S3 tabs switch with Ctrl+1..5', async () => {
  const names = ['Swim Lane', 'Task Board', 'Agent Hub', 'Calendar', 'Terminal'];
  let ok = true;
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(`Control+${i + 1}`);
    const sel = await page.locator('[role=tab][id^=tab-][aria-selected=true]').innerText();
    ok &&= sel.includes(names[i]);
  }
  check('S3 each Ctrl+n selects the matching tab', ok);
});

await step('S3b the "Add task" tooltip paints above the cards', async () => {
  await page.keyboard.press('Control+2');
  await page.locator('[data-column="todo"] [data-task-id]').first().waitFor();
  await page.locator('section[aria-label^="TO DO"] button[aria-label="Add task"]').hover();
  const tip = page.locator('[role=tooltip]');
  await tip.waitFor({ timeout: 3000 });
  // Whatever is on top at the tooltip's centre must be the tooltip itself, not a card behind it.
  const onTop = await tip.evaluate((el) => {
    // The tooltip is pointer-events:none, which hit testing skips: turn it on just for this probe.
    el.style.pointerEvents = 'auto';
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(top && el.contains(top));
  });
  check('S3b tooltip is the top element at its own position', onTop);
  await page.mouse.move(5, 5);
});

await step('S4 drag a card To Do -> In Progress', async () => {
  await page.keyboard.press('Control+2');
  const card = page.locator('[data-column="todo"] [data-task-id]').first();
  await card.scrollIntoViewIfNeeded();
  const id = await card.getAttribute('data-task-id');
  const a = await card.boundingBox();
  const b = await page.locator('[data-column="in_progress"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(
      a.x + a.width / 2 + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 14,
      a.y + a.height / 2 + ((b.y + 90 - a.y - a.height / 2) * i) / 14,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForSelector(`[data-column="in_progress"] [data-task-id="${id}"]`, {
    timeout: 5000,
  });
  check('S4 card moved to In Progress', true, id);
});

await step('S5 clicking a card opens the task modal; Esc closes it', async () => {
  await page.waitForTimeout(500);
  await page.locator('[data-task-id]').first().click();
  await page.waitForSelector('dialog[open]', { timeout: 4000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 4000 });
  check('S5 modal opens and closes', true);
});

await step('S5b Delete button removes a task after confirming', async () => {
  const before = await page.locator('[data-task-id]').count();
  const card = page.locator('[data-task-id]').first();
  const id = await card.getAttribute('data-task-id');
  await card.click();
  await page.waitForSelector('dialog[open]', { timeout: 4000 });
  await page.locator('dialog[open] button:has-text("Delete")').first().click();
  // Cancel first: nothing is deleted.
  await page.locator('dialog[open] button:has-text("Cancel")').last().click();
  check('S5b cancel keeps the task', (await page.locator('[data-task-id]').count()) === before);
  await page.locator('dialog[open] button:has-text("Delete")').first().click();
  await page.locator('dialog[open] button:has-text("Delete")').last().click();
  await page.waitForSelector(`[data-task-id="${id}"]`, { state: 'detached', timeout: 5000 });
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 4000 });
  check(
    'S5b confirmed delete removes the card and closes the modal',
    (await page.locator('[data-task-id]').count()) === before - 1,
    id,
  );
});

await step('S6 palette, settings and shortcut sheet', async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('dialog[open] [role=combobox]');
  await page.keyboard.type('calendar');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=tab][id^=tab-][aria-selected=true]:has-text("Calendar")', {
    timeout: 4000,
  });
  check('S6a palette: "calendar" + Enter goes to Calendar', true);
  await page.keyboard.press('Control+,');
  await page.waitForSelector('dialog[open][aria-label=Settings]');
  check(
    'S6b Ctrl+, opens Settings with the webhook card',
    (await page.locator('dialog[open]').innerText()).includes('Webhook 127.0.0.1:38120'),
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.waitForSelector('dialog[open][aria-label="Keyboard shortcuts"]');
  check('S6c ? opens the shortcut sheet', true);
  await page.keyboard.press('Escape');
});

await step('S7 terminal spawns a shell', async () => {
  await page.keyboard.press('Control+5');
  await page.waitForSelector('.xterm', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const body = await page.locator('main').innerText();
  check(
    'S7 xterm is mounted and the shell started (no node-pty rebuild hint)',
    !body.includes('rebuild node-pty') && !body.includes('Could not start'),
    body.slice(0, 80).replace(/\s+/g, ' '),
  );
});

await step('S8 status bar shows the webhook', async () => {
  const t = await page.locator('footer').innerText();
  check(
    'S8 status bar: Webhook :38120 running',
    t.includes('Webhook :38120 ● running'),
    t.replace(/\n/g, ' | '),
  );
});

await step('S9 the bundled MCP server answers initialize over stdio', async () => {
  const mcp = exe
    ? join(appPath, 'out', 'bundles', 'mcp.mjs')
    : join(desktop, 'out', 'bundles', 'mcp.mjs');
  const node = exe ?? (await app.evaluate(() => process.execPath));
  const req = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' },
    },
  });
  const r = spawnSync(node, [mcp], {
    input: req + '\n',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROJECT_ROOT: root },
    encoding: 'utf8',
    timeout: 15000,
  });
  check(
    'S9 MCP initialize returns serverInfo',
    /"serverInfo"/.test(r.stdout ?? ''),
    (r.stdout || r.stderr).slice(0, 100),
  );
});

check('Z0 no console errors during the run', errors.length === 0, errors.slice(0, 2).join(' | '));
await app.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
