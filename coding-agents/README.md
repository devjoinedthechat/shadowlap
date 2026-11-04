# Instructions for coding agents

What a coding agent needs to know to set Shadowlap up for an agent and debug it, packaged as two
skills in the [Agent Skills](https://agentskills.io/specification) format: `setup-agent` and
`debug-agent`. The section to paste in [docs/agents.md](../docs/agents.md) is a shorter version of
the second. CI runs every command they name against the repository's reference agent
(`testing/coding-agents`), so none of them drifts from the CLI, and the skills' version is the CLI's.

| For | What it is | Install |
|---|---|---|
| Claude Code | [`claude-code/`](./claude-code): a plugin with both skills, as `/shadowlap:setup-agent` and `/shadowlap:debug-agent` | `shadowlap skill install` puts it into the project's `.claude/skills/shadowlap/`. For every project instead: `claude plugin marketplace add devjoinedthechat/shadowlap@v<version>`, `claude plugin install shadowlap@shadowlap`, then `claude plugin update shadowlap@shadowlap` |
| Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity, Devin Desktop (formerly Windsurf), OpenCode, Cline, Amp, goose, Zed, Junie | The same skills, as `shadowlap-setup-agent` and `shadowlap-debug-agent` | `shadowlap skill install agents` (or any of their names) puts them into the project's `.agents/skills/` |
| Kiro | The same | `shadowlap skill install kiro` puts them into the project's `.kiro/skills/` |

`shadowlap skill install` copies what came with the CLI, so it needs no network and the commands
match the CLI's; `<version>` is what `shadowlap --version` prints. In `.agents/skills` and
`.kiro/skills`, folders every tool's skills share, each name starts with `shadowlap-` so it can't
collide with another tool's, and the skills leave out `allowed-tools`, which names Claude Code's
tools. For a `CLAUDE.md` or `AGENTS.md` of your own, paste that section instead. The repository's
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) lists the plugin, which is
what lets Claude Code install it from the repository by name.
