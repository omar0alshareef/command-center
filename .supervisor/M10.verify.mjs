// Drives the BUILT app (apps/desktop/out) over CDP through the M10 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M10.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = `${REPO}/packages/cli/dist/index.js`;
const cli = (args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: root, ...extraEnv } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const BUNDLE = `${REPO}/packages/mcp-server/dist/index.js`;
const sdk = (p) => import(pathToFileURL(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');
async function connectMcp(name) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE], env: { PROJECT_ROOT: root }, stderr: 'pipe' }));
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    return { isError: Boolean(r.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call };
}
const openTab = async (name) => { await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes(${JSON.stringify(name)})).click()`); await sleep(500); };
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(250); };
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const lessons = () => q('SELECT * FROM lessons_learned ORDER BY created_at, id');
const mdPath = join(root, '.claude', 'LESSONS_LEARNED.md');
const readMd = () => (existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '');
/** Entries of the generated file: [task, reason, fix, prevention] (the file says "_Not recorded yet._" for empty fields). */
const mdEntries = () => readMd().split(/^## /m).slice(1).map((b) => {
  const get = (label, next) => { const m = new RegExp(`\\*\\*${label}:\\*\\*\\n([\\s\\S]*?)${next ? `\\n\\n\\*\\*${next}:\\*\\*` : '\\s*$'}`).exec(b); return (m?.[1] ?? '').trim(); };
  const norm = (s) => (s === '_Not recorded yet._' ? '' : s);
  return [/^(\S+) Rejection/.exec(b)?.[1], get('Rejection Reason', 'Fix Applied'), norm(get('Fix Applied', 'Prevention')), norm(get('Prevention', null))];
});
const inSync = () => JSON.stringify(mdEntries()) === JSON.stringify(lessons().map((l) => [l.subtask_id, l.rejection_reason, l.fix_applied, l.prevention]));

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));

mkdirSync(join(root, 'src'), { recursive: true });
const wf = new Database(`${root}/command-center.db`);
const reviewIds = q(`SELECT id FROM subtasks WHERE status='review' ORDER BY id`).map((r) => r.id);
const [UI_TASK, MCP_TASK] = reviewIds;
wf.prepare(`UPDATE subtasks SET label = ? WHERE id = ?`).run('Modal backdrop close behaviour', UI_TASK);
wf.prepare(`UPDATE subtasks SET label = ? WHERE id = ?`).run('Report CSV export', MCP_TASK);
const baseLessons = lessons().length;
wf.close();
const mcp = await connectMcp('claude-code');
const reviewer = await connectMcp('reviewer-agent');

// ===== R. rejecting twice with different reasons =====
await run('R', async () => {
  await openTab('Task Board');
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  await sleep(600);
  check('R0 the seed starts with no lessons file yet', baseLessons === 0 && !existsSync(mdPath), `${baseLessons} lessons`);
  // 1. through the app UI: the Reject button on a Review card
  await ev(`document.querySelector('[aria-label="Reject ${UI_TASK}"]').scrollIntoView({ block: 'center' })`);
  const b = await center(`[aria-label="Reject ${UI_TASK}"]`);
  await click(b.x, b.y);
  await waitDom(`!!document.querySelector('dialog[open] textarea')`);
  await ev(`document.querySelector('dialog[open] textarea').focus()`);
  await typeText('The modal did not close when the backdrop was clicked');
  await clickInDialog('Reject');
  await until(() => lessons().length === 1, 5000, 'first lesson');
  check('R1 rejecting in the app writes a lesson and moves the task back to In Progress', q(`SELECT status FROM subtasks WHERE id=?`, UI_TASK)[0].status === 'in_progress' && lessons()[0].rejection_reason.includes('backdrop was clicked'));
  // 2. through MCP, with a prevention
  const rej = await reviewer.call('reject_task', { task_id: MCP_TASK, reason: 'The CSV export dropped the header row', prevention: 'Assert the first line of every export' });
  check('R2 rejecting over MCP (reason + prevention) writes the second, different lesson', !rej.isError && lessons().length === 2 && lessons()[1].prevention === 'Assert the first line of every export', rej.text.slice(0, 80));
  const md = readMd();
  check('R3 .claude/LESSONS_LEARNED.md exists and has one entry per lesson in the blueprint format', /^# Lessons Learned/.test(md) && (md.match(/^## TASK-\d+ Rejection \(\d{4}-\d{2}-\d{2}\)/gm) ?? []).length === 2 && md.includes('**Rejection Reason:**') && md.includes('**Fix Applied:**') && md.includes('**Prevention:**'), md.split('\n').slice(0, 6).join(' | '));
  check('R4 the file and the table say exactly the same thing', inSync(), JSON.stringify(mdEntries()).slice(0, 200));
  await screenshot('board-after-rejects');
});

// ===== F. the fix is recorded when the task is completed again =====
await run('F', async () => {
  await mcp.call('complete_task', { task_id: UI_TASK, summary: 'Added a backdrop click handler and a test for it' });
  const l = lessons().find((x) => x.subtask_id === UI_TASK);
  check('F1 the next complete_task summary becomes the lesson\'s fix', l.fix_applied === 'Added a backdrop click handler and a test for it', l.fix_applied);
  check('F2 and the markdown file followed', readMd().includes('Added a backdrop click handler and a test for it') && inSync());
  const never = q(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 1`)[0].id;
  const before = lessons().length;
  const mdBefore = readMd();
  await mcp.call('start_task', { task_id: never });
  await mcp.call('complete_task', { task_id: never, summary: 'a normal completion, no rejection involved' });
  check('F3 completing a task that was never rejected writes no lesson and leaves the file alone', lessons().length === before && readMd() === mdBefore && !readMd().includes('no rejection involved'));
});

