import { randomBytes } from 'node:crypto';
import { keys } from './layout.js';
import type { ObjectStore, SignedLink } from './object-store.js';

/**
 * Share links: a redacted HTML report written to the bucket, behind a presigned link that expires
 * after 7 days. Anyone with the link can open it, without an account; nothing is hosted by
 * shadowlap. Each share is a new object, so an older link keeps working until it expires. The
 * link is signed before the report is written: credentials that can't sign one (a SAS token, a
 * Google user sign-in) leave nothing behind in the bucket.
 */

export const SHARE_DAYS = 7;

export interface Share {
  key: string;
  link: SignedLink;
  bytes: number;
}

export async function shareReport(remote: ObjectStore, runId: string, html: string, options: { expiresSeconds?: number } = {}): Promise<Share> {
  const key = keys.share(runId, randomBytes(6).toString('hex'));
  const body = Buffer.from(html, 'utf8');
  const link = await remote.presign(key, options.expiresSeconds ?? SHARE_DAYS * 86_400);
  await remote.put(key, body, { contentType: 'text/html; charset=utf-8' });
  return { key, link, bytes: body.length };
}
