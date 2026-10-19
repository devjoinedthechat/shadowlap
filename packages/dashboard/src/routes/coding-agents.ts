import { CODING_AGENTS, type CodingAgent } from '../agent-skill.js';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * Settings → Coding agents' install: the job kind `skill-install` { agent: 'claude-code' | 'cursor',
 * replace? } runs `shadowlap skill install <agent>` in the project, `--force` when `replace`, which
 * puts the copy of the plugin or the rule that came with the CLI into the project. What the tab
 * offers, and when, is in its read model (`GET /api/settings/agents`, `skill`, agent-skill.ts): Install
 * the skill only once the owner has published it, the rule at any time. The job itself installs
 * either whenever it is asked, as the command does.
 */
export function register(_router: Router, ctx: RouteContext): void {
  ctx.jobs.registerJobKind('skill-install', {
    title: (req) => (req.agent === 'cursor' ? 'Adding the Cursor rule' : 'Installing the skill'),
    build: (req, { project }) => {
      if (!CODING_AGENTS.includes(req.agent as CodingAgent)) return { error: `agent is ${CODING_AGENTS.join(' or ')}` };
      if (req.replace !== undefined && typeof req.replace !== 'boolean') return { error: 'replace is true or false' };
      // It writes into the project's folder: a dashboard serving a store alone has none.
      if (!project) return { error: 'installing needs the project folder: start the dashboard with shadowlap dashboard in it', status: 409 };
      return { args: ['skill', 'install', req.agent as CodingAgent, ...(req.replace === true ? ['--force'] : [])] };
    },
  });
}
