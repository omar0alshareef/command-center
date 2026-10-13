// A stand-in for `claude -p --output-format json` for the M14 orchestrator checks. It logs every call, and its behaviour
// follows markers in the task's label (the prompt starts with "# <id>: <label>"): [fail] exits 1, [hang] never ends and
// leaves a grandchild process (so cancel has a process tree to kill), anything else answers with a short report.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const m = /^# ([^:\n]+): (.*)$/m.exec(prompt);
  const id = m?.[1] ?? 'unknown';
  const label = m?.[2] ?? '';
  const modelIdx = process.argv.indexOf('--model');
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ id, model: modelIdx < 0 ? null : process.argv[modelIdx + 1], cwd: process.cwd(), args: process.argv.slice(2), at: Date.now() }) + '\n',
  );
  if (label.includes('[fail]')) {
    console.error('simulated provider failure');
    process.exit(1);
  }
  if (label.includes('[hang]')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(`${process.env.FAKE_CLAUDE_PIDS}.${id}.json`, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
    return;
  }
  setTimeout(() => {
    console.log(
      JSON.stringify({
        result: `Report for ${id}.\nSUMMARY: done ${id}`,
        is_error: false,
        total_cost_usd: 0.02,
        usage: { input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 10 },
      }),
    );
  }, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 600));
});
