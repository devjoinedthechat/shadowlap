"""Amazon Bedrock through the anthropic package's AnthropicBedrock: a message, then a streamed one
(InvokeModel and InvokeModelWithResponseStream), SigV4-signed with credentials from the environment.
The client signs its Accept-Encoding too."""
import json
import os

from anthropic import AnthropicBedrock

client = AnthropicBedrock(aws_region=os.environ["AWS_REGION"], max_retries=0)
model = "anthropic.claude-3-5-haiku-20241022-v1:0"
prompt = os.environ["PROMPT"]
one = client.messages.create(model=model, max_tokens=64, messages=[{"role": "user", "content": prompt}])
with client.messages.stream(model=model, max_tokens=64, messages=[{"role": "user", "content": prompt + " (streamed)"}]) as stream:
    two = stream.get_final_message()
print(json.dumps({"texts": [one.content[0].text, two.content[0].text]}))
