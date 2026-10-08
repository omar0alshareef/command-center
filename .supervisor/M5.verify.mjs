// Drives the BUILT app (apps/desktop/out) over CDP through the M5 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M5.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
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

// ---- M5 body: Swim Lane ----
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

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));
await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Swim Lane')).click()`);
await waitDom(`document.querySelectorAll('[data-milestone-id]').length >= 8`);
await sleep(600);

const node = (mid) => ev(`(() => { const e = document.querySelector('[data-milestone-id="${mid}"]'); if (!e) return null; const d = e.dataset; return { x: +d.x, plannedX: +d.plannedX, y: +d.y, lane: +d.lane, status: d.status, drift: +d.drift }; })()`);
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const click = async (x, y, button = 'left') => { await mouse('mouseMoved', x, y); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 }); await sleep(250); };
const panelOpen = () => ev(`!!document.querySelector('aside[aria-label="Milestone details"]:not([aria-hidden="true"])')`);
const panelClosed = `!document.querySelector('aside[aria-label="Milestone details"]:not([aria-hidden="true"])')`;
const weekW = () => ev(`+document.querySelector('[data-zoom]').dataset.zoom`);
const scrollerLeft = () => ev(`document.querySelector('[data-swim-scroller]').scrollLeft`);
const circleSel = (m) => `[data-milestone-id="${m}"] .node-focus`;
const menuItemPos = (text) => ev(`(() => { const b = [...document.querySelectorAll('[role=menu] button')].find(b => b.textContent.includes(${JSON.stringify(text)})); const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()`);

const proj = q('SELECT * FROM project')[0];
const ms = q('SELECT * FROM milestones ORDER BY id');
const dayMs = 86400000;
const dn = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / dayMs;
const lt = new Date();
const todayIso = `${lt.getFullYear()}-${String(lt.getMonth() + 1).padStart(2, '0')}-${String(lt.getDate()).padStart(2, '0')}`;
const W0 = await weekW();

// ===== P. placement =====
await run('P', async () => {
  const labels = await ev(`[...document.querySelectorAll('[data-lane-label]')].map(e => e.dataset.laneLabel)`);
  check('P1 one lane label per domain, sticky label column present', labels.length === 3 && ms.every((m) => labels.includes(m.domain)), labels.join(','));
  const bad = [];
  const canvas = await rect('[data-swim-canvas]');
  for (const m of ms) {
    const n = await node(m.id);
    const wk = await rect(`[data-week="${m.week}"]`);
    const expectPlanned = wk.x - canvas.x + W0 / 2; // planned_start on the week's Monday, 7-day span -> centred in the week
    if (!n || Math.abs(n.plannedX - expectPlanned) > 1.5 || n.lane !== labels.indexOf(m.domain)) bad.push(`${m.id}: x=${n?.plannedX} want ${expectPlanned.toFixed(1)}, lane ${n?.lane} want ${labels.indexOf(m.domain)}`);
  }
  check('P2 every seed milestone sits in its domain lane at its planned week', bad.length === 0, bad.join('; ') || `${ms.length} nodes checked`);
  const weeks = await ev(`document.querySelectorAll('[data-week]').length`);
  check('P3 week grid header spans the plan (>= 12 weeks)', weeks >= 12, String(weeks));
  const phases = await ev(`[...document.querySelectorAll('[data-phase]')].map(e => e.textContent.trim())`);
  check('P4 phase bands labelled', phases.join() === 'Foundation,Build,Launch', phases.join());
  const keys = await ev(`[...document.querySelectorAll('[data-key-milestone-id]')].map(e => e.dataset.keyMilestoneId)`);
  check('P5 key milestones render as diamonds in the Key row', keys.join() === 'M4,M8', keys.join());
  await screenshot('swim-dark-1200');
});

