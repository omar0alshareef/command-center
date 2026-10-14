import { deleteLesson, updateLesson, type Db, type Lesson } from '@command-center/core';
import { z } from 'zod';
import type { Result } from '../shared/ipc';
import { run } from './task-api';

// Editing the memory from the Lessons list. Always through core, which keeps LESSONS_LEARNED.md in step.
const Text = z.string().max(4000);
const UpdateRequest = z.object({
  id: z.number().int().positive(),
  patch: z
    .object({
      rejection_reason: Text,
      fix_applied: Text,
      prevention: Text,
      trigger_keywords: z.string().max(500),
      check_text: z.string().max(1000),
      check_type: z.enum(['automatic', 'manual', 'none']),
      status: z.enum(['draft', 'active', 'needs_rewrite', 'retired']),
    })
    .partial()
    .strict(),
});

export function lessonsApi(getDb: () => Db) {
  return {
    update: (req: unknown): Result<Lesson> =>
      run(() => {
        const r = UpdateRequest.parse(req);
        return updateLesson(getDb(), r.id, r.patch);
      }),
    remove: (id: unknown): Result<null> =>
      run(() => {
        deleteLesson(getDb(), z.number().int().positive().parse(id));
        return null;
      }),
  };
}
