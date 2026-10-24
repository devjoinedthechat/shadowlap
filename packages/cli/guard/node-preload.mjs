// Loaded into Node agents by `shadowlap run`, `replay` and `test` (NODE_OPTIONS=--import): in-process
// capture for clients a base URL can't redirect, the network guard for everything else, and what a
// person types, recorded so a replay needs no one at the keyboard. Then it says it loaded.
import './node-capture.mjs';
import './node-guard.mjs';
import './node-input.mjs';
import './node-hello.mjs';
