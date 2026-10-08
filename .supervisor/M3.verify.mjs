// Drives the BUILT app (apps/desktop/out) over CDP through the M3 exit criteria.
// usage: [ONLY=B,E] node .supervisor/M3.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop; seed a fresh root with packages/core/src/seed.ts; the run mutates it)
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
const app = spawn(
  `${REPO}/node_modules/electron/dist/electron.exe`,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${REPO}/apps/desktop/out/verify-profile-${PORT}`],
  { cwd: `${REPO}/apps/desktop`, env, stdio: ['ignore', 'pipe', 'pipe'] },
);
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
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
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

await send('Runtime.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
await ev(`window.__ccRenders = {}`);
await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Task Board')).click()`);
await waitDom(`document.querySelectorAll('[data-column]').length === 5`);

// ===== A. Initial render matches the DB =====
await run('A', async () => {
  const dbCounts = Object.fromEntries(q('SELECT status, COUNT(*) n FROM subtasks GROUP BY status').map((r) => [r.status, r.n]));
  const domCounts = await ev(`Object.fromEntries([...document.querySelectorAll('[data-column]')].map(c => [c.dataset.column, c.querySelectorAll('[data-task-id]').length]))`);
  check('A1 five columns render with the DB counts', JSON.stringify(dbCounts) === JSON.stringify(Object.fromEntries(Object.keys(dbCounts).map((k) => [k, domCounts[k]]))), `db=${JSON.stringify(dbCounts)} dom=${JSON.stringify(domCounts)}`);
  await screenshot('board');
});