// ===== N. NOW =====
await run('N', async () => {
  const nowX = await ev(`+document.querySelector('[data-now-line]').dataset.nowX`);
  const expect = ((dn(todayIso) - dn(proj.start_date) + 0.5) / 7) * W0;
  check("N1 NOW line is at the middle of today's day column", Math.abs(nowX - expect) < 0.6, `now ${nowX.toFixed(1)} expected ${expect.toFixed(1)} for ${todayIso}`);
  const line = await rect('[data-now-line]');
  const wk = await rect(`[data-week="${Math.floor((dn(todayIso) - dn(proj.start_date)) / 7) + 1}"]`);
  check('N2 NOW line lies inside the current week column', line.x >= wk.x - 0.5 && line.x <= wk.x + wk.w + 0.5, `${line.x} in [${wk.x}, ${wk.x + wk.w}]`);
  check('N3 NOW flag visible in the sticky header', (await ev(`document.querySelector('[data-now-flag]').textContent`)) === 'NOW');
  const sc = await rect('[data-swim-scroller]');
  check('N4 initial scroll puts NOW in view', line.x > sc.x + 140 && line.x < sc.x + sc.w, `${line.x} in view [${sc.x}, ${sc.x + sc.w}]`);
});

// ===== D. drift =====
await run('D', async () => {
  const m4 = await node('M4');
  const dm = ms.find((m) => m.id === 'M4').drift_days;
  check('D1 M4 (drift +5d) node is shifted right of its planned position by 5/7 week', Math.abs(m4.x - m4.plannedX - (dm / 7) * W0) < 1, `${m4.x - m4.plannedX} vs ${(dm / 7) * W0}`);
  check('D2 drift ghost drawn for M4 and for ahead-of-plan M5, none for on-plan M1', await ev(`!!document.querySelector('[data-drift-ghost="M4"]') && !!document.querySelector('[data-drift-ghost="M5"]') && !document.querySelector('[data-drift-ghost="M1"]')`));
  const badge = await ev(`document.querySelector('[data-milestone-id="M4"] [data-drift-badge]')?.textContent`);
  const badge5 = await ev(`document.querySelector('[data-milestone-id="M5"] [data-drift-badge]')?.textContent`);
  check('D3 drift badges read +5d and −1d', badge === '+5d' && badge5 === '−1d', `${badge} ${badge5}`);
});

// ===== S. sticky axes =====
await run('S', async () => {
  await ev(`(() => { const s = document.querySelector('[data-swim-scroller]'); s.scrollLeft = 300; s.scrollTop = 60; })()`);
  await sleep(150);
  const sc = await rect('[data-swim-scroller]');
  const hd = await rect('[data-swim-header]');
  const lb = await rect('[data-swim-labels]');
  check('S1 week/phase header stays pinned to the top while scrolling', Math.abs(hd.y - sc.y) < 1.5, `${hd.y} vs ${sc.y}`);
  check('S2 lane labels stay pinned to the left while scrolling right', Math.abs(lb.x - sc.x) < 1.5, `${lb.x} vs ${sc.x}`);
  await ev(`document.querySelector('[data-swim-scroller]').scrollTop = 0`);
});

