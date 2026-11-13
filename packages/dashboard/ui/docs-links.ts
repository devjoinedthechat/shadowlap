/**
 * Where a dialog's lead ends: the docs page that says how the job works, at its section's anchor
 * where the page is long, and the words its link reads, the page's title or the subject of that
 * section. A dialog names a key, as the connection's expired card does; test/ui-docs-links.test.ts
 * holds every anchor to a heading.
 */
export const DOCS_AT = 'https://github.com/devjoinedthechat/shadowlap/blob/main/docs/';

export interface DocsLink {
  /** A page of docs/, with `#` and a heading's anchor where the page is long. */
  page: string;
  /** What it opens, as the link says it: `<what> in the docs`. */
  what: string;
}

export const DOCS = {
  checks: { page: 'checks#make-a-check-in-the-dashboard', what: 'Checks' },
  deletingRuns: { page: 'cli#rm-gc', what: 'Deleting runs' },
  commandsFromSomeoneElse: { page: 'dashboard#commands-from-someone-else', what: 'Commands from someone else' },
  injectInstruction: { page: 'interventions#inject-an-instruction', what: 'Interventions' },
  switchModel: { page: 'interventions#patch-parameters', what: 'Interventions' },
  failWithStatus: { page: 'interventions#inject-a-failure', what: 'Interventions' },
  overrideResult: { page: 'interventions#override-a-tool-result', what: 'Interventions' },
  failWithToolError: { page: 'interventions#fail-a-tool', what: 'Interventions' },
  plantInstruction: { page: 'interventions#plant-an-instruction-in-a-tool-result', what: 'Interventions' },
  repeatFork: { page: 'interventions#repeat-a-fork', what: 'Interventions' },
  forceLive: { page: 'interventions#force-a-tool-live', what: 'Interventions' },
  changedPrompt: { page: 'interventions#apply-a-changed-prompt-from-a-later-call', what: 'Interventions' },
  injectionTests: { page: 'injection#what-a-test-does', what: 'Injection tests' },
  injectionGate: { page: 'injection#gate-ci-on-it', what: 'Injection tests' },
  injectionReport: { page: 'injection#the-security-report', what: 'Injection tests' },
  imports: { page: 'cli#import', what: 'Imports' },
  packs: { page: 'cli#pack-unpack', what: 'Packs' },
  datasets: { page: 'cli#export-dataset', what: 'Datasets' },
  traces: { page: 'cli#export-otel', what: 'Traces' },
  labels: { page: 'cli#label-note', what: 'Labels' },
  bisect: { page: 'cli#bisect', what: 'Bisect' },
  makeGolden: { page: 'ci#make-a-golden', what: 'Goldens' },
  goldenUpdates: { page: 'ci#update-a-golden-after-an-intended-change', what: 'Golden updates' },
  judgeChecks: { page: 'judges#recorded-once-judged-free-after', what: 'Judge checks' },
  ciMode: { page: 'ci#run-it', what: 'CI mode' },
  githubActions: { page: 'ci#github-actions', what: 'GitHub Actions' },
  prComment: { page: 'ci#the-pull-request-comment', what: 'Pull request comments' },
  gating: { page: 'gating#settle-one-with-more-attempts', what: 'Gating' },
  goldensThatFork: { page: 'ci#recordings-that-fork-on-purpose', what: 'Goldens that fork' },
  blame: { page: 'blame', what: 'Blame' },
  repair: { page: 'repair', what: 'Repair' },
  verify: { page: 'verify', what: 'Verify' },
  decisions: { page: 'decisions', what: 'Decisions' },
  migrate: { page: 'decisions#migrate', what: 'Migrate' },
  repairHandover: { page: 'repair#handing-it-over', what: 'Repair' },
  fixTitles: { page: 'cli#fix-title', what: 'Fix titles' },
  pairs: { page: 'training#exporting-pairs', what: 'Pairs' },
  scoring: { page: 'training#scoring-a-model', what: 'Scoring' },
  tasks: { page: 'training#task-status', what: 'Tasks' },
  normalizers: { page: 'normalizers-and-redaction#normalizers', what: 'Normalizers' },
  redaction: { page: 'normalizers-and-redaction#redaction', what: 'Redaction' },
  mcp: { page: 'mcp', what: 'MCP servers' },
  agents: { page: 'agents#the-skills', what: 'Coding agents' },
  removingProject: { page: 'dashboard#removing-a-project', what: 'Projects' },
  quickstart: { page: 'quickstart', what: 'Quickstart' },
  jobs: { page: 'dashboard#jobs', what: 'Jobs' },
  sessionTokens: { page: 'dashboard#security-and-consent', what: 'Session tokens' },
  // The top bar's help menu: the dashboard's page and the command line's.
  dashboard: { page: 'dashboard', what: 'Dashboard' },
  cli: { page: 'cli', what: 'Command line' },
} as const satisfies Record<string, DocsLink>;

export type DocKey = keyof typeof DOCS;

/** The address a link opens: the page, then its anchor. */
export function docsHref({ page }: DocsLink): string {
  const at = page.indexOf('#');
  return at < 0 ? `${DOCS_AT}${page}.md` : `${DOCS_AT}${page.slice(0, at)}.md${page.slice(at)}`;
}
