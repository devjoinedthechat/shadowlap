import sys

from .tools import agent


def main() -> None:
    question = " ".join(sys.argv[1:]) or "Summarize Northwind's Q3 10-Q."
    print(agent.run_sync(question).output)
