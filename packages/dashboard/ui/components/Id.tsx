/**
 * A run's id, in mono, never broken (`code.rnm`): its about line on hover, a link where the place can
 * hold one. In a list of runs (the sidebar, Runs, the pickers, the fork tree, ⌘K's
 * runs: `list`), its first six characters, a ULID's leading time that runs made close together
 * share, are quieter, so the four that tell runs apart are what the eye finds. The quiet part is
 * drawn by the id's own ground (`.rl`), never by an element of its own: its text is the id as it
 * is, one text, nothing inserted, so it copies, searches and reads whole, a screen reader's too.
 * An id that names the page, or one in a sentence, stays whole in ink.
 */
export function Id({ id, list = false, href, about, className }: { id: string; list?: boolean; href?: string | undefined; about?: string | null | undefined; className?: string | undefined }) {
  const code = (
    <code className={`rnm${list && id.length > 6 ? ' rl' : ''}${className && !href ? ` ${className}` : ''}`} title={href ? undefined : (about ?? undefined)}>
      {id}
    </code>
  );
  return href ? (
    <a className={`more rlink${className ? ` ${className}` : ''}`} href={href} title={about ?? undefined}>
      {code}
    </a>
  ) : (
    code
  );
}

/** A title that names a run or a golden: its name in mono, whole, in ink. */
export function namedIn(title: string, name: string) {
  const at = title.indexOf(name);
  if (at < 0) return title;
  return (
    <>
      {title.slice(0, at)}
      <Id id={name} />
      {title.slice(at + name.length)}
    </>
  );
}
