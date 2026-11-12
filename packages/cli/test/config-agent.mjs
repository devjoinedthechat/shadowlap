// An agent that reads its model from the project's config, as most do: it runs the command it is
// given with AGENT_MODEL set to agent.config.json's model, so a config change that switches the model
// changes what it sends, and a golden recorded before it diverges on $.model when it replays.
//
//   node config-agent.mjs <command> [args...]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const { model } = JSON.parse(readFileSync('agent.config.json', 'utf8'));
const run = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, AGENT_MODEL: model } });
process.exit(run.status ?? 1);
