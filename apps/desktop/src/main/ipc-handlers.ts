import { BrowserWindow, dialog, ipcMain } from 'electron';
import { CH, type SyncStatus } from '../shared/ipc';
import type { ProjectService } from './project';
import { milestoneApi } from './milestone-api';
import { taskApi } from './task-api';

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

export const projectEvents = {
  changed: () => broadcast(CH.dbChanged),
  status: (s: SyncStatus) => broadcast(CH.dbStatus, s),
};

export function registerIpc(project: ProjectService): void {
  ipcMain.handle(CH.projectGet, () => project.info());
  ipcMain.handle(CH.projectRetry, () => project.retry());
  ipcMain.handle(CH.getAll, () => project.getAll());
  ipcMain.handle(CH.projectChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const picked = result.filePaths[0];
    return result.canceled || !picked ? project.info() : project.open(picked, true);
  });

  const tasks = taskApi(() => project.db());
  ipcMain.handle(CH.taskTransition, (_e, req: unknown) => tasks.transition(req));
  ipcMain.handle(CH.taskUpdate, (_e, req: unknown) => tasks.update(req));
  ipcMain.handle(CH.taskCreate, (_e, req: unknown) => tasks.create(req));
  ipcMain.handle(CH.taskHistory, (_e, id: unknown) => tasks.history(id));
  ipcMain.handle(CH.taskContext, (_e, id: unknown) => tasks.contextMd(id));

  const milestones = milestoneApi(() => project.db());
  ipcMain.handle(CH.milestoneNote, (_e, req: unknown) => milestones.addNote(req));
  ipcMain.handle(CH.milestoneDates, (_e, req: unknown) => milestones.setDates(req));
}
