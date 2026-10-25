import { awsCredentialProvider, configuredRegion } from './aws-credentials.js';
import { AzureStore } from './azure.js';
import { azureAuth, connectionStringEndpoint, type AzureEnv } from './azure-auth.js';
import { googleTokenProvider } from './gcp-auth.js';
import { GcsStore } from './gcs.js';
import type { FetchLike } from './http.js';
import { StoreError, type ObjectStore } from './object-store.js';
import { S3Store } from './s3.js';
import type { AwsCredentials } from './sigv4.js';
import type { StoreLocation } from './url.js';

/**
 * Opens a store with the user's own credentials, read from the environment and the standard files
 * of each cloud's CLI. Nothing is stored. The URL comes from the project's committed config, so it
 * never decides where credentials go: an `?endpoint=` gets requests signed in a way that names the
 * host (S3's SigV4), and nothing else unless it is the cloud's own address or this machine.
 */

export interface OpenOptions {
  env?: NodeJS.ProcessEnv;
  /** The home folder holding ~/.aws and ~/.config/gcloud; for tests. */
  home?: string;
  fetch?: FetchLike;
  now?: () => number;
  retryDelayMs?: number;
  /** Runs the Azure CLI; for tests. */
  azCli?: AzureEnv['azCli'];
}

function staticKeys(id: string | undefined, secret: string | undefined, source: string): (() => Promise<AwsCredentials>) | null {
  if (!id || !secret) return null;
  const creds: AwsCredentials = { accessKeyId: id, secretAccessKey: secret, source };
  return () => Promise.resolve(creds);
}

const GOOGLE_HOSTS = /(^|\.)googleapis\.com$/i;
const AZURE_HOSTS = /\.blob\.(core\.windows\.net|core\.chinacloudapi\.cn|core\.usgovcloudapi\.net|storage\.azure\.net)$/i;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether Google or Azure credentials may be used with an endpoint the project's config names. The
 * config is a committed file, so anyone who can change it could name their own host. A bearer token
 * (a Google or Entra access token, a SAS) works for whoever receives it; an Azure Shared Key
 * signature covers the account and the path but not the host, so a request signed for another host
 * can be replayed against the account for minutes after. Either goes only to the cloud's own
 * addresses over https, or to this machine (an emulator). Another address, such as Azurite or Azure
 * Stack elsewhere, is given on this machine instead: AZURE_STORAGE_CONNECTION_STRING's BlobEndpoint,
 * or STORAGE_EMULATOR_HOST, which is sent no credentials.
 */
export function credentialsMayGoTo(endpoint: string, provider: 'gcs' | 'azure'): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (isLoopback(u.hostname)) return true;
  return u.protocol === 'https:' && (provider === 'gcs' ? GOOGLE_HOSTS : AZURE_HOSTS).test(u.hostname);
}

/** The environment variables that hold HMAC keys for Cloud Storage's S3-compatible API. */
export const GCS_HMAC_VARS = ['GCS_HMAC_ACCESS_KEY_ID', 'GCS_HMAC_SECRET_ACCESS_KEY'] as const;
/** And an R2 API token's keys. */
export const R2_VARS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

