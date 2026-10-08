import type { Task } from '@command-center/core';
import type { CheckResult } from './checks';
import type { Stage } from './stages';

/** Everything a runner may use. An LLM runner reads `prompt`/`system`; the local runner reads the structured `data`. */
export interface StageRequest {
  stage: Stage;
  prompt: string;
  system: string;
  root: string;
  task: Task;
  data: StageData;
}

export interface StageData {
  research?: string;
  lessons?: string[];
  checks?: CheckResult[];
  files?: string[];
  findings?: string[];
  /** Earlier audit stage results, for the validator. */
  audit?: { stage: string; verdict: 'PASS' | 'FAIL' | null; summary: string }[];
  budget?: number;
}

export interface StageResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Pluggable executor of pipeline stages. v1 ships `claude` (Claude Code CLI, non-interactive) and `local` (offline). */
export interface Runner {
  name: string;
  run(req: StageRequest): Promise<StageResult>;
}
