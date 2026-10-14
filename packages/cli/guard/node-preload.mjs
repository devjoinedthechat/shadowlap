// Loaded into Node agents by `shadowlap run`, `replay` and `test` (NODE_OPTIONS=--import): in-process
// capture for clients a base URL can't redirect, and the network guard for everything else.
import './node-capture.mjs';
import './node-guard.mjs';