// ===== Z. zoom + Today + pan =====
await run('Z', async () => {
  const nowBefore = (await rect('[data-now-line]')).x;
  await ev(`document.querySelector('button[aria-label="Zoom in"]').click()`);
  await sleep(300);
  const w1 = await weekW();
  const nowAfter = (await rect('[data-now-line]')).x;
  check('Z1 zoom in widens weeks and keeps NOW anchored on screen', w1 > W0 && Math.abs(nowAfter - nowBefore) < 2, `weekW ${W0}->${w1}, NOW x ${nowBefore.toFixed(1)}->${nowAfter.toFixed(1)}`);
  const c = await center('[data-swim-scroller]');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: 100, modifiers: 2 });
  await sleep(300);
  const w2 = await weekW();
  check('Z2 ctrl+wheel down zooms out', w2 < w1, `${w1}->${w2}`);
  check('Z3 zoom persists to localStorage', (await ev(`localStorage.getItem('cc-swim-zoom')`)) === String(w2));
  for (let i = 0; i < 12 && (await weekW()) !== W0; i++) {
    await ev(`document.querySelector('button[aria-label="${(await weekW()) > W0 ? 'Zoom out' : 'Zoom in'}"]').click()`);
    await sleep(150);
  }
  await ev(`document.querySelector('[data-swim-scroller]').scrollLeft = 0`);
  await sleep(100);
  await ev(`document.querySelector('button[aria-label="Scroll to today"]').click()`);
  await sleep(200);
  const line = await rect('[data-now-line]');
  const sc = await rect('[data-swim-scroller]');
  check('Z4 Today button brings NOW back into view', line.x > sc.x + 140 && line.x < sc.x + sc.w, String(line.x));
  const before = await scrollerLeft();
  const a = await center('[data-swim-scroller]');
  const sx = a.x + 200, sy = a.y + 150;
  await ev(`window.__pe = []; for (const t of ['pointerdown','pointermove','pointerup','lostpointercapture']) document.addEventListener(t, (e) => window.__pe.push(t + ':' + e.buttons), true)`);
  void ('pan start element:', await ev(`(() => { const e = document.elementFromPoint(${sx}, ${sy}); return e && e.tagName + ' ' + (e.closest('[data-milestone-id]')?.dataset.milestoneId ?? '') + ' ' + (e.getAttribute('class') ?? ''); })()`));
  await mouse('mouseMoved', sx, sy);
  await mouse('mousePressed', sx, sy, 1);
  const dir = before > 100 ? 1 : -1; // drag right when already scrolled (content moves with the pointer)
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', sx + dir * i * 20, sy, 1); await sleep(12); }
  await mouse('mouseReleased', sx + dir * 160, sy, 0);
  const after = await scrollerLeft();
  check('Z5 dragging empty canvas pans horizontally', Math.abs(after - before) > 100, `${before}->${after}`);
  await ev(`document.querySelector('button[aria-label="Scroll to today"]').click()`);
});

// ===== H. hover chain + tooltip =====
await run('H', async () => {
  await ev(`document.querySelector('${circleSel('M4')}').scrollIntoView({ inline: 'center', block: 'center' })`);
  await sleep(200);
  const c = await center(circleSel('M4'));
  await mouse('mouseMoved', c.x - 30, c.y);
  await mouse('mouseMoved', c.x, c.y);
  await waitDom(`document.querySelectorAll('[data-edge][data-hot]').length > 0`);
  const hot = await ev(`[...document.querySelectorAll('[data-edge][data-hot]')].map(e => e.dataset.edge).sort().join()`);
  check('H1 hovering M4 highlights its full dependency chain (up and down)', hot === 'M1>M2,M1>M3,M2>M4,M3>M4,M4>M6,M6>M8', hot);
  const dim = await ev(`+document.querySelector('[data-milestone-id="M5"]').style.opacity`);
  const lit = await ev(`+document.querySelector('[data-milestone-id="M2"]').style.opacity`);
  check('H2 nodes outside the chain dim, chain nodes stay lit', dim < 0.5 && lit === 1, `M5 ${dim}, M2 ${lit}`);
  const tip = await ev(`document.querySelector('[data-swim-tooltip]')?.innerText ?? null`);
  check('H3 tooltip shows id/title, planned dates, progress and drift', !!tip && tip.includes('M4') && tip.includes('Planned') && /tasks done/.test(tip) && tip.includes('+5d'), tip);
  await screenshot('hover-chain');
  await mouse('mouseMoved', 5, 5);
  await waitDom(`document.querySelectorAll('[data-edge][data-hot]').length === 0 && !document.querySelector('[data-swim-tooltip]')`);
  check('H4 moving away clears highlight and tooltip', true);
});

