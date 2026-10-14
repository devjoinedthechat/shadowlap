"""Azure OpenAI through the openai package's AzureOpenAI, endpoint in code: a completion, then a streamed one."""
import json
import os

from openai import AzureOpenAI

client = AzureOpenAI(azure_endpoint="https://shadowlap-test.openai.azure.com", api_key="test-key", api_version="2024-10-21", azure_deployment="gpt-4o-prod", max_retries=0)
prompt = os.environ["PROMPT"]
one = client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": prompt}])
stream = client.chat.completions.create(model="gpt-4o", stream=True, messages=[{"role": "user", "content": prompt + " (streamed)"}])
two = "".join((c.choices[0].delta.content or "") for c in stream if c.choices)
print(json.dumps({"texts": [one.choices[0].message.content, two]}))
