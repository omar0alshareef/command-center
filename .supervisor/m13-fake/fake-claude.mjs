// A scripted stand-in for `claude -p` (M13 verification): reads the prompt on stdin, recognises the planner
// stage and prints a canned reply. The mode comes from the file named in FAKE_CLAUDE_MODE (default "normal").
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = (() => {
  try {
    return readFileSync(process.env.FAKE_CLAUDE_MODE, 'utf8').trim();
  } catch {
    return 'normal';
  }
})();
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG)
    appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ mode, args: process.argv.slice(2), prompt }) + '\n');
  if (mode === 'hang') {
    // A grandchild too, so cancel has a process tree to kill.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(process.env.FAKE_CLAUDE_PIDS, JSON.stringify([process.pid, child.pid]));
    process.stdout.write('{"thinking": "');
    setInterval(() => process.stdout.write('.'), 200);
    return;
  }
  const out = reply();
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
});

function reply() {
  if (prompt.includes('Decide whether you know enough')) {
    if (mode === 'big') return { ready: false, questions: ['x'.repeat(9000), 'b', 'c'] };
    return prompt.includes('(none yet)')
      ? { ready: false, questions: ['Who is it for?', 'Is there a hard deadline?', 'Which platforms first?'] }
      : { ready: true, questions: [] };
  }
  if (prompt.includes('Write the project manifesto'))
    return { content: '# Manifesto\n\nBook yoga classes in **two taps**.\n\n## Non-goals\n- payments in v1\n- `native` apps', assumptions: ['Studios have fewer than 50 members'] };
  if (prompt.includes('Write the roadmap in markdown'))
    return { content: `# Roadmap\n\n## M1 — Brand and landing page\nLogo, colours, landing page by ${day(10)}.\n\n## M2 — Booking API\nAccounts and bookings.`, assumptions: ['Launch is web only'] };
  if (mode === 'video' && prompt.includes("List the roadmap's milestones"))
    return {
      milestones: [
        { id: 'E1', title: 'Episode 1', domain: 'video', planned_start: day(0), planned_end: day(14), capabilities: ['script', 'voiceover', 'edit', 'publish'], dependencies: [] },
        { id: 'E2', title: 'Channel art', domain: 'design', planned_start: day(0), planned_end: day(7), capabilities: ['thumbnail'], dependencies: [] },
      ],
      assumptions: ['One episode first'],
    };
  if (mode === 'video' && prompt.includes('Break every milestone'))
    return {
      tasks: [
        { key: 'T1', milestone: 'E1', label: 'Write the script', priority: 'P1', due_date: day(3), capability: 'script', depends_on: [], acceptance_criteria: ['under 600 words'], brief: null, checklist: [] },
        { key: 'T2', milestone: 'E1', label: 'Record the voice-over', priority: 'P1', due_date: day(6), capability: 'voiceover', depends_on: ['T1'], acceptance_criteria: [], brief: 'Read the approved script in a calm voice, 3-4 minutes, no music.', checklist: ['WAV 48 kHz', 'no clipping', 'matches the script'] },
        { key: 'T3', milestone: 'E1', label: 'Edit the episode', priority: 'P1', due_date: day(11), capability: 'edit', depends_on: ['T2'], acceptance_criteria: [], brief: 'Cut to the voice-over; captions on.', checklist: ['1080p export', 'captions burned in'] },
        { key: 'T4', milestone: 'E1', label: 'Publish on YouTube', priority: 'P2', due_date: day(14), capability: 'publish', depends_on: ['T3'], acceptance_criteria: [], brief: 'Upload, set title and description, schedule.', checklist: ['scheduled', 'end screen set'] },
        { key: 'T5', milestone: 'E2', label: 'Thumbnail template', priority: 'P2', due_date: day(7), capability: 'thumbnail', depends_on: [], acceptance_criteria: [], brief: 'A reusable 1280x720 thumbnail template.', checklist: ['1280x720 PNG'] },
      ],
      assumptions: ['The operator records the voice'],
    };
  if (prompt.includes("List the roadmap's milestones"))
    return {
      milestones: [
        { id: 'M1', title: 'Brand and landing page', domain: 'frontend', planned_start: day(-7), planned_end: day(10), capabilities: ['design', 'frontend'], dependencies: [] },
        { id: 'M2', title: 'Booking API', domain: 'backend', planned_start: day(11), planned_end: day(30), capabilities: ['backend', 'database'], dependencies: ['M1'], is_key_milestone: true },
      ],
      assumptions: ['Two milestones are enough for v1'],
    };
  if (prompt.includes('Break every milestone')) {
    const tasks = [
      { key: 'T1', milestone: 'M1', label: 'Design the logo', priority: 'P1', due_date: day(-1), capability: 'design', depends_on: [], acceptance_criteria: ['SVG logo in the repo'] },
      { key: 'T2', milestone: 'M1', label: 'Build the landing page', priority: 'P1', due_date: day(10), capability: 'frontend', depends_on: ['T1'], acceptance_criteria: ['Lighthouse > 90'] },
      { key: 'T3', milestone: 'M2', label: 'Accounts API', priority: 'P0', due_date: day(25), capability: 'backend', depends_on: ['T2'], acceptance_criteria: ['sign up and log in'] },
      { key: 'T4', milestone: 'M2', label: 'Bookings table', priority: 'P2', due_date: null, capability: 'database', depends_on: [], acceptance_criteria: [] },
    ];
    if (mode === 'bad-due') tasks[0].due_date = 20261013;
    if (mode === 'bad-dep') tasks[1].depends_on = ['T99'];
    if (mode === 'cycle') tasks[0].depends_on = ['T3'];
    return { tasks, assumptions: ['The logo comes first'] };
  }
  return 'unknown stage';
}
