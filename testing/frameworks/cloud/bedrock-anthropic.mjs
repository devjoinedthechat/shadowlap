// Amazon Bedrock through Anthropic's Bedrock client: a message, then a streamed one (InvokeModel and
// InvokeModelWithResponseStream), SigV4-signed with credentials from the environment.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

const client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION, maxRetries: 0 });
const model = 'anthropic.claude-3-5-haiku-20241022-v1:0';
const one = await client.messages.create({ model, max_tokens: 64, messages: [{ role: 'user', content: process.env.PROMPT }] });
const stream = client.messages.stream({ model, max_tokens: 64, messages: [{ role: 'user', content: `${process.env.PROMPT} (streamed)` }] });
const two = await stream.finalMessage();
console.log(JSON.stringify({ texts: [one.content[0].text, two.content[0].text] }));
