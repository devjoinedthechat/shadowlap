"""An agent that builds its client the default way, ``anthropic.AnthropicBedrock()``: its AWS
credentials and region come from the environment, and the client signs each request with them."""

import anthropic

from answer import answer

answer(lambda prompt: anthropic.AnthropicBedrock(max_retries=0).messages.create(model="anthropic.claude-opus-5", max_tokens=64, messages=[{"role": "user", "content": prompt}]).content[0].text)
