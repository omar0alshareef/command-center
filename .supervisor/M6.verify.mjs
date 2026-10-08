// Drives the BUILT app (apps/desktop/out) over CDP through the M6 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M6.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
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

// ---- M6 body: Agent Hub ----
import { pathToFileURL } from 'node:url';
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
const MODE = process.env.MODE ?? 'main';

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));
const openHub = async () => {
  await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Agent Hub')).click()`);
  await waitDom(`!!document.querySelector('[data-activity-feed]')`);
  await sleep(500);
};
const click = async (x, y, button = 'left') => { await mouse('mouseMoved', x, y); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 }); await sleep(250); };
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const feedIds = () => ev(`[...document.querySelectorAll('[data-feed-entry]')].map(e => e.dataset.feedEntry)`);
const feedAgents = () => ev(`[...new Set([...document.querySelectorAll('[data-feed-entry]')].map(e => e.dataset.agent))]`);
const scroller = `document.querySelector('[data-feed-scroller]')`;
const dbAgents = () => q(`SELECT * FROM agents WHERE id NOT IN ('operator','system')`);
const weekStartMs = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() - ((n.getDay() + 6) % 7)).getTime(); };

await ev(`localStorage.removeItem('cc-ui')`);
await openHub();
const mcp = await connectMcp('claude-code');

// ===== T. tree =====
await run('T', async () => {
  const agents = dbAgents();
  const rows = await ev(`[...document.querySelectorAll('[data-agent-row]')].map(e => ({ id: e.dataset.agentRow, state: e.dataset.agentState, x: e.getBoundingClientRect().left, text: e.innerText }))`);
  check('T1 one tree row per connected agent', rows.length === agents.length, rows.map((r) => r.id).join(','));
  const parent = rows.find((r) => r.id === 'claude-code');
  const child = rows.find((r) => r.id === 'research-explorer');
  check('T2 sub-agents are indented 16px under their orchestrator', child.x - parent.x >= 14, `${parent.x} -> ${child.x}`);
  check('T3 each row shows state badge, relative time, action count and model', rows.every((r) => /ACTIVE|IDLE|ERROR/.test(r.text) && /ago|just now|no actions/.test(r.text)) && /claude-sonnet-5-5/.test(parent.text), parent.text.replace(/\n/g, ' | '));
  const expectActive = (a) => a.status === 'active' || (a.last_action_at && Date.now() - Date.parse(a.last_action_at) <= 300000);
  check('T4 ACTIVE/IDLE derived from last_action_at (5 min) or status', agents.every((a) => rows.find((r) => r.id === a.id).state === (expectActive(a) ? 'active' : 'idle')), agents.map((a) => `${a.id}:${rows.find((r) => r.id === a.id).state}`).join(' '));
  await screenshot('hub-dark');
  // collapse + persistence
  await ev(`document.querySelector('button[aria-label="Collapse claude-code"]').click()`);
  await sleep(150);
  check('T5 collapsing an orchestrator hides its sub-agents', (await ev(`document.querySelectorAll('[data-agent-row]').length`)) === agents.length - 2);
  await send('Page.reload');
  await waitDom(`!!document.querySelector('[data-agent-tree]')`, 10000);
  await sleep(500);
  check('T6 collapse state survives a reload (persisted)', (await ev(`document.querySelectorAll('[data-agent-row]').length`)) === agents.length - 2, await ev(`localStorage.getItem('cc-ui')`));
  await ev(`document.querySelector('button[aria-label="Expand claude-code"]').click()`);
  await sleep(150);
});

// ===== C. cards =====
await run('C', async () => {
  const dbp = await ev(`document.querySelector('[data-db-path]').textContent`);
  check('C1 Shared State shows the (middle-truncated) DB path', dbp.includes('command-center.db') && dbp.length <= 34, dbp);
  const counts = await ev(`[...document.querySelectorAll('section[aria-label="Shared state"] dd')].map(e => +e.textContent)`);
  const total = q('SELECT COUNT(*) c FROM agent_log')[0].c;
  check('C2 counts match the DB (milestones, tasks, loaded log rows)', counts[0] === q('SELECT COUNT(*) c FROM milestones')[0].c && counts[1] === q('SELECT COUNT(*) c FROM subtasks')[0].c && counts[2] === Math.min(500, total), `${counts} vs log ${total}`);
  const ctx = await ev(`document.querySelector('[data-context-preview]').textContent`);
  const status = (await mcp.call('get_project_status')).json();
  check("C3 Context Injection Preview equals core's context string (via get_project_status)", ctx === status.context, ctx);
  await ev(`[...document.querySelectorAll('section[aria-label="Context injection preview"] button')].find(b => b.textContent.includes('Copy')).click()`);
  await sleep(300);
  const t = await toasts();
  check('C4 Copy confirms with a toast', t.some((x) => /Context copied/.test(x)), t.join('|'));
  const today = await ev(`[...document.querySelectorAll('section[aria-label="Today\\'s summary"] dd')].map(e => +e.textContent)`);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const doneToday = q('SELECT completed_at FROM subtasks WHERE completed_at IS NOT NULL').filter((r) => Date.parse(r.completed_at) >= midnight.getTime()).length;
  check("C5 Today's Summary tiles match the DB", today[0] === doneToday && today[1] === q(`SELECT COUNT(*) c FROM subtasks WHERE status='in_progress'`)[0].c && today[2] === q(`SELECT COUNT(*) c FROM subtasks WHERE status='blocked'`)[0].c, `${today} (done today ${doneToday})`);
  const bar = await ev(`[...document.querySelectorAll('[data-contribution]')].map(e => e.dataset.contribution + ':' + Math.round(e.getBoundingClientRect().width))`);
  const perAgentToday = q(`SELECT agent_id, COUNT(*) c FROM agent_log WHERE timestamp >= ? GROUP BY agent_id`, new Date(midnight).toISOString());
  check('C6 contribution bar has one segment per agent that acted today', bar.length === perAgentToday.length && bar.length > 0, bar.join(' '));
});

