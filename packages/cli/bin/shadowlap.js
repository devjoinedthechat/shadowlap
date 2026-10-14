#!/usr/bin/env node
import { main } from '../dist/index.js';

// `shadowlap show <run> | head` closes the pipe early: that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

main(process.argv).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // The message is what a person needs; the stack is for bug reports.
  console.error(process.env.SHADOWLAP_DEBUG && err instanceof Error && err.stack ? err.stack : `shadowlap: ${message}`);
  process.exit(1);
});
