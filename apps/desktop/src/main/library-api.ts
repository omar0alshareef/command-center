import { shell } from 'electron';
import {
  agentUsage,
  AGENT_TEMPLATES,
  assignLibraryAgent,
  createLibraryAgent,
  deleteOrArchiveLibraryAgent,
  getLibraryAgent,
  listAgentVersions,
  listAssignments,
  listLibraryAgents,
  listLibraryLessons,
  promoteLesson,
  readSpec,
  readProjectFile,
  removeLibraryAgent,
  retireLesson,
  setLibraryAgentStatus,
  syncMirrors,
  updateAssignment,
  updateLibraryAgent,
  updateLibraryLesson,
  InvalidInputError,
  type Db,
  type LibraryAgent,
  type LibraryAgentFilter,
  type LibraryAgentPatch,
  type NewLibraryAgent,
  type ProjectAgent,
} from '@command-center/core';
import { z } from 'zod';
import type { LibraryAgentView, ProjectAgentView, Result } from '../shared/ipc';
import { getLibrary } from './library-service';
import { run } from './task-api';

// IPC for the agent library, a project's assigned agents and lesson promotion (M15). The renderer is the human operator:
// this is the only path that creates agents, edits them, assigns them or promotes lessons (MCP can do none of these).

const Id = z.string().min(1).max(64);
const Filter = z
  .object({
    role: z.string().max(40).optional(),
    status: z.enum(['active', 'archived', 'all']).optional(),
    provider: z.string().max(40).optional(),
    search: z.string().max(200).optional(),
  })
  .strict();
const LessonPatch = z
  .object({
    rejection_reason: z.string().max(4000),
    fix_applied: z.string().max(4000),
    prevention: z.string().max(4000),
    trigger_keywords: z.string().max(500),
    check_text: z.string().max(1000),
    check_type: z.enum(['automatic', 'manual']),
    status: z.enum(['active', 'needs_rewrite', 'retired']),
  })
  .partial()
  .strict();

export function libraryApi(
  getDb: () => Db,
  getRoot: () => string | null,
  getProjectId: () => string | null,
) {
  const view = (a: LibraryAgent): LibraryAgentView => ({
    ...a,
    usage: agentUsage(getLibrary(), a.id),
  });

  return {
    agents: (raw: unknown): Result<LibraryAgentView[]> =>
      run(() => {
        const f = Filter.parse(raw ?? {}) as LibraryAgentFilter;
        return listLibraryAgents(getLibrary(), f).map(view);
      }),
    templates: () => run(() => AGENT_TEMPLATES),
    create: (raw: unknown): Result<LibraryAgent> =>
      run(() => createLibraryAgent(getLibrary(), raw as NewLibraryAgent)),
    update: (raw: unknown): Result<LibraryAgent> =>
      run(() => {
        const r = z.object({ id: Id, patch: z.record(z.string(), z.unknown()) }).parse(raw);
        const a = updateLibraryAgent(getLibrary(), r.id, r.patch as LibraryAgentPatch);
        syncMirrors(getDb(), getLibrary()); // this project sees the new profile now; others on their next run
        return a;
      }),
    archive: (id: unknown): Result<LibraryAgent> =>
      run(() => setLibraryAgentStatus(getLibrary(), Id.parse(id), 'archived')),
    restore: (id: unknown): Result<LibraryAgent> =>
      run(() => setLibraryAgentStatus(getLibrary(), Id.parse(id), 'active')),
    remove: (id: unknown): Result<{ result: 'deleted' | 'archived' }> =>
      run(() => {
        const aid = Id.parse(id);
        const r = deleteOrArchiveLibraryAgent(getLibrary(), aid, agentUsage(getLibrary(), aid));
        return { result: r.result };
      }),
    versions: (id: unknown) => run(() => listAgentVersions(getLibrary(), Id.parse(id))),

    projectAgents: {
      list: (): Result<ProjectAgentView[]> =>
        run(() => {
          const lib = getLibrary();
          const out: ProjectAgentView[] = [];
          for (const assignment of listAssignments(getDb())) {
            const library = getLibraryAgent(lib, assignment.library_agent_id);
            if (library) out.push({ library, assignment });
          }
          return out;
        }),
      assign: (raw: unknown): Result<{ notes: string[] }> =>
        run(() => {
          const ids = z.array(Id).min(1).max(50).parse(raw);
          return { notes: ids.map((id) => assignLibraryAgent(getDb(), getLibrary(), id).note) };
        }),
      remove: (id: unknown): Result<null> =>
        run(() => {
          removeLibraryAgent(getDb(), Id.parse(id));
          return null;
        }),
      update: (raw: unknown): Result<ProjectAgent> =>
        run(() => {
          const r = z.object({ id: Id, patch: z.record(z.string(), z.unknown()) }).parse(raw);
          return updateAssignment(getDb(), r.id, r.patch);
        }),
      openSpec: async (): Promise<Result<null>> => {
        try {
          const root = getRoot();
          if (!root) throw new InvalidInputError('No project is open.');
          const file = readProjectFile(root);
          const spec = readSpec(root, file.ok ? file.project : null);
          if (spec.status === 'missing')
            throw new InvalidInputError(
              `This project has no spec file (${spec.path}). Create it from the project's README or the New project flow.`,
            );
          const err = await shell.openPath(spec.path);
          if (err) throw new InvalidInputError(err);
          return { ok: true, value: null };
        } catch (e) {
          return run(() => {
            throw e;
          });
        }
      },
    },

    lessons: {
      promote: (raw: unknown) =>
        run(() => {
          const r = z
            .object({
              id: z.number().int().positive(),
              target: z.union([
                z.object({ scope: z.literal('agent'), agentId: Id }).strict(),
                z.object({ scope: z.literal('global') }).strict(),
              ]),
            })
            .strict()
            .parse(raw);
          return promoteLesson(getDb(), getLibrary(), r.id, r.target, {
            actor: 'operator',
            projectId: getProjectId(),
          });
        }),
      retire: (id: unknown) =>
        run(() => retireLesson(getDb(), z.number().int().positive().parse(id))),
      library: () => run(() => listLibraryLessons(getLibrary())),
      updateLibrary: (raw: unknown) =>
        run(() => {
          const r = z
            .object({ id: z.number().int().positive(), patch: LessonPatch })
            .strict()
            .parse(raw);
          return updateLibraryLesson(getLibrary(), r.id, r.patch);
        }),
    },
  };
}
