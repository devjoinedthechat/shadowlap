"""Amazon Bedrock through boto3: converse, then converse_stream. Signed with credentials from the environment."""
import json
import os

import boto3

client = boto3.client("bedrock-runtime", region_name=os.environ["AWS_REGION"])
model = "anthropic.claude-3-5-haiku-20241022-v1:0"
prompt = os.environ["PROMPT"]
one = client.converse(modelId=model, messages=[{"role": "user", "content": [{"text": prompt}]}])
stream = client.converse_stream(modelId=model, messages=[{"role": "user", "content": [{"text": prompt + " (streamed)"}]}])
two = "".join(e["contentBlockDelta"]["delta"]["text"] for e in stream["stream"] if "contentBlockDelta" in e)
print(json.dumps({"texts": [one["output"]["message"]["content"][0]["text"], two]}))
