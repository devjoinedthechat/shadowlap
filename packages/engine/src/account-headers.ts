/**
 * Response headers that name the account a call was made with: Anthropic's organization id. A
 * recording made now never keeps one (the sidecar's provider modules leave it out of what they store
 * and pass on); every copy of a run recorded before leaves it out too (credentialFreeHeaders), a
 * pack, a HAR file and a share link among them.
 */
export const ACCOUNT_HEADERS: readonly string[] = ['anthropic-organization-id'];
