import { readFileSync } from 'node:fs';

/**
 * The instructions docs/agents.md gives coding agents to paste also come packaged, in the
 * repository's coding-agents/ folder and versioned with the CLI: a Claude Code plugin with one
 * skill, and a Cursor rule. Settings → Coding agents offers to install them only once an install can
 * be completed, which takes them published.
 *
 * The owner publishes the plugin by hand, and flips this to true once it is published.
 */
export const SKILL_PUBLISHED = false;

/** The repository, which is its own Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). */
export const SKILL_REPOSITORY = 'devjoinedthechat/shadowlap';
/** The plugin as Claude Code installs it, `<plugin>@<marketplace>`: both are named shadowlap. */
export const SKILL_PLUGIN = 'shadowlap@shadowlap';
/** The skill's command in Claude Code: the plugin's name, then the skill's. */
export const SKILL_COMMAND = '/shadowlap:debug-agent';
/** The Cursor rule: where it is in the repository, and where it goes in a project. */
export const CURSOR_RULE = { source: 'coding-agents/cursor/shadowlap.mdc', path: '.cursor/rules/shadowlap.mdc' } as const;

/** What Settings → Coding agents can offer to install. */
export interface SkillOffer {
  /** Whether the plugin is published, so an install can be completed. Until it is, nothing is offered. */
  published: boolean;
  /** `shadowlap@shadowlap`. */
  plugin: string;
  /** `/shadowlap:debug-agent`. */
  command: string;
  /**
   * The commands that install each at this version, the one whose commands this CLI takes: the
   * repository as a marketplace pinned to the release's tag, and the rule from that tag. Null until
   * published.
   */
  install: { claudeCode: string[]; cursor: string[] } | null;
}

/** The offer for the release `version` (this dashboard's own by default). */
export function skillOffer(version: string = ownVersion(), published: boolean = SKILL_PUBLISHED): SkillOffer {
  const offer = { published, plugin: SKILL_PLUGIN, command: SKILL_COMMAND };
  // A version that isn't a release's (one unreadable, or not semver) has no tag to pin to.
  if (!published || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return { ...offer, install: null };
  const tag = `v${version}`;
  const rule = `https://raw.githubusercontent.com/${SKILL_REPOSITORY}/${tag}/${CURSOR_RULE.source}`;
  return {
    ...offer,
    install: {
      claudeCode: [`claude plugin marketplace add ${SKILL_REPOSITORY}@${tag}`, `claude plugin install ${SKILL_PLUGIN}`],
      cursor: [`mkdir -p ${CURSOR_RULE.path.slice(0, CURSOR_RULE.path.lastIndexOf('/'))}`, `curl -fsSL ${rule} -o ${CURSOR_RULE.path}`],
    },
  };
}

/** This package's version, which is the CLI's: one version is set across every package. */
function ownVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}