// ===== K. keyboard =====
await run('K', async () => {
  await ev(`document.querySelector('[data-milestone-id="M1"]').focus()`);
  await ARROW('Right');
  await sleep(150);
  const f1 = await ev(`document.activeElement?.dataset?.milestoneId`);
  check('K1 ArrowRight moves focus to the next milestone in the lane (M1 -> M2)', f1 === 'M2', f1);
  await key('ArrowDown', 'ArrowDown', 40);
  await sleep(150);
  const f2 = await ev(`document.activeElement?.dataset?.milestoneId`);
  const lane2 = ms.find((m) => m.id === f2)?.domain;
  check('K2 ArrowDown moves to the nearest milestone in the next lane', !!f2 && lane2 !== 'Platform', `${f2} (${lane2})`);
  const tabbable = await ev(`document.querySelectorAll('[data-milestone-id][tabindex="0"]').length`);
  check('K3 roving tabindex: exactly one milestone is a tab stop', tabbable === 1, String(tabbable));
  await ENTER();
  await waitDom(`!!document.querySelector('[data-milestone-panel]')`);
  check('K4 Enter opens the Milestone Panel for the focused node', (await panelOpen()) && (await ev(`document.querySelector('[data-milestone-panel]').dataset.milestonePanel`)) === f2);
  await ESC();
  await waitDom(panelClosed);
  check('K5 Esc closes the panel', true);
});

// ===== PNL. panel =====
await run('PNL', async () => {
  await ev(`document.querySelector('${circleSel('M2')}').scrollIntoView({ inline: 'center', block: 'center' })`);
  await sleep(200);
  const c = await center(circleSel('M2'));
  await click(c.x, c.y);
  await waitDom(`!!document.querySelector('[data-milestone-panel="M2"]')`);
  await sleep(300);
  const pw = await rect('aside[aria-label="Milestone details"]');
  check('PNL1 clicking a node opens the 480px panel', (await panelOpen()) && Math.abs(pw.w - 480) < 1.5, `width ${pw.w}`);
  const txt = await ev(`document.querySelector('[data-milestone-panel]').innerText`);
  const need = ['M2', 'depends on', 'tasks', 'dates', 'notes'];
  check('PNL2 panel shows id, title, dependencies, tasks, dates and notes sections', need.every((s) => txt.toLowerCase().includes(s.toLowerCase())), need.filter((s) => !txt.toLowerCase().includes(s.toLowerCase())).join(',') + ' missing of ' + txt.length + ' chars');
  await screenshot('panel-dark');
  await click(300, 400);
  await waitDom(panelClosed);
  check('PNL3 backdrop click closes the panel', true);
  await click(c.x, c.y);
  await waitDom(`!!document.querySelector('[data-task-row]')`);
  await sleep(300);
  const firstRow = await ev(`document.querySelector('[data-task-row]').dataset.taskRow`);
  const rc = await center('[data-task-row]');
  await click(rc.x, rc.y);
  await waitDom(`!!document.querySelector('dialog[open]')`);
  const dlg = await dialogText();
  check('PNL4 clicking a task row opens the task modal', dlg.includes(firstRow), firstRow);
  await ESC();
  await noDialog();
  check('PNL5 Esc closes only the modal; the panel stays open', await panelOpen());
  await ESC();
  await waitDom(panelClosed);
  check('PNL6 second Esc closes the panel', true);
});

