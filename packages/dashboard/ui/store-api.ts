import type { SetupCiStep, SetupPolicy, SetupProvider, SetupRecord, SetupUrlCheck, StoreSetupView } from '../src/store-setup.js';
import type { Request } from './settings-api.js';

/**
 * The team store's setup in the API client (`client.storeSetup`): where the setup page's steps
 * stand, a URL checked against the provider picked, and the steps the CLI leaves no trace of (Push
 * from CI added or skipped, the setup finished). Connecting runs as a job (`store-set`), and so do
 * Push and Pull. Types only from the server's read model (`src/store-setup.ts`).
 */

export type { SetupCiStep, SetupPolicy, SetupProvider, SetupRecord, SetupUrlCheck, StoreSetupView };

export type CiName = SetupCiStep['ci'];

export interface StoreSetupApi {
  /** Where the setup stands, with each provider, the CI steps and the commit (`GET /api/store/setup`). */
  view(): Promise<StoreSetupView>;
  /** A URL typed in Connect your bucket, checked against the provider picked (`GET /api/store/setup/url`). */
  check(provider: string, url: string): Promise<SetupUrlCheck>;
  /** Records Push from CI as added or skipped, for which CI, or the setup finished (`POST /api/store/setup`). */
  save(step: { ci?: 'added' | 'skipped'; ciProvider?: CiName; finished?: true }): Promise<{ setup: SetupRecord }>;
}

export function storeSetupApi(request: Request): StoreSetupApi {
  const q = encodeURIComponent;
  return {
    view: () => request('store/setup'),
    check: (provider, url) => request(`store/setup/url?provider=${q(provider)}&url=${q(url)}`),
    save: (step) => request('store/setup', { method: 'POST', body: JSON.stringify(step) }),
  };
}

/** An exported copy, or a page without a server: there is no store to set up. */
export function noStoreSetup(refuse: () => Promise<never>): StoreSetupApi {
  return { view: refuse, check: refuse, save: refuse };
}
