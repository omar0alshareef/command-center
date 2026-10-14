import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  dbPath,
  defaultLibraryDir,
  libraryPath,
  openDb,
  openLibraryReadonly,
  type LibraryDb,
} from '@command-center/core';
import { existsSync } from 'node:fs';
import { log } from './results';
import { createServer } from './server';

const root = process.env['PROJECT_ROOT']?.trim();
if (!root) {
  log('PROJECT_ROOT is not set. Set it to the project folder that contains command-center.db.');
  process.exit(1);
}
if (!existsSync(dbPath(root))) {
  // Opening would silently create an empty board in the wrong folder after a typo.
  log(
    `No command-center.db in ${root}. Open the Command Center app on that folder first, or fix PROJECT_ROOT.`,
  );
  process.exit(1);
}

const db = openDb(root);
// The agent library is read-only here, at COMMAND_CENTER_LIBRARY or the app's default folder. Without it the library tools say so and the rest work.
let library: LibraryDb | null = null;
const libDir = defaultLibraryDir();
if (existsSync(libraryPath(libDir))) {
  try {
    library = openLibraryReadonly(libDir);
  } catch (e) {
    log('could not open the agent library:', e);
  }
}
const server = createServer({ db, library });

// A bug outside a tool body must not take the agent's session down; tool bodies already cannot throw.
process.on('uncaughtException', (e) => log('uncaught exception:', e));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e));

const shutdown = () => {
  try {
    db.close();
    library?.close();
  } finally {
    process.exit(0);
  }
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
log(`ready: ${root}`);
