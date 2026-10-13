// A stand-in for `claude -p` that records its arguments (M14 Slice 1 verification) and answers every stage with
// text the pipeline accepts. Appends one JSON line per call to FAKE_CLAUDE_LOG.
import { appendFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), bytes: prompt.length }) + '\n');
  process.stdout.write('## Files\n- `src/login.ts` — the form\nSUMMARY: done\nVERDICT: PASS\n');
});
