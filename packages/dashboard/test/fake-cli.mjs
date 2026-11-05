// Stands in for the shadowlap CLI in the dashboard's job tests. It reports on fd 3 the way
// emitJobEvent does when SHADOWLAP_EVENTS_FD is set, and prints what a person would read.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const fd = Number(process.env.SHADOWLAP_EVENTS_FD);
const emit = (event) => {
  if (Number.isInteger(fd) && fd >= 3) writeSync(fd, typeof event === 'string' ? `${event}\n` : `${JSON.stringify(event)}\n`);
};

switch (args[0]) {
  case 'events': {
    const [, outside] = args;
    console.log(`cwd ${process.cwd()}`);
    console.log(`events fd ${process.env.SHADOWLAP_EVENTS_FD ?? 'none'}`);
    process.stderr.write('[shadowlap] replaying run 01K5CQ4P2R0000000000000000\n');
    mkdirSync(join(process.cwd(), '.shadowlap', 'exports'), { recursive: true });
    writeFileSync(join(process.cwd(), '.shadowlap', 'exports', 'dataset.jsonl'), '{"messages":[]}\n');
    mkdirSync(join(process.cwd(), 'share', 'pack-1'), { recursive: true });
    emit({ type: 'run', runId: '01K5CQ4P2S0000000000000000', role: 'new' });
    emit({ type: 'run', runId: '01K5CQ4P2T0000000000000000', role: 'attempt' });
    emit('not json at all');
    emit({ type: 'run', runId: 'not-a-run-id' });
    emit({ type: 'link', label: 'Open fix', href: '#/fixes/fx-1' });
    emit({ type: 'link', label: 'Open the run', href: '#/run/01K5CQ4P2S0000000000000000', secondary: true });
    emit({ type: 'link', label: 'Somewhere else', href: 'javascript:alert(1)' });
    emit({ type: 'file', path: '.shadowlap/exports/dataset.jsonl', label: 'Dataset' });
    emit({ type: 'file', path: 'share/pack-1', label: 'Pack' });
    if (outside) emit({ type: 'file', path: outside, label: 'Outside' });
    emit({ type: 'result', data: { first: true } });
    emit({ type: 'result', data: { clean: true, calls: 30 } });
    console.log('done');
    break;
  }
  case 'text-only':
    process.stderr.write('[shadowlap] recording run 01K5CQ4P2V0000000000000000\n');
    console.log('recorded');
    break;
  case 'cat':
    process.stdout.write(readFileSync(args[1], 'utf8'));
    break;
  case 'sleep':
    setTimeout(() => console.log('woke'), Number(args[1] ?? 10_000));
    break;
  case 'stubborn': {
    // `shadowlap replay` with an agent that ignores SIGTERM: the CLI reports its run, passes a
    // SIGTERM on to the agent and waits for it, as runUnderSidecar does.
    if (args[1]) emit({ type: 'run', runId: args[1], role: 'new' });
    const agent = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('agent ignores SIGTERM')); setInterval(() => {}, 1000); console.log('agent ' + process.pid);"], { stdio: 'inherit' });
    process.on('SIGTERM', () => {
      console.log('passing SIGTERM on');
      agent.kill('SIGTERM');
    });
    agent.on('exit', (code, signal) => {
      console.log(`agent exited ${signal ?? code}`);
      process.exit(1);
    });
    break;
  }
  case 'pwd':
    console.log(`cwd ${process.cwd()}`);
    break;
  case 'lines':
    for (let i = 1; i <= Number(args[1] ?? 10); i++) console.log(`line ${i}`);
    break;
  case 'fail':
    console.error('it went wrong');
    process.exit(3);
    break;
  default:
    console.log(`args ${JSON.stringify(args)}`);
}
