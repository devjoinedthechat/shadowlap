"""An agent that builds its client the default way, ``openai.OpenAI()``: its key, like its base URL,
comes from the environment."""

import openai

from answer import answer

answer(lambda prompt: openai.OpenAI(max_retries=0).chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": prompt}]).choices[0].message.content)
