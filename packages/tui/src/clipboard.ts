import { spawn } from 'node:child_process';

/** Copies text with the platform's clipboard command. Resolves false when none works; never throws. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
      child.stdin.on('error', () => resolve(false));
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}
