import type { ThemeName } from './theme.js';

/**
 * Which palette suits the terminal the UI opens in. The background is the user's: lime text that
 * reads well on a dark one all but disappears on a light one. In order:
 *
 * 1. `SHADOWLAP_UI_THEME=dark|light|ansi`, for a terminal that answers wrongly or not at all.
 * 2. A terminal with fewer than 256 colours gets `ansi`: hex colours would be rounded to whatever is near.
 * 3. The background colour the terminal reports when asked (OSC 11), as Neovim and delta ask. It is
 *    kept too: the ground of where you are is mixed from it, so it shows on any background.
 * 4. `COLORFGBG`, which rxvt, Konsole and iTerm2 set when they start.
 * 5. Otherwise `ansi`, the terminal's own colours, which suit whatever background it has.
 */
export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** How long to wait for the terminal's answer; it comes back in a round trip, over SSH too. */
  timeoutMs?: number;
}

const NAMES = new Set<ThemeName>(['dark', 'light', 'ansi']);

export function themeFromEnv(env: NodeJS.ProcessEnv): ThemeName | null {
  const v = env.SHADOWLAP_UI_THEME?.trim().toLowerCase();
  return v && NAMES.has(v as ThemeName) ? (v as ThemeName) : null;
}

/** `COLORFGBG` is `fg;bg` (or `fg;default;bg`) in the sixteen-colour numbering: 7 and 15 are light, 0–6 and 8 dark. */
export function themeFromColorFgBg(value: string | undefined): 'dark' | 'light' | null {
  const bg = value?.split(';').at(-1)?.trim();
  if (!bg || !/^\d+$/.test(bg)) return null;
  const n = Number(bg);
  if (n === 7 || (n >= 9 && n <= 15)) return 'light';
  if (n <= 8) return 'dark';
  return null;
}

/**
 * A terminal's answer to OSC 11, `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by BEL or ESC \, with one to
 * four hex digits a channel: its background's channels, from 0 to 1.
 */
function osc11Channels(reply: string): [number, number, number] | null {
  const m = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply) ?? /\]11;#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(reply);
  if (!m) return null;
  const channel = (hex: string) => parseInt(hex, 16) / (16 ** hex.length - 1);
  return [channel(m[1]!), channel(m[2]!), channel(m[3]!)];
}

/**
 * Light when black text would stand out more on the background the terminal reports than white:
 * relative luminance above 0.179, where the two contrasts are equal.
 */
export function themeFromOsc11(reply: string): 'dark' | 'light' | null {
  const rgb = osc11Channels(reply);
  if (!rgb) return null;
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  return luminance > 0.179 ? 'light' : 'dark';
}

/** The background the terminal reports, as `#rrggbb`: what the selection ground is mixed from (`themeFor`). */
export function backgroundFromOsc11(reply: string): string | null {
  const rgb = osc11Channels(reply);
  return rgb ? `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}` : null;
}

/** A Primary Device Attributes answer, `ESC [ ? … c`, which every VT100-style terminal sends. */
const DA1 = /\x1b\[\?[\d;]*c/;

/** How long to wait for the answer: a round trip, which over SSH can take longer than on this machine. */
export function queryTimeout(env: NodeJS.ProcessEnv): number {
  return env.SSH_CONNECTION || env.SSH_TTY ? 3000 : 1000;
}

/**
 * Asks the terminal for its background colour, then for its device attributes. Terminals answer in
 * order, and every one answers the second, so its answer means the first won't come: nothing is
 * left to arrive later as stray keys. Resolves with what came back, or null without a TTY or an
 * answer in time. Keys typed in those few milliseconds are dropped, except Ctrl-C, which still stops
 * the program. With no answer in time the terminal stays in raw mode, as the UI wants it next, so an
 * answer that comes later is never echoed on the screen.
 */
export function queryTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 1000): Promise<string | null> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let reply = '';
    const wasRaw = stdin.isRaw;
    const finish = (answered: boolean) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        if (answered) stdin.setRawMode(wasRaw);
      } catch {
        // A terminal that went away: there is nothing to restore.
      }
      stdin.pause();
      resolve(reply || null);
    };
    const onData = (chunk: Buffer | string) => {
      reply += chunk.toString();
      if (reply.includes('\x03')) {
        finish(true);
        process.kill(process.pid, 'SIGINT');
      } else if (DA1.test(reply)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.write('\x1b]11;?\x1b\\\x1b[c');
    } catch {
      finish(true);
    }
  });
}

/** The palette for the terminal, and the background it reported when it was asked and answered. */
export interface TerminalColours {
  theme: ThemeName;
  background: string | null;
}

export async function detectTerminal({ env = process.env, stdin = process.stdin, stdout = process.stdout, timeoutMs }: DetectOptions = {}): Promise<TerminalColours> {
  const asked = themeFromEnv(env);
  if (asked) return { theme: asked, background: null };
  const depth = typeof stdout.getColorDepth === 'function' ? stdout.getColorDepth(env) : 8;
  if (depth < 8) return { theme: 'ansi', background: null };
  const reply = await queryTerminal(stdin, stdout, timeoutMs ?? queryTimeout(env));
  const theme = reply ? themeFromOsc11(reply) : null;
  if (theme) return { theme, background: backgroundFromOsc11(reply!) };
  return { theme: themeFromColorFgBg(env.COLORFGBG) ?? 'ansi', background: null };
}

export async function detectTheme(options: DetectOptions = {}): Promise<ThemeName> {
  return (await detectTerminal(options)).theme;
}
