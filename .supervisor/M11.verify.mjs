// Drives the BUILT app (apps/desktop/out) over CDP through the M11 exit criteria (webhook).
// usage: node .supervisor/M11.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop; seed a fresh root with packages/core/src/seed.ts)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const require = createRequire(`${REPO}/package.json`);
const Database = require('better-sqlite3');
const [root, shot] = process.argv.slice(2);
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, PROJECT_ROOT: root };
delete env.ELECTRON_RENDERER_URL;
const electronArgs = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${REPO}/apps/desktop/out/verify-profile-${PORT}`];
// DEV=1 launches the real dev server (what `npm run dev` runs): React's development build, with its warnings.
const app =
  process.env.DEV === '1'
    ? spawn(process.execPath, [`${REPO}/node_modules/electron-vite/bin/electron-vite.js`, 'dev', '--', ...electronArgs], {
        cwd: `${REPO}/apps/desktop`,
        env: { ...process.env, PROJECT_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(`${REPO}/node_modules/electron/dist/electron.exe`, ['.', ...electronArgs], {
        cwd: `${REPO}/apps/desktop`,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
let appLog = '';
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));

// ---------- DB helpers (read-only, fresh connection per query) ----------
const q = (sql, ...p) => {
  const db = new Database(`${root}/command-center.db`, { readonly: true });
  try {
    return db.prepare(sql).all(...p);
  } finally {
    db.close();
  }
};
const task = (id) => q('SELECT * FROM subtasks WHERE id = ?', id)[0];
const until = async (fn, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error('timeout: ' + what);
};

// ---------- CDP plumbing ----------
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
  } else if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push((msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300));
  else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (['error', 'warning'].includes(e.level) && !/favicon/.test(e.url ?? '')) consoleErrors.push(`[log ${e.level}] ${e.text} ${e.url ?? ''}`.slice(0, 300));
  } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result.result.value;
};
const waitDom = (expr, ms = 6000) => until(async () => { try { return await ev(expr); } catch { return false; } }, ms, expr.slice(0, 90));
const screenshot = async (name) => {
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${shot}-${name}.png`, Buffer.from(r.result.data, 'base64'));
};

const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const mouse = (type, x, y, buttons = 0, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
const key = async (k, code, vk, modifiers = 0, text) => {
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const SPACE = () => key(' ', 'Space', 32, 0, ' ');
const ENTER = () => key('Enter', 'Enter', 13, 0, '\r');
const TAB = () => key('Tab', 'Tab', 9);
const ESC = () => key('Escape', 'Escape', 27);
const ARROW = (dir) => key(`Arrow${dir}`, `Arrow${dir}`, dir === 'Right' ? 39 : 37);
const typeText = (text) => send('Input.insertText', { text });

const cardSel = (tid) => `[data-task-id="${tid}"]`;
const colSel = (s) => `[data-column="${s}"]`;
async function drag(tid, toStatus, { hold = false } = {}) {
  await ev(`document.querySelector('${cardSel(tid)}').scrollIntoView({ block: 'center' })`);
  let a = await rect(cardSel(tid));
  for (let i = 0; i < 40; i++) {
    await sleep(60);
    const n = await rect(cardSel(tid));
    const stable = Math.abs(n.x - a.x) < 0.5 && Math.abs(n.y - a.y) < 0.5;
    a = n;
    if (stable) break;
  }
  const b = await rect(colSel(toStatus));
  const sx = a.x + a.w / 2, sy = a.y + a.h / 2;
  const tx = b.x + b.w / 2, ty = Math.min(b.y + 90, b.y + b.h - 12);
  await mouse('mouseMoved', sx, sy);
  await mouse('mousePressed', sx, sy, 1);
  for (let i = 1; i <= 14; i++) {
    await mouse('mouseMoved', sx + ((tx - sx) * i) / 14, sy + ((ty - sy) * i) / 14, 1);
    await sleep(16);
  }
  if (!hold) {
    await mouse('mouseReleased', tx, ty, 0);
    // dnd-kit swallows clicks for ~50-100ms after a drop (by design); a person needs longer than that anyway.
    await sleep(400);
  }
  return { tx, ty };
}
const dialogText = () => ev(`document.querySelector('dialog[open]')?.innerText ?? null`);
const dialogButton = (label) =>
  ev(`(() => {
    const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled };
  })()`);
const clickInDialog = async (label) => {
  // Real mouse click, like a person: wait for the button to exist and be enabled first.
  for (let i = 0; i < 50; i++) {
    const btn = await dialogButton(label);
    if (btn && !btn.disabled) {
      await mouse('mouseMoved', btn.x, btn.y);
      await mouse('mousePressed', btn.x, btn.y, 1);
      await mouse('mouseReleased', btn.x, btn.y, 0);
      return 'ok';
    }
    if (i === 49) return btn ? 'disabled' : 'no button ' + label;
    await sleep(40);
  }
};
const noDialog = () => waitDom(`document.querySelectorAll('dialog[open]').length === 0`);
const toasts = () => ev(`[...document.querySelectorAll('[aria-live=polite] > div')].map(d => d.innerText.trim())`);
const colIds = (s) => ev(`[...document.querySelectorAll('${colSel(s)} [data-task-id]')].map(e => e.dataset.taskId)`);
const pickTask = (sql) => q(sql)[0]?.id;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 700) });
};
const ONLY = process.env.ONLY?.split(",");
const run = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (e) {
    let dump = ''; try { dump = JSON.stringify({ dialog: await dialogText(), toasts: await toasts(), errs: consoleErrors.slice(-2), ui: await ev("JSON.stringify({ ta: document.querySelector(\"dialog[open] textarea\")?.value, active: document.activeElement?.tagName + \":\" + document.activeElement?.textContent?.slice(0,20), btns: [...document.querySelectorAll(\"dialog[open] button\")].map(b => b.textContent.trim() + (b.disabled ? \"(disabled)\" : \"\")) })") }); } catch {} check(name + ' [threw]', false, e.message + ' :: ' + dump);
  }
};