// ===== L. retrieval feeds the next, similar task =====
await run('L', async () => {
  const sim = (await mcp.call('add_milestone_task', { milestone_id: 'M4', label: 'Settings modal dismiss behaviour' })).json();
  const other = (await mcp.call('add_milestone_task', { milestone_id: 'M4', label: 'Weather widget colours' })).json();
  const SIM = sim.id, OTHER = other.id;
  const enriched = (await mcp.call('enrich_task', { task_id: SIM, notes: 'dismiss the settings modal on backdrop click' })).json();
  check('L1 enrich_task returns the relevant lessons for the similar task (and not the unrelated one)', enriched.relevant_lessons.some((x) => /backdrop was clicked/.test(x.rejection_reason)) && !enriched.relevant_lessons.some((x) => /CSV/.test(x.rejection_reason)), JSON.stringify(enriched.relevant_lessons.map((x) => x.rejection_reason)));
  const ctx = (await mcp.call('get_task_context', { task_id: SIM })).text;
  check('L2 get_task_context for it carries the lesson with its fix', /## Relevant lessons[\s\S]*backdrop was clicked[\s\S]*fix: Added a backdrop click handler/.test(ctx) && !/CSV export/.test(ctx), ctx.slice(ctx.indexOf('## Relevant lessons'), ctx.indexOf('## Relevant lessons') + 200).replace(/\n/g, ' | '));
  const none = (await mcp.call('get_task_context', { task_id: OTHER })).text;
  check('L3 an unrelated task gets none', /## Relevant lessons\s+_None\._/.test(none));
  const prep = cli(['prepare', '--id', SIM, '--runner', 'local']);
  const file = readFileSync(join(root, '.claude', 'TASK_CONTEXT.md'), 'utf8');
  const sec = file.slice(file.indexOf('## Relevant lessons'));
  check('L4 `command-center prepare` writes a TASK_CONTEXT.md that includes the lesson (and the optimizer repeats it as a rule)', prep.code === 0 && /modal did not close when the backdrop was clicked/.test(sec) && /Do not repeat: The modal did not close/.test(file) && !/CSV export/.test(file), prep.err || sec.slice(0, 160).replace(/\n/g, ' | '));
  const pn = cli(['prepare', '--id', OTHER, '--runner', 'local']);
  const fileOther = readFileSync(join(root, '.claude', 'TASK_CONTEXT.md'), 'utf8');
  check('L5 preparing the unrelated task does not', pn.code === 0 && /## Relevant lessons\s+_None\._/.test(fileOther));
  const cq = cli(['lessons', '--query', 'backdrop']);
  check('L6 `command-center lessons --query` finds it; `--task` lists the related ones', cq.code === 0 && /backdrop was clicked/.test(cq.out) && !/CSV/.test(cq.out) && /backdrop was clicked/.test(cli(['lessons', '--task', SIM]).out), cq.out.trim().split('\n')[0]);
  const gl = (await mcp.call('get_lessons_learned', { query: 'header row' })).json();
  check('L7 get_lessons_learned (MCP) searches reason, fix and prevention', gl.length === 1 && gl[0].prevention === 'Assert the first line of every export' && (await mcp.call('get_lessons_learned', { query: 'every export' })).json().length === 1);
});

// ===== U. the app: Lessons list, history card =====
await run('U', async () => {
  await openTab('Agent Hub');
  await waitDom(`!!document.querySelector('[data-lessons]')`);
  await sleep(500);
  const shown = await ev(`document.querySelectorAll('[data-lesson]').length`);
  const count = await ev(`+document.querySelector('[data-lessons-count]').textContent`);
  check('U1 the Agent Hub Lessons list shows every lesson (count and rows match the DB)', shown === lessons().length && count === lessons().length, `${shown} rows, count ${count}`);
  const text = await ev(`document.querySelector('[data-lessons]').innerText`);
  check('U2 each entry shows task, reason, fix and prevention (not recorded yet where empty)', /backdrop was clicked/.test(text) && /Added a backdrop click handler/.test(text) && /Assert the first line of every export/.test(text) && /not recorded yet/.test(text));
  await screenshot('hub-lessons');
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search lessons"]'); i.focus(); })()`);
  await typeText('csv');
  await sleep(300);
  check('U3 search narrows the list', (await ev(`document.querySelectorAll('[data-lesson]').length`)) === 1 && /CSV/.test(await ev(`document.querySelector('[data-lesson]').innerText`)));
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search lessons"]'); i.select(); })()`);
  await key('Backspace', 'Backspace', 8);
  await sleep(300);
  // edit
  const target = lessons().find((l) => l.subtask_id === MCP_TASK);
  await ev(`document.querySelector('[aria-label="Edit lesson ${target.id}"]').click()`);
  await waitDom(`!!document.querySelector('textarea[aria-label="Fix applied"]')`);
  await ev(`document.querySelector('textarea[aria-label="Fix applied"]').focus()`);
  await typeText('Wrote the header row before the data rows');
  await ev(`document.querySelector('textarea[aria-label="Prevention"]').focus()`);
  await key('a', 'KeyA', 65, 2);
  await typeText('Assert the header row of every export, and test an empty export');
  await ev(`[...document.querySelectorAll('[data-lesson="${target.id}"] button')].find(b => b.textContent.trim() === 'Save').click()`);
  await until(() => lessons().find((l) => l.id === target.id).fix_applied === 'Wrote the header row before the data rows', 5000, 'edit saved');
  const edited = lessons().find((l) => l.id === target.id);
  check('U4 editing fix and prevention in the app saves to the table', edited.prevention === 'Assert the header row of every export, and test an empty export', edited.prevention);
  check('U5 and the markdown file follows, still identical to the table', readMd().includes('Wrote the header row before the data rows') && inSync());
  const found = (await mcp.call('get_lessons_learned', { query: 'empty export' })).json();
  check('U6 the edited text is searchable (FTS index updated)', found.length === 1, String(found.length));
  // history card
  await openTab('Task Board');
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  await ev(`document.querySelector('[data-task-id="${UI_TASK}"]').scrollIntoView({ block: 'center' })`);
  const c = await center(`[data-task-id="${UI_TASK}"]`);
  await click(c.x, c.y);
  await waitDom(`!!document.querySelector('dialog[open]')`);
  await ev(`[...document.querySelectorAll('dialog[open] [role=tab]')].find(t => t.textContent.includes('History')).click()`);
  await waitDom(`document.querySelector('dialog[open]')?.innerText.includes('REJECTED')`);
  const hist = await ev(`document.querySelector('dialog[open]').innerText`);
  check('U7 the task\'s History tab shows the rejection card with its reason and the fix', /REJECTED/.test(hist) && /backdrop was clicked/.test(hist) && /Fix: Added a backdrop click handler/.test(hist));
  await screenshot('history-rejection');
  await ESC();
  await noDialog();
  // delete
  await openTab('Agent Hub');
  await waitDom(`!!document.querySelector('[data-lessons]')`);
  const before = lessons().length;
  await ev(`document.querySelector('[aria-label="Delete lesson ${target.id}"]').click()`);
  await waitDom(`!!document.querySelector('dialog[open]')`);
  check('U8 deleting asks first and says the file is updated too', /LESSONS_LEARNED\.md/.test(await dialogText()));
  await clickInDialog('Delete');
  await until(() => lessons().length === before - 1, 5000, 'lesson deleted');
  check('U9 the lesson is gone from the table, the file, search and the list', !readMd().includes('CSV export dropped') && inSync() && (await mcp.call('get_lessons_learned', { query: 'header row' })).json().length === 0 && cli(['lessons', '--query', 'header']).out.includes('No lessons'));
  await waitDom(`document.querySelectorAll('[data-lesson]').length === ${before - 1}`, 4000);
  check('U10 the list updated live', true);
  const gone = (await mcp.call('get_lessons_learned', { task_id: UI_TASK })).json();
  check('U11 the other lesson is untouched', gone.length >= 1 && gone[0].fix_applied.includes('backdrop click handler'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev(`document.querySelector('[data-lessons]').scrollIntoView({ block: 'start' })`);
  await ev(`document.querySelector('button[aria-label="Switch to light theme"]')?.click()`);
  await sleep(600);
  await screenshot('hub-lessons-light');
  await send('Emulation.clearDeviceMetricsOverride');
});

// ===== M. migration of an existing project =====
await run('M', async () => {
  check('M1 the schema is at version 4 with the prevention column and a three-column search index', q(`SELECT MAX(version) v FROM schema_version`)[0].v === 4 && q(`PRAGMA table_info(lessons_learned)`).some((c) => c.name === 'prevention') && q(`SELECT sql FROM sqlite_master WHERE name='lessons_fts'`)[0].sql.includes('prevention'));
});

check('Z0 no console errors/warnings during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
await mcp.client.close();
await reviewer.client.close();
void send('Browser.close');
await sleep(2000);
ws.close();
app.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
