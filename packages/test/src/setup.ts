/**
 * Vitest `setupFiles`: points this worker's model clients at the Shadowlap host started by
 * `@shadowlap/test/global-setup`, before any test file creates one, and loads in-process capture.
 */
import { HOST_ENV, useHost, workerSlot, type HostInfo } from './host.js';

const raw = process.env[HOST_ENV];
if (raw) await useHost(JSON.parse(raw) as HostInfo, workerSlot());
