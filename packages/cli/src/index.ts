import { CoreError, hydrate, hydrationPrompt } from '@command-center/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { agentsCommand, lessonsCommand, logCommand, statusCommand } from './commands';
import { CliError, openProject, type Handle } from './context';
import { audit } from './pipeline/audit';
import { prepare } from './pipeline/prepare';
import { resolveRunner } from './pipeline/runtime';
import { start } from './pipeline/start';

// The app launches this through Electron-as-node for its terminal; children (claude, npm) must not inherit that.
delete process.env['ELECTRON_RUN_AS_NODE'];

const out = (line: string) => console.log(line);
const int = (min: number, max: number) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new InvalidArgumentError(`must be a whole number from ${min} to ${max}`);
  return n;
};
const collect = (v: string, prev: string[]) => [...prev, v];
const taskId = (positional: string | undefined, flag: string | undefined): string => {
  const id = (flag ?? positional)?.trim().toUpperCase();
  if (!id) throw new CliError('Give a task id: --id TASK-001');
  return id;
};

const program = new Command();
program
  .name('command-center')
  .description(
    'Operator CLI for Command Center. Works on the project in --root, $PROJECT_ROOT, or the nearest folder with a command-center.db.',
  )
  .option(
    '--root <folder>',
    'project folder (default: $PROJECT_ROOT or the nearest parent with a command-center.db)',
  )
  .showHelpAfterError('(add --help for usage)');

/** Opens the project, runs the handler, closes the board, and turns errors into one clean line and an exit code. */
function action<A extends unknown[]>(
  fn: (h: Handle, ...args: A) => Promise<number | undefined> | number | undefined,
) {
  return async (...args: A) => {
    let h: Handle | null = null;
    try {
      h = openProject(program.opts<{ root?: string }>().root);
      const code = await fn(h, ...args);
      if (typeof code === 'number') process.exitCode = code;
    } catch (e) {
      if (e instanceof CliError) {
        console.error(`error: ${e.message}`);
        process.exitCode = e.exitCode;
      } else if (e instanceof CoreError) {
        console.error(`error: ${e.message}`);
        process.exitCode = 1;
      } else {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 3;
      }
    } finally {
      h?.db.close();
    }
  };
}

program
  .command('status')
  .description('Project status: week, phase, progress, what needs review, what is blocked')
  .option('--json', 'machine-readable output')
  .action(
    action((h, o: { json?: boolean }) => (statusCommand(h, Boolean(o.json), out), undefined)),
  );

program
  .command('agents')
  .description('List agents and whether they are active')
  .option('--json', 'machine-readable output')
  .action(
    action((h, o: { json?: boolean }) => (agentsCommand(h, Boolean(o.json), out), undefined)),
  );

program
  .command('log')
  .description('Activity log, newest first (one task with --task)')
  .option('--task <id>', 'only entries about this task')
  .option('--agent <id>', 'only this agent')
  .option('--limit <n>', 'how many entries', int(1, 1000), 30)
  .option('--json', 'machine-readable output')
  .action(
    action(
      (h, o: { task?: string; agent?: string; limit: number; json?: boolean }) => (
        logCommand(h, { ...o, json: Boolean(o.json) }, out),
        undefined
      ),
    ),
  );

program
  .command('lessons')
  .description(
    'Lessons learned from rejections: those that apply to --task, a --query search, or the latest',
  )
  .option('--task <id>', 'lessons that apply to this task')
  .option('--query <text>', 'search past rejection reasons, fixes and preventions')
  .option('--limit <n>', 'how many lessons', int(1, 50), 10)
  .option('--json', 'machine-readable output')
  .action(
    action(
      (h, o: { task?: string; query?: string; limit: number; json?: boolean }) => (
        lessonsCommand(h, { ...o, json: Boolean(o.json) }, out),
        undefined
      ),
    ),
  );