// ===== F. feed =====
await run('F', async () => {
  const headers = await ev(`[...document.querySelectorAll('[data-day-header]')].map(e => e.textContent)`);
  check('F1 day headers start with TODAY (then YESTERDAY / dated)', headers[0] === 'TODAY', headers.join(','));
  const tabs = await ev(`[...document.querySelectorAll('[data-feed-tab]')].map(e => e.dataset.feedTab)`);
  check('F2 tabs: All | one per agent | Manual | System', tabs[0] === 'all' && tabs.at(-2) === 'manual' && tabs.at(-1) === 'system' && tabs.length === dbAgents().length + 3, tabs.join(','));
  const sample = await ev(`(() => { const e = document.querySelector('[data-feed-entry]'); return e.innerText; })()`);
  check('F3 entry shows agent, action pill, description, time', /\d\d:\d\d/.test(sample) && sample.length > 20, sample.replace(/\n/g, ' | '));
  // tree filter
  const r = await center('[data-agent-row="deepseek-r1"]');
  await click(r.x, r.y);
  await sleep(300);
  const ag = await feedAgents();
  const tabSel = await ev(`document.querySelector('[data-feed-tab="deepseek-r1"]').getAttribute('aria-selected')`);
  check('F4 clicking an agent in the tree filters the feed to that agent (and selects its tab)', ag.length === 1 && ag[0] === 'deepseek-r1' && tabSel === 'true', ag.join(','));
  const cnt = await ev(`document.querySelector('[data-feed-count]').textContent`);
  const expect = Math.min(500, q(`SELECT COUNT(*) c FROM agent_log WHERE agent_id='deepseek-r1'`)[0].c);
  check('F5 the filtered count is the DB count for that agent', cnt.startsWith(String(expect)), `${cnt} (db ${expect})`);
  await click(r.x, r.y);
  await sleep(200);
  check('F6 clicking the row again clears the filter', (await ev(`document.querySelector('[data-feed-tab="all"]').getAttribute('aria-selected')`)) === 'true');
  // search
  const taskId = (await ev(`document.querySelector('[data-feed-entry] button')?.textContent`)) ?? 'TASK-0';
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search activity"]'); i.focus(); })()`);
  await typeText(taskId);
  await sleep(300);
  const ids = await ev(`[...document.querySelectorAll('[data-feed-entry]')].map(e => e.innerText)`);
  check('F7 search narrows the feed to entries matching the task id', ids.length > 0 && ids.every((t) => t.includes(taskId)), `${ids.length} rows for ${taskId}`);
  // target link opens modal
  await ev(`[...document.querySelectorAll('[data-feed-entry] button')].find(b => b.textContent === ${JSON.stringify(taskId)}).click()`);
  await waitDom(`!!document.querySelector('dialog[open]')`);
  check('F8 clicking a target link opens the task modal', (await dialogText()).includes(taskId));
  await ESC();
  await noDialog();
  await ev(`(() => { const i = document.querySelector('input[aria-label="Search activity"]'); i.focus(); i.select(); })()`);
  await key('Backspace', 'Backspace', 8);
  await sleep(300);
  check('F9 clearing search restores the feed', (await ev(`document.querySelectorAll('[data-feed-entry]').length`)) > 5);
  // manual / system tabs
  await ev(`window.api.tasks.create({ milestoneId: 'M1', label: 'Operator-made task' }).then((r) => r.ok)`);
  await ev(`document.querySelector('[data-feed-tab="manual"]').click()`);
  await sleep(600);
  const man = await feedAgents();
  check('F10 Manual tab shows only operator actions (one was just made)', man.length === 1 && man[0] === 'operator', man.join(',') || '(none)');
  await ev(`document.querySelector('[data-feed-tab="all"]').click()`);
  await sleep(200);
});

