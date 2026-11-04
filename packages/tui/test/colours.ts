import { readFileSync } from 'node:fs';

/**
 * The dashboard's colour tokens, read from its own file (packages/dashboard/ui/css/tokens.css) so
 * the terminal's palette can't drift from them: each resolved to `#rrggbb` as the browser computes
 * it, through the var()s that alias it and the color-mix()es that make it, in sRGB. A mix with
 * `transparent` is worked out over the page (--bg), where the dashboard draws it.
 */
const TOKENS = new URL('../../dashboard/ui/css/tokens.css', import.meta.url);

const declared = new Map<string, string>();
for (const block of readFileSync(TOKENS, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const decl of block[1].split(';')) {
    const at = decl.indexOf(':');
    const name = decl.slice(0, at).trim();
    if (at > 0 && name.startsWith('--')) declared.set(name, decl.slice(at + 1).trim());
  }
}

type Rgb = [number, number, number];

const hex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const channels = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

function resolve(value: string, depth = 0): Rgb {
  if (depth > 10) throw new Error(`a var() loop at ${value}`);
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return channels(v);
  if (v === 'transparent') return resolve('var(--bg)', depth + 1);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    const t = declared.get(ref[1]);
    if (t === undefined) throw new Error(`tokens.css defines no ${ref[1]}`);
    return resolve(t, depth + 1);
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const [a, b, p] = [resolve(mix[1], depth + 1), resolve(mix[3], depth + 1), Number(mix[2]) / 100];
    return a.map((c, i) => Math.round(c * p + b[i] * (1 - p))) as Rgb;
  }
  throw new Error(`not a colour tokens.css's test reads: ${value}`);
}

/** A token of the dashboard's, as `#rrggbb`. */
export function token(name: string): string {
  return hex(resolve(`var(${name})`));
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (h: string) => {
  const [r, g, b] = channels(h).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG's contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The SGR codes chalk writes for the sixteen colours a palette names, as text and as a ground. */
const NAMED: Record<string, [fg: string, bg: string]> = {
  black: ['30', '40'],
  red: ['31', '41'],
  green: ['32', '42'],
  yellow: ['33', '43'],
  blue: ['34', '44'],
  magenta: ['35', '45'],
  cyan: ['36', '46'],
  white: ['37', '47'],
  gray: ['90', '100'],
  redBright: ['91', '101'],
  greenBright: ['92', '102'],
  yellowBright: ['93', '103'],
  blueBright: ['94', '104'],
  magentaBright: ['95', '105'],
  cyanBright: ['96', '106'],
  whiteBright: ['97', '107'],
};

/** A colour as the frame's SGR codes name it: `r;g;b` for one in hex, the code for one of the sixteen. */
function sgrOf(colour: string, ground: boolean): string {
  if (colour.startsWith('#')) return channels(colour).join(';');
  const named = NAMED[colour];
  if (!named) throw new Error(`not a colour chalk names: ${colour}`);
  return named[ground ? 1 : 0];
}

/**
 * The text a frame draws in `colour` (as text, or as the ground behind it, or either), each run of
 * it trimmed, in order. Reads the frame's SGR codes as a terminal does: a colour holds until its own
 * reset (39, 49) or a reset of everything.
 */
export function painted(frame: string, colour: string, as: 'text' | 'ground' | 'either' = 'either'): string[] {
  const fgWanted = as === 'ground' ? null : sgrOf(colour, false);
  const bgWanted = as === 'text' ? null : sgrOf(colour, true);
  const runs: string[] = [];
  let fg = '';
  let bg = '';
  let run = '';
  const end = () => {
    if (run.trim()) runs.push(run.trim());
    run = '';
  };
  for (const part of frame.split(/(\x1b\[[0-9;]*m)/)) {
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!sgr) {
      if (fg === fgWanted || bg === bgWanted) run += part;
      else end();
      continue;
    }
    const codes = sgr[1].split(';');
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if ((c === '38' || c === '48') && codes[i + 1] === '2') {
        const rgb = codes.slice(i + 2, i + 5).join(';');
        if (c === '38') fg = rgb;
        else bg = rgb;
        i += 4;
      } else if (c === '39') fg = '';
      else if (c === '49') bg = '';
      else if (c === '0' || c === '') fg = bg = '';
      else if (/^(3[0-7]|9[0-7])$/.test(c)) fg = c;
      else if (/^(4[0-7]|10[0-7])$/.test(c)) bg = c;
    }
    if (fg !== fgWanted && bg !== bgWanted) end();
  }
  end();
  return runs;
}