export function openObjectStore(location: StoreLocation, options: OpenOptions = {}): ObjectStore {
  const env = options.env ?? process.env;
  const common = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}), ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}) };
  const awsEnv = { env, ...(options.home ? { home: options.home } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) };
  switch (location.provider) {
    case 's3': {
      const endpoint = location.endpoint ?? (env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL || null);
      const region = location.region ?? configuredRegion(awsEnv, location.profile) ?? (endpoint ? 'us-east-1' : null);
      return new S3Store({
        location,
        service: endpoint ? 'The S3-compatible store' : 'Amazon S3',
        endpoint: endpoint ? endpoint.replace(/\/+$/, '') : null,
        region,
        pathStyle: location.pathStyle ?? !!endpoint,
        credentials: awsCredentialProvider(awsEnv, { ...(location.profile ? { profile: location.profile } : {}), allowInstance: !endpoint, allowSts: !endpoint }),
        versioning: true,
        objectLock: true,
        ...common,
      });
    }
    case 'r2': {
      const endpoint = location.endpoint ?? `https://${location.account!}.r2.cloudflarestorage.com`;
      const fromR2 = staticKeys(env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, 'R2_ACCESS_KEY_ID');
      return new S3Store({
        location,
        service: 'Cloudflare R2',
        endpoint,
        region: location.region ?? 'auto',
        pathStyle: true,
        credentials: fromR2 ?? awsCredentialProvider(awsEnv, { ...(location.profile ? { profile: location.profile } : {}), allowInstance: false, allowSts: false }),
        versioning: false,
        alwaysEncrypted: 'AES-256 (R2 encrypts every object)',
        ...common,
      });
    }
    case 'gcs': {
      if (location.auth === 'hmac') {
        const keys = staticKeys(env.GCS_HMAC_ACCESS_KEY_ID, env.GCS_HMAC_SECRET_ACCESS_KEY, 'GCS_HMAC_ACCESS_KEY_ID');
        return new S3Store({
          location,
          service: 'Google Cloud Storage',
          endpoint: (location.endpoint ?? 'https://storage.googleapis.com').replace(/\/+$/, ''),
          region: 'auto',
          pathStyle: true,
          credentials:
            keys ??
            (() => Promise.reject(new StoreError('credentials', 'gs://…?auth=hmac uses HMAC keys: set GCS_HMAC_ACCESS_KEY_ID and GCS_HMAC_SECRET_ACCESS_KEY (create them under Cloud Storage → Settings → Interoperability).'))),
          versioning: true,
          alwaysEncrypted: 'Google-managed (Cloud Storage encrypts every object)',
          ...common,
        });
      }
      if (location.endpoint) {
        const endpoint = location.endpoint;
        const token = credentialsMayGoTo(endpoint, 'gcs')
          ? googleTokenProvider(awsEnv)
          : (): Promise<never> =>
              Promise.reject(
                new StoreError('credentials', `${endpoint} isn't Google's: Shadowlap doesn't send your Google sign-in there. Use Cloud Storage's own address (https://storage.googleapis.com, or a *.googleapis.com private endpoint); for an emulator, set STORAGE_EMULATOR_HOST instead, which is sent no credentials.`),
              );
        return new GcsStore({ location, endpoint: endpoint.replace(/\/+$/, ''), token, ...common });
      }
      if (env.STORAGE_EMULATOR_HOST) {
        // As Google's own client libraries do: an emulator is sent no credentials.
        const host = env.STORAGE_EMULATOR_HOST;
        const endpoint = /^https?:\/\//.test(host) ? host : `http://${host}`;
        return new GcsStore({ location, endpoint: endpoint.replace(/\/+$/, ''), token: () => Promise.resolve({ accessToken: '', expiresAt: null, source: 'no credentials (STORAGE_EMULATOR_HOST)' }), ...common });
      }
      return new GcsStore({ location, endpoint: 'https://storage.googleapis.com', token: googleTokenProvider(awsEnv), ...common });
    }
    case 'azure': {
      const account = location.account!;
      const endpoint = location.endpoint ?? connectionStringEndpoint(env, account) ?? `https://${account}.blob.core.windows.net`;
      let auth = azureAuth({ env, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}), ...(options.azCli ? { azCli: options.azCli } : {}) }, account);
      // An Entra token or a SAS is sent with each request, and an account key's signature doesn't
      // name the host: none of them goes to an address the committed config names unless it is
      // Azure Storage's own, or this machine.
      if (location.endpoint && !credentialsMayGoTo(location.endpoint, 'azure')) {
        const where = location.endpoint;
        auth = {
          kind: 'bearer',
          source: auth.source,
          token: () =>
            Promise.reject(
              new StoreError(
                'credentials',
                `${where} isn't an Azure Storage address, and the store URL comes from a committed file: Shadowlap doesn't send requests made with your Azure credentials there. Use the account's own endpoint (https://${account}.blob.core.windows.net). For Azurite or Azure Stack at another address, give it on this machine instead: AZURE_STORAGE_CONNECTION_STRING with BlobEndpoint=…, and the store URL without ?endpoint=.`,
              ),
            ),
        };
      }
      return new AzureStore({ location, endpoint: endpoint.replace(/\/+$/, ''), auth, ...common });
    }
  }
}
