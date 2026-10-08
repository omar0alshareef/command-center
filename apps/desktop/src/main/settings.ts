import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Saved app settings (userData/config.json). M2 only stores the chosen project root.
const file = () => join(app.getPath('userData'), 'config.json');

export function loadSavedRoot(): string | null {
  try {
    const data: unknown = JSON.parse(readFileSync(file(), 'utf8'));
    const root = (data as { projectRoot?: unknown }).projectRoot;
    return typeof root === 'string' && root ? root : null;
  } catch {
    return null;
  }
}

export function saveRoot(projectRoot: string): void {
  writeFileSync(file(), JSON.stringify({ projectRoot }, null, 2));
}
