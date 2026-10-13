import {
  getClaudeModels,
  setAgentModel,
  setClaudeModels,
  type Agent,
  type Db,
  type ModelOption,
} from '@command-center/core';
import { z } from 'zod';
import type { Result } from '../shared/ipc';
import { run } from './task-api';

// Which Claude Code model each agent runs on (M14 Slice 1). The renderer is the operator, so the actor is fixed.
const SetModel = z
  .object({ agentId: z.string().min(1).max(64), model: z.string().max(100).nullable() })
  .strict();

export function modelsApi(getDb: () => Db) {
  return {
    list: (): Result<ModelOption[]> => run(() => getClaudeModels(getDb())),
    setList: (list: unknown): Result<ModelOption[]> => run(() => setClaudeModels(getDb(), list)),
    setAgentModel: (req: unknown): Result<Agent> =>
      run(() => {
        const r = SetModel.parse(req);
        return setAgentModel(getDb(), r.agentId, r.model);
      }),
  };
}
