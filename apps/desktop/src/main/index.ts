import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { resolveProjectRoot } from './config';
import { projectEvents, registerIpc } from './ipc-handlers';
import { ProjectService } from './project';
import { loadSavedRoot } from './settings';
import { buildWindowOptions } from './window-options';

const project = new ProjectService(projectEvents);

function createWindow(): void {
  const win = new BrowserWindow({
    ...buildWindowOptions(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Never open new windows or navigate away from the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  registerIpc(project);
  const root = resolveProjectRoot(process.env, loadSavedRoot());
  if (root) project.open(root);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => project.close());

app.on('window-all-closed', () => {
  app.quit();
});
