// Stands in for `shadowlap ui` in the tests: the dashboard the terminal UI opens, with the same stop
// handling and nothing to draw (the terminal UI itself needs a real terminal). It prints the
// dashboard's address and token as one JSON line, then runs until a signal ends it.
import { cliSpawner, startDashboard } from '@shadowlap/dashboard';
import { Store } from '@shadowlap/engine';
import { embeddedDashboard } from '../dist/dashboard-stop.js';

const [cli, dbPath] = process.argv.slice(2);
const cwd = process.cwd();
const store = Store.open(dbPath);
const dashboard = embeddedDashboard(() => startDashboard({ store, dbPath, port: 0, spawnCli: cliSpawner({ command: [process.execPath, cli], dbPath, cwd }), project: { path: cwd } }));
const d = await dashboard.open();
process.stdout.write(`${JSON.stringify({ url: d.url, token: d.token })}\n`);
setInterval(() => {}, 1000);
