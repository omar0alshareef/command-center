import { BrowserWindow, dialog, ipcMain } from 'electron';
import { CH, type SyncStatus } from '../shared/ipc';
import type { ProjectService } from './project';

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
}