// ===== W. performance =====
await run('W', async () => {
  const cards = await ev(`[...document.querySelectorAll('[data-perf-agent]')].map(e => ({ id: e.dataset.perfAgent, n: +e.querySelector('[title="Actions this week"]').textContent }))`);
  const wk = new Date(weekStartMs()).toISOString();
  const db = q(`SELECT agent_id id, COUNT(*) n FROM agent_log WHERE timestamp >= ? GROUP BY agent_id`, wk);
  const loaded = Math.min(500, q('SELECT COUNT(*) c FROM agent_log')[0].c);
  const sumCards = cards.reduce((s, c) => s + c.n, 0);
  const sumDb = db.reduce((s, c) => s + c.n, 0);
  check('W1 weekly cards total the DB actions since Monday (when the loaded window covers the week)', sumCards === sumDb || sumCards === loaded, `cards ${sumCards}, db ${sumDb}, loaded ${loaded}`);
  check('W2 each card shows tag bars', await ev(`document.querySelectorAll('[data-perf-agent] ul li').length > 0`));
  await screenshot('hub-performance');
});

// ===== L. live feed + pill =====
await run('L', async () => {
  await ev(`${scroller}.scrollTop = 0`);
  await sleep(200);
  const before = await feedIds();
  const t0 = performance.now();
  await mcp.call('log_action', { action: 'live_probe', description: 'probe at top' });
  await waitDom(`document.querySelector('[data-feed-entry]') && !!document.querySelector('[data-feed-entry] .font-semibold') && [...document.querySelectorAll('[data-feed-entry]')].some(e => e.innerText.includes('probe at top'))`, 3000);
  const ms = Math.round(performance.now() - t0);
  check('L1 log_action appears in the feed within 1 s', ms < 1000, `${ms} ms (call included)`);
  const top = await ev(`document.querySelector('[data-feed-entry]').innerText`);
  check('L2 the new entry is on top and flashes', top.includes('probe at top') && (await ev(`document.querySelector('[data-feed-entry]').classList.contains('feed-flash')`)), top.replace(/\n/g, ' | '));
  check('L3 at the top there is no "new" pill', (await ev(`!document.querySelector('[data-new-pill]')`)));
  // scrolled down: pill instead of jumping
  await ev(`${scroller}.scrollTop = 900`);
  await sleep(300);
  const anchor = await ev(`(() => { const s = ${scroller}; const sr = s.getBoundingClientRect(); const e = [...s.querySelectorAll('[data-feed-entry]')].find(x => x.getBoundingClientRect().top >= sr.top); return { id: e.dataset.feedEntry, y: e.getBoundingClientRect().top - sr.top, st: s.scrollTop }; })()`);
  await mcp.call('log_action', { action: 'live_probe', description: 'probe while scrolled' });
  await waitDom(`!!document.querySelector('[data-new-pill]')`, 3000);
  const after = await ev(`(() => { const s = ${scroller}; const sr = s.getBoundingClientRect(); const e = s.querySelector('[data-feed-entry="${anchor.id}"]'); return { y: e ? e.getBoundingClientRect().top - sr.top : null, st: s.scrollTop }; })()`);
  check('L4 scrolled down: a "↑ n new" pill appears', /1 new/.test(await ev(`document.querySelector('[data-new-pill]').innerText`)));
  check('L5 and the entry under the reader does not move', after.y !== null && Math.abs(after.y - anchor.y) <= 1, `anchor row y ${anchor.y} -> ${after.y} (scrollTop ${anchor.st} -> ${after.st})`);
  await mcp.call('log_action', { action: 'live_probe', description: 'second while scrolled' });
  await waitDom(`/2 new/.test(document.querySelector('[data-new-pill]')?.innerText ?? '')`, 3000);
  check('L6 the pill counts up', true);
  const pill = await center('[data-new-pill]');
  await screenshot('hub-new-pill');
  await click(pill.x, pill.y);
  await waitDom(`${scroller}.scrollTop <= 1 && !document.querySelector('[data-new-pill]')`, 3000);
  check('L7 clicking the pill returns to the top and clears it', true);
});

