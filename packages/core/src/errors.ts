import type { TaskStatus } from './types';

export class CoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TaskNotFoundError extends CoreError {
  constructor(readonly taskId: string) {
    super('TASK_NOT_FOUND', `Task ${taskId} does not exist.`);
  }
}

export class IllegalTransitionError extends CoreError {
  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly trigger: string,
    allowedFrom: readonly TaskStatus[],
  ) {
    super(
      'ILLEGAL_TRANSITION',
      `Cannot ${trigger} ${taskId}: it is ${from}. ${trigger} is only allowed from: ${allowedFrom.join(', ')}.`,
    );
  }
}

export class ReasonRequiredError extends CoreError {
  constructor(
    readonly taskId: string,
    readonly trigger: string,
  ) {
    super('REASON_REQUIRED', `Cannot ${trigger} ${taskId} without a reason.`);
  }
}

export class DependenciesIncompleteError extends CoreError {
  constructor(
    readonly taskId: string,
    readonly unmet: string[],
  ) {
    super(
      'DEPENDENCIES_INCOMPLETE',
      `${taskId} depends on unfinished tasks: ${unmet.join(', ')}. Finish them first, or start with force.`,
    );
  }
}
