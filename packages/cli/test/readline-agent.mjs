// An interactive Node agent for the recorded-input tests: it reads lines from the terminal through
// readline, in the style named by argv, and hands each to a tool, so a recording of it holds what was
// typed and what came of it. An empty line, or the end of the input, ends it.
//
//   node readline-agent.mjs promises | callback | promisify | lines
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { promisify } from 'node:util';
import { tool } from '@shadowlap/sdk';

const mode = process.argv[2] ?? 'promises';
const handle = tool('handle', { effect: 'read' }, async ({ text }) => ({ length: text.length }));
const heard = async (text) => console.log(`heard ${text} (${(await handle({ text })).length})`);

if (mode === 'promises') {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => console.log('[closed]'));
  for (let answer = await rl.question('> '); answer; answer = await rl.question('> ')) await heard(answer);
  rl.close();
} else if (mode === 'callback') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => console.log('[closed]'));
  const ask = () =>
    rl.question('? ', (answer) => {
      if (!answer) return rl.close();
      heard(answer).then(ask);
    });
  ask();
} else if (mode === 'promisify') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => console.log('[closed]'));
  const question = promisify(rl.question).bind(rl);
  for (let answer = await question('# '); answer; answer = await question('# ')) await heard(answer);
  rl.close();
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('close', () => console.log('[closed]'));
  for await (const line of rl) await heard(line);
  console.log('[done]');
}
