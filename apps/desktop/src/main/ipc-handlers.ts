import { BrowserWindow, dialog, ipcMain } from 'electron';
import { CH, type SyncStatus } from '../shared/ipc';
import type { ProjectService } from './project';
import { activityApi } from './activity-api';
import { ensureShimDir } from './cli-shim';
import { PtyManager } from './pty';
import { terminalApi } from './terminal-api';
import { lessonsApi } from './lessons-api';
import { milestoneApi } from './milestone-api';
import { planningApi } from './planning-api';
import type { Planner } from './planner';
import { run, taskApi } from './task-api';
import { WebhookServer } from './webhook';

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

export const projectEvents = {
  changed: () => broadcast(CH.dbChanged),
  status: (s: SyncStatus) => broadcast(CH.dbStatus, s),
};

export const pty = new PtyManager(
  {
    data: (id, data) => broadcast(CH.termData, { id, data }),
    exit: (id, exitCode) => broadcast(CH.termExit, { id, exitCode }),
  },
  () => projectRoot(),
  () => ensureShimDir(),
);
export let webhook: WebhookServer;
export let planner: Planner | null = null;
let projectRoot: () => string | null = () => null;

export function registerIpc(project: ProjectService): void {
  projectRoot = () => project.info().root;
  webhook = new WebhookServer(() => project.db());
  webhook.start();
  ipcMain.handle(CH.webhookStatus, () => webhook.status());
  ipcMain.handle(CH.webhookRegenerate, () => run(() => webhook.regenerate()));
  ipcMain.handle(CH.projectGet, () => project.info());
  ipcMain.handle(CH.projectRetry, () => project.retry());
  ipcMain.handle(CH.getAll, () => project.getAll());
  ipcMain.handle(CH.projectChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose project folder',
      defaultPath: project.info().root ?? process.cwd(),
      properties: ['openDirectory', 'createDirectory'],
    });
    const picked = result.filePaths[0];
    return result.canceled || !picked ? project.info() : project.open(picked, true);
  });

  const tasks = taskApi(() => project.db());
  ipcMain.handle(CH.taskTransition, (_e, req: unknown) => tasks.transition(req));
  ipcMain.handle(CH.taskUpdate, (_e, req: unknown) => tasks.update(req));
  ipcMain.handle(CH.taskCreate, (_e, req: unknown) => tasks.create(req));
  ipcMain.handle(CH.taskDelete, (_e, taskId: unknown) => tasks.delete(taskId));
  ipcMain.handle(CH.taskHistory, (_e, id: unknown) => tasks.history(id));
  ipcMain.handle(CH.taskContext, (_e, id: unknown) => tasks.contextMd(id));

  const milestones = milestoneApi(() => project.db());
  ipcMain.handle(CH.milestoneNote, (_e, req: unknown) => milestones.addNote(req));
  ipcMain.handle(CH.milestoneDates, (_e, req: unknown) => milestones.setDates(req));

  const lessons = lessonsApi(() => project.db());
  ipcMain.handle(CH.lessonUpdate, (_e, req: unknown) => lessons.update(req));
  ipcMain.handle(CH.lessonRemove, (_e, id: unknown) => lessons.remove(id));

  const plan = planningApi(
    () => project.db(),
    (e) => broadcast(CH.planEvent, e),
  );
  planner = plan.planner;
  ipcMain.handle(CH.planList, () => plan.list());
  ipcMain.handle(CH.planGet, (_e, id: unknown) => plan.get(id));
  ipcMain.handle(CH.planCreate, (_e, req: unknown) => plan.create(req));
  ipcMain.handle(CH.planAnswer, (_e, req: unknown) => plan.answer(req));
  ipcMain.handle(CH.planSaveDoc, (_e, req: unknown) => plan.saveDocument(req));
  ipcMain.handle(CH.planSaveProposal, (_e, req: unknown) => plan.saveProposal(req));
  ipcMain.handle(CH.planValidate, (_e, id: unknown) => plan.validate(id));
  ipcMain.handle(CH.planAbandon, (_e, id: unknown) => plan.abandon(id));
  ipcMain.handle(CH.planApprove, (_e, id: unknown) => plan.approve(id));
  ipcMain.handle(CH.planInterview, (_e, id: unknown) => plan.interview(id));
  ipcMain.handle(CH.planDraft, (_e, id: unknown) => plan.draft(id));
  ipcMain.handle(CH.planCancel, (_e, id: unknown) => plan.cancel(id));
  ipcMain.handle(CH.planApprovedDocs, () => plan.approvedDocuments());
  ipcMain.handle(CH.planSettings, () => plan.settings());
  ipcMain.handle(CH.planSetSettings, (_e, req: unknown) => plan.setSettings(req));

  const term = terminalApi(pty);
  ipcMain.handle(CH.termShells, () => term.shells());
  ipcMain.handle(CH.termCreate, (_e, req: unknown) => term.create(req));
  ipcMain.on(CH.termWrite, (_e, id: unknown, data: unknown) => term.write(id, data));
  ipcMain.on(CH.termResize, (_e, id: unknown, cols: unknown, rows: unknown) =>
    term.resize(id, cols, rows),
  );
  ipcMain.handle(CH.termKill, (_e, id: unknown) => term.kill(id));

  const activity = activityApi(() => project.db());
  ipcMain.handle(CH.activityOlder, (_e, req: unknown) => activity.older(req));
}
