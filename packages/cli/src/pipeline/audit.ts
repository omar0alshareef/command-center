import { getTask, logAction, transition } from '@command-center/core';
import { CliError, type Handle } from '../context';
import { checksText, defaultChecks, runChecks } from './checks';
import type { Runner, StageData } from './runner';
import { firstLine, ensurePipelineAgents, runStage, type Out } from './runtime';
import { filesToScan, findingText, scanFiles } from './scan';
import { criteriaText, parseVerdict, renderPrompt, STAGES, taskVars, type Stage } from './stages';

export interface AuditOptions {
  runner: Runner;
  dryRun: boolean;
  checks: string[];
  out: Out;
}

export interface AuditResult {
  pass: boolean;
  stages: { stage: string; verdict: 'PASS' | 'FAIL'; summary: string }[];
  /** Set when a failed audit sent the task back to In Progress. */
  rejected: boolean;
}

/** Code Quality -> Security -> Final Validator. A FAIL in review sends the task back to In Progress with the reason. */
export async function audit(
  h: Handle,
  taskId: string,
  o: AuditOptions,
): Promise<AuditResult | null> {
  const { db, root } = h;
  const task = getTask(db, taskId);
  if (!task) throw new CliError(`No task ${taskId}. Try \`command-center status\`.`);
  if (task.status !== 'review' && task.status !== 'in_progress') {
    throw new CliError(
      `${taskId} is ${task.status}. Audit runs on tasks that are In Progress or in Review.`,
    );
  }
  const checks = o.checks.length ? o.checks : defaultChecks(root);

  if (o.dryRun) {
    const vars = taskVars(task);
    const show = (n: number, s: Stage, v: Record<string, string>) =>
      o.out(
        `## ${n}. ${s.title} (${s.agentId})\n[system] ${s.system}\n\n${renderPrompt(s, { ...vars, ...v })}\n`,
      );
    o.out(`# dry run: audit ${taskId} (${task.status})\n`);
    show(1, STAGES.quality, {
      checks: `<results of: ${checks.join(' && ') || 'no checks configured'}>`,
    });
    show(2, STAGES.security, {
      files: '<files this task touched>',
      findings: '<secret scan findings>',
    });
    show(3, STAGES.validator, { audit: '<verdicts of stages 1-2>' });
    o.out(
      'A FAIL in Review moves the task back to In Progress with the reason; a PASS leaves it for your approval.',
    );
    return null;
  }

  ensurePipelineAgents(db);
  const stages: AuditResult['stages'] = [];
  const data: StageData = { audit: [] };

  const record = async (
    stage: Stage,
    extra: Record<string, string>,
    d: StageData,
    deterministic: 'PASS' | 'FAIL',
    detail: string,
  ): Promise<void> => {
    o.out(`${stage.title}…`);
    let verdict: 'PASS' | 'FAIL' = 'FAIL';
    let summary = detail;
    const run = await runStage(db, o.runner, root, task, stage, extra, d, (out) => {
      // A deterministic failure (a failing check, a found secret) cannot be talked away by the model.
      const said = parseVerdict(out);
      verdict = deterministic === 'FAIL' || said !== 'PASS' ? 'FAIL' : 'PASS';
      summary = `${verdict}: ${detail || firstLine(out)}`;
      return {
        action:
          stage.id === 'validator'
            ? verdict === 'PASS'
              ? 'validation_passed'
              : 'validation_failed'
            : stage.doneAction,
        summary,
        tags: [stage.id, verdict.toLowerCase()],
      };
    });
    if (!run.result.ok)
      throw new CliError(
        `${stage.title} could not run: ${run.result.error ?? 'no output'}. The task was not changed.`,
        2,
      );
    stages.push({ stage: stage.title, verdict, summary });
    data.audit?.push({ stage: stage.title, verdict, summary });
    o.out(`  ${summary}`);
  };

  const results = runChecks(checks, root);
  const bad = results.filter((r) => !r.ok);
  await record(
    STAGES.quality,
    { checks: checksText(results) },
    { checks: results },
    bad.length ? 'FAIL' : 'PASS',
    bad.length
      ? `${bad.length}/${results.length} checks failed (${bad.map((r) => r.command).join(', ')})`
      : results.length
        ? `${results.length} checks passed`
        : 'no checks configured',
  );

  const files = filesToScan(root, task.context_files);
  const findings = scanFiles(root, files).map(findingText);
  await record(
    STAGES.security,
    {
      files: files.length ? files.join(', ') : '(none)',
      findings: findings.length ? findings.join('\n') : '(none)',
    },
    { files, findings },
    findings.length ? 'FAIL' : 'PASS',
    findings.length
      ? `${findings.length} possible secret${findings.length === 1 ? '' : 's'} (${findings.slice(0, 2).join('; ')})`
      : `${files.length} files scanned, no secrets`,
  );

  const unmet = task.acceptance_criteria.filter((c) => !c.done);
  const earlier = stages.filter((s) => s.verdict === 'FAIL');
  await record(
    STAGES.validator,
    {
      criteria: criteriaText(task),
      audit: stages.map((s) => `${s.stage}: ${s.verdict} - ${s.summary}`).join('\n'),
    },
    { audit: data.audit },
    unmet.length || earlier.length ? 'FAIL' : 'PASS',
    unmet.length
      ? `${unmet.length} acceptance criteri${unmet.length === 1 ? 'on is' : 'a are'} not met (${unmet
          .slice(0, 2)
          .map((c) => c.text)
          .join('; ')})`
      : earlier.length
        ? `${earlier.map((s) => s.stage).join(' and ')} did not pass`
        : 'all acceptance criteria are met',
  );

  const failed = stages.filter((s) => s.verdict === 'FAIL');
  const pass = failed.length === 0;
  let rejected = false;
  if (!pass) {
    const reason = `Audit failed. ${failed.map((s) => s.summary).join(' ')}`.slice(0, 600);
    if (task.status === 'review') {
      // What would have prevented it: the failed checks, the unmet criteria, any secret found.
      const prevention = [
        ...unmet.slice(0, 3).map((c) => `Verify before review: ${c.text}.`),
        ...(bad.length
          ? [`Run ${bad.map((r) => r.command).join(', ')} until it passes before submitting.`]
          : []),
        ...(findings.length ? ['Never commit credentials; read them from the environment.'] : []),
      ].join(' ');
      transition(db, taskId, 'reject', {
        actor: STAGES.validator.agentId,
        reason,
        ...(prevention ? { prevention } : {}),
      });
      rejected = true;
      o.out(`\nFAIL. ${taskId} -> In Progress. Reason recorded: ${reason}`);
    } else {
      logAction(db, {
        agentId: STAGES.validator.agentId,
        action: 'audit_failed',
        targetType: 'subtask',
        targetId: taskId,
        description: reason.slice(0, 300),
        tags: ['audit'],
      });
      o.out(`\nFAIL. ${taskId} is still In Progress. ${reason}`);
    }
  } else {
    o.out(
      `\nPASS. ${task.status === 'review' ? `${taskId} is waiting for your approval in the app.` : `${taskId} looks ready for complete_task.`}`,
    );
  }
  return { pass, stages, rejected };
}
