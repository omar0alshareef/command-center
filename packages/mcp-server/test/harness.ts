import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@command-center/core';
import { seedDb } from '../../core/src/seed';
import { createServer } from '../src/server';

export const NOW = new Date('2026-03-12T10:00:00Z');

export interface Reply {
  isError: boolean;
  text: string;
  json: <T = Record<string, unknown>>() => T;
}

export interface Harness {
  db: Db;
  root: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<Reply>;
  client: Client;
  close: () => Promise<void>;
}

/** A real MCP client talking to the real server over an in-memory transport, on a seeded temp DB. */
export async function connect(
  opts: { clientName?: string; env?: NodeJS.ProcessEnv; seed?: boolean } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  const db = openDb(root);
  if (opts.seed !== false) seedDb(db, { now: NOW });
  const server = createServer({ db, env: opts.env ?? {}, now: () => NOW });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: opts.clientName ?? 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const call: Harness['call'] = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const first = (r.content as { type: string; text: string }[])[0];
    const text = first?.text ?? '';
    return { isError: Boolean(r.isError), text, json: <T>() => JSON.parse(text) as T };
  };
  return {
    db,
    root,
    call,
    client,
    close: async () => {
      await client.close();
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
