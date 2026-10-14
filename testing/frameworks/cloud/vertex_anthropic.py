"""Claude on Vertex AI through the anthropic package's AnthropicVertex, region in code."""
import json
import os

from anthropic import AnthropicVertex

client = AnthropicVertex(region="us-east5", project_id="shadowlap-test", access_token="test-token", max_retries=0)
one = client.messages.create(model="claude-sonnet-4@20250514", max_tokens=64, messages=[{"role": "user", "content": os.environ["PROMPT"]}])
print(json.dumps({"texts": [one.content[0].text]}))