// ===== C. context menu + panel edits =====
await run('C', async () => {
  await ev(`document.querySelector('${circleSel('M3')}').scrollIntoView({ inline: 'center', block: 'center' })`);
  await sleep(200);
  const c = await center(circleSel('M3'));
  await click(c.x, c.y, 'right');
  await waitDom(`!!document.querySelector('[role=menu]')`);
  const items = await ev(`[...document.querySelectorAll('[role=menu] button')].map(b => b.textContent.trim())`);
  check('C1 right-click shows Open / View tasks / Add task / Set dates', items.join() === 'Open,View tasks,Add task,Set dates…', items.join());
  const add = await menuItemPos('Add task');
  await click(add.x, add.y);
  await waitDom(`document.activeElement?.getAttribute('aria-label') === 'New task label'`);
  check('C2 "Add task" opens the panel with the new-task input focused', true);
  await typeText('Written from the Swim Lane panel');
  await ENTER();
  const row = await until(() => q(`SELECT * FROM subtasks WHERE milestone_id='M3' AND label='Written from the Swim Lane panel'`)[0], 4000, 'task row in DB');
  check('C3 the new task is written to the DB', !!row, row ? `${row.id}` : '');
  await waitDom(`[...document.querySelectorAll('[data-task-row]')].some(r => r.textContent.includes('Written from the Swim Lane panel'))`);
  check('C4 and appears in the panel list', true);
  await ev(`document.querySelector('textarea[aria-label="New note"]').focus()`);
  await typeText('<b>bold?</b> operator note');
  await ev(`[...document.querySelectorAll('aside button')].find(b => b.textContent.trim() === 'Add note').click()`);
  await until(() => JSON.parse(q(`SELECT notes FROM milestones WHERE id='M3'`)[0].notes).some((n) => n.author === 'operator'), 4000, 'note in DB');
  await waitDom(`[...document.querySelectorAll('[data-milestone-panel] li p')].some(p => p.textContent.includes('<b>bold?</b>'))`);
  check('C5 notes are saved as operator and rendered as literal text (no markup)', (await ev(`document.querySelectorAll('[data-milestone-panel] b').length`)) === 0);
  const r = await ev(`window.api.milestones.setDates({ milestoneId: 'M3', dates: { actual_start: '2026-09-08' } }).then(r => r.ok)`);
  check('C6 setDates persists', r === true && q(`SELECT actual_start FROM milestones WHERE id='M3'`)[0].actual_start === '2026-09-08');
  await ESC();
  await waitDom(panelClosed);
  await click(c.x, c.y, 'right');
  await waitDom(`!!document.querySelector('[role=menu]')`);
  const sd = await menuItemPos('Set dates');
  await click(sd.x, sd.y);
  await waitDom(`document.querySelector('[data-milestone-panel] details')?.open === true`);
  check('C7 "Set dates…" opens the panel with the date editor expanded', true);
  await ESC();
  await waitDom(panelClosed);
});

// ===== J. jump to Task Board =====
await run('J', async () => {
  await ev(`document.querySelector('button[aria-label="Scroll to today"]').click()`);
  await ev(`document.querySelector('${circleSel('M4')}').scrollIntoView({ inline: 'center', block: 'center' })`);
  await sleep(200);
  const c = await center(circleSel('M4'));
  await click(c.x, c.y);
  await ESC();
  await waitDom(panelClosed);
  await mouse('mouseMoved', c.x, c.y);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 2 });
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  const ids = await ev(`[...new Set([...document.querySelectorAll('[data-task-id]')].map(e => e.dataset.taskId))]`);
  const want = q(`SELECT id FROM subtasks WHERE milestone_id='M4'`).map((r) => r.id).sort();
  check('J1 double-clicking a node switches to the Task Board filtered to that milestone', JSON.stringify([...ids].sort()) === JSON.stringify(want), `${ids.length} cards vs ${want.length} tasks in M4`);
  await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Swim Lane')).click()`);
  await waitDom(`document.querySelectorAll('[data-milestone-id]').length > 0`);
});

