import type { ThemeName } from './theme.js';

/**
 * Which palette suits the terminal the UI opens in. The background is the user's: lime text that
 * reads well on a dark one all but disappears on a light one. In order:
 *
 * 1. `SHADOWLAP_UI_THEME=dark|light|ansi`, for a terminal that answers wrongly or not at all.
 * 2. A terminal with fewer than 256 colours gets `ansi`: hex colours would be rounded to whatever is near.
 * 3. The background colour the terminal reports when asked (OSC 11), as Neovim and delta ask.
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
 * four hex digits a channel. Light when black text would stand out more on it than white: relative
 * luminance above 0.179, where the two contrasts are equal.
 */
export function themeFromOsc11(reply: string): 'dark' | 'light' | null {
  const m = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply) ?? /\]11;#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(reply);
  if (!m) return null;
  const channel = (hex: string) => {
    const c = parseInt(hex, 16) / (16 ** hex.length - 1);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(m[1]!) + 0.7152 * channel(m[2]!) + 0.0722 * channel(m[3]!);
  return luminance > 0.179 ? 'light' : 'dark';
}

/** A Primary Device Attributes answer, `ESC [ ? … c`, which every VT100-style terminal sends. */
const DA1 = /\x1b\[\?[\d;]*c/;

/**
 * Asks the terminal for its background colour, then for its device attributes. Terminals answer in
 * order, and every one answers the second, so its answer means the first won't come: nothing is
 * left to arrive later as stray keys. Resolves with what came back, or null without a TTY or an
 * answer in time. Keys typed in those few milliseconds are dropped.
 */
export function queryTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 1000): Promise<string | null> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let reply = '';
    const wasRaw = stdin.isRaw;
    const finish = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // A terminal that went away: there is nothing to restore.
      }
      stdin.pause();
      resolve(reply || null);
    };
    const onData = (chunk: Buffer | string) => {
      reply += chunk.toString();
      if (DA1.test(reply)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.write('\x1b]11;?\x1b\\\x1b[c');
    } catch {
      finish();
    }
  });
}

export async function detectTheme({ env = process.env, stdin = process.stdin, stdout = process.stdout, timeoutMs }: DetectOptions = {}): Promise<ThemeName> {
  const asked = themeFromEnv(env);
  if (asked) return asked;
  const depth = typeof stdout.getColorDepth === 'function' ? stdout.getColorDepth(env) : 8;
  if (depth < 8) return 'ansi';
  const reply = await queryTerminal(stdin, stdout, timeoutMs);
  return (reply ? themeFromOsc11(reply) : null) ?? themeFromColorFgBg(env.COLORFGBG) ?? 'ansi';
}
