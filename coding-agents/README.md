# Instructions for coding agents

What a coding agent needs to know to debug an agent with Shadowlap, packaged for the agents that
install instructions. The skill and the rule hold the same text, and the section to paste in
[docs/agents.md](../docs/agents.md) is a shorter version of it. CI runs every command the three name
against the repository's reference agent (`testing/coding-agents`), so none of them drifts from the
CLI, and the plugin's version is the CLI's.

| Folder | What it is | Install |
|---|---|---|
| [`claude-code/`](./claude-code) | A Claude Code plugin with one skill, `debug-agent` | `shadowlap skill install` puts it into the project. For every project instead: `claude plugin marketplace add devjoinedthechat/shadowlap@v<version>`, `claude plugin install shadowlap@shadowlap`, then `claude plugin update shadowlap@shadowlap` |
| [`cursor/`](./cursor) | A Cursor project rule, applied when Agent finds it relevant | `shadowlap skill install cursor` puts it into the project's `.cursor/rules/` |

`shadowlap skill install` copies what came with the CLI, so it needs no network and the commands
match the CLI's; `<version>` is what `shadowlap --version` prints. For Codex, Copilot or a
`CLAUDE.md` of your own, paste that section instead. The repository's
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) lists the plugin, which is
what lets Claude Code install it from the repository by name.