program
  .command('hydrate')
  .description(
    'Fill the board from a plan (--plan plan.json), or write the extraction prompt for an agent (--manifesto + --roadmap)',
  )
  .option('--plan <file>', 'JSON plan: project, phases, agents, milestones with tasks')
  .option('--manifesto <file>', 'project manifesto (markdown/text)')
  .option('--roadmap <file>', 'project roadmap (markdown/text)')
  .option(
    '--out <file>',
    'with --manifesto/--roadmap: write the prompt here instead of printing it',
  )
  .option('--dry-run', 'validate the plan and report counts, change nothing')
  .option('--json', 'machine-readable output')
  .action(
    action(
      (
        h,
        o: {
          plan?: string;
          manifesto?: string;
          roadmap?: string;
          out?: string;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        const read = (f: string) => {
          try {
            return readFileSync(f, 'utf8');
          } catch {
            throw new CliError(`Cannot read ${f}.`);
          }
        };
        if (o.plan) {
          let plan: unknown;
          try {
            plan = JSON.parse(read(o.plan));
          } catch (e) {
            if (e instanceof CliError) throw e;
            throw new CliError(`${o.plan} is not valid JSON.`);
          }
          const s = hydrate(h.db, plan, { dryRun: o.dryRun });
          out(
            o.json
              ? JSON.stringify(s)
              : `${s.dryRun ? 'Dry run (nothing written): would create' : 'Created'} ${s.phases} phases, ${s.agents} agents, ${s.milestones} milestones, ${s.tasks} tasks.`,
          );
          return undefined;
        }
        if (!o.manifesto || !o.roadmap)
          throw new CliError(
            'Give --plan <file>, or both --manifesto <file> and --roadmap <file>.',
          );
        const prompt = hydrationPrompt(read(o.manifesto), read(o.roadmap));
        if (o.out) {
          writeFileSync(o.out, prompt);
          out(
            `Prompt written to ${o.out}. Give it to your agent, save its JSON reply, then run: command-center hydrate --plan <file>`,
          );
        } else out(prompt);
        return undefined;
      },
    ),
  );

const pipelineOptions = (c: Command) =>
  c
    .argument('[id]', 'task id, for example TASK-001')
    .option('--id <id>', 'task id')
    .option(
      '--runner <name>',
      'claude (Claude Code CLI), local (offline heuristics) or auto',
      'auto',
    )
    .option('--timeout <minutes>', 'give up on one agent stage after this long', int(1, 240), 15)
    .option('--dry-run', 'print the stage prompts and what would happen, change nothing');

interface Common {
  id?: string;
  runner: string;
  timeout?: number;
  dryRun?: boolean;
  check?: string[];
  budget?: number;
}

pipelineOptions(
  program
    .command('prepare')
    .description('Research -> compress -> optimize, then write .claude/TASK_CONTEXT.md'),
)
  .option('--budget <tokens>', 'token budget for the compressed research', int(100, 4000), 500)
  .action(
    action(async (h, id: string | undefined, o: Common) => {
      await prepare(h, taskId(id, o.id), {
        runner: resolveRunner(o.runner, out, o.timeout),
        dryRun: Boolean(o.dryRun),
        budget: o.budget ?? 500,
        out,
      });
      return undefined;
    }),
  );

pipelineOptions(
  program
    .command('start')
    .description(
      'start_task, dispatch the agent with TASK_CONTEXT.md, run the checks, complete_task',
    ),
)
  .option(
    '--check <command>',
    'command to run after the build (repeatable; default: npm run typecheck / lint)',
    collect,
    [] as string[],
  )
  .option('--no-dispatch', 'the work is already built: only run the checks and complete')
  .option('--budget <tokens>', 'token budget for prepare, if it has to run', int(100, 4000), 500)
  .action(
    action(async (h, id: string | undefined, o: Common & { dispatch: boolean }) => {
      const outcome = await start(h, taskId(id, o.id), {
        runner: resolveRunner(o.runner, out, o.timeout),
        dryRun: Boolean(o.dryRun),
        checks: o.check ?? [],
        dispatch: o.dispatch,
        budget: o.budget ?? 500,
        out,
      });
      return outcome === 'checks-failed' ? 1 : 0;
    }),
  );

pipelineOptions(
  program
    .command('audit')
    .description(
      'Code quality -> security -> final validator; FAIL sends a reviewed task back with the reason',
    ),
)
  .option(
    '--check <command>',
    'check command (repeatable; default: npm run typecheck / lint)',
    collect,
    [] as string[],
  )
  .action(
    action(async (h, id: string | undefined, o: Common) => {
      const r = await audit(h, taskId(id, o.id), {
        runner: resolveRunner(o.runner, out, o.timeout),
        dryRun: Boolean(o.dryRun),
        checks: o.check ?? [],
        out,
      });
      return r && !r.pass ? 1 : 0;
    }),
  );

await program.parseAsync(process.argv);
