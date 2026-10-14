/** Display labels. No Node imports: the dashboard's browser bundle uses this too. */

/**
 * A model call's endpoint without the method and API version, which every row would repeat:
 * `POST /v1/chat/completions` reads `chat/completions`, a Gemini `…/models/x:streamGenerateContent`
 * reads `streamGenerateContent` (the model has its own column). Tool names are left alone.
 */
export function shortCallName(kind: string, name: string): string {
  if (kind !== 'api') return name;
  const path = name.replace(/^[A-Z]+\s+/, '').replace(/^\//, '').replace(/^v\d+(beta\d*|alpha\d*)?\//, '');
  const action = /models\/[^/:]+:(\w+)$/.exec(path);
  return action ? action[1]! : path;
}
