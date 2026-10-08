// Child-process writer for the concurrency test. Opens the DB, says "ready", then on "go" hammers
// it with short write transactions (log rows + task transitions) while other processes do the same.
import { openDb } from '../../src/db';
import { logAction } from '../../src/queries';
import { transition } from '../../src/state-machine';

const [root, name, iterations] = process.argv.slice(2);
if (!root || !name || !iterations) throw new Error('usage: writer <root> <name> <iterations>');

const db = openDb(root);
process.stdout.write('ready\n');
process.stdin.once('data', () => {
  for (let i = 0; i < Number(iterations); i++) {
    logAction(db, { agentId: 'system', action: 'stress', description: `${name}-${i}` });
    transition(db, `T-${name}`, 'start');
    transition(db, `T-${name}`, 'reset');
  }
  db.close();
  process.exit(0);
});