// ===== B. 5,000 rows =====
await run('B', async () => {
  const wdb = new Database(`${root}/command-center.db`);
  const base = q('SELECT MIN(timestamp) t FROM agent_log')[0].t;
  const ins = wdb.prepare(`INSERT INTO agent_log (id, agent_id, action, target_type, target_id, description, timestamp, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const agentIds = ['claude-code', 'research-explorer', 'code-quality', 'deepseek-r1'];
  wdb.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      ins.run(`bulk-${i}`, agentIds[i % 4], i % 3 ? 'tests_passed' : 'file_edited', 'subtask', `TASK-${String((i % 60) + 1).padStart(3, '0')}`, `Bulk row ${i}: something an agent did`, new Date(Date.parse(base) - (i + 1) * 60000).toISOString(), JSON.stringify([['quality', 'build', 'docs'][i % 3]]));
    }
  })();
  wdb.close();
  const total = q('SELECT COUNT(*) c FROM agent_log')[0].c;
  await waitDom(`!!document.querySelector('[data-feed-entry]')`);
  let loaded = 0;
  for (let i = 0; i < 20; i++) {
    const done = await ev(`document.body.innerText.includes('Start of log')`);
    if (done) break;
    await ev(`[...document.querySelectorAll('[data-activity-feed] button')].find(b => b.textContent.trim() === 'Load older')?.click()`);
    await sleep(500);
  }
  const cnt = await ev(`document.querySelector('[data-feed-count]').textContent`);
  loaded = parseInt(cnt, 10);
  check('B1 "Load older" pages back through the whole log', loaded === total && total >= 5000, `${cnt} (db ${total})`);
  check('B2 the end of the log is announced', await ev(`document.body.innerText.includes('Start of log')`));
  const dom = await ev(`document.querySelectorAll('[data-feed-entry]').length`);
  check('B3 only a window of rows is mounted (virtualized)', dom > 0 && dom < 80, `${dom} DOM rows for ${loaded}`);
  // scroll smoothness: drive scrollTop every animation frame and record frame intervals
  const perf = await ev(`new Promise((resolve) => {
    const s = ${scroller};
    s.scrollTop = 0;
    const frames = [];
    let last = performance.now(), y = 0, n = 0;
    const step = (t) => {
      frames.push(t - last); last = t;
      y += 40; n++;
      s.scrollTop = y;
      if (n < 240 && y < s.scrollHeight - s.clientHeight) requestAnimationFrame(step); else resolve({ frames, y });
    };
    requestAnimationFrame(step);
  })`);
  const f = perf.frames.slice(2).sort((a, b) => a - b);
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  const p95 = f[Math.floor(f.length * 0.95)];
  check('B4 scrolling 5,000 rows holds ~60 fps (avg frame <= 17.5 ms, p95 <= 25 ms)', avg <= 17.5 && p95 <= 25, `${f.length} frames, avg ${avg.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${f.at(-1).toFixed(1)} ms, scrolled ${perf.y}px`);
  await screenshot('hub-5000');
  await ev(`${scroller}.scrollTop = 0`);
  // filtered load older with an agent filter
  await ev(`document.querySelector('[data-feed-tab="deepseek-r1"]').click()`);
  await sleep(300);
  const c2 = await ev(`document.querySelector('[data-feed-count]').textContent`);
  check('B5 per-agent filter works over the loaded 5,000', parseInt(c2, 10) === q(`SELECT COUNT(*) c FROM agent_log WHERE agent_id='deepseek-r1'`)[0].c, c2);
  await ev(`document.querySelector('[data-feed-tab="all"]').click()`);
});

// ===== V. view tasks / copy id =====
await run('V', async () => {
  const r = await center('[data-agent-row="deepseek-r1"]');
  await click(r.x, r.y, 'right');
  await waitDom(`!!document.querySelector('[role=menu]')`);
  const items = await ev(`[...document.querySelectorAll('[role=menu] button')].map(b => b.textContent.trim())`);
  check('V1 right-click menu: View tasks / Copy agent id', items.join() === 'View tasks,Copy agent id', items.join());
  const p = await ev(`(() => { const b = [...document.querySelectorAll('[role=menu] button')].find(b => b.textContent.includes('View tasks')); const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()`);
  await click(p.x, p.y);
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  await sleep(400);
  const cards = await ev(`[...new Set([...document.querySelectorAll('[data-task-id]')].map(e => e.dataset.taskId))]`);
  const mine = q(`SELECT id FROM subtasks WHERE assignee='deepseek-r1'`).map((x) => x.id).sort();
  check('V2 "View tasks" opens the Task Board filtered to that agent', JSON.stringify([...cards].sort()) === JSON.stringify(mine) && mine.length > 0, `${cards.length} cards vs ${mine.length} tasks`);
  await openHub();
});

// ===== T2. themes + sizes =====
await run('Z', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev(`document.documentElement.dataset.theme = 'light'`);
  await ev(`${scroller}.scrollTop = 0`);
  await sleep(500);
  await screenshot('hub-light-1200');
  check('Z1 light theme at 1200x800 renders; screenshot taken', true);
  await ev(`document.documentElement.dataset.theme = 'dark'`);
  await send('Emulation.clearDeviceMetricsOverride');
});

check('X1 no console errors/warnings during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await mcp.client.close();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close();
app.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
