/**
 * The words of the row that stands for the failed runs nobody has blamed, which Fixes and Needs a
 * look show alike (and any list that adds such a row): its title, and its Run blame's card. One
 * place, so they can't drift. No imports: the browser reads it as it is.
 */

/** Its title: `3 failing runs nobody has blamed`. */
export const unblamedTitle = (count: number): string => `${count.toLocaleString('en-US')} failing run${count === 1 ? '' : 's'} nobody has blamed`;

/**
 * Its Run blame's card: the run it blames, by the short id the row names it by (`id`), the newest
 * where the row stands for several, and what blame does.
 */
export const unblamedBlameCard = (count: number, id: string): string => `Blames ${count > 1 ? 'the newest, ' : ''}${id}: finds the model call that lost it, then joins the fix its failure belongs to`;
