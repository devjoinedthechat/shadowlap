/**
 * Whether a host is this machine: `localhost`, the IPv4 loopback range 127.0.0.0/8, or `::1`
 * (also as an IPv4-mapped address). Takes a URL's hostname, brackets and all.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return host.split('.').every((n) => Number(n) <= 255);
  // ::ffff:127.0.0.1, which URL writes as ::ffff:7f00:1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  return !!mapped && parseInt(mapped[1]!, 16) >> 8 === 127;
}
