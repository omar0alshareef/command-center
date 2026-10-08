import { addMilestoneNote, setMilestoneDates, type Db, type Milestone } from '@command-center/core';
import { z } from 'zod';
import type { Result } from '../shared/ipc';
import { run } from './task-api';

// Validation for renderer-initiated milestone edits. Always the human operator, always through core.
const ACTOR = 'operator';

const NoteRequest = z.object({ milestoneId: z.string().min(1), text: z.string() });
const DatesRequest = z.object({ milestoneId: z.string().min(1), dates: z.unknown() });

export function milestoneApi(getDb: () => Db) {
  return {
    addNote: (req: unknown): Result<Milestone> =>
      run(() => {
        const r = NoteRequest.parse(req);
        return addMilestoneNote(getDb(), r.milestoneId, r.text, ACTOR);
      }),
    setDates: (req: unknown): Result<Milestone> =>
      run(() => {
        const r = DatesRequest.parse(req);
        return setMilestoneDates(getDb(), r.milestoneId, r.dates, ACTOR);
      }),
  };
}
