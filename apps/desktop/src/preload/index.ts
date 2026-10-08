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
  tasks: {
    transition: (req) => ipcRenderer.invoke(CH.taskTransition, req),
    update: (req) => ipcRenderer.invoke(CH.taskUpdate, req),
    create: (req) => ipcRenderer.invoke(CH.taskCreate, req),
    history: (taskId) => ipcRenderer.invoke(CH.taskHistory, taskId),
    contextMd: (taskId) => ipcRenderer.invoke(CH.taskContext, taskId),
  },
  milestones: {
    addNote: (req) => ipcRenderer.invoke(CH.milestoneNote, req),
    setDates: (req) => ipcRenderer.invoke(CH.milestoneDates, req),
  },
  activity: { older: (req) => ipcRenderer.invoke(CH.activityOlder, req) },
  lessons: {
    update: (req) => ipcRenderer.invoke(CH.lessonUpdate, req),
    remove: (id) => ipcRenderer.invoke(CH.lessonRemove, id),
  },
  terminal: {
    shells: () => ipcRenderer.invoke(CH.termShells),
    create: (req) => ipcRenderer.invoke(CH.termCreate, req),
    write: (id, data) => ipcRenderer.send(CH.termWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(CH.termResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(CH.termKill, id),
    onData: (cb) => subscribe(CH.termData, cb),
    onExit: (cb) => subscribe(CH.termExit, cb),
  },
  webhook: {
    status: () => ipcRenderer.invoke(CH.webhookStatus),
    regenerate: () => ipcRenderer.invoke(CH.webhookRegenerate),
  },
  onDbChanged: (cb) => subscribe<undefined>(CH.dbChanged, () => cb()),
  onDbStatus: (cb) => subscribe<SyncStatus>(CH.dbStatus, cb),
};

contextBridge.exposeInMainWorld('api', api);
