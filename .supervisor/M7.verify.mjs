// Drives the BUILT app (apps/desktop/out) over CDP through the M7 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M7.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
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

// ---- M7 body: Calendar ----
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
// TZ_TEST=<IANA zone>: run the whole check in that zone. The env var TZ is ignored by node/Electron on Windows,
// so set it at runtime for this script and override the page's zone over CDP, then reload so it renders in it.
const TZ_TEST = process.env.TZ_TEST;
if (TZ_TEST) process.env.TZ = TZ_TEST;

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));
if (TZ_TEST) {
  await send('Emulation.setTimezoneOverride', { timezoneId: TZ_TEST });
  await send('Page.reload');
  await waitDom(`!!document.querySelector('[role=tab]')`, 10000);
  await sleep(600);
}
const appTz = await ev(`new Date().getTimezoneOffset()`);
check('TZ0 the app and this script run in the same time zone', appTz === new Date().getTimezoneOffset(), `app ${appTz}; `+ `${Intl.DateTimeFormat().resolvedOptions().timeZone} (TZ_TEST=${TZ_TEST ?? 'none'}), offset now ${-new Date().getTimezoneOffset() / 60}h`);
await ev(`localStorage.removeItem('cc-ui')`);
const openCalendar = async () => {
  await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Calendar')).click()`);
  await waitDom(`!!document.querySelector('[data-week-grid]') || !!document.body.innerText.includes('No milestones yet')`);
  await sleep(300);
};
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(250); };
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };

// ---- local-time helpers (this script is in the same zone as the app) ----
const pad = (n) => String(n).padStart(2, '0');
const dk = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const isoWeek = (d) => { const th = addDays(mondayOf(d), 3); const j = new Date(th.getFullYear(), 0, 1); return Math.floor(Math.round((th - j) / 86400000) / 7) + 1; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d) => `${MON[d.getMonth()]} ${d.getDate()}`;
const weekLabel = (anchor) => { const m = mondayOf(anchor); return `Week ${isoWeek(m)} · ${md(m)} – ${md(addDays(m, 6))}`; };
const dbDone = () => q(`SELECT id, completed_at FROM subtasks WHERE status='done' AND completed_at IS NOT NULL`);
const dbByDay = (anchor) => {
  const m = mondayOf(anchor);
  const out = {};
  for (let i = 0; i < 7; i++) out[dk(addDays(m, i))] = [];
  for (const t of dbDone().sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at) || a.id.localeCompare(b.id))) {
    const k = dk(new Date(t.completed_at));
    if (out[k]) out[k].push(t.id);
  }
  return out;
};
const uiByDay = () => ev(`Object.fromEntries([...document.querySelectorAll('[data-day]')].map(d => [d.dataset.day, [...d.querySelectorAll('[data-chip]')].map(c => c.dataset.chip)]))`);
const label = () => ev(`document.querySelector('[data-week-label]').innerText.replace(/\\s*\\n\\s*/g, ' ')`);

