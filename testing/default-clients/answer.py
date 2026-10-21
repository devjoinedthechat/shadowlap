"""What every agent here prints: its answer to PROMPT as one line of JSON, or the error it got, and
exit 1 then. The tests read the line from Node and Python agents alike."""

import json
import os
import sys


def answer(ask):
    try:
        print(json.dumps({"answer": ask(os.environ.get("PROMPT", "hello"))}), flush=True)
    except Exception as err:
        print(json.dumps({"error": "%s: %s" % (type(err).__name__, err)}), flush=True)
        sys.exit(1)
