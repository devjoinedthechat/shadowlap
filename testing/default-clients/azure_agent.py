"""An agent that builds its Azure OpenAI client the default way, ``openai.AzureOpenAI()``: its
endpoint, API version and key come from AZURE_OPENAI_ENDPOINT, OPENAI_API_VERSION and
AZURE_OPENAI_API_KEY."""

import openai

from answer import answer

answer(lambda prompt: openai.AzureOpenAI(max_retries=0).chat.completions.create(model="gpt-prod", messages=[{"role": "user", "content": prompt}]).choices[0].message.content)
