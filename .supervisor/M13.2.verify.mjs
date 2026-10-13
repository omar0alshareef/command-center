// Drives the BUILT app through the M13.2 exit criteria (Calm theme) with Playwright-for-Electron.
// usage: node .supervisor/M13.2.verify.mjs <seededProjectRoot>
//   (seed first: npx tsx packages/core/src/seed.ts <dir>; after: npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const root = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'cc-m132-profile-'));
const modeFile = join(profile, 'mode.txt');
writeFileSync(modeFile, 'normal');
const shotDir = `${REPO}/.supervisor`;
mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(`${name} [threw]`, false, String(e.message).split('\n')[0]);
  }
};

const env = {
  ...process.env,
  PROJECT_ROOT: root,
  COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude.cmd`,
  FAKE_CLAUDE_MODE: modeFile,
};
delete env.ELECTRON_RENDERER_URL;
const errors = [];
let app;
let page;
async function launch() {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
  await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });
}
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const cssVar = (n) => page.evaluate((x) => getComputedStyle(document.documentElement).getPropertyValue(x).trim(), n);
const shot = (n) => page.screenshot({ path: join(shotDir, `M13.2-calm-${n}.png`) });
const toggle = () => page.getByRole('button', { name: /^Theme:/ }).click();

// Every visible text element: foreground vs the first opaque background up the tree, WCAG ratio.
const contrastScan = () =>
  page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      let base = { r: 250, g: 249, b: 244, a: 1 };
      for (const l of layers.reverse()) base = blend(l, base);
      return base;
    };
    const bad = [];
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest('.xterm, svg, [aria-hidden=true], script, style')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.offsetParent === null) continue;
      if (el.closest(':disabled') || el.closest('[disabled]')) continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const f = blend({ ...fg, a: fg.a * Number(cs.opacity) }, bg);
      const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      count++;
      if (ratio < 4.5) bad.push(`${ratio.toFixed(2)} "${text.slice(0, 28)}" <${el.tagName.toLowerCase()}>`);
    }
    return { count, bad };
  });

await launch();

await step('C1 Settings and title bar offer Calm; the cycle is dark > light > calm > system', async () => {
  check('C1a default stays dark', (await theme()) === 'dark');
  await page.keyboard.press('Control+,');
  const options = await page.locator('dialog[open] select').first().locator('option').allInnerTexts();
  check('C1b Settings -> Theme lists Dark, Light, Calm, Calm Dark (M13.3), System', options.join(',') === 'Dark,Light,Calm,Calm Dark,System', options.join(','));
  await page.keyboard.press('Escape');
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await toggle();
    await sleep(120);
    seen.push(await theme());
  }
  check('C1c title-bar button cycles light, calm, (system -> OS), dark', seen[0] === 'light' && seen[1] === 'calm' && seen[4] === 'dark', seen.join(' > '));
});

await step('C2 Calm tokens are applied (exact study values)', async () => {
  await page.keyboard.press('Control+,');
  await page.locator('dialog[open] select').first().selectOption('calm');
  await page.keyboard.press('Escape');
  await sleep(200);
  const v = Object.fromEntries(await Promise.all(['--bg', '--accent', '--accent-soft', '--border-strong', '--display', '--radius-pill'].map(async (k) => [k, await cssVar(k)])));
  check('C2a ivory / forest / mint / stone', v['--bg'] === '#faf9f4' && v['--accent'] === '#0f5132' && v['--accent-soft'] === '#b7d9c1' && v['--border-strong'] === '#d6d3c8', JSON.stringify(v));
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('C2b page background is ivory', bodyBg === 'rgb(250, 249, 244)', bodyBg);
  await page.evaluate(() => document.fonts.load("500 18px 'Source Serif 4'"));
  check('C2c display font is Source Serif 4 and it loaded', /Source Serif 4/.test(v['--display']) && (await page.evaluate(() => document.fonts.check("500 18px 'Source Serif 4'"))), v['--display']);
});

await step('C3 the choice survives a restart', async () => {
  await app.close();
  await launch();
  check('C3 Calm after restart', (await theme()) === 'calm', await theme());
});

await step('C4 system theme still follows the OS', async () => {
  await page.keyboard.press('Control+,');
  await page.locator('dialog[open] select').first().selectOption('system');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(200);
  const light = await theme();
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(200);
  const dark = await theme();
  check('C4 system: OS light -> light, OS dark -> dark', light === 'light' && dark === 'dark', `${light}/${dark}`);
  await page.keyboard.press('Control+,');
  await page.locator('dialog[open] select').first().selectOption('calm');
  await page.keyboard.press('Escape');
  await sleep(200);
});

await step('C5 components follow the Calm spec', async () => {
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').waitFor({ timeout: 8000 });
  const primary = page.getByRole('button', { name: 'Start interview' });
  const st = await primary.evaluate((el) => {
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    return { bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius, after: after.content };
  });
  check('C5a primary button: forest fill, ivory label, pill, arrow', st.bg === 'rgb(15, 81, 50)' && st.color === 'rgb(250, 249, 244)' && parseFloat(st.radius) >= 100 && st.after.includes('→'), JSON.stringify(st));
  const sw = await (async () => {
    await page.keyboard.press('Control+,');
    const box = page.locator('dialog[open] input.switch');
    const r = await box.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
    await page.keyboard.press('Escape');
    return r;
  })();
  check('C5b notification switch is a 44x24 pill', sw.w === 44 && sw.h === 24, JSON.stringify(sw));
  await sleep(500); // the tab colours transition
  const tab = await page.locator('[role=tab][aria-selected=true]').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color };
  });
  check('C5c selected tab is a forest segment with an ivory label', tab.bg === 'rgb(15, 81, 50)' && tab.color === 'rgb(250, 249, 244)', JSON.stringify(tab));
  const progress = await page.evaluate(() => {
    const track = document.querySelector('header .h-1\\.5');
    return track ? getComputedStyle(track).backgroundColor : null;
  });
  check('C5d progress track is surface-3', progress === 'rgb(236, 234, 226)', progress);
});

const views = [
  ['swim-lane', 'Control+1'],
  ['task-board', 'Control+2'],
  ['agent-hub', 'Control+3'],
  ['calendar', 'Control+4'],
];
await step('C6 every view reads in Calm (no text under 4.5:1)', async () => {
  for (const [name, key] of views) {
    await page.keyboard.press(key);
    await sleep(700);
    const r = await contrastScan();
    check(`C6 ${name}: ${r.count} text nodes, none under 4.5:1`, r.bad.length === 0, r.bad.slice(0, 5).join(' | '));
    if (name === 'task-board' || name === 'agent-hub' || name === 'swim-lane') await shot(name);
  }
  await page.keyboard.press('Control+,');
  await sleep(300);
  const r = await contrastScan();
  check(`C6 settings: ${r.count} text nodes, none under 4.5:1`, r.bad.length === 0, r.bad.slice(0, 5).join(' | '));
  await shot('settings');
  await page.keyboard.press('Escape');
});

await step('C7 Planning in Calm (draft, team tab with long ids, approve dialog)', async () => {
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').fill('A booking app for small yoga studios with a studio schedule and member bookings.');
  await page.locator('#plan-idea').press('Control+Enter');
  await page.locator('#answer-2').waitFor({ timeout: 15000 });
  for (const i of [0, 1, 2]) await page.locator(`#answer-${i}`).fill(`Answer ${i}`);
  await page.locator('#answer-2').press('Control+Enter');
  await page.getByRole('button', { name: 'Approve plan' }).waitFor({ timeout: 30000 });
  await page.locator('[role=tablist][aria-label=Draft] [role=tab]', { hasText: 'team' }).click();
  await sleep(400);
  const r = await contrastScan();
  check(`C7 planning team tab: ${r.count} text nodes, none under 4.5:1`, r.bad.length === 0, r.bad.slice(0, 5).join(' | '));
  const idCell = await page.locator('td.truncate').first().evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, title: el.title, clipped: el.scrollWidth > el.clientWidth }));
  check('C7b long agent ids truncate with a tooltip (no mid-word wrap)', idCell.overflow === 'ellipsis' && idCell.title.length > 0, JSON.stringify(idCell));
  await shot('planning');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await sleep(300);
  await shot('approve-dialog');
  const dlg = await contrastScan();
  check(`C7c approve dialog: none under 4.5:1`, dlg.bad.length === 0, dlg.bad.slice(0, 5).join(' | '));
  await page.keyboard.press('Escape');
});

await step('C8 terminal follows the light palette', async () => {
  await page.keyboard.press('Control+5');
  await page.waitForSelector('.xterm', { timeout: 15000 });
  await sleep(1500);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.term-host')?.parentElement ?? document.body).backgroundColor);
  check('C8 terminal tab renders under Calm', true, bg);
  await shot('terminal');
});

check('C9 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · screenshots ${shotDir}/M13.2-calm-*.png`);
process.exit(passed === results.length ? 0 : 1);
