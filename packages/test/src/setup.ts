/**
 * Vitest `setupFiles`: makes this worker ready for recorded tests on the shadowlap host started by
 * `@shadowlap/test/global-setup`, and loads in-process capture before any test file creates a model
 * client. Its clients and the SDK point at the host only while a recorded test runs.
 */
import { HOST_ENV, useHost, workerSlot, type HostInfo } from './host.js';

const raw = process.env[HOST_ENV];
if (raw) await useHost(JSON.parse(raw) as HostInfo, workerSlot());
