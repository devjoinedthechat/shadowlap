// The README's terminal UI recording as one SVG, from the screens `shadowlap ui` draws, which
// readme-shots.mjs takes: each screen in turn, as the key before it left it, then the first again.
// It is drawn as demo-svg.mjs draws the terminal: rows of text on the dashboard's ink, one column
// per character, in the same frame. A screen is the text the UI wrote, escape codes and all. Its
// colours are the ones it asked for, its box lines are drawn as lines, so they meet whatever font
// shows the text, and nothing in it is changed. GitHub shows a repository's SVG as an image, so it
// moves by CSS alone; where motion is unwanted it holds one screen still.

const FONT = 13;
const CW = FONT * 0.6;
const LH = 20;
const PX = 26;
const PY = 22;
/** The terminal's own colours: its background, its frame's edge, and the text no code colours. */
const C = { bg: '#0e0f0b', edge: '#25261d', fg: '#eeede6' };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (r, g, b) => `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

/**
 * Which ways a box character's lines leave the middle of its cell: l, r, u, d. The four round
 * corners turn through a curve.
 */
const BOX = { '─': 'lr', '│': 'ud', '╭': 'rd', '╮': 'ld', '╰': 'ru', '╯': 'lu', '┌': 'rd', '┐': 'ld', '└': 'ru', '┘': 'lu', '├': 'udr', '┤': 'udl', '┬': 'lrd', '┴': 'lru', '┼': 'lrud' };
const ROUND = '╭╮╰╯';

/**
 * A screen's line as cells, one a column: each character with the colour, ground and weight its
 * escape codes gave it. `style` is the style the line before left, and is left as this one leaves
 * it. The UI colours by 24-bit codes, bold, and the codes that end them; any other escape stops
 * the drawing, so a change in what the UI writes is looked at before it is drawn.
 * @param {string} line
 * @param {{ fg: string | null, bg: string | null, bold: boolean }} style
 */
export function lineCells(line, style) {
  const cells = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '\x1b') {
      const ch = String.fromCodePoint(line.codePointAt(i));
      i += ch.length - 1;
      cells.push({ ch, fg: style.fg, bg: style.bg, bold: style.bold });
      continue;
    }
    const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i, i + 32));
    if (!m) throw new Error(`tui-svg: an escape the picture has no rule for: ${JSON.stringify(line.slice(i, i + 12))}`);
    const codes = (m[1] || '0').split(';').map(Number);
    for (let k = 0; k < codes.length; k++) {
      const code = codes[k];
      if (code === 0) Object.assign(style, { fg: null, bg: null, bold: false });
      else if (code === 1) style.bold = true;
      else if (code === 22) style.bold = false;
      else if (code === 39) style.fg = null;
      else if (code === 49) style.bg = null;
      else if ((code === 38 || code === 48) && codes[k + 1] === 2 && codes.length >= k + 5) {
        style[code === 38 ? 'fg' : 'bg'] = hex(codes[k + 2], codes[k + 3], codes[k + 4]);
        k += 4;
      } else throw new Error(`tui-svg: a style code the picture has no rule for: ${String(m[1])}`);
    }
    i += m[0].length - 1;
  }
  return cells;
}

/** A screen as rows of cells, the style carried from line to line as a terminal carries it. */
function screenRows(screen, rows) {
  const style = { fg: null, bg: null, bold: false };
  const lines = screen.replace(/\n$/, '').split('\n');
  if (lines.length > rows) throw new Error(`tui-svg: a screen of ${lines.length} lines in a terminal of ${rows}`);
  return Array.from({ length: rows }, (_, r) => lineCells(lines[r] ?? '', style));
}

const x = (col) => (PX + col * CW).toFixed(1);

/** One row drawn at its place: the grounds under it, then its text, each word at its exact column. Its box lines are the screen's (`boxLines`). */
function drawRow(cells, r, columns) {
  if (cells.length > columns) throw new Error(`tui-svg: a line of ${cells.length} columns in a terminal of ${columns}: ${cells.map((c) => c.ch).join('')}`);
  const top = PY + r * LH;
  const out = [];
  // Grounds: a run of cells on the same ground is one box.
  for (let c = 0; c < cells.length; c++) {
    const { bg } = cells[c];
    if (!bg) continue;
    let end = c;
    while (end + 1 < cells.length && cells[end + 1].bg === bg) end++;
    out.push(`<rect x="${x(c)}" y="${top}" width="${((end - c + 1) * CW).toFixed(1)}" height="${LH}" fill="${bg}"/>`);
    c = end;
  }
  // Text: each word of ASCII in a tspan at its column, any other character in one of its own, spaces and box lines skipped.
  let text = '';
  for (let c = 0; c < cells.length; ) {
    const cell = cells[c];
    if (cell.ch === ' ' || BOX[cell.ch]) {
      c++;
      continue;
    }
    let word = cell.ch;
    let end = c + 1;
    const ascii = (ch) => ch > ' ' && ch <= '~';
    if (ascii(cell.ch)) {
      while (end < cells.length && ascii(cells[end].ch) && cells[end].fg === cell.fg && cells[end].bold === cell.bold) word += cells[end++].ch;
    }
    text += `<tspan x="${x(c)}"${cell.fg ? ` fill="${cell.fg}"` : ''}${cell.bold ? ' font-weight="700"' : ''}>${esc(word)}</tspan>`;
    c = end;
  }
  if (text) out.push(`<text y="${(top + 14.5).toFixed(1)}">${text}</text>`);
  return out.join('');
}

/**
 * A screen's box lines, a path a colour: across the middle of a row and down the middle of a
 * column, each run of cells one line from end to end, so a pane's side is one stroke however many
 * rows it passes and no seam shows where two would meet. A round corner turns through a curve that
 * starts a pixel inside each of the lines it joins.
 */
function boxLines(screen) {
  const R = 3.5;
  /** By colour: the pieces across, by their row's middle; the pieces down, by their column's; and the corners' curves. */
  const colours = new Map();
  const of = (colour) => colours.get(colour) ?? colours.set(colour, { across: new Map(), down: new Map(), curves: [] }).get(colour);
  const piece = (pieces, at, from, to) => (pieces.get(at) ?? pieces.set(at, []).get(at)).push([from, to]);
  const f = (n) => n.toFixed(1);
  screen.forEach((cells, r) => {
    const top = PY + r * LH;
    const cy = top + LH / 2;
    cells.forEach((cell, c) => {
      const ways = BOX[cell.ch];
      if (!ways) return;
      const { across, down, curves } = of(cell.fg ?? C.fg);
      const [x0, cx, x1] = [PX + c * CW, PX + (c + 0.5) * CW, PX + (c + 1) * CW];
      if (ROUND.includes(cell.ch)) {
        const sx = ways.includes('r') ? 1 : -1;
        const sy = ways.includes('d') ? 1 : -1;
        piece(across, cy, sx > 0 ? cx + R : x0, sx > 0 ? x1 : cx - R);
        piece(down, cx, sy > 0 ? cy + R : top, sy > 0 ? top + LH : cy - R);
        curves.push(`M${f(cx)} ${f(cy + sy * (R + 1))}V${f(cy + sy * R)}Q${f(cx)} ${f(cy)} ${f(cx + sx * R)} ${f(cy)}H${f(cx + sx * (R + 1))}`);
        return;
      }
      if (ways.includes('l') || ways.includes('r')) piece(across, cy, ways.includes('l') ? x0 : cx, ways.includes('r') ? x1 : cx);
      if (ways.includes('u') || ways.includes('d')) piece(down, cx, ways.includes('u') ? top : cy, ways.includes('d') ? top + LH : cy);
    });
  });
  /** Pieces on one line, joined where one starts as the last ends. */
  const joined = (pieces) => {
    const runs = [];
    for (const [from, to] of [...pieces].sort((a, b) => a[0] - b[0])) {
      if (runs.length && from <= runs.at(-1)[1] + 0.05) runs.at(-1)[1] = Math.max(runs.at(-1)[1], to);
      else runs.push([from, to]);
    }
    return runs;
  };
  const out = [];
  for (const [colour, { across, down, curves }] of colours) {
    const d = [];
    for (const [cy, pieces] of across) for (const [from, to] of joined(pieces)) d.push(`M${f(from)} ${f(cy)}H${f(to)}`);
    for (const [cx, pieces] of [...down].sort((a, b) => a[0] - b[0])) for (const [from, to] of joined(pieces)) d.push(`M${f(cx)} ${f(from)}V${f(to)}`);
    out.push(`<path class="x" stroke="${colour}" d="${d.join('')}${curves.join('')}"/>`);
  }
  return out.join('');
}

/**
 * `scenes`: each `{ screen, hold }` in the order shown: `screen` what the UI wrote for it, its lines
 * apart by newlines; `hold` how long it shows, in seconds. The first comes back after the last.
 * `still` is the scene shown where motion is unwanted, and the one drawn when `animated` is false.
 * A row that two scenes share is drawn once, and shows through both; so are a screen's box lines.
 * @param {{ columns: number, rows: number, scenes: Array<{ screen: string, hold: number }>, still: number, animated?: boolean, title: string, desc: string }} o
 * @returns {string}
 */
export function tuiSvg({ columns, rows, scenes, still, animated = true, title, desc }) {
  if (!scenes.length) throw new Error('tui-svg: a recording has a scene or more');
  if (!scenes[still]) throw new Error(`tui-svg: no scene ${still} to hold still`);
  const W = Math.round(PX * 2 + columns * CW);
  const H = Math.round(PY * 2 + rows * LH);
  const shown = animated ? scenes : [scenes[still]];
  const stillAt = animated ? still : 0;
  const at = [];
  let t = 0;
  for (const s of shown) {
    at.push(t);
    t += s.hold;
  }
  const T = t;
  const pct = (s) => `${((Math.min(Math.max(s, 0), T) / T) * 100).toFixed(3)}%`;
  const css = [];
  /** The animation that shows something through the scenes `on` names, and through no other; one for each set of scenes. */
  const shows = new Map();
  const showing = (on) => {
    const key = on.map((v) => (v ? 1 : 0)).join('');
    if (!shows.has(key)) {
      const k = `k${shows.size}`;
      const frames = [`0%{opacity:${on[0] ? 1 : 0};animation-timing-function:step-end}`];
      for (let i = 1; i < on.length; i++) if (on[i] !== on[i - 1]) frames.push(`${pct(at[i])}{opacity:${on[i] ? 1 : 0};animation-timing-function:step-end}`);
      frames.push(`100%{opacity:${on.at(-1) ? 1 : 0}}`);
      css.push(`.${k}{animation:${k} ${T.toFixed(2)}s infinite}@keyframes ${k}{${frames.join('')}}`);
      shows.set(key, k);
    }
    return shows.get(key);
  };

  // Each row of each scene, drawn once for all the scenes that show it as it is; then each screen's box lines, the same way.
  const screens = shown.map((s) => screenRows(s.screen, rows));
  const body = [];
  const once = (parts) => {
    const drawn = new Map();
    parts.forEach((part, i) => {
      if (part) (drawn.get(part) ?? drawn.set(part, []).get(part)).push(i);
    });
    for (const [part, inScenes] of drawn) {
      const classes = ['s', ...(inScenes.includes(stillAt) ? ['still'] : []), ...(animated ? [showing(shown.map((_, i) => inScenes.includes(i)))] : [])];
      body.push(`<g class="${classes.join(' ')}">${part}</g>`);
    }
  };
  for (let r = 0; r < rows; r++) once(screens.map((screen) => drawRow(screen[r], r, columns)));
  once(screens.map(boxLines));

  const style = [
    `text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace;font-size:${FONT}px;fill:${C.fg};white-space:pre}`,
    '.x{fill:none;stroke-width:1}',
    ...(animated
      ? [
          // Without its animation a row shows only where the still scene has it: what a reader who wants no motion sees.
          '.s{opacity:0}.s.still{opacity:1}',
          ...css,
          '@media (prefers-reduced-motion:reduce){.s{animation:none!important}}',
        ]
      : []),
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<style>
${style}
</style>
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="11.5" fill="none" stroke="${C.edge}"/>
${body.join('\n')}
</svg>
`;
}
