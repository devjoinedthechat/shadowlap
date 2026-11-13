import { type Command } from 'commander';
import { links } from '@shadowlap/dashboard';
import { ACTIONS, shortSessionId } from '@shadowlap/engine';
import { EXIT } from '../exit-codes.js';
import { emitJobEvent } from '../job-events.js';
import { applyMigration, type MigrateApplyResult } from '../migrate-apply.js';
import { ApplyError } from '../patch-apply.js';
import { openStore, type GlobalOpts } from '../shared.js';
import { palette as p } from '../ui.js';

/**
 * `shadowlap migrate apply <id>`: a migration's config change put in the working tree, its goldens
 * replayed offline, and each that the switch now leaves behind named (migrate-apply.ts).
 */
export function registerMigrateApply(migrate: Command, program: Command): void {
  migrate
    .command('apply')
    .description("Apply a migration's config change: git apply the patch it wrote, checked as fix apply checks a repair's, then replay the project's goldens offline and name each that now diverges on $.model, with the command that re-records it. Only a migration that is all clear, whose patch is the whole switch, is applied")
    .argument('<id>', "the migration's mg-… id, or a unique prefix of it: 4 characters or more after mg-")
    .option('--goldens <dir>', "the project's goldens folder, replayed offline once the patch is in", 'goldens')
    .option('--build <command>', 'rebuild the agent after the patch is applied, before the replay: a compiled agent replays its old build without it')
    .option('--json', 'print what was done as JSON (progress still goes to stderr)')
    .action(async (id: string, flags: { goldens: string; build?: string; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const store = openStore(opts);
      const log = (line: string) => process.stderr.write(`${line}\n`);
      try {
        const result = await applyMigration(store, id, { cwd: process.cwd(), goldens: flags.goldens, build: flags.build ?? null, log, start: (from, to, sessionId) => log(`${p.yellow('⑂')} Applying ${shortSessionId(sessionId)} · ${from.join(', ')} → ${to}`) });
        reportApplied(result, flags.json);
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ migrateId: id, status: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = err.exitCode;
      } finally {
        store.close();
      }
    });
}

/** What `migrate apply` did, as text or JSON, and its drawer's way on: the migration's report, behind Update goldens when goldens wait. */
function reportApplied(result: MigrateApplyResult, json: boolean | undefined): void {
  const short = shortSessionId(result.migrateId);
  const n = result.outdated.length;
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (result.status === 'already-applied') process.stdout.write(`${p.green('✓')} ${short} is already applied: its config change is in the working tree, nothing is left to do\n`);
  else process.stdout.write(`${p.green('✓')} ${short} applied${result.patch === 'already' ? ': the config change was already in the working tree' : ''}${n ? ` · ${n} golden${n === 1 ? '' : 's'} to update` : ''}\n`);
  emitJobEvent({ type: 'link', label: ACTIONS.openMigrationReport.label, href: links.changeSession('migrate', result.migrateId), ...(result.update ? { secondary: true } : {}) });
  emitJobEvent({ type: 'result', data: result as unknown as Record<string, unknown> });
  process.exitCode = EXIT.ok;
}
