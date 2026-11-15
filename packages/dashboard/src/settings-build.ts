import { configBuild, messageOf } from '@shadowlap/engine';
import { type ConfigInfo, loadConfigFile } from './settings-shared.js';

/**
 * Build, on Settings → Project: the command that builds the agent, as `build` in shadowlap.config.json
 * names it. `repair`, `fix apply`, `verify` (in the checkout of the code before a change), `migrate
 * apply` and `bisect` run it where no `--build` is given, so a compiled agent is never replayed from
 * an old build, whether the command runs in a terminal or from the dashboard.
 */
export interface BuildSettings {
  /** The command, as the file names it; null for none. */
  build: string | null;
  /** Why the file's `build` can't be run, in the CLI's words; null when it can. */
  problem: string | null;
  /** The file, and the version an edit sends back. */
  config: ConfigInfo;
}

export function buildSettings(cwd: string): BuildSettings {
  const { info, file } = loadConfigFile(cwd);
  if (!file) return { build: null, problem: null, config: info };
  try {
    return { build: configBuild(file.data.build), problem: null, config: info };
  } catch (err) {
    return { build: null, problem: messageOf(err), config: info };
  }
}
