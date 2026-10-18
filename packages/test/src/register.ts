/**
 * `node --import @shadowlap/test/register --test`: for node:test and plain scripts. Starts a Shadowlap
 * host for this process and makes it ready for recorded tests, whose model clients and SDK calls
 * reach the host while each runs.
 */
import { HOST_ENV, startHost, useHost } from './host.js';

if (!(process.env.SHADOWLAP_URL && !process.env[HOST_ENV])) {
  const host = await startHost(process.cwd());
  await useHost(host.info, 'main');
}
