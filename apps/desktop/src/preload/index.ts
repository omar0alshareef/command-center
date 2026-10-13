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
    delete: (taskId) => ipcRenderer.invoke(CH.taskDelete, taskId),
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
  planning: {
    list: () => ipcRenderer.invoke(CH.planList),
    get: (id) => ipcRenderer.invoke(CH.planGet, id),
    create: (req) => ipcRenderer.invoke(CH.planCreate, req),
    answer: (req) => ipcRenderer.invoke(CH.planAnswer, req),
    saveDocument: (req) => ipcRenderer.invoke(CH.planSaveDoc, req),
    saveProposal: (req) => ipcRenderer.invoke(CH.planSaveProposal, req),
    validate: (id) => ipcRenderer.invoke(CH.planValidate, id),
    abandon: (id) => ipcRenderer.invoke(CH.planAbandon, id),
    approve: (id) => ipcRenderer.invoke(CH.planApprove, id),
    interview: (id) => ipcRenderer.invoke(CH.planInterview, id),
    draft: (id) => ipcRenderer.invoke(CH.planDraft, id),
    cancel: (id) => ipcRenderer.invoke(CH.planCancel, id),
    approvedDocuments: () => ipcRenderer.invoke(CH.planApprovedDocs),
    settings: () => ipcRenderer.invoke(CH.planSettings),
    setSettings: (req) => ipcRenderer.invoke(CH.planSetSettings, req),
    onEvent: (cb) => subscribe(CH.planEvent, cb),
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
