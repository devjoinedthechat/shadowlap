#!/usr/bin/env node
// Every store has a full-text index, which Node's built-in SQLite has from 22.16 on and in 24 and
// later, never in 23. The Node is checked before the CLI loads, so an older one is named in one line
// rather than failing at the first store it opens.
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 16) || major >= 24)) {
  console.error(`shadowlap: needs Node.js 22.16 or later (not 23), whose built-in SQLite has full-text search; this is Node.js ${process.versions.node}`);
  process.exit(1);
}

// `shadowlap show <run> | head` closes the pipe early: that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

import('../dist/index.js')
  .then(({ main }) => main(process.argv))
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    // The message is what a person needs; the stack is for bug reports.
    console.error(process.env.SHADOWLAP_DEBUG && err instanceof Error && err.stack ? err.stack : `shadowlap: ${message}`);
    process.exit(1);
  });
