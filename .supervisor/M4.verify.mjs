// Drives the BUILT app (apps/desktop/out) over CDP through the M3 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M4.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
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

// ---- M4 body, appended after the shared harness (CDP plumbing, drag(), check(), run()) ----
import { pathToFileURL } from 'node:url';
const MODE = process.env.MODE ?? 'main';
const BUNDLE = `${REPO}/packages/mcp-server/dist/index.js`;
const sdk = (p) => import(pathToFileURL(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');

async function connectMcp(name, launch = { command: process.execPath, args: [BUNDLE], env: { PROJECT_ROOT: root } }) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StdioClientTransport({ ...launch, stderr: 'pipe' }));
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    return { isError: Boolean(r.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call };
}
const columnOf = (tid) => ev(`document.querySelector('[data-task-id="${tid}"]')?.closest('[data-column]')?.dataset.column ?? null`);
const waitColumn = async (tid, col, ms = 5000) => {
  const t0 = performance.now();
  await waitDom(`document.querySelector('[data-task-id="${tid}"]')?.closest('[data-column]')?.dataset.column === '${col}'`, ms);
  return Math.round(performance.now() - t0);
};

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') {
  check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));
}

if (MODE === 'empty') {
  // A project with no agents: the Agent Hub empty state must show a snippet that really works.
  await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Agent Hub')).click()`);
  await waitDom(`document.body.innerText.includes('No agents connected')`);
  const blocks = await ev(`[...document.querySelectorAll('main pre')].map(p => p.innerText)`);
  check('E1 empty Agent Hub shows "No agents connected"', true);
  check('E2 shows a claude mcp add command with the real project root and server path', blocks[0].startsWith('claude mcp add command-center') && blocks[0].includes('PROJECT_ROOT=') && blocks[0].includes('mcp-server') && blocks[0].includes('index.js'), blocks[0]);
  const cfg = JSON.parse(blocks[1]).mcpServers['command-center'];
  check('E3 config block names the bundled server and PROJECT_ROOT', cfg.command === 'node' && cfg.args[0].endsWith('index.js') && cfg.env.PROJECT_ROOT.length > 0, JSON.stringify(cfg).slice(0, 160));
  await screenshot('agent-hub-empty');
  // The decisive test: launch the server EXACTLY as the snippet says and use it.
  const mcp = await connectMcp('snippet-agent', { command: process.execPath, args: cfg.args, env: cfg.env });
  const tools = await mcp.client.listTools();
  check('E4 a server launched from the on-screen config lists 25 tools', tools.tools.length === 25, String(tools.tools.length));
  const status = await mcp.call('get_project_status');
  check('E5 and talks to this project (empty board)', !status.isError && status.json().total_tasks === 0, status.text.slice(0, 80));
  await mcp.call('log_action', { action: 'hello_from_snippet', description: 'first call registers me' });
  await waitDom(`!document.body.innerText.includes('No agents connected')`, 6000);
  check('E6 the first tool call auto-registers the agent and the hub reacts live', /connect another agent/i.test(await ev(`document.body.innerText`)));
  await mcp.client.close();
} else {
  await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Task Board')).click()`);
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  await sleep(500);
  const mcp = await connectMcp('claude-code');

  // ===== L. The core loop: tool calls move cards live =====
  let id;
  await run('L', async () => {
    const list = (await mcp.call('list_tasks', { status: 'todo', limit: 5 })).json();
    id = list.tasks.find((t) => !t.depends_on)?.id;
    check('L1 list_tasks over stdio returns todo tasks', Boolean(id) && list.total > 0, `${list.total} todo, using ${id}`);
    await ev(`document.querySelector('[data-task-id="${id}"]')?.scrollIntoView({ block: 'center' })`);
    check('L2 the card starts in To Do', (await columnOf(id)) === 'todo');
    await screenshot('before-start');

    const t0 = performance.now();
    const started = await mcp.call('start_task', { task_id: id });
    const callMs = Math.round(performance.now() - t0);
    const inProgressMs = await waitColumn(id, 'in_progress');
    check('L3 start_task moves the card to In Progress live', !started.isError && started.json().status === 'in_progress', `tool ${callMs} ms, card moved after ${inProgressMs} ms total`);
    await screenshot('after-start');

    await mcp.call('log_action', { action: 'tests_passed', task_id: id, description: 'all green', tags: ['quality'] });
    const row = q(`SELECT agent_id, action, target_id, description FROM agent_log WHERE action='tests_passed' AND target_id=?`, id)[0];
    check('L4 log_action lands in the DB under the calling agent', row?.agent_id === 'claude-code' && row.description === 'all green', JSON.stringify(row));

    const t1 = performance.now();
    const done = await mcp.call('complete_task', { task_id: id, summary: 'implemented and verified' });
    const reviewMs = await waitColumn(id, 'review');
    check('L5 complete_task moves the card to Review live', !done.isError && done.json().status === 'review', `card moved after ${reviewMs} ms (call ${Math.round(performance.now() - t1) - reviewMs} ms)`);
    await waitDom(`document.querySelector('[data-task-id="${id}"]').innerText.includes('Awaiting your review')`);
    const amber = await ev(`(() => { const c = document.querySelector('[data-task-id="${id}"] > div'); const probe = document.createElement('i'); probe.style.color = 'var(--warning)'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return { left: getComputedStyle(c).borderLeftColor, want }; })()`);
    check('L6 the Review card has the amber treatment (left border + "Awaiting your review")', amber.left === amber.want, JSON.stringify(amber));
    await screenshot('after-complete');

    const bad = await mcp.call('approve_task', { task_id: id, agent_id: 'operator' });
    check('L7 spoofing the operator is refused with an actionable message', bad.isError && /Omit agent_id/.test(bad.text), bad.text.slice(0, 110));
    const stillReview = await columnOf(id);
    check('L8 …and the card did not move', stillReview === 'review');
    const illegal = await mcp.call('start_task', { task_id: id });
    check('L9 an invalid transition returns an error naming the next tool, not a crash', illegal.isError && /approve_task|reject_task/.test(illegal.text), illegal.text.slice(0, 120));
    check('L10 the server still answers afterwards', !(await mcp.call('get_project_status')).isError);

    await mcp.call('reject_task', { task_id: id, reason: 'Needs keyboard support' });
    await waitColumn(id, 'in_progress');
    check('L11 reject_task sends it back to In Progress', task(id).status === 'in_progress');
    await mcp.call('complete_task', { task_id: id, summary: 'keyboard support added' });
    await mcp.call('approve_task', { task_id: id });
    await waitColumn(id, 'done');
    check('L12 approve_task completes it: start→complete→reject→complete→approve all moved the card live', task(id).status === 'done');
  });

  // ===== A. Agents appear live =====
  await run('A', async () => {
    const before = q(`SELECT COUNT(*) n FROM agents`)[0].n;
    const other = await connectMcp('Brand New Agent');
    await other.call('log_action', { action: 'hello' });
    check('A1 a new client is auto-registered as its own agent', q(`SELECT type FROM agents WHERE id='brand-new-agent'`)[0]?.type === 'orchestrator' && q(`SELECT COUNT(*) n FROM agents`)[0].n === before + 1);
    await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Agent Hub')).click()`);
    await waitDom(`/AGENTS\\s*\\n?\\s*${before - 2 + 1}\\b/.test(document.querySelector('main').innerText)`, 6000);
    check('A2 the Agent Hub count updates without a refresh', true);
    await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Task Board')).click()`);
    await other.client.close();
  });

  // ===== C. Carry-over: an external update arriving mid-drag must not reorder under the cursor =====
  await run('C', async () => {
    await sleep(800);
    const cands = q(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id`).map((r) => r.id);
    const [A, B] = [cands[0], cands[1]];
    const inProgBefore = await colIds('in_progress');
    await drag(A, 'in_progress', { hold: true }); // pressed, moved, NOT released
    const mid = await mcp.call('start_task', { task_id: B }); // an agent starts B while the operator is dragging A
    check('C1 the agent’s call succeeded', !mid.isError);
    await sleep(1300); // longer than the watcher's poll + debounce
    const during = await colIds('in_progress');
    check('C2 mid-drag, the board did not change under the cursor', JSON.stringify(during) === JSON.stringify(inProgBefore), `before=${inProgBefore.length} during=${during.length}`);
    const bx = await rect(colSel('in_progress'));
    await mouse('mouseReleased', bx.x + bx.w / 2, bx.y + 90, 0);
    await sleep(400);
    await until(() => task(A).status === 'in_progress', 4000, 'A started by the drop');
    await waitColumn(B, 'in_progress', 4000);
    check('C3 after the drop the deferred update is applied: both cards are In Progress', (await columnOf(A)) === 'in_progress' && (await columnOf(B)) === 'in_progress');
  });

  // ===== S. Carry-over: Esc on stacked modal + confirm =====
  await run('S', async () => {
    const tid = q(`SELECT id FROM subtasks WHERE status='todo' ORDER BY id LIMIT 1`)[0].id;
    await ev(`document.querySelector('[data-task-id="${tid}"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-task-id="${tid}"]').click()`);
    await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
    await clickInDialog('Reset');
    await waitDom(`document.querySelectorAll('dialog[open]').length === 2`);
    await ESC();
    await waitDom(`document.querySelectorAll('dialog[open]').length === 1`);
    check('S1 Esc closes only the top-most dialog (the confirm)', (await dialogText()).includes(tid));
    await ESC();
    await noDialog();
    check('S2 a second Esc closes the task modal', true);
  });

  // ===== W. Carry-over: 1200x800 and light theme =====
  await run('W', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const dims = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight })`);
    check('W1 no page-level scrollbars at 1200×800 (dark)', dims.sw <= dims.cw && dims.sh <= dims.ch, JSON.stringify(dims));
    const fit = await ev(`(() => { const s = document.querySelector('[data-column]').closest('div.overflow-x-auto'); const inner = [...document.querySelectorAll('[data-column]')].filter((c) => c.scrollWidth > c.clientWidth).length; return { boardScroll: s.scrollWidth - s.clientWidth, columnsOverflowing: inner }; })()`);
    check('W1b all five columns fit at 1200×800 with no horizontal scrolling anywhere on the board', fit.boardScroll <= 0 && fit.columnsOverflowing === 0, JSON.stringify(fit));
    await screenshot('min-size-dark');
    await ev(`document.querySelector('button[aria-label^="Switch to light"]').click()`);
    await waitDom(`document.documentElement.dataset.theme === 'light'`);
    await sleep(300);
    const light = await ev(`({ bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme })`);
    check('W2 light theme applies (page + native controls)', light.bg === 'rgb(246, 246, 250)' && light.scheme === 'light', JSON.stringify(light));
    await screenshot('min-size-light-board');
    const tid = q(`SELECT id FROM subtasks WHERE status='todo' ORDER BY id LIMIT 1`)[0].id;
    await ev(`document.querySelector('[data-task-id="${tid}"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-task-id="${tid}"]').click()`);
    await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
    const ring = await ev(`getComputedStyle(document.querySelector('dialog[open] .modal-body')).outlineStyle`);
    check('W3a the task modal body shows no focus ring when opened', ring === 'none', ring);
    await screenshot('min-size-light-modal');
    await ESC();
    await noDialog();
    await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Agent Hub')).click()`);
    await sleep(400);
    await screenshot('min-size-light-agenthub');
    await send('Emulation.clearDeviceMetricsOverride');
    await ev(`document.querySelector('button[aria-label^="Switch to dark"]').click()`);
    check('W3 light screens captured for review', true);
  });

  await mcp.client.close();
}

check('Z no console errors / uncaught exceptions', consoleErrors.length === 0, consoleErrors.join(' || '));
console.log(JSON.stringify({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }, null, 1));
send('Browser.close');
setTimeout(() => {
  app.kill();
  process.exit(0);
}, 2000);