// ===== B. Pointer drag todo -> in_progress (direct start) =====
let started;
await run('B', async () => {
  started = pickTask(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 1`);
  await drag(started, 'in_progress');
  await until(() => task(started).status === 'in_progress', 4000, 'db in_progress');
  const t = task(started);
  check('B1 drag todo->in_progress persists, sets last_run_id + started_at', t.status === 'in_progress' && t.last_run_id && t.started_at, JSON.stringify({ s: t.status, run: !!t.last_run_id, st: !!t.started_at }));
  await waitDom(`document.querySelector('${colSel('in_progress')} ${cardSel(started)}') !== null`);
  check('B2 card appears in the In Progress column', (await colIds('in_progress')).includes(started));
  const log = q(`SELECT agent_id, action FROM agent_log WHERE target_id=? ORDER BY rowid DESC LIMIT 1`, started)[0];
  check('B3 log row written by operator', log?.action === 'task_started' && log?.agent_id === 'operator', JSON.stringify(log));
  check('B4 elapsed timer shown on in-progress card', await ev(`/(<1m|\\dm|\\dh)/.test(document.querySelector('${cardSel(started)}').innerText)`));
});

// ===== C. Illegal drop: done -> in_progress =====
await run('C', async () => {
  const doneId = pickTask(`SELECT id FROM subtasks WHERE status='done' ORDER BY id DESC LIMIT 1`);
  const before = task(doneId);
  await drag(doneId, 'in_progress', { hold: true });
  const state = await ev(`document.querySelector('${colSel('in_progress')}').dataset.dropState`);
  check('C1 hovered illegal column shows the not-allowed state', state === 'illegal', state);
  await screenshot('drag-illegal');
  const b = await rect(colSel('in_progress'));
  await mouse('mouseReleased', b.x + b.w / 2, b.y + 90, 0);
  const t = await until(async () => { const x = await toasts(); return x.length ? x : null; }, 3000, 'toast');
  check('C2 toast explains why', t.some((x) => /is done.*Reset/.test(x)), t.join(' | '));
  const after = task(doneId);
  check('C3 task unchanged and snaps back', after.status === 'done' && after.updated_at === before.updated_at && (await colIds('done')).includes(doneId));
  await ev(`document.querySelectorAll('[aria-live=polite] button').forEach(b => b.click())`);
});

// ===== D. Reject flow (review -> in_progress): reason required, becomes a lesson =====
let rejected;
await run('D', async () => {
  rejected = pickTask(`SELECT id FROM subtasks WHERE status='review' ORDER BY id LIMIT 1`);
  const lessonsBefore = q('SELECT COUNT(*) n FROM lessons_learned')[0].n;
  await drag(rejected, 'in_progress');
  await waitDom(`!!document.querySelector('dialog[open] textarea')`);
  check('D1 reason dialog opens, titled for the task', (await dialogText()).includes(`Reject ${rejected}`), (await dialogText()).slice(0, 60));
  check('D2 submit is disabled until a reason is typed', (await clickInDialog('Reject')) === 'disabled');
  await screenshot('reject-dialog');
  await typeText('The modal did not close on backdrop click');
  check('D3 submit enabled after typing', (await clickInDialog('Reject')) === 'ok');
  await until(() => task(rejected).status === 'in_progress', 4000, 'rejected in db');
  const l = q('SELECT * FROM lessons_learned ORDER BY id DESC LIMIT 1')[0];
  check('D4 lessons_learned row written', q('SELECT COUNT(*) n FROM lessons_learned')[0].n === lessonsBefore + 1 && l.subtask_id === rejected && l.rejection_reason.includes('backdrop click'), JSON.stringify(l));
  const fts = q(`SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH '"backdrop"*'`);
  check('D5 FTS index has the lesson', fts.length === 1);
});

// ===== E. Block flow (in_progress -> blocked), then unblock restores =====
await run('E', async () => {
  await drag(started, 'blocked');
  await waitDom(`!!document.querySelector('dialog[open] textarea')`);
  check('E1 block asks for a reason', (await dialogText()).includes(`Block ${started}`));
  await typeText('Waiting on API contract');
  await clickInDialog('Block');
  await until(() => task(started).status === 'blocked', 4000, 'blocked in db');
  const t = task(started);
  check('E2 blocked_from + reason stored', t.blocked_from === 'in_progress' && t.blocked_reason === 'Waiting on API contract' && t.blocked_by === 'manual', JSON.stringify({ f: t.blocked_from, r: t.blocked_reason }));
  await waitDom(`document.querySelector('${colSel('blocked')} ${cardSel(started)}')?.innerText.includes('Waiting on API contract')`);
  check('E3 card shows the red reason line', true);
  await drag(started, 'done');
  await waitDom(`document.querySelectorAll('[aria-live=polite] > div').length > 0`);
  check('E4 blocked -> done is rejected with an explanation', (await toasts()).some((x) => /blocked.*In Progress/.test(x)) && task(started).status === 'blocked', (await toasts()).join('|'));
  await ev(`document.querySelectorAll('[aria-live=polite] button').forEach(b => b.click())`);
  await drag(started, 'in_progress');
  await until(() => task(started).status === 'in_progress', 4000, 'unblocked');
  check('E5 dragging back to its previous column unblocks', task(started).blocked_from === null && task(started).blocked_reason === null);
});

// ===== F. Skip confirmations =====
await run('F', async () => {
  const t1 = pickTask(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id DESC LIMIT 1`);
  await drag(t1, 'done');
  await waitDom(`!!document.querySelector('dialog[open]')`);
  check('F1 todo->done asks "Skip review?"', (await dialogText()).includes('Skip review?'), (await dialogText()).slice(0, 80));
  check('F2 default focus is Cancel', await ev(`document.activeElement?.textContent.trim() === 'Cancel'`), await ev(`document.activeElement?.textContent`));
  await ESC();
  await noDialog();
  check('F3 Esc cancels without changes', task(t1).status === 'todo');
  await drag(t1, 'done');
  await waitDom(`!!document.querySelector('dialog[open]')`);
  await clickInDialog('Mark done');
  await until(() => task(t1).status === 'done', 4000, 'skipped to done');
  const log = q(`SELECT description FROM agent_log WHERE target_id=? ORDER BY rowid DESC LIMIT 1`, t1)[0];
  check('F4 confirming skips and records it', task(t1).done === 1 && log.description.includes('(steps skipped)'), log.description);
  const t2 = pickTask(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 1`);
  await drag(t2, 'review');
  await waitDom(`!!document.querySelector('dialog[open]')`);
  check('F5 todo->review asks "Skip steps?"', (await dialogText()).includes('Skip steps?'));
  await clickInDialog('Skip to Review');
  await until(() => task(t2).status === 'review', 4000, 'skipped to review');
  check('F6 todo->review lands in Review', true);
});

// ===== G. Dependencies incomplete -> start anyway =====
await run('G', async () => {
  const cand = q(`SELECT id, depends_on FROM subtasks WHERE status='todo' AND depends_on != '[]' ORDER BY id`).find((r) => JSON.parse(r.depends_on).some((d) => task(d)?.status !== 'done'));
  if (!cand) return check('G0 found a todo task with unmet dependencies', false, 'none in seed');
  const locked = await ev(`document.querySelector('${cardSel(cand.id)}').innerText.includes('locked')`);
  check('G1 card shows the dependency lock', locked);
  await drag(cand.id, 'in_progress');
  await waitDom(`!!document.querySelector('dialog[open]')`);
  check('G2 asks "start anyway?"', (await dialogText()).includes('Dependencies incomplete'), (await dialogText()).slice(0, 100));
  await clickInDialog('Start anyway');
  await until(() => task(cand.id).status === 'in_progress', 4000, 'forced start');
  check('G3 forced start works', true);
});

// ===== H. Review-card Approve button =====
await run('H', async () => {
  const rv = pickTask(`SELECT id FROM subtasks WHERE status='review' ORDER BY id LIMIT 1`);
  check('H1 review card shows "Awaiting your review"', await ev(`document.querySelector('${cardSel(rv)}').innerText.includes('Awaiting your review')`));
  await ev(`document.querySelector('${cardSel(rv)}').scrollIntoView({block:'center'}); document.querySelector('[aria-label="Approve ${rv}"]').click()`);
  await until(() => task(rv).status === 'done', 4000, 'approved');
  check('H2 inline Approve completes it', task(rv).completed_at && task(rv).done === 1);
});

// ===== I. Modal: open/close with Esc and backdrop; tabs; autosave; footer actions =====
await run('I', async () => {
  const mid = pickTask(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 1`);
  await ev(`document.querySelector('${cardSel(mid)}').scrollIntoView({block:'center'}); document.querySelector('${cardSel(mid)}').click()`);
  await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
  check('I1 click opens the task modal', (await dialogText()).includes(mid));
  await screenshot('modal-details');
  await ESC();
  await noDialog();
  check('I2 Esc closes the modal', true);
  await ev(`document.querySelector('${cardSel(mid)}').click()`);
  await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
  await mouse('mouseMoved', 6, 6);
  await mouse('mousePressed', 6, 6, 1);
  await mouse('mouseReleased', 6, 6, 0);
  await noDialog();
  check('I3 backdrop click closes the modal', true);

  await ev(`document.querySelector('${cardSel(mid)}').click()`);
  await waitDom(`!!document.querySelector('dialog[open] textarea#f-notes')`);
  await ev(`document.querySelector('#f-notes').focus()`);
  await typeText(' autosave probe');
  await ev(`document.querySelector('#f-notes').blur()`);
  await until(() => (task(mid).notes ?? '').includes('autosave probe'), 4000, 'notes saved');
  check('I4 description autosaves on blur', true);
  check('I5 "Saved" tick appears', await waitDom(`document.querySelector('dialog[open]')?.innerText.includes('Saved')`, 2000));

  const before = JSON.parse(task(mid).acceptance_criteria)[0].done;
  await ev(`document.querySelector('dialog[open] input[type=checkbox]').click()`);
  await until(() => JSON.parse(task(mid).acceptance_criteria)[0].done !== before, 4000, 'criterion toggled');
  check('I6 acceptance-criteria checkbox persists', true);
  await waitDom(`document.querySelector('${cardSel(mid)}')?.innerText.includes('criteria')`);

  await ev(`[...document.querySelectorAll('dialog[open] [role=tab]')].find(t => t.textContent === 'Context').click()`);
  await waitDom(`document.querySelector('dialog[open] pre')?.innerText.includes('## Acceptance criteria')`);
  const ctx = await ev(`document.querySelector('dialog[open] pre').innerText`);
  check('I7 Context tab previews TASK_CONTEXT.md (all six sections)', ['Task description', 'Acceptance criteria', 'Context files', 'Reference docs', 'Constraints', 'Relevant lessons'].every((h) => ctx.includes(`## ${h}`)));
  await ev(`[...document.querySelectorAll('dialog[open] [role=tab]')].find(t => t.textContent === 'History').click()`);
  await waitDom(`document.querySelector('dialog[open]')?.innerText.includes('task updated')`);
  check('I8 History tab lists this task’s log entries', true);

  await ev(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Start').click()`);
  await until(() => task(mid).status === 'in_progress', 4000, 'start from modal');
  check('I9 footer Start runs the transition (status-aware footer)', await ev(`!![...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Complete')`));

  await ev(`document.querySelector('dialog[open]').dispatchEvent(new Event('x'))`);
  await ESC();
  await noDialog();
  // Reject history card on the previously rejected task
  await ev(`document.querySelector('${cardSel(rejected)}').scrollIntoView({block:'center'}); document.querySelector('${cardSel(rejected)}').click()`);
  await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
  await ev(`[...document.querySelectorAll('dialog[open] [role=tab]')].find(t => t.textContent === 'History').click()`);
  await waitDom(`document.querySelector('dialog[open]')?.innerText.includes('REJECTED')`);
  check('I10 History shows the rejection as an amber card with the reason', (await dialogText()).includes('backdrop click'));
  await screenshot('modal-history');
  await ESC();
  await noDialog();
});

// ===== J. Keyboard only: one card through all five columns, then open/close the modal =====
await run('J', async () => {
  const kid = pickTask(`SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 1`);
  // Record what the screen-reader live region says during the keyboard drags.
  await ev(`window.__liveLog = []; const lr = document.querySelector('[aria-live=assertive]'); if (lr) new MutationObserver((recs) => recs.forEach((r) => { if (r.oldValue) window.__liveLog.push(r.oldValue); window.__liveLog.push(lr.innerText); })).observe(lr, { childList: true, subtree: true, characterData: true, characterDataOldValue: true })`);
  const focusCard = async (tid) => {
    await ev(`document.activeElement && document.activeElement.blur()`);
    for (let i = 0; i < 400; i++) {
      await TAB();
      if (await ev(`document.activeElement?.dataset?.taskId === ${JSON.stringify(tid)}`)) return i + 1;
    }
    throw new Error('could not Tab to ' + tid);
  };
  const liftMoveDrop = async (tid, dir, n) => {
    await focusCard(tid);
    await SPACE();
    await sleep(120);
    for (let i = 0; i < n; i++) {
      await ARROW(dir);
      await sleep(90);
    }
    await SPACE();
    await sleep(200);
  };
  const tabs = await focusCard(kid);
  check('J0 Tab reaches the card (focus order)', tabs > 0, `${tabs} Tab presses`);
  await ev(`document.activeElement.blur()`);
  const visited = ['todo'];
  await liftMoveDrop(kid, 'Right', 1); // todo -> in_progress (start)
  await until(() => task(kid).status === 'in_progress', 4000, 'kb start');
  visited.push('in_progress');
  await liftMoveDrop(kid, 'Right', 3); // in_progress -> blocked (3 columns right)
  await waitDom(`!!document.querySelector('dialog[open] textarea')`);
  await typeText('kb block');
  await TAB();
  await TAB();
  await ENTER(); // Cancel? no: order is textarea -> Cancel -> Block. Tab twice lands on Block.
  await until(() => task(kid).status === 'blocked', 4000, 'kb block');
  visited.push('blocked');
  await liftMoveDrop(kid, 'Left', 3); // blocked -> in_progress (unblock)
  await until(() => task(kid).status === 'in_progress', 4000, 'kb unblock');
  await liftMoveDrop(kid, 'Right', 1); // in_progress -> review (summary dialog)
  await waitDom(`!!document.querySelector('dialog[open] textarea')`);
  await TAB();
  await TAB();
  await ENTER(); // Submit for review
  await until(() => task(kid).status === 'review', 4000, 'kb review');
  visited.push('review');
  await liftMoveDrop(kid, 'Right', 1); // review -> done
  await until(() => task(kid).status === 'done', 4000, 'kb done');
  visited.push('done');
  check('J1 keyboard-only move visits all five columns', new Set(visited).size === 5, visited.join(' > '));
  await focusCard(kid);
  await ENTER();
  await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
  check('J2 Enter opens the modal', (await dialogText()).includes(kid));
  await ESC();
  await noDialog();
  check('J3 Esc closes it', true);
  const live = await ev(`window.__liveLog`);
  check(
    'J4 live region announced pick-up, column moves and drops',
    live.some((t) => /^Picked up /.test(t)) && live.some((t) => /is over (Review|In Progress|Blocked|Done)/.test(t)) && live.some((t) => /^Dropped .* on (Done|Blocked|In Progress|Review)\./.test(t)),
    [...new Set(live)].slice(0, 3).join(' | '),
  );
});

// ===== K. Re-render storm check =====
await run('K', async () => {
  await sleep(1500); // let flashes from earlier steps finish (each flash-off is a re-render of that card)
  await ev(`window.__ccRenders = {}`);
  await sleep(300);
  const ext = new Database(`${root}/command-center.db`);
  ext.pragma('busy_timeout = 5000');
  // 1) a change that touches no task row
  ext.prepare(`INSERT INTO agent_log (id, agent_id, action, description, timestamp, tags) VALUES (lower(hex(randomblob(8))), 'system', 'ping', 'no task change', ?, '[]')`).run(new Date().toISOString());
  await sleep(1500);
  const none = await ev(`Object.values(window.__ccRenders).reduce((a, b) => a + b, 0)`);
  check('K1 a log-only change re-renders zero task cards', none === 0, `renders=${none}`);
  // 2) change exactly one task
  const target = pickTask(`SELECT id FROM subtasks WHERE status='todo' ORDER BY id DESC LIMIT 1`);
  await ev(`window.__ccRenders = {}`);
  ext.prepare(`UPDATE subtasks SET priority='P0', updated_at=? WHERE id=?`).run(new Date().toISOString(), target);
  await waitDom(`document.querySelector('${cardSel(target)}')?.innerText.includes('P0')`, 4000);
  await sleep(1200);
  const counts = await ev(`window.__ccRenders`);
  const others = Object.keys(counts).filter((k) => k !== target);
  check('K2 one changed task re-renders only that card', others.length === 0 && (counts[target] ?? 0) > 0, `target=${JSON.stringify(counts[target])} others=${others.length}`);
  ext.close();
  // flash: re-trigger and look for the class right after the change lands
  const ext2 = new Database(`${root}/command-center.db`);
  ext2.prepare(`UPDATE subtasks SET priority='P1', updated_at=? WHERE id=?`).run(new Date().toISOString(), target);
  const flashed = await waitDom(`!!document.querySelector('${cardSel(target)} .flash') || !!document.querySelector('${cardSel(target)}').querySelector('div.flash')`, 3000).catch(() => false);
  check('K3 changed card flashes', flashed);
  ext2.close();
});

// ===== L. Filters, search, context bar =====
await run('L', async () => {
  await sleep(800);
  await ev(`[...document.querySelectorAll('[aria-pressed]')].find(b => b.textContent.trim() === 'Blocked').click()`);
  await waitDom(`document.querySelectorAll('[data-column="todo"] [data-task-id]').length === 0`);
  const nBlocked = q(`SELECT COUNT(*) n FROM subtasks WHERE status='blocked'`)[0].n;
  check('L1 "Blocked" segment shows only blocked cards', (await ev(`document.querySelectorAll('[data-task-id]').length`)) === nBlocked, `dom=${await ev(`document.querySelectorAll('[data-task-id]').length`)} db=${nBlocked}`);
  await ev(`[...document.querySelectorAll('[aria-pressed]')].find(b => b.textContent.trim() === 'All').click()`);
  await ev(`document.activeElement.blur()`);
  await key('/', 'Slash', 191, 0, '/');
  check('L2 "/" focuses search', await waitDom(`document.activeElement?.id === 'board-search'`, 2000));
  await typeText('zzzzzz');
  await waitDom(`document.body.innerText.includes('No tasks match')`);
  check('L3 empty filter result shows "No tasks match" + Clear filters', await ev(`document.body.innerText.includes('Clear filters')`));
  await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear filters').click()`);
  await waitDom(`document.querySelectorAll('[data-task-id]').length > 20`);
  check('L4 Clear filters restores the board', true);
  await ev(`document.activeElement.blur()`);
  await key(']', 'BracketRight', 221, 0, ']');
  await waitDom(`document.body.innerText.includes('M1 · Core schema')`);
  const m1 = q(`SELECT COUNT(*) n FROM subtasks WHERE milestone_id='M1'`)[0].n;
  check('L5 "]" selects the first milestone and scopes the board', (await ev(`document.querySelectorAll('[data-task-id]').length`)) === m1, `dom=${await ev(`document.querySelectorAll('[data-task-id]').length`)} db=${m1}`);
  await screenshot('milestone-scope');
});

// ===== M. Quick add =====
await run('M', async () => {
  await ev(`document.querySelector('button[aria-label="Add task"]').click()`);
  await waitDom(`!!document.querySelector('input[aria-label="New task title"]')`);
  await typeText('Quick-added by the verification script');
  await ENTER();
  const row = await until(() => q(`SELECT id, milestone_id, status FROM subtasks WHERE label LIKE 'Quick-added%'`)[0], 4000, 'created');
  check('M1 quick add creates a todo task in the selected milestone', row.status === 'todo' && row.milestone_id === 'M1', JSON.stringify(row));
  await waitDom(`document.querySelector('${colSel('todo')} ${cardSel(row.id)}') !== null`);
  check('M2 new card appears in To Do', true);
});

// ===== R. Reset from the modal (confirm, default focus on Cancel) =====
const lastDialogText = () => ev(`[...document.querySelectorAll('dialog[open]')].at(-1)?.innerText ?? null`);
const clickInLastDialog = async (label) => {
  const btn = await ev(`(() => { const d = [...document.querySelectorAll('dialog[open]')].at(-1); const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!btn) return 'no button ' + label;
  await mouse('mouseMoved', btn.x, btn.y);
  await mouse('mousePressed', btn.x, btn.y, 1);
  await mouse('mouseReleased', btn.x, btn.y, 0);
  return 'ok';
};
await run('R', async () => {
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'All milestones').click()`);
  const rid = pickTask(`SELECT id FROM subtasks WHERE status='done' AND started_at IS NOT NULL ORDER BY id LIMIT 1`);
  await waitDom(`!!document.querySelector('${cardSel(rid)}')`);
  await ev(`document.querySelector('${cardSel(rid)}').scrollIntoView({ block: 'center' }); document.querySelector('${cardSel(rid)}').click()`);
  await waitDom(`!!document.querySelector('dialog[open] [role=tablist]')`);
  await clickInDialog('Reset'); // modal footer button (only one dialog open yet)
  await waitDom(`document.querySelectorAll('dialog[open]').length === 2`);
  check('R1 Reset asks to confirm, naming the task and what is cleared', /Reset .*\?[\s\S]*status, blockers and run history will be cleared/.test(await lastDialogText()) && (await lastDialogText()).includes(rid), (await lastDialogText()).slice(0, 90));
  check('R2 confirm dialog focus starts on Cancel', await ev(`document.activeElement?.textContent.trim() === 'Cancel'`));
  await clickInLastDialog('Cancel');
  await waitDom(`document.querySelectorAll('dialog[open]').length === 1`);
  check('R3 Cancel leaves the task done', task(rid).status === 'done');
  await clickInDialog('Reset');
  await waitDom(`document.querySelectorAll('dialog[open]').length === 2`);
  await clickInLastDialog('Reset');
  await until(() => task(rid).status === 'todo', 4000, 'reset in db');
  const t = task(rid);
  check('R4 confirming resets status, completion and run state', t.done === 0 && t.completed_at === null && t.started_at === null && t.last_run_id === null, JSON.stringify({ d: t.done, c: t.completed_at, s: t.started_at }));
  await ESC();
  await noDialog().catch(() => {});
});

