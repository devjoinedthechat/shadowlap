"""The research agent's tools. Three are wrapped with shadowlap and say what they do; the two that
write, saving a report and posting to Slack, aren't yet."""

from pydantic_ai import Agent

from shadowlap import tool

agent = Agent(
    "anthropic:claude-sonnet-5-5",
    system_prompt="You are a research analyst. Find and read filings with the tools; never guess a figure.",
)


@agent.tool_plain
@tool(effect="read")
def search_filings(company: str, form: str) -> dict:
    return {"results": [{"id": "F-2291", "form": form, "period": "Q3 2026"}]}


@agent.tool_plain
@tool(effect="read")
def fetch_document(id: str) -> dict:
    return {"id": id, "pages": 48}


@agent.tool_plain
@tool(effect="pure")
def extract_figures(id: str, fields: list[str]) -> dict:
    return {"revenue": "$412M", "operating_margin": "14.2%"}


@agent.tool_plain
def save_report(path: str, text: str) -> dict:
    with open(path, "w") as f:
        f.write(text)
    return {"saved": True, "bytes": len(text)}


@agent.tool_plain
def notify_slack(channel: str, text: str) -> dict:
    return {"ok": True}
