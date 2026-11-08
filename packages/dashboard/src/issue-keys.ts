/**
 * The key of an issue on Runs › Failed (issues.ts): what the failed runs under it share. A fix's
 * (`fix:<fixId>`), a golden's (`test:<path>`), the runs that failed after a planted instruction
 * (`plant:`), or what failed without its call numbers and amounts, by kind: a capture's (`cap:`), a
 * run failing only today's checks (`today:`), or a failure no fix holds (`fail:`). A link that opens
 * an issue names it by its key (ui/runspage/open-issue.ts), so the server and the page build it here.
 */
export const issueKey = {
  fix: (fixId: string): string => `fix:${fixId}`,
  golden: (path: string): string => `test:${path}`,
  planted: (): string => 'plant:',
  failure: (kind: 'cap' | 'today' | 'fail', failed: string): string => `${kind}:${failed}`,
} as const;
