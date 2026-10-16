/**
 * The shape of a rule's regex, read without running it: what the Redaction tab's preview names when
 * a rule took too long, and what the Add dialog warns about before the rule is added. Nothing here
 * needs Node, so the page uses it as it is.
 */

/**
 * Whether a regex (`/…/flags`) repeats a group that itself holds an unbounded repeat, as (a+)+,
 * (\w*\s?)* or (x+y?){2,}: the shape that can backtrack for minutes on a value it almost matches.
 * Named patterns are fine.
 */
export function repeatsARepeat(pattern: string): boolean {
  if (!pattern.startsWith('/')) return false;
  const src = pattern.replace(/^\/|\/[a-z]*$/g, '');
  const groups: boolean[] = [];
  let inClass = false;
  const unbounded = (at: number) => src[at] === '+' || src[at] === '*' || /^\{\d*,\}/.test(src.slice(at));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') groups.push(false);
    else if (c === ')') {
      const inner = groups.pop() ?? false;
      const repeated = unbounded(i + 1) || /^\{\d+,\d{2,}\}/.test(src.slice(i + 1));
      if (inner && repeated) return true;
      if (groups.length && (inner || repeated)) groups[groups.length - 1] = true;
    } else if (groups.length && unbounded(i)) groups[groups.length - 1] = true;
  }
  return false;
}
