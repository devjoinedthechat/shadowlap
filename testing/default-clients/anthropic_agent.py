"""An agent that builds its client the default way, ``anthropic.Anthropic()``: its key, like its base
URL, comes from the environment. anthropic 2.0 and later send it as a bearer token."""

import anthropic

from answer import answer

answer(lambda prompt: anthropic.Anthropic(max_retries=0).messages.create(model="claude-opus-5", max_tokens=64, messages=[{"role": "user", "content": prompt}]).content[0].text)