// ---- M10 body: Self-improving memory ----

// ---- M11 body: Webhooks ----
const BASE = 'http://127.0.0.1:38120/webhook';
const openTab = async (name) => { await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes(${JSON.stringify(name)})).click()`); await sleep(500); };
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(250); };
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const tokenNow = () => q(`SELECT value FROM settings WHERE key='webhook_token'`)[0]?.value;
const post = async (path, body, token) => {
  const r = await fetch(`${BASE}/${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text };
};

await run('W', async () => {
  await waitDom(`document.querySelector('[role=tab]') !== null`);
  await openTab('Task Board');
  const t = pickTask(`SELECT id FROM subtasks WHERE status = 'todo' ORDER BY id LIMIT 1`);
  await waitDom(`document.querySelector('${colSel('todo')} ${cardSel(t)}') !== null`);
  const token = await until(tokenNow, 8000, 'token created by the app');
  await waitDom(`document.querySelector('footer')?.innerText.includes('Webhook :38120')`);
  check('W1 status bar shows the webhook port and "running"', (await ev(`document.querySelector('footer').innerText`)).includes('Webhook :38120 ● running'), await ev(`document.querySelector('footer').innerText`));

  const no = await post('task-update', { task_id: t, status: 'in_progress' });
  check('W2 no token -> 401, card unchanged', no.status === 401 && task(t).status === 'todo', `${no.status} ${no.text.slice(0, 80)}`);
  const bad = await post('task-update', { task_id: t, status: 'finished' }, token);
  check('W3 invalid status -> 400, card unchanged', bad.status === 400 && task(t).status === 'todo', `${bad.status} ${bad.text.slice(0, 120)}`);

  const t0 = Date.now();
  const ok = await post('task-update', { task_id: t, status: 'in_progress' }, token);
  check('W4 token + valid status -> 200', ok.status === 200 && task(t).status === 'in_progress', `${ok.status}`);
  await waitDom(`document.querySelector('${colSel('in_progress')} ${cardSel(t)}') !== null`, 4000);
  const ms = Date.now() - t0;
  check('W5 the card moved to In Progress in the open board within 2 s, no reload', ms < 2000 && (await colIds('todo')).includes(t) === false, `${ms} ms; In Progress = ${(await colIds('in_progress')).includes(t)}`);
  await screenshot('board-after-webhook');

  const rev = await post('task-update', { task_id: t, status: 'review', summary: 'via webhook' }, token);
  await waitDom(`document.querySelector('${colSel('review')} ${cardSel(t)}') !== null`, 4000);
  check('W6 a second request moves it on to Review live', rev.status === 200);

  // Agent Hub webhook card
  await openTab('Agent Hub');
  await ev(`document.querySelector('details > summary')?.click()`);
  await waitDom(`document.body.innerText.includes('Webhook 127.0.0.1:38120')`);
  const cardText = await ev(`(() => { const t = document.body.innerText; const i = t.indexOf('Webhook 127.0.0.1:38120'); return i < 0 ? '' : t.slice(i, i + 60).split(String.fromCharCode(10))[0]; })()`);
  const curlText = await ev(`[...document.querySelectorAll('pre')].map(p => p.innerText).find(x => x.includes('/webhook/task-update')) ?? ''`);
  check('W7 the webhook card shows port, state and the token (in the curl example)', /running/.test(cardText) && curlText.includes(token), `${cardText} | token in curl: ${curlText.includes(token)}`);
  await screenshot('hub-webhook-card');
  const btn = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Regenerate token'); if (!b) return null; b.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(200);
  const r = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Regenerate token'); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
  await click(r.x, r.y);
  const fresh = await until(() => (tokenNow() !== token ? tokenNow() : null), 4000, 'token replaced');
  await waitDom(`[...document.querySelectorAll('pre')].some(p => p.innerText.includes(${JSON.stringify(fresh)}))`);
  const old = await post('task-update', { task_id: t, status: 'done' }, token);
  const self = await post('task-update', { task_id: t, status: 'done' }, fresh);
  const neu = await post('task-update', { task_id: t, status: 'done', completed_by: 'github' }, fresh);
  check('W8 Regenerate token (real click): the card shows the new token, the old one gets 401, the new one works', Boolean(btn) && old.status === 401 && neu.status === 200 && self.status === 409, `old ${old.status}, new ${neu.status}; same agent approving its own submission -> ${self.status} (independence rule)`);
  await openTab('Task Board');
  await waitDom(`document.querySelector('${colSel('done')} ${cardSel(t)}') !== null`, 4000);
  check('W9 review -> done by webhook shows in the Done column', true);
});

check('Z0 no console errors/warnings during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
void send('Browser.close');
await sleep(2000);
ws.close();
app.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
