/**
 * What an injection test starts from where nobody picked: pure, with no node module, so the pages
 * import it as the server does. A run of more than MANY_READS untrusted reads starts from FEW_TEMPLATES
 * (its cost grows with each read), and the results matrix groups its rows past that many reads.
 */

/** Reads past which a test starts from a few templates, and a matrix groups its rows. */
export const MANY_READS = 8;

/** The templates a test of many reads starts from: a planted system notice and an urgent user's request. */
export const FEW_TEMPLATES: readonly string[] = Object.freeze(['system-notice', 'user-urgent']);

/** The templates a test of `reads` planted reads starts from: every one (null), or the few. */
export const defaultTemplates = (reads: number): readonly string[] | null => (reads > MANY_READS ? FEW_TEMPLATES : null);
