"""An agent that asks Bedrock through boto3's Converse, its client built the default way: its
credentials come from the environment, the shared files or an instance role."""

import boto3
from botocore.config import Config

from answer import answer


def ask(prompt):
    client = boto3.client("bedrock-runtime", config=Config(retries={"max_attempts": 1}))
    reply = client.converse(modelId="amazon.nova-pro-v1:0", messages=[{"role": "user", "content": [{"text": prompt}]}])
    return reply["output"]["message"]["content"][0]["text"]


answer(ask)
