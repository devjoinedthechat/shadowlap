#!/usr/bin/env node
// Every store has a full-text index, which Node's built-in SQLite has from 22.16 on and in 24 and
// later, never in 23; and 22.16 itself crashes `shadowlap ui` when its terminal closes. The Node is
// checked before the CLI loads, so another one is named in one line rather than failing at the first
// store it opens. A Node it can't run on is how this machine is set up, so it ends with 2, as any
// configuration shadowlap can't use does (docs/cli.md, Exit status).
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 17) || major >= 24)) {
  console.error(`shadowlap: needs Node.js 22.17 or later (not 23, whose built-in SQLite has no full-text search); this is Node.js ${process.versions.node}`);
  process.exit(2);
}

// The Python package's shadowlap command marks what it runs, so it can tell when that runs it again
// (SHADOWLAP_CLI=shadowlap names it). This is the CLI it runs: nothing this starts, an agent that
// runs that command among them, is running it again.
delete process.env.SHADOWLAP_CONSOLE_SCRIPT;

// `shadowlap show <run> | head` closes the pipe early: that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

// What a command throws ends it with the status the contract gives it (exit-codes.ts): the message
// is what a person needs, and SHADOWLAP_DEBUG=1 adds the stack for a bug report. A stop signal ends
// it with 128 + the signal's number, however the command wound down, one that came during its last
// synchronous work too (runToEnd), or with an error nothing caught, as a closed terminal's SIGHUP
// does (endUncaught).
import('../dist/index.js').then(
  (cli) => {
    cli.watchStopSignals();
    process.on('uncaughtException', cli.endUncaught);
    cli.runToEnd(() => cli.main(process.argv));
  },
  (/** @type {unknown} */ err) => {
    // The CLI's own files did not load: an installation that is broken, never what it was asked.
    console.error(process.env.SHADOWLAP_DEBUG && err instanceof Error && err.stack ? err.stack : `shadowlap: internal error: ${err instanceof Error ? err.message : String(err)}`);
    console.error('This is a bug in shadowlap or its installation: reinstall it, and if that does not help, report it at https://github.com/devjoinedthechat/shadowlap/issues');
    process.exit(70);
  },
);
