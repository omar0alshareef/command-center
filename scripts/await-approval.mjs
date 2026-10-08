// Usage: node scripts/await-approval.mjs M1
// Blocks (polls) until the supervisor writes .supervisor/<M>.verdict.json, or ~9 minutes pass.
// Verdict file format: {"verdict":"APPROVED"|"CHANGES_REQUESTED","notes":"..."}
import fs from 'node:fs';
import path from 'node:path';

const m = process.argv[2];
if (!m) { console.error('usage: await-approval.mjs <milestone e.g. M1>'); process.exit(1); }
const file = path.join('.supervisor', `${m}.verdict.json`);
const deadline = Date.now() + 9 * 60 * 1000;

while (Date.now() < deadline) {
  if (fs.existsSync(file)) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`VERDICT: ${v.verdict}\n${v.notes ?? ''}`);
      process.exit(0);
    } catch { /* file mid-write, retry */ }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(`STILL_WAITING: no verdict for ${m} yet. Run this same command again.`);
process.exit(2);
