import { Command } from 'commander';
import { safeText } from '@shadowlap/engine';
import { CI_PROVIDERS, LayoutError, PROVIDERS, StoreError, StoreUrlError, type CiProvider, type Provider } from '@shadowlap/remote';
import { parseChoice, VERSION, type GlobalOpts } from '../shared.js';
import { storeCheck, storeCi, storePolicy, storePushFromCi, storeSet, storeSetChecked, storeShow, teamEnv, TeamError, teamPull, teamPush, teamShare } from '../team.js';
import { palette as p } from '../ui.js';

/**
 * The team store: the project's runs in a bucket you own. `push`, `pull` and `share` move runs and
 * reports between this machine and the bucket; `store` sets it up.
 */

/**
 * Runs a team store command. What goes wrong with the store or its contents is a message to print
 * (credentials missing, access denied, a damaged object), not a stack trace.
 */
async function run(fn: () => number | Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (err) {
    if (err instanceof TeamError || err instanceof StoreError || err instanceof LayoutError || err instanceof StoreUrlError) {
      // A message may quote what a store answered: shown with its control characters escaped.
      process.stderr.write(p.red(`✗ ${safeText(err.message)}\n`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const PROVIDER_FLAG = 's3 | gcs | azure | r2';
const provider = parseChoice<Provider>(PROVIDERS);

export function register(program: Command): void {
  program.commandsGroup('Team store:');
  const env = () => teamEnv(program.opts<GlobalOpts>().db);

  program
    .command('push')
    .description("Copy runs from this machine to the team store, so teammates and CI can open them. Blobs shared between runs go up once; a run still recording goes when it ends. A pull request's CI job pushes to its own folder in the store")
    .argument('[runs...]', 'run ids or unique prefixes; their ancestors go too')
    .option('--all', 'every run on this machine that is not in the store as it is')
    .option('--json', 'machine-readable output')
    .action((runs: string[], flags: { all?: boolean; json?: boolean }) => run(() => teamPush(env(), runs, flags)));

  program
    .command('pull')
    .description("Bring teammates' runs from the team store to this machine, and merge labels and notes")
    .argument('[runs...]', 'only these runs (ids or unique prefixes, as in the store)')
    .option('--include-pr', "also bring the runs pull requests' CI jobs pushed to their own folders; they stay on this machine")
    .option('--json', 'machine-readable output')
    .action((runs: string[], flags: { includePr?: boolean; json?: boolean }) => run(() => teamPull(env(), runs, flags)));

  program
    .command('share')
    .description('Write a redacted HTML report of a run to the team store and print a link that expires after 7 days. Anyone with the link can open it, without an account')
    .argument('<run>', 'run id or unique prefix')
    .option('--lineage', "include the run's ancestors, so its recording and forks compare inside the report")
    .option('--json', 'machine-readable output')
    .action((runArg: string, flags: { lineage?: boolean; json?: boolean }) => run(() => teamShare(env(), runArg, { ...flags, version: VERSION })));

  const store = program.command('store').description("The team store: a bucket you own that holds the team's runs");
  store
    .command('set')
    .description('Use a bucket as the team store: writes "store" to shadowlap.config.json')
    .argument('<url>', 's3://bucket/folder, gs://bucket/folder, az://account/container/folder or r2://account/bucket/folder')
    .option('--provider <provider>', `check the URL against one provider's scheme: ${PROVIDER_FLAG}`, provider)
    .option('--check', "check access first, as store check does, and write the store only when it works")
    .option('--json', 'machine-readable output')
    .action((url: string, flags: { provider?: Provider; check?: boolean; json?: boolean }) => run(() => (flags.check ? storeSetChecked(env(), url, flags) : storeSet(env(), url, flags))));
  store
    .command('check')
    .description("List, write, read and delete a test object with this machine's credentials; report encryption, versioning and object lock")
    .option('--json', 'machine-readable output')
    .action((flags: { json?: boolean }) => run(() => storeCheck(env(), flags)));
  store
    .command('show')
    .description('The store, the last push and pull, and how many runs are in it or only on this machine (offline)')
    .option('--json', 'machine-readable output')
    .action((flags: { json?: boolean }) => run(() => storeShow(env(), flags)));
  store
    .command('policy')
    .description("Print the access to ask your cloud admin for: a policy for people and CI on protected branches, and one for pull requests' CI jobs, which may write only to their own folders")
    .option('--provider <provider>', `${PROVIDER_FLAG} (default: the store's)`, provider)
    .option('--json', 'machine-readable output')
    .action((flags: { provider?: Provider; json?: boolean }) => run(() => storePolicy(env(), flags)));
  store
    .command('push-from-ci')
    .description('Turn pushing from CI on or off: writes "ciPush" to shadowlap.config.json. Off, test --push in CI runs the tests and keeps their runs in the job, and the GitHub Action keeps the fixes it opens there')
    .argument('<on|off>', 'on (the default) or off', parseChoice<'on' | 'off'>(['on', 'off']))
    .option('--json', 'machine-readable output')
    .action((value: 'on' | 'off', flags: { json?: boolean }) => run(() => storePushFromCi(env(), value, flags)));
  store
    .command('ci')
    .description('Print a CI step that runs the goldens and pushes every test run, with short-lived credentials (OIDC) where the CI and cloud allow it, and the step for pull requests beside it')
    .requiredOption('--provider <ci>', 'github | gitlab | other', parseChoice<CiProvider>(CI_PROVIDERS))
    .option('--packs <glob>', 'the goldens to test', 'goldens/*')
    .option('--json', 'machine-readable output')
    .action((flags: { provider: CiProvider; packs: string; json?: boolean }) => run(() => storeCi(env(), flags)));
}
