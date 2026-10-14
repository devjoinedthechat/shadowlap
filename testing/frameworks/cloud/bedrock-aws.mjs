// Amazon Bedrock through the AWS SDK: Converse, then ConverseStream. Requests are SigV4-signed for
// bedrock-runtime.us-east-1.amazonaws.com; credentials come from the environment.
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION, maxAttempts: 1 });
const modelId = 'anthropic.claude-3-5-haiku-20241022-v1:0';
const messages = [{ role: 'user', content: [{ text: process.env.PROMPT }] }];
const one = await client.send(new ConverseCommand({ modelId, messages }));
const stream = await client.send(new ConverseStreamCommand({ modelId, messages: [{ role: 'user', content: [{ text: `${process.env.PROMPT} (streamed)` }] }] }));
let two = '';
for await (const event of stream.stream) if (event.contentBlockDelta) two += event.contentBlockDelta.delta.text;
console.log(JSON.stringify({ texts: [one.output.message.content[0].text, two], usage: one.usage }));
