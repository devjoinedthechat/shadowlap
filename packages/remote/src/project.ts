import type { StoreOf } from '@shadowlap/engine';
import { awsCredentialsHere } from './aws-credentials.js';
import { azureCredentialsHere, parseConnectionString } from './azure-auth.js';
import { googleCredentialsHere } from './gcp-auth.js';
import { credentialsMayGoTo } from './open.js';
import type { Provider, StoreLocation } from './url.js';

/**
 * What this machine knows about a project's store without asking it: whose credentials it would use,
 * found offline, and the last `shadowlap store check`. Nothing here leaves the machine.
 */

/** Where each provider's credentials come from on a machine, in words. */
export const CREDENTIAL_HINTS: Record<Provider, { uses: string; from: string }> = {
  s3: { uses: 'your AWS credentials', from: 'AWS_PROFILE or the default profile in ~/.aws (aws configure or aws sso login), access keys in the environment, or an IAM role' },
  gcs: { uses: 'gcloud application default credentials', from: 'gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS' },
  azure: { uses: 'your Azure CLI sign-in', from: 'az login, AZURE_STORAGE_KEY or AZURE_STORAGE_CONNECTION_STRING, or a service principal' },
  r2: { uses: 'an R2 API token', from: 'R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY' },
};

/**
 * What this machine would sign in with for a provider (for the store, when it is that provider's),
 * found offline, as each cloud's tools look: the environment and their files, read here and sent
 * nowhere. Null when nothing here names any credentials: an instance role or a metadata server only
 * shows when asked, which `shadowlap store check` does.
 */
export function credentialsHere(provider: Provider, loc: StoreLocation | null, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): { uses: string; from: string } | null {
  const env = options.env ?? process.env;
  const own = loc && loc.provider === provider ? loc : null;
  const e = { env, ...(options.home ? { home: options.home } : {}) };
  const profile = own?.profile ? { profile: own.profile } : {};
  switch (provider) {
    case 's3':
      return awsCredentialsHere(e, { ...profile, allowInstance: !own?.endpoint, allowSts: !own?.endpoint });
    case 'r2':
      if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) return { uses: 'an R2 API token', from: 'from R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY' };
      return awsCredentialsHere(e, { ...profile, allowInstance: false, allowSts: false });
    case 'gcs':
      if (own?.auth === 'hmac') return env.GCS_HMAC_ACCESS_KEY_ID && env.GCS_HMAC_SECRET_ACCESS_KEY ? { uses: 'HMAC keys', from: 'from GCS_HMAC_ACCESS_KEY_ID and GCS_HMAC_SECRET_ACCESS_KEY' } : null;
      if (own?.endpoint && !credentialsMayGoTo(own.endpoint, 'gcs')) return null;
      if (own && !own.endpoint && env.STORAGE_EMULATOR_HOST) return { uses: 'no credentials', from: 'STORAGE_EMULATOR_HOST names an emulator' };
      return googleCredentialsHere(e);
    case 'azure': {
      if (own?.endpoint && !credentialsMayGoTo(own.endpoint, 'azure')) return null;
      const account = own?.account ?? env.AZURE_STORAGE_ACCOUNT ?? parseConnectionString(env.AZURE_STORAGE_CONNECTION_STRING ?? '').get('accountname') ?? '';
      return azureCredentialsHere(e, account);
    }
  }
}

/** The last `shadowlap store check` on this machine, kept per store (team_sync.data.check). */
export interface LastCheck {
  ok: boolean;
  at: number;
  encryption: string | null;
  versioning: string;
  /** on, off, unavailable or unknown. */
  objectLock: string;
  /** Where the credentials it used came from, in words. */
  credentials: string | null;
}

export function lastCheck(store: StoreOf<'team'>, url: string): LastCheck | null {
  const data = store.teamSync(url)?.data.check;
  return typeof data === 'object' && data !== null && typeof (data as LastCheck).ok === 'boolean' ? (data as LastCheck) : null;
}

export function recordCheck(store: StoreOf<'team'>, url: string, check: LastCheck): void {
  store.setTeamSync(url, { data: { check } });
}
