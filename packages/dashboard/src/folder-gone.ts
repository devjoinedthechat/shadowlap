/**
 * What Settings says when a project's folder is gone from disk, and why an edit to its
 * shadowlap.config.json is refused: the dashboard has nothing to write into until the folder is
 * back, or the project is removed. The page and the server say it in the same words.
 */
export function folderGoneText(name: string): string {
  return `${name}’s folder is gone: put it back or remove the project`;
}
