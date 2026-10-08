// Launches the BUILT app (apps/desktop/out) against a project dir and drives it over CDP.
// usage: node verify.mjs <mode: main|welcome|fatal> <projectRoot|-> <shotPrefix>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const require = createRequire(`${REPO}/package.json`);
const [mode, root, shot] = process.argv.slice(2);
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, ELECTRON_RENDERER_URL: '' };
delete env.ELECTRON_RENDERER_URL;
if (root && root !== '-') env.PROJECT_ROOT = root;
else delete env.PROJECT_ROOT;

const app = spawn(
  `${REPO}/node_modules/electron/dist/electron.exe`,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${REPO}/apps/desktop/out/verify-profile-${PORT}`],
  { cwd: `${REPO}/apps/desktop`, env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let appLog = '';
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));

async function pageWsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('no page target\n' + appLog);
}

const ws = new WebSocket(await pageWsUrl());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''));
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const waitFor = async (expr, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await ev(expr);
      if (v) return v;
    } catch {}
    await sleep(40);
  }
  throw new Error('timeout waiting for: ' + expr);
};
const screenshot = async (name) => {
  await sleep(700); // let the 200ms underline / color transitions settle
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${shot}-${name}.png`;
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
};
const key = (k, code, vk, modifiers = 0) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });

await send('Runtime.enable');
const out = { mode };

try {
  if (mode === 'welcome') {
    out.text = await waitFor(`document.body.innerText.includes('Choose your project folder') && document.body.innerText`);
    out.shot = await screenshot('welcome');
  } else if (mode === 'fatal') {
    out.text = await waitFor(`document.body.innerText.includes('Retry') && document.body.innerText`);
    out.shot = await screenshot('fatal');
  } else {
    await waitFor(`!!document.querySelector('[role=tab]')`);
    const badge = () => ev(`document.querySelector('[aria-label$="in review"]')?.textContent ?? null`);
    out.sandbox = await ev(`({ api: typeof window.api, keys: Object.keys(window.api), require: typeof require, process: typeof process })`);
    out.header = await waitFor(`document.querySelector('header')?.innerText.includes('%') && document.querySelector('header').innerText`);
    out.footer = await ev(`document.querySelector('footer').innerText`);
    out.tabs = await ev(`[...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim() + (t.getAttribute('aria-selected')==='true' ? ' *' : ''))`);
    out.reviewBadgeInitial = await badge();
    out.bgDark = await ev(`getComputedStyle(document.body).backgroundColor`);
    out.shot1 = await screenshot('dark-swimlane');

    // Live sync: change the DB from ANOTHER connection (stand-in for `sqlite3 command-center.db "UPDATE ..."`).
    const Database = require('better-sqlite3');
    const ext = new Database(`${root}/command-center.db`);
    ext.pragma('busy_timeout = 5000');
    out.latenciesMs = [];
    for (let n = 1; n <= 3; n++) {
      const before = Number(await badge());
      ext.prepare("UPDATE subtasks SET status='review' WHERE id=(SELECT id FROM subtasks WHERE status='todo' ORDER BY id LIMIT 1)").run();
      const t0 = performance.now();
      await waitFor(`document.querySelector('[aria-label$="in review"]')?.textContent === '${before + 1}'`, 5000);
      out.latenciesMs.push(Math.round(performance.now() - t0));
    }
    ext.close();
    out.reviewBadgeAfter = await badge();

    // Tabs: click each, read the view title; then keyboard shortcuts.
    out.views = {};
    for (const label of ['Swim Lane', 'Task Board', 'Agent Hub', 'Calendar', 'Terminal']) {
      await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('${label}')).click()`);
      out.views[label] = await waitFor(`document.querySelector('h1')?.innerText === '${label}' && document.querySelector('main').innerText.slice(0, 120)`);
    }
    await key('2', 'Digit2', 50, 2); // Ctrl+2
    out.afterCtrl2 = await waitFor(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Task Board') && 'Task Board'`);
    out.shot2 = await screenshot('dark-taskboard');
    await key('Tab', 'Tab', 9, 2); // Ctrl+Tab
    out.afterCtrlTab = await waitFor(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Agent Hub') && 'Agent Hub'`);

    // Theme toggle (both themes) + persistence of activeTab/theme in localStorage.
    await ev(`document.querySelector('button[aria-label^="Switch to light"]').click()`);
    out.theme = await waitFor(`document.documentElement.dataset.theme === 'light' && getComputedStyle(document.body).backgroundColor`);
    out.shot3 = await screenshot('light-agenthub');
    out.persisted = await ev(`localStorage.getItem('cc-ui')`);
  }
  out.consoleErrors = consoleErrors;
} catch (e) {
  out.failure = String(e.message).slice(0, 400);
  out.diag = await ev(`({ body: document.body.innerText.slice(0, 300), api: typeof window.api, url: location.href, html: document.body.innerHTML.slice(0, 300) })`).catch((x) => String(x));
  out.consoleErrors = consoleErrors;
  out.appLog = appLog.slice(-600);
} finally {
  console.log(JSON.stringify(out, null, 2));
  send('Browser.close'); // never answers: the browser exits
  setTimeout(() => {
    app.kill();
    process.exit(0);
  }, 2000);
}
