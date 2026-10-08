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

export class MilestoneNotFoundError extends CoreError {
  constructor(readonly milestoneId: string) {
    super('MILESTONE_NOT_FOUND', `Milestone ${milestoneId} does not exist.`);
  }
}

export class LessonNotFoundError extends CoreError {
  constructor(readonly lessonId: number) {
    super('LESSON_NOT_FOUND', `Lesson ${lessonId} does not exist.`);
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

export class AgentNotFoundError extends CoreError {
  constructor(readonly agentId: string) {
    super('AGENT_NOT_FOUND', `Agent '${agentId}' is not registered.`);
  }
}

/** `operator` (the human) and `system` are built in and cannot be registered or impersonated. */
export class ReservedAgentError extends CoreError {
  constructor(readonly agentId: string) {
    super(
      'RESERVED_AGENT',
      `'${agentId}' is a reserved agent id and cannot be used by a tool call.`,
    );
  }
}

export class InvalidInputError extends CoreError {
  constructor(message: string) {
    super('INVALID_INPUT', message);
  }
}

/** An agent tried to approve work that it (or its own sub-agent / parent) submitted for review. */
export class SelfApprovalError extends CoreError {
  constructor(
    readonly taskId: string,
    readonly actor: string,
    readonly submitter: string,
  ) {
    super(
      'SELF_APPROVAL',
      actor === submitter
        ? `${actor} cannot approve ${taskId}: ${actor} submitted it for review. Ask the operator or a different agent to approve.`
        : `${actor} cannot approve ${taskId}: it was submitted by ${submitter}, which is in the same agent family as ${actor}. Ask the operator or an unrelated agent to approve.`,
    );
  }
}

/** A session tried to act as an agent that is neither itself nor one of its own sub-agents. */
export class ForeignAgentError extends CoreError {
  constructor(
    readonly agentId: string,
    readonly sessionAgent: string,
  ) {
    super(
      'FOREIGN_AGENT',
      `You can act only as yourself (${sessionAgent}) or as agents registered under you; '${agentId}' is neither.`,
    );
  }
}