// ===== P. Priority filter (multi-select UI) =====
await run('P', async () => {
  await sleep(300);
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Priority')).click()`);
  await waitDom(`!!document.querySelector('[role=group][aria-label=Priority]')`);
  await ev(`[...document.querySelectorAll('[role=group][aria-label=Priority] label')].find((l) => l.textContent.trim() === 'P0').querySelector('input').click()`);
  const n = q(`SELECT COUNT(*) n FROM subtasks WHERE priority='P0'`)[0].n;
  await waitDom(`document.querySelectorAll('[data-task-id]').length === ${n}`);
  check('P1 Priority = P0 shows exactly the P0 tasks', await ev(`[...document.querySelectorAll('[data-task-id]')].every((e) => e.innerText.includes('P0'))`), `cards=${n}`);
  await ESC(); // closes the popover, not the app
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear').click()`);
  await waitDom(`document.querySelectorAll('[data-task-id]').length > ${n}`);
  check('P2 Clear removes the priority filter', true);
});

// ===== N. Sync badges =====
await run('N', async () => {
  const review = q(`SELECT COUNT(*) n FROM subtasks WHERE status='review'`)[0].n;
  const badge = await ev(`document.querySelector('[aria-label$="in review"]')?.textContent ?? null`);
  check('N1 tab badge shows the live Review count', String(review) === badge, `db=${review} badge=${badge}`);
});

check('Z no console errors / exceptions', consoleErrors.length === 0, consoleErrors.join(' || '));
console.log(JSON.stringify({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }, null, 1));
send('Browser.close');
setTimeout(() => {
  app.kill();
  process.exit(0);
}, 2000);
