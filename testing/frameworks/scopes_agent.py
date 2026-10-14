"""Two sub-agents as asyncio tasks that start with the same request, each in shadowlap.scope().
ORDER=reverse swaps which one asks first."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

import anthropic  # noqa: E402

from shadowlap import scope  # noqa: E402

client = anthropic.AsyncAnthropic(api_key="k", max_retries=0)


async def worker(name, wait):
    with scope(name):
        await asyncio.sleep(wait)
        plan = await client.messages.create(model="claude-opus-5", max_tokens=16, messages=[{"role": "user", "content": "Make a plan."}])
        text = plan.content[0].text
        done = await client.messages.create(model="claude-opus-5", max_tokens=16, messages=[{"role": "user", "content": "Make a plan."}, {"role": "assistant", "content": text}, {"role": "user", "content": "Carry it out as %s." % name}])
        return "%s: %s / %s" % (name, text, done.content[0].text)


async def main():
    a, b = (0.08, 0) if os.environ.get("ORDER") == "reverse" else (0, 0.08)
    print(json.dumps(await asyncio.gather(worker("alpha", a), worker("beta", b))))


asyncio.run(main())
