import { dialog } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyScaffold,
  getProjectByPath,
  getProjectRecord,
  InvalidInputError,
  lineDiff,
  listProjects,
  normalizePath,
  planScaffold,
  projectHealth,
  readProjectFile,
  registerProject,
  relocateProject,
  removeProjectRecord,
  slugify,
} from '@command-center/core';
import { z } from 'zod';
import type { ProjectEntry, Result, ScaffoldPlan, SwitchResult } from '../shared/ipc';
import { getLibrary } from './library-service';
import type { OrchestratorLoop } from './orchestrator-loop';
import type { ProjectService } from './project';
import { run } from './task-api';

// The project registry and switcher (M15, D31). The registry only lists folders; a folder is a project when it has a
// project.json, and its data lives in its own command-center.db. Nothing here ever deletes a project's files.

const Path = z.string().trim().min(1).max(1000);
const Name = z.string().trim().min(1).max(120).optional();
const Repo = z.string().trim().min(1).max(1000).nullable().optional();
const PlanReq = z.object({ path: Path, name: Name, repoPath: Repo }).strict();
const CreateReq = PlanReq.extend({ replace: z.array(Path).max(10).optional() }).strict();
const SwitchReq = z
  .object({ id: z.string().min(1).max(100), cancelRunning: z.boolean().optional() })
  .strict();

export function projectsApi(project: ProjectService, loop: OrchestratorLoop) {
  const entries = (): ProjectEntry[] => {
    const current = project.info().root;
    const cur = current ? normalizePath(current) : null;
    return listProjects(getLibrary()).map((p) => {
      const h = projectHealth(p.path);
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        path: p.path,
        last_opened: p.last_opened,
        openable: h.openable,
        error: h.error,
        dispatchBlock: h.dispatchBlock,
        current: cur !== null && normalizePath(p.path).toLowerCase() === cur.toLowerCase(),
      };
    });
  };

  /** Pause dispatch for the project that is open (saying so in the result), then open another folder. */
  const openFolder = async (path: string, cancelRunning: boolean): Promise<SwitchResult> => {
    const before = project.info();
    const same =
      before.root && normalizePath(before.root).toLowerCase() === normalizePath(path).toLowerCase();
    let paused: SwitchResult['paused'] = null;
    if (before.root && !same) {
      const r = await loop.releaseForSwitch(cancelRunning);
      paused = { project: before.projectName, running: r.running, cancelled: r.cancelled };
    }
    const info = project.open(path, true);
    if (info.error) throw new InvalidInputError(`The project could not be opened: ${info.error}`);
    loop.push();
    return { info, paused };
  };

  const plan = (raw: unknown): ScaffoldPlan => {
    const r = PlanReq.parse(raw);
    const path = normalizePath(r.path);
    const existingFile = readProjectFile(path);
    const name =
      r.name ??
      (existingFile.ok ? existingFile.project.name : (path.split(/[\\/]/).pop() ?? 'Project'));
    const items = planScaffold(path, { name, slug: slugify(name), repoPath: r.repoPath ?? null });
    return {
      path,
      name,
      existing: existingFile.ok,
      items: items.map((i) => ({
        path: i.path,
        kind: i.kind,
        action: i.action,
        diff: i.action === 'differs' ? lineDiff(i.current ?? '', i.template ?? '') : null,
      })),
    };
  };

  return {
    list: (): Result<ProjectEntry[]> => run(entries),

    pick: async (): Promise<Result<string | null>> => {
      try {
        const res = await dialog.showOpenDialog({
          title: 'Choose a project folder',
          defaultPath: project.info().root ?? process.cwd(),
          properties: ['openDirectory', 'createDirectory'],
        });
        return { ok: true, value: res.canceled ? null : (res.filePaths[0] ?? null) };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
        };
      }
    },

    plan: (raw: unknown): Result<ScaffoldPlan> => run(() => plan(raw)),

    create: async (raw: unknown): Promise<Result<SwitchResult>> => {
      try {
        const r = CreateReq.parse(raw);
        const p = plan(r);
        const items = planScaffold(p.path, {
          name: p.name,
          slug: slugify(p.name),
          repoPath: r.repoPath ?? null,
        });
        applyScaffold(p.path, items, { replace: r.replace ?? [], repoPath: r.repoPath ?? null });
        const file = readProjectFile(p.path);
        registerProject(getLibrary(), {
          name: file.ok ? file.project.name : p.name,
          slug: file.ok ? file.project.slug : slugify(p.name),
          path: p.path,
        });
        return { ok: true, value: await openFolder(p.path, false) };
      } catch (e) {
        return fail(e);
      }
    },

    addExisting: (rawPath: unknown): Result<ProjectEntry[]> =>
      run(() => {
        const path = normalizePath(Path.parse(rawPath));
        if (!existsSync(join(path, 'project.json')))
          throw new InvalidInputError(
            `${path} has no project.json: use New project to create one there.`,
          );
        const file = readProjectFile(path);
        if (!file.ok) throw new InvalidInputError(file.issues.join('; '));
        registerProject(getLibrary(), { name: file.project.name, slug: file.project.slug, path });
        return entries();
      }),

    remove: (rawId: unknown): Result<ProjectEntry[]> =>
      run(() => {
        const id = z.string().min(1).parse(rawId);
        const rec = getProjectRecord(getLibrary(), id);
        const cur = project.info().root;
        if (rec && cur && getProjectByPath(getLibrary(), cur)?.id === rec.id)
          throw new InvalidInputError('This project is open. Switch to another project first.');
        removeProjectRecord(getLibrary(), id);
        return entries();
      }),

    relocate: (raw: unknown): Result<ProjectEntry[]> =>
      run(() => {
        const r = z
          .object({ id: z.string().min(1).max(100), path: Path })
          .strict()
          .parse(raw);
        const cur = project.info().root;
        const rec = getProjectRecord(getLibrary(), r.id);
        if (
          rec &&
          cur &&
          normalizePath(rec.path).toLowerCase() === normalizePath(cur).toLowerCase()
        )
          throw new InvalidInputError(
            'This project is open: its folder is fine. Switch to another project first.',
          );
        relocateProject(getLibrary(), r.id, r.path);
        return entries();
      }),

    switchTo: async (raw: unknown): Promise<Result<SwitchResult>> => {
      try {
        const r = SwitchReq.parse(raw);
        const rec = getProjectRecord(getLibrary(), r.id);
        if (!rec) throw new InvalidInputError('That project is not in the registry.');
        const h = projectHealth(rec.path);
        if (!h.openable) throw new InvalidInputError(h.error ?? 'This project cannot be opened.');
        return { ok: true, value: await openFolder(rec.path, r.cancelRunning ?? false) };
      } catch (e) {
        return fail(e);
      }
    },
  };
}

function fail(e: unknown): Result<never> {
  // Reuse the shared mapping (zod and CoreError aware) by running a throwing function through `run`.
  return run(() => {
    throw e;
  });
}
