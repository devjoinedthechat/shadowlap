/**
 * Who did something, in the activity feed, the By column and a run's page: an email by its name
 * part, CI as `ci`. A module of its own, so a page that names a person loads nothing else for it.
 */
export function personName(author: string | null | undefined): string {
  if (!author) return 'unknown';
  const at = author.indexOf('@');
  return at > 0 ? author.slice(0, at) : author;
}
