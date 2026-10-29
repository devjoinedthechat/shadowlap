"""A CrewAI crew as a user writes it: one Agent on an LLM named by its model, which CrewAI builds on
the OpenAI SDK's client, and one Task, run by Crew.kickoff. Nothing here names Shadowlap's address:
under shadowlap run CrewAI's OpenAI client reads OPENAI_BASE_URL. Tools are CrewAI @tool functions,
named as CrewAI's docs name them, wrapped with shadowlap.adapters.crewai.with_effect. QUERY is the
user's request. Prints a JSON summary, with each tool's result as the model read it."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from crewai import LLM, Agent, Crew, Task
from crewai.tools import tool as crewai_tool

from shadowlap.adapters.crewai import with_effect

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@crewai_tool("Search the web")
def search_web(query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@crewai_tool("Send email")
def send_email(to: str, body: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


def main() -> dict:
    llm = LLM(model="gpt-5")
    researcher = Agent(
        role="Researcher",
        goal="Research what you are asked about and email the team",
        backstory="You research topics and keep the team informed.",
        tools=[with_effect(search_web, "read", trust="untrusted"), with_effect(send_email, "write")],
        llm=llm,
    )
    task = Task(description=f"Research {QUERY} and email the team.", expected_output="One sentence on what was emailed.", agent=researcher)
    out = Crew(agents=[researcher], tasks=[task]).kickoff()
    return {"answer": str(out.raw), "model": type(llm).__name__, "executed": executed}


if __name__ == "__main__":
    print(json.dumps(main()))