// ===== M. live MCP create_milestone =====
const mcp = await connectMcp('claude-code');
await run('M', async () => {
  await ev(`document.querySelector('button[aria-label="Scroll to today"]').click()`);
  const before = await ev(`document.querySelectorAll('[data-milestone-id]').length`);
  const t0 = performance.now();
  const res = await mcp.call('create_milestone', { title: 'Live from MCP', domain: 'Infra', week: 10, dependencies: ['M7'] });
  check('M1 create_milestone succeeds over stdio', !res.isError, res.text.slice(0, 120));
  const newId = res.json().id;
  await waitDom(`!!document.querySelector('[data-milestone-id="${newId}"]')`);
  const ms1 = Math.round(performance.now() - t0);
  const n = await node(newId);
  const wk = await rect('[data-week="10"]');
  const canvas = await rect('[data-swim-canvas]');
  const lanes = await ev(`[...document.querySelectorAll('[data-lane-label]')].map(e => e.dataset.laneLabel)`);
  check('M2 the node appears live (no reload) in the Infra lane at week 10', n.lane === lanes.indexOf('Infra') && Math.abs(n.plannedX - (wk.x - canvas.x + W0 / 2)) < 1.5, `${ms1} ms after the call; lane ${n.lane}, x ${n.plannedX}`);
  check('M3 a dependency connector M7 -> new milestone is drawn', await ev(`!!document.querySelector('[data-edge="M7>${newId}"]')`));
  check('M4 node count grew by exactly one', (await ev(`document.querySelectorAll('[data-milestone-id]').length`)) === before + 1);
  await ev(`document.querySelector('[data-milestone-id="${newId}"]').scrollIntoView({ inline: 'center', block: 'center' })`);
  await screenshot('mcp-live-node');
  await mcp.call('add_milestone_task', { milestone_id: newId, label: 'one task' });
  await waitDom(`document.querySelector('[data-milestone-id="${newId}"]').textContent.includes('0/1')`);
  check('M5 progress ring updates live when a task is added via MCP', true);
});

// ===== W. windowing =====
await run('W', async () => {
  for (let i = 0; i < 44; i++) await mcp.call('create_milestone', { title: `Bulk ${i}`, domain: ['Platform', 'Product', 'Infra'][i % 3], week: 1 + ((i * 3) % 30) });
  await sleep(2000);
  const total = q('SELECT COUNT(*) c FROM milestones')[0].c;
  await ev(`document.querySelector('[data-swim-scroller]').scrollLeft = 0`);
  await sleep(400);
  const leftCount = await ev(`document.querySelectorAll('[data-milestone-id]').length`);
  check('W1 with >40 milestones only those near the viewport are mounted', total > 40 && leftCount < total, `${leftCount} mounted of ${total}`);
  const maxLeft = await ev(`(() => { const s = document.querySelector('[data-swim-scroller]'); s.scrollLeft = s.scrollWidth; return s.scrollLeft; })()`);
  await sleep(500);
  const rightIds = await ev(`[...document.querySelectorAll('[data-milestone-id]')].map(e => +e.dataset.x)`);
  check('W2 scrolling to the far end mounts the milestones there', rightIds.length > 0 && Math.max(...rightIds) > maxLeft, `max x ${Math.max(...rightIds)} vs scrollLeft ${maxLeft}`);
  const t0 = performance.now();
  for (let s = 0; s < 20; s++) { await ev(`document.querySelector('[data-swim-scroller]').scrollLeft -= 300`); await sleep(16); }
  check('W3 scroll stays responsive (20 scroll steps < 3 s)', performance.now() - t0 < 3000, `${Math.round(performance.now() - t0)} ms`);
  await ev(`document.querySelector('button[aria-label="Scroll to today"]').click()`);
  await sleep(400);
  await screenshot('swim-big');
});

// ===== T. themes + sizes =====
await run('T', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev(`document.documentElement.dataset.theme = 'light'`);
  await ev(`document.querySelector('button[aria-label="Scroll to today"]').click()`);
  await sleep(500);
  await screenshot('swim-light-1200');
  await ev(`document.querySelector('${circleSel('M4')}').scrollIntoView({ inline: 'center', block: 'center' })`);
  await sleep(200);
  const c = await center(circleSel('M4'));
  await click(c.x, c.y);
  await waitDom(`!!document.querySelector('[data-milestone-panel]')`);
  await sleep(300);
  await screenshot('panel-light-1200');
  check('T1 light theme + 1200x800: panel opens, screenshots taken', await panelOpen());
  await ESC();
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
