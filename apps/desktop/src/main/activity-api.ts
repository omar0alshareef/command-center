import { getActivityFeed, type AgentLogEntry, type Db } from '@command-center/core';
import { z } from 'zod';
import type { Result } from '../shared/ipc';
import { run } from './task-api';

// Read-only pagination for the Agent Hub's "Load older". The renderer names an anchor row; it never sends SQL.
const OlderRequest = z.object({
  before: z.object({ id: z.string().min(1), timestamp: z.string().min(1) }),
  agentId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export function activityApi(getDb: () => Db) {
  return {
    older: (req: unknown): Result<AgentLogEntry[]> =>
      run(() => {
        const r = OlderRequest.parse(req);
        return getActivityFeed(getDb(), { before: r.before, agentId: r.agentId, limit: r.limit });
      }),
  };
}
