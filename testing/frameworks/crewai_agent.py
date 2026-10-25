"""CrewAI tools (no API), invoked the way a CrewAI agent invokes them (`BaseTool.run` with keyword
arguments, which validates them first): a @tool function and a BaseTool subclass, both wrapped with
shadowlap.adapters.crewai.with_effect. QUERY changes the search so a replay forks. Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from crewai.tools import BaseTool, tool
from pydantic import BaseModel

from shadowlap import ShadowlapWriteBlocked
from shadowlap.adapters.crewai import with_effect

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool("search_web")
def search_web(query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return f"{query} #1"


class EmailInput(BaseModel):
    to: str


class SendEmail(BaseTool):
    name: str = "send_email"
    description: str = "Send an email to someone."
    args_schema: type = EmailInput

    def _run(self, to: str) -> str:
        executed.append("send_email")
        return f"sent to {to}"


search = with_effect(search_web, "read")
email = with_effect(SendEmail(), "write")


def main() -> dict:
    found = search.run(query=QUERY)
    try:
        sent = email.run(to="team@example.com")
    except ShadowlapWriteBlocked as err:
        return {"found": found, "sent": None, "executed": executed, "error": f"ShadowlapWriteBlocked: {err}"}
    return {"found": found, "sent": sent, "executed": executed, "error": None}


if __name__ == "__main__":
    print(json.dumps(main()))
