// The README's dashboard walkthrough as one SVG, from pictures of the real dashboard that
// readme-shots.mjs takes: each page in turn, a pointer that moves to what is pressed on it and
// presses it, and the next page in its place; then the first page again. GitHub shows a
// repository's SVG as an image, so the pictures go inside it, as WebP, and it moves by CSS alone.
// Where motion is unwanted it holds one page still, with no pointer.

/** How long a page takes to come in over the one before it, in seconds. */
const FADE = 0.2;
/** How long the pointer takes to reach what it presses. */
const MOVE = 1.1;
/** How long it rests on what it presses before it presses, and from the press to the next page. */
const SETTLE = 0.35;
const PRESSED = 0.15;
/** How long a press's ring grows and fades. */
const RING = 0.5;
/** How long after the last page has come in the pointer moves to where it rests. */
const LAST_MOVE = 0.8;

/** The frame round the pages, as the README's other pictures have it. */
const EDGE = '#25261d';

/** An arrow pointer, its tip at 0,0, about the size a 1280 px window draws one. */
const POINTER = 'M0 0V17.6L4.6 13.4L7.6 20.4L10.5 19.2L7.6 12.4H13.6Z';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ image: string, hold: number, press?: Point, rest?: Point }} Page
 */

/**
 * `pages`: each `{ image, hold, press }` in the order shown: `image` a WebP's bytes, base64; `hold`
 * how long it shows, in seconds, its coming in included; `press` where the pointer presses at the end
 * of its hold, in the window's px. The last page has `rest` instead, where the pointer stops, and
 * the first page comes back over it. `start` is where the pointer starts, on the first page.
 * `still` is the page shown where motion is unwanted.
 * @param {{ width: number, height: number, radius: number, pages: Page[], start: Point, still: number, title: string, desc: string }} o
 * @returns {string}
 */
export function walkthroughSvg({ width, height, pages, start, still, title, desc, radius }) {
  if (pages.length < 2) throw new Error('walkthrough-svg: a walkthrough has two pages or more');
  if (pages.slice(0, -1).some((p) => !p.press) || !pages.at(-1).rest) throw new Error('walkthrough-svg: each page but the last presses, and the last rests');
  const at = [];
  let t = 0;
  for (const p of pages) {
    at.push(t);
    t += p.hold;
  }
  const T = t;
  const pct = (s) => `${((Math.min(Math.max(s, 0), T) / T) * 100).toFixed(3)}%`;
  const css = [];
  let n = 0;
  const keyframes = (frames) => {
    const k = `k${n++}`;
    css.push(`.${k}{animation:${k} ${T.toFixed(2)}s infinite}@keyframes ${k}{${frames}}`);
    return k;
  };

  // The first page is always under the rest. Each later one comes in over the page before it, and
  // goes as soon as the next one has come in over it, so only two are ever seen together; the last
  // fades over the first as the walkthrough starts again.
  const body = pages.map((p, i) => {
    const image = `<image width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/webp;base64,${p.image}"/>`;
    const tag = i === still ? ' still' : '';
    if (i === 0) return `<g class="f${tag}">${image}</g>`;
    const goes = i < pages.length - 1 ? `${pct(at[i + 1] + FADE)}{opacity:1;animation-timing-function:step-end}${pct(at[i + 1] + FADE + 0.01)}{opacity:0}` : `${pct(T - FADE)}{opacity:1}`;
    const k = keyframes(`0%{opacity:0;animation-timing-function:step-end}${pct(at[i])}{opacity:0}${pct(at[i] + FADE)}{opacity:1}${goes}100%{opacity:0}`);
    return `<g class="f ${k}${tag}">${image}</g>`;
  });

  // The pointer: at each page's end it moves to what it presses, rests, and presses, a ring growing
  // from the press; on the last page it moves to where it rests. It leaves as the first page comes
  // back, and comes in again where it started.
  const ease = 'animation-timing-function:cubic-bezier(.45,.05,.25,1)';
  const stay = 'animation-timing-function:linear';
  const to = ({ x, y }) => `transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
  const steps = [`0%{${to(start)};${stay}}`];
  const rings = [];
  let from = start;
  pages.forEach((p, i) => {
    const end = at[i] + p.hold;
    if (p.press) {
      const pressAt = end - PRESSED;
      const arrive = pressAt - SETTLE;
      steps.push(`${pct(arrive - MOVE)}{${to(from)};${ease}}`, `${pct(arrive)}{${to(p.press)};${stay}}`);
      const ring = keyframes(`0%{opacity:0;transform:scale(.4);animation-timing-function:step-end}${pct(pressAt)}{opacity:.85;transform:scale(.4);animation-timing-function:ease-out}${pct(pressAt + RING)}{opacity:0;transform:scale(1.7)}100%{opacity:0;transform:scale(1.7)}`);
      rings.push(`<circle class="r ${ring}" cx="${p.press.x.toFixed(1)}" cy="${p.press.y.toFixed(1)}" r="14" fill="none" stroke="#c4f233" stroke-width="2.5"/>`);
      from = p.press;
    } else {
      steps.push(`${pct(at[i] + LAST_MOVE)}{${to(from)};${ease}}`, `${pct(at[i] + LAST_MOVE + MOVE)}{${to(p.rest)};${stay}}`);
      from = p.rest;
    }
  });
  steps.push(`100%{${to(from)}}`);
  const moves = keyframes(steps.join(''));
  const shows = keyframes(`0%{opacity:0}${pct(0.3)}{opacity:1}${pct(T - FADE)}{opacity:1}100%{opacity:0}`);
  const pointer = `<g class="p ${shows}"><g class="${moves}"><path d="${POINTER}" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></g></g>`;

  const style = [
    '.r{transform-box:fill-box;transform-origin:center}',
    ...css,
    '@media (prefers-reduced-motion:reduce){.f{animation:none!important;opacity:0!important}.f.still{opacity:1!important}.p,.r{display:none}}',
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<style>
${style}
</style>
<clipPath id="frame"><rect width="${width}" height="${height}" rx="${radius}"/></clipPath>
<g clip-path="url(#frame)">
${body.join('\n')}
${rings.join('\n')}
${pointer}
</g>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius - 0.5}" fill="none" stroke="${EDGE}"/>
</svg>
`;
}
