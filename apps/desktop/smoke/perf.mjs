/* global window, document, requestAnimationFrame */
// Performance pass: 500 tasks and 5,000 log rows. Fills a fresh project through the bundled CLI and the
// webhook, then measures tab render time, scroll frame cost, long tasks, and live-update latency.
// usage (from apps/desktop, after `npm run build` and `npm run bundles`): node smoke/perf.mjs
import { _electron as electron } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Database = createRequire(join(desktop, 'package.json'))('better-sqlite3');
const root = mkdtempSync(join(tmpdir(), 'cc-perf-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const env = { ...process.env, PROJECT_ROOT: root };
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: ['.'], cwd: desktop, env });
const page = await app.firstWindow();
await page.waitForSelector('[role=tab]', { timeout: 20000 });
const node = await app.evaluate(() => process.execPath);

// --- fill: 25 milestones x 20 tasks = 500 tasks ---
const plan = {
  project: { name: 'Perf', start_date: '2026-01-05', target_date: '2026-12-31' },
  milestones: Array.from({ length: 25 }, (_, m) => ({
    id: `M${m + 1}`,
    title: `Milestone ${m + 1}`,
    domain: ['backend', 'frontend', 'infra', 'design', 'qa'][m % 5],
    week: 1 + m * 2,
    tasks: Array.from({ length: 20 }, (_, t) => ({
      label: `Task ${m + 1}.${t + 1} with a reasonably long label to wrap`,
      priority: ['P0', 'P1', 'P2', 'P3'][t % 4],
      acceptance_criteria: ['one', 'two', 'three'],
    })),
  })),
};
writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
const cli = join(desktop, 'out', 'bundles', 'cli.mjs');
const r = spawnSync(node, [cli, '--root', root, 'hydrate', '--plan', join(root, 'plan.json')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});
check('P0 hydrate 500 tasks', r.status === 0, r.stdout.trim());

const db = new Database(join(root, 'command-center.db'), { readonly: true });
const token = db.prepare("SELECT value FROM settings WHERE key='webhook_token'").get()?.value;
db.close();
const hook = (path, body) =>
  fetch(`http://127.0.0.1:38120/webhook/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
for (let i = 0; i < 5000; i++)
  await hook('agent-action', {
    agent_id: `agent-${i % 8}`,
    action: 'note',
    description: `entry ${i}`,
  });
await page.waitForTimeout(1500);

// long tasks + commit counting
await page.evaluate(() => {
  window.__long = [];
  new PerformanceObserver((l) =>
    window.__long.push(...l.getEntries().map((e) => e.duration)),
  ).observe({
    entryTypes: ['longtask'],
  });
});

const tabMs = {};
for (const [i, name] of ['Swim Lane', 'Task Board', 'Agent Hub', 'Calendar'].entries()) {
  const t0 = Date.now();
  await page.keyboard.press(`Control+${i + 1}`);
  await page.waitForSelector(`[role=tab][id^=tab-][aria-selected=true]:has-text("${name}")`);
  await page.evaluate(
    () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
  );
  tabMs[name] = Date.now() - t0;
}
check(
  'P1 each tab renders within 600 ms with 500 tasks / 5,000 log rows',
  Object.values(tabMs).every((v) => v < 600),
  JSON.stringify(tabMs),
);

// Task Board scroll cost
await page.keyboard.press('Control+2');
await page.waitForSelector('[data-task-id]');
const cards = await page.locator('[data-task-id]').count();
const frames = await page.evaluate(
  () =>
    new Promise((res) => {
      const col = document.querySelector('[data-column="todo"]');
      const scroller = [col, ...col.querySelectorAll('*')].find(
        (e) => e.scrollHeight > e.clientHeight + 50,
      );
      const times = [];
      let last = performance.now();
      let n = 0;
      const tick = (t) => {
        times.push(t - last);
        last = t;
        if (scroller) scroller.scrollTop += 60;
        if (++n < 60) requestAnimationFrame(tick);
        else
          res({
            worst: Math.max(...times),
            avg: times.reduce((a, b) => a + b, 0) / times.length,
            scrolled: Boolean(scroller),
          });
      };
      requestAnimationFrame(tick);
    }),
);
check(
  'P2 board scroll: average frame <= 20 ms',
  frames.avg <= 20,
  `${cards} cards mounted, avg ${frames.avg.toFixed(1)} ms, worst ${frames.worst.toFixed(0)} ms`,
);

// live update latency + render storm check: 20 quick writes, then measure the last one's arrival
const ids = Array.from({ length: 20 }, (_, i) => `TASK-${String(i + 1).padStart(3, '0')}`);
await page.evaluate(() => (window.__long.length = 0));
const t0 = Date.now();
for (const id of ids) await hook('task-update', { task_id: id, status: 'in_progress' });
await page.waitForSelector(`[data-column="in_progress"] [data-task-id="${ids[19]}"]`, {
  timeout: 5000,
});
const settle = Date.now() - t0;
const long = await page.evaluate(() => window.__long);
check('P3 20 external writes settle in the open board within 3 s', settle < 3000, `${settle} ms`);
check(
  'P4 no long task over 200 ms during the burst',
  Math.max(0, ...long) < 200,
  `${long.length} long tasks, max ${Math.max(0, ...long).toFixed(0)} ms`,
);

await app.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
