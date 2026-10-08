import { contextBridge, ipcRenderer } from 'electron';
import { CH, type Api, type SyncStatus } from '../shared/ipc';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: Api = {
  platform: process.platform,
  project: {
    get: () => ipcRenderer.invoke(CH.projectGet),
    choose: () => ipcRenderer.invoke(CH.projectChoose),
    retry: () => ipcRenderer.invoke(CH.projectRetry),
  },
  db: { getAll: () => ipcRenderer.invoke(CH.getAll) },
  onDbChanged: (cb) => subscribe<undefined>(CH.dbChanged, () => cb()),
  onDbStatus: (cb) => subscribe<SyncStatus>(CH.dbStatus, cb),
};

contextBridge.exposeInMainWorld('api', api);
