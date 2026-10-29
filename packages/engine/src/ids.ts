import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32, lexically time-sortable. */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let t = '';
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD.charAt(time % 32) + t;
    time = Math.floor(time / 32);
  }
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD.charAt(rnd[i]! & 31);
  return t + r;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
