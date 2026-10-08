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

export type Call = (name: string, args?: Record<string, unknown>) => Promise<Reply>;

export interface Peer {
  client: Client;
  call: Call;
  close: () => Promise<void>;
}

export interface Harness extends Peer {
  db: Db;
  root: string;
  /** Another agent session (its own server + client) on the same database. */
  another: (clientName: string, env?: NodeJS.ProcessEnv) => Promise<Peer>;
}

/** A real MCP client talking to a real server over an in-memory transport, on `db`. */
async function attach(db: Db, clientName: string, env: NodeJS.ProcessEnv): Promise<Peer> {
  const server = createServer({ db, env, now: () => NOW });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call: Call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const first = (r.content as { type: string; text: string }[])[0];
    const text = first?.text ?? '';
    return { isError: Boolean(r.isError), text, json: <T>() => JSON.parse(text) as T };
  };
  return { client, call, close: () => client.close() };
}

/** First session on a fresh (seeded) temp project. */
export async function connect(
  opts: { clientName?: string; env?: NodeJS.ProcessEnv; seed?: boolean } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  const db = openDb(root);
  if (opts.seed !== false) seedDb(db, { now: NOW });
  const first = await attach(db, opts.clientName ?? 'test-client', opts.env ?? {});
  const others: Peer[] = [];
  return {
    ...first,
    db,
    root,
    another: async (clientName, env = {}) => {
      const peer = await attach(db, clientName, env);
      others.push(peer);
      return peer;
    },
    close: async () => {
      for (const p of others) await p.close();
      await first.close();
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
