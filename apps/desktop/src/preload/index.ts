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
    promote: (req) => ipcRenderer.invoke(CH.lessonPromote, req),
    retire: (id) => ipcRenderer.invoke(CH.lessonRetire, id),
    library: () => ipcRenderer.invoke(CH.libLessons),
    updateLibrary: (req) => ipcRenderer.invoke(CH.libLessonUpdate, req),
  },
  projects: {
    list: () => ipcRenderer.invoke(CH.projList),
    pick: () => ipcRenderer.invoke(CH.projPick),
    plan: (req) => ipcRenderer.invoke(CH.projPlan, req),
    create: (req) => ipcRenderer.invoke(CH.projCreate, req),
    addExisting: (path) => ipcRenderer.invoke(CH.projAdd, path),
    remove: (id) => ipcRenderer.invoke(CH.projRemove, id),
    switchTo: (req) => ipcRenderer.invoke(CH.projSwitch, req),
    relocate: (req) => ipcRenderer.invoke(CH.projRelocate, req),
  },
  library: {
    agents: (f) => ipcRenderer.invoke(CH.libAgents, f),
    templates: () => ipcRenderer.invoke(CH.libTemplates),
    create: (req) => ipcRenderer.invoke(CH.libCreate, req),
    update: (req) => ipcRenderer.invoke(CH.libUpdate, req),
    archive: (id) => ipcRenderer.invoke(CH.libArchive, id),
    restore: (id) => ipcRenderer.invoke(CH.libRestore, id),
    remove: (id) => ipcRenderer.invoke(CH.libDelete, id),
    versions: (id) => ipcRenderer.invoke(CH.libVersions, id),
  },
  projectAgents: {
    list: () => ipcRenderer.invoke(CH.pagList),
    assign: (ids) => ipcRenderer.invoke(CH.pagAssign, ids),
    remove: (id) => ipcRenderer.invoke(CH.pagRemove, id),
    update: (req) => ipcRenderer.invoke(CH.pagUpdate, req),
    openSpec: () => ipcRenderer.invoke(CH.specOpen),
  },
  models: {
    setList: (req) => ipcRenderer.invoke(CH.modelsSet, req),
    setAgentModel: (req) => ipcRenderer.invoke(CH.agentSetModel, req),
  },
  agents: {
    setProvider: (req) => ipcRenderer.invoke(CH.agentSetProvider, req),
    setConcurrency: (req) => ipcRenderer.invoke(CH.agentSetConcurrency, req),
  },
  orchestrator: {
    status: () => ipcRenderer.invoke(CH.orchStatus),
    resume: () => ipcRenderer.invoke(CH.orchResume),
    pause: (req) => ipcRenderer.invoke(CH.orchPause, req),
    stopAfterCurrent: () => ipcRenderer.invoke(CH.orchStopAfter),
    start: (req) => ipcRenderer.invoke(CH.orchStart, req),
    cancelRun: (runId) => ipcRenderer.invoke(CH.orchCancelRun, runId),
    setConfig: (patch) => ipcRenderer.invoke(CH.orchConfig, patch),
    onStatus: (cb) => subscribe(CH.orchEvent, cb),
  },
  providers: {
    list: (refresh) => ipcRenderer.invoke(CH.provList, refresh),
    setKey: (req) => ipcRenderer.invoke(CH.provSetKey, req),
    setBaseUrl: (req) => ipcRenderer.invoke(CH.provSetUrl, req),
    test: (id) => ipcRenderer.invoke(CH.provTest, id),
    models: (id) => ipcRenderer.invoke(CH.provModels, id),
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
