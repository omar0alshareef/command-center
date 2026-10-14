import { basename } from 'node:path';
import {
  defaultLibraryDir,
  openLibrary,
  readProjectFile,
  registerProject,
  slugify,
  type LibraryDb,
  type ProjectRecord,
} from '@command-center/core';

// The app-wide library (M15): agents, library lessons and the project registry, in one SQLite file in the per-user
// application data folder (`defaultLibraryDir`, shared with the CLI and MCP server). COMMAND_CENTER_LIBRARY (a folder)
// overrides it so tests and a second install never touch the real one.

let lib: LibraryDb | null = null;

export const libraryDir = (): string => defaultLibraryDir();

export function getLibrary(): LibraryDb {
  lib ??= openLibrary(libraryDir());
  return lib;
}

export function closeLibrary(): void {
  if (lib?.open) lib.close();
  lib = null;
}

/** Put an opened project folder in the registry (idempotent); its name comes from a valid project.json, else the folder name. */
export function registerFolder(root: string, opened = true): ProjectRecord {
  const file = readProjectFile(root);
  const name = file.ok ? file.project.name : basename(root) || 'Project';
  return registerProject(getLibrary(), {
    name,
    slug: file.ok ? file.project.slug : slugify(name) || 'project',
    path: root,
    opened,
  });
}