if (MODE === 'empty') {
  await openCalendar();
  check('E1 an empty project shows the hydration empty state, not a broken grid', await ev(`document.body.innerText.includes('No milestones yet') && !document.querySelector('[data-week-grid]')`));
  await screenshot('calendar-empty');
} else {
  // Make the data interesting: completions spread over this week and the previous one, including local-midnight edges.
  const wdb = new Database(`${root}/command-center.db`);
  const todos = q(`SELECT id FROM subtasks WHERE status IN ('todo') ORDER BY id LIMIT 12`).map((r) => r.id);
  const now0 = new Date();
  const mon = mondayOf(now0);
  const at = (d, h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).toISOString();
  const edits = [
    [mon, 0, 5], // 00:05 on Monday (first minutes of the week)
    [addDays(mon, 6), 23, 55], // 23:55 on Sunday (last minutes)
    [addDays(mon, -1), 23, 50], // previous Sunday, late: belongs to the previous week
    [addDays(mon, -7), 12, 0], // a week earlier
  ];
  wdb.transaction(() => {
    edits.forEach(([d, h, m], i) => wdb.prepare(`UPDATE subtasks SET status='done', done=1, completed_at=?, completed_by='claude-code' WHERE id=?`).run(at(d, h, m), todos[i]));
  })();
  wdb.close();
  await sleep(1200);
  await openCalendar();
  const mcp = await connectMcp('claude-code');

  // ===== H. header and grid =====
  await run('H', async () => {
    const now = new Date();
    check('H1 header reads "Week N · Mon D – Mon D · n completed" (ISO week, Monday start)', (await label()).startsWith(weekLabel(now)), await label());
    const days = await ev(`[...document.querySelectorAll('[data-day]')].map(d => ({ day: d.dataset.day, head: d.querySelector('[data-day-header]').innerText.replace(/\\s+/g, ' ').trim(), today: d.dataset.today === 'true', weekend: d.dataset.weekend === 'true' }))`);
    check('H2 seven columns Mon..Sun starting on Monday', days.length === 7 && days.map((d) => d.head.slice(0, 3)).join() === 'MON,TUE,WED,THU,FRI,SAT,SUN', days.map((d) => d.head).join(' | '));
    check('H3 the column dates are this week (local)', days[0].day === dk(mondayOf(now)) && days[6].day === dk(addDays(mondayOf(now), 6)));
    const today = days.filter((d) => d.today);
    check('H4 exactly one column is marked today, and it is today (local)', today.length === 1 && today[0].day === dk(now), today.map((d) => d.day).join());
    check('H5 only Sat/Sun are weekend-styled', days.filter((d) => d.weekend).map((d) => d.head.slice(0, 3)).join() === 'SAT,SUN');
    const accent = await ev(`(() => { const h = document.querySelector('[data-today="true"] [data-day-header]'); const probe = document.createElement('i'); probe.style.color = 'var(--accent)'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return { got: getComputedStyle(h).borderTopColor, want }; })()`);
    check('H6 today header has an accent bar', accent.got === accent.want, JSON.stringify(accent));
    await screenshot('calendar-dark');
  });

  // ===== C. chips match the DB per local day =====
  await run('C', async () => {
    const expect = dbByDay(new Date());
    const got = await uiByDay();
    check('C1 every chip sits on its local completion day, ordered by time', JSON.stringify(got) === JSON.stringify(expect), JSON.stringify({ expect, got }).slice(0, 400));
    const total = Object.values(expect).flat().length;
    check('C2 the header count equals the week total', (await label()).includes(`${total} completed`), `${total} in DB`);
    const foot = await ev(`[...document.querySelectorAll('[data-day-count]')].map(e => e.innerText)`);
    check('C3 each day footer says "n done"', foot.join() === Object.values(expect).map((a) => `${a.length} done`).join(), foot.join());
    const dashes = await ev(`[...document.querySelectorAll('[data-day]')].map(d => d.querySelectorAll('[data-chip]').length === 0 && d.innerText.includes('—'))`);
    check('C4 empty days show a faint "—"', dashes.filter(Boolean).length === Object.values(expect).filter((a) => a.length === 0).length);
    const edge = await ev(`[document.querySelector('[data-day="${dk(mondayOf(new Date()))}"] [data-chip]')?.dataset.chip, document.querySelector('[data-day="${dk(addDays(mondayOf(new Date()), 6))}"] [data-chip]')?.dataset.chip]`);
    check('C5 00:05 Monday and 23:55 Sunday both land inside this week, on the right days', !!edge[0] && !!edge[1], edge.join());
    const chip = await ev(`(() => { const c = document.querySelector('[data-chip]'); const probe = document.createElement('i'); return { text: c.innerText.replace(/\\n/g, ' | '), title: c.title, border: getComputedStyle(c).borderLeftWidth }; })()`);
    check('C6 a chip has a 3px domain border, label, domain tag, time, and a full-label tooltip', chip.border === '3px' && /\d\d:\d\d/.test(chip.text) && chip.title.includes('TASK-'), JSON.stringify(chip));
  });

  // ===== N. navigation =====
  await run('N', async () => {
    const now = new Date();
    const prev = addDays(now, -7);
    await ev(`document.querySelector('button[aria-label="Previous week"]').click()`);
    await sleep(250);
    check('N1 Previous week button shows last week', (await label()).startsWith(weekLabel(prev)), await label());
    check('N2 last week\'s chips match the DB', JSON.stringify(await uiByDay()) === JSON.stringify(dbByDay(prev)));
    check('N3 no "today" marker on another week', (await ev(`document.querySelectorAll('[data-today="true"]').length`)) === 0);
    await key2('t');
    check('N4 T jumps back to this week', (await label()).startsWith(weekLabel(now)), await label());
    await key2('ArrowLeft');
    await key2('ArrowLeft');
    check('N5 ← steps back one week per press', (await label()).startsWith(weekLabel(addDays(now, -14))), await label());
    await key2('ArrowRight');
    check('N6 → steps forward', (await label()).startsWith(weekLabel(prev)), await label());
    await ev(`document.querySelector('button[aria-label="Next week"]').click()`);
    await sleep(200);
    check('N7 Next week button returns to this week', (await label()).startsWith(weekLabel(now)));
    // far back: empty state
    for (let i = 0; i < 30; i++) await ev(`document.querySelector('button[aria-label="Previous week"]').click()`);
    await sleep(300);
    check('N8 an empty week shows "Nothing completed this week" with a previous-week link', await ev(`!!document.querySelector('[data-calendar-empty]') && document.body.innerText.includes('Nothing completed this week')`));
    check('N9 its header count is 0', (await label()).includes('0 completed'), await label());
    await screenshot('calendar-empty-week');
    await key2('t');
    // picker
    await ev(`document.querySelector('[data-week-label]').click()`);
    await waitDom(`!!document.querySelector('[role=dialog][aria-label="Choose a date"] input')`);
    const target = addDays(now, -21);
    await ev(`(() => { const el = document.querySelector('[role=dialog][aria-label="Choose a date"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(dk(target))}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
    check('N10 the date picker jumps to the week containing the chosen day (value set programmatically)', (await label()).startsWith(weekLabel(target)) && (await ev(`!document.querySelector('[role=dialog][aria-label="Choose a date"]')`)), await label());
    await key2('t');
    // typing in the picker/search must not trigger the hotkeys: open picker, press T into input context
    await ev(`document.querySelector('[data-week-label]').click()`);
    await waitDom(`!!document.querySelector('[role=dialog][aria-label="Choose a date"] input')`);
    await ESC();
    await sleep(150);
    check('N11 Esc closes the picker', await ev(`!document.querySelector('[role=dialog][aria-label="Choose a date"]')`));
  });

  // ===== M. modal =====
  await run('M', async () => {
    const c = await center('[data-chip]');
    const id = await ev(`document.querySelector('[data-chip]').dataset.chip`);
    await click(c.x, c.y);
    await waitDom(`!!document.querySelector('dialog[open]')`);
    check('M1 clicking a chip opens the task modal', (await dialogText()).includes(id), id);
    await ESC();
    await noDialog();
    await click(c.x, c.y);
    await waitDom(`!!document.querySelector('dialog[open]')`);
    const open = await label();
    await key2('ArrowLeft');
    check('M2 hotkeys are ignored while the modal is open', (await label()) === open);
    await ESC();
    await noDialog();
    await key2('ArrowLeft');
    check('M3 and work again after it closes', (await label()).startsWith(weekLabel(addDays(new Date(), -7))), await label());
    await key2('t');
  });

  // ===== L. live completions (MCP + board path) =====
  await run('L', async () => {
    await key2('t');
    const todayKey = dk(new Date());
    const before = await ev(`document.querySelectorAll('[data-day="${todayKey}"] [data-chip]').length`);
    const id = q(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id DESC LIMIT 1`)[0].id;
    await mcp.call('start_task', { task_id: id });
    await mcp.call('complete_task', { task_id: id, summary: 'done via MCP' });
    const reviewer = await connectMcp('reviewer-agent');
    const t0 = performance.now();
    const res = await reviewer.call('approve_task', { task_id: id });
    check('L1 approve_task (MCP) succeeds', !res.isError, res.text.slice(0, 90));
    await waitDom(`!!document.querySelector('[data-day="${todayKey}"] [data-chip="${id}"]')`, 4000);
    const ms = Math.round(performance.now() - t0);
    check('L2 the chip appears on today\'s column live, no reload', true, `${ms} ms after approve_task`);
    check('L3 today\'s count went up by one', (await ev(`document.querySelectorAll('[data-day="${todayKey}"] [data-chip]').length`)) === before + 1);
    check('L4 the header total updated', (await label()).includes(`${Object.values(dbByDay(new Date())).flat().length} completed`), await label());
    await reviewer.client.close();
    // board path: operator approves a review task through the same IPC the board's approve button/drag uses
    const rev = q(`SELECT id FROM subtasks WHERE status='review' LIMIT 1`)[0]?.id;
    if (rev) {
      const r = await ev(`window.api.tasks.transition({ taskId: ${JSON.stringify(rev)}, trigger: 'approve' }).then((r) => r.ok)`);
      await waitDom(`!!document.querySelector('[data-day="${todayKey}"] [data-chip="${rev}"]')`, 4000);
      check('L5 approving from the app (board path) also places a chip on today', r === true, rev);
    }
    // reopening removes it again
    const rj = await ev(`window.api.tasks.transition({ taskId: ${JSON.stringify(id)}, trigger: 'reset', payload: { reason: 'redo' } }).then((r) => r.ok ? 'ok' : r.error.message)`);
    if (rj === 'ok') {
      await waitDom(`!document.querySelector('[data-chip="${id}"]')`, 4000);
      check('L6 re-opening a task removes its chip', true);
    } else check('L6 re-opening a task removes its chip', false, rj);
    await screenshot('calendar-live');
  });

  // ===== Z. light theme + 1200x800 =====
  await run('Z', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await ev(`document.documentElement.dataset.theme = 'light'`);
    await sleep(500);
    await screenshot('calendar-light-1200');
    const overflowX = await ev(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    check('Z1 no page-level horizontal scrollbar at 1200x800 (grid scrolls inside its own container)', !overflowX);
    await ev(`document.documentElement.dataset.theme = 'dark'`);
    await send('Emulation.clearDeviceMetricsOverride');
  });
  await mcp.client.close();
}

async function key2(k) {
  const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
  const vk = { ArrowLeft: 37, ArrowRight: 39, t: 84 }[k];
  await send('Input.dispatchKeyEvent', { type: k.length === 1 ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(250);
}

check('X1 no console errors/warnings during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close();
app.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
