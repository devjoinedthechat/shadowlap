import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { send, type FetchLike } from './http.js';
import { StoreError } from './object-store.js';

/**
 * Azure Storage credentials, as the Azure CLI and SDKs find them: a connection string or account
 * key (Shared Key), a SAS token, a service principal's secret, a federated token (workload
 * identity, CI with OIDC), the Azure CLI's sign-in, then a managed identity.
 */

export interface AzureEnv {
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  /** Runs `az`; injectable for tests. */
  azCli?: (args: string[]) => Promise<string>;
}

export interface BearerToken {
  token: string;
  expiresAt: number | null;
}

export type AzureAuth =
  | { kind: 'key'; account: string; key: Buffer; source: string }
  | { kind: 'sas'; token: string; source: string }
  | { kind: 'bearer'; token: () => Promise<BearerToken>; source: string };

const RESOURCE = 'https://storage.azure.com/';

/** `AccountName=…;AccountKey=…;BlobEndpoint=…` as a map. */
export function parseConnectionString(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

/** The blob endpoint a connection string names, if any. */
export function connectionStringEndpoint(env: NodeJS.ProcessEnv, account: string): string | null {
  const cs = env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) return null;
  const m = parseConnectionString(cs);
  if (m.get('accountname') && m.get('accountname') !== account) return null;
  const blob = m.get('blobendpoint');
  if (blob) return blob.replace(/\/+$/, '');
  const suffix = m.get('endpointsuffix');
  return suffix ? `${m.get('defaultendpointsprotocol') ?? 'https'}://${account}.blob.${suffix}` : null;
}

async function entraToken(e: AzureEnv, tenant: string, body: Record<string, string>, source: string): Promise<BearerToken> {
  const authority = (e.env.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
  const res = await send(
    { method: 'POST', url: `${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(new URLSearchParams({ ...body, scope: `${RESOURCE}.default` }).toString(), 'utf8') },
    { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 1024 * 1024, attempts: 3 },
  );
  const j = JSON.parse(res.body.toString('utf8') || '{}') as { access_token?: string; expires_in?: number | string; error_description?: string; error?: string };
  if (res.status !== 200 || !j.access_token) throw new StoreError('credentials', `${source}: Microsoft Entra refused the sign-in (${(j.error_description ?? j.error ?? `answered ${res.status}`).split('\n')[0]})`, res.status);
  const secs = Number(j.expires_in);
  return { token: j.access_token, expiresAt: Number.isFinite(secs) ? (e.now?.() ?? Date.now()) + secs * 1000 : null };
}

function defaultAzCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'az.cmd' : 'az', args, { timeout: 30_000, maxBuffer: 1024 * 1024, shell: process.platform === 'win32' }, (err: Error | null, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

async function cliToken(e: AzureEnv): Promise<BearerToken> {
  let out: string;
  try {
    out = await (e.azCli ?? defaultAzCli)(['account', 'get-access-token', '--resource', RESOURCE, '--output', 'json']);
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreError('credentials', 'No Azure credentials found: set AZURE_STORAGE_KEY or AZURE_STORAGE_CONNECTION_STRING, a service principal (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET), or install the Azure CLI and run az login.');
    throw new StoreError('credentials', `The Azure CLI couldn't get a token: ${stderr.trim().split('\n')[0] || (err as Error).message}. Run az login.`);
  }
  const j = JSON.parse(out) as { accessToken?: string; expires_on?: number | string; expiresOn?: string };
  if (!j.accessToken) throw new StoreError('credentials', 'The Azure CLI gave no token. Run az login.');
  const epoch = Number(j.expires_on);
  const parsed = Number.isFinite(epoch) ? epoch * 1000 : Date.parse(j.expiresOn ?? '');
  return { token: j.accessToken, expiresAt: Number.isFinite(parsed) ? parsed : null };
}

async function managedIdentity(e: AzureEnv): Promise<BearerToken | null> {
  const opts = { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 64 * 1024, attempts: 1, timeoutMs: 1500 };
  const clientId = e.env.AZURE_CLIENT_ID ? `&client_id=${encodeURIComponent(e.env.AZURE_CLIENT_ID)}` : '';
  try {
    if (e.env.IDENTITY_ENDPOINT && e.env.IDENTITY_HEADER) {
      const res = await send({ method: 'GET', url: `${e.env.IDENTITY_ENDPOINT}?api-version=2019-08-01&resource=${encodeURIComponent(RESOURCE)}${clientId}`, headers: { 'x-identity-header': e.env.IDENTITY_HEADER } }, opts);
      if (res.status !== 200) return null;
      const j = JSON.parse(res.body.toString('utf8')) as { access_token?: string; expires_on?: string };
      return j.access_token ? { token: j.access_token, expiresAt: Number(j.expires_on) * 1000 || null } : null;
    }
    const host = e.env.AZURE_IMDS_ENDPOINT || 'http://169.254.169.254';
    const res = await send({ method: 'GET', url: `${host}/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(RESOURCE)}${clientId}`, headers: { metadata: 'true' } }, opts);
    if (res.status !== 200) return null;
    const j = JSON.parse(res.body.toString('utf8')) as { access_token?: string; expires_on?: string };
    return j.access_token ? { token: j.access_token, expiresAt: Number(j.expires_on) * 1000 || null } : null;
  } catch {
    return null;
  }
}

function cached(e: AzureEnv, get: () => Promise<BearerToken>): () => Promise<BearerToken> {
  let have: BearerToken | null = null;
  let pending: Promise<BearerToken> | null = null;
  return async () => {
    const now = e.now?.() ?? Date.now();
    if (have && (have.expiresAt === null || have.expiresAt - now > 5 * 60_000)) return have;
    pending ??= get().finally(() => {
      pending = null;
    });
    have = await pending;
    return have;
  };
}

const CLI_SOURCE = 'your Azure CLI sign-in';

/**
 * Where Azure credentials would come from, found offline in the same order: the sign-in of the
 * Azure CLI counts when its profile is on this machine; a managed identity only shows when asked.
 */
export function azureCredentialsHere(e: AzureEnv & { home?: string }, account: string): { uses: string; from: string } | null {
  const auth = azureAuth({ env: e.env }, account);
  if (auth.kind === 'key') return { uses: 'the storage account key', from: `from ${auth.source}` };
  if (auth.kind === 'sas') return { uses: 'a SAS token', from: `from ${auth.source}` };
  if (auth.source !== CLI_SOURCE) return { uses: auth.source, from: auth.source.startsWith('service principal') ? 'from AZURE_CLIENT_ID and AZURE_CLIENT_SECRET' : 'from AZURE_FEDERATED_TOKEN_FILE' };
  const dir = e.env.AZURE_CONFIG_DIR || join(e.home ?? homedir(), '.azure');
  return existsSync(join(dir, 'azureProfile.json')) ? { uses: 'your Azure CLI sign-in', from: 'from az login' } : null;
}


/** The credentials for a storage account, in the order the Azure tools look. */
export function azureAuth(e: AzureEnv, account: string): AzureAuth {
  const env = e.env;
  const cs = env.AZURE_STORAGE_CONNECTION_STRING;
  if (cs) {
    const m = parseConnectionString(cs);
    const name = m.get('accountname');
    if (!name || name === account) {
      const key = m.get('accountkey');
      if (key) return { kind: 'key', account, key: Buffer.from(key, 'base64'), source: 'AZURE_STORAGE_CONNECTION_STRING' };
      const sas = m.get('sharedaccesssignature');
      if (sas) return { kind: 'sas', token: sas.replace(/^\?/, ''), source: 'AZURE_STORAGE_CONNECTION_STRING' };
    }
  }
  if (env.AZURE_STORAGE_KEY && (!env.AZURE_STORAGE_ACCOUNT || env.AZURE_STORAGE_ACCOUNT === account)) {
    return { kind: 'key', account, key: Buffer.from(env.AZURE_STORAGE_KEY, 'base64'), source: 'AZURE_STORAGE_KEY' };
  }
  if (env.AZURE_STORAGE_SAS_TOKEN) return { kind: 'sas', token: env.AZURE_STORAGE_SAS_TOKEN.replace(/^\?/, ''), source: 'AZURE_STORAGE_SAS_TOKEN' };
  const { AZURE_CLIENT_ID: clientId, AZURE_TENANT_ID: tenant } = env;
  if (clientId && tenant && env.AZURE_CLIENT_SECRET) {
    const secret = env.AZURE_CLIENT_SECRET;
    return { kind: 'bearer', source: `service principal ${clientId}`, token: cached(e, () => entraToken(e, tenant, { grant_type: 'client_credentials', client_id: clientId, client_secret: secret }, `service principal ${clientId}`)) };
  }
  if (clientId && tenant && env.AZURE_FEDERATED_TOKEN_FILE) {
    const file = env.AZURE_FEDERATED_TOKEN_FILE;
    return {
      kind: 'bearer',
      source: `workload identity ${clientId}`,
      token: cached(e, () => {
        let assertion: string;
        try {
          assertion = readFileSync(file, 'utf8').trim();
        } catch {
          throw new StoreError('credentials', `workload identity: can't read AZURE_FEDERATED_TOKEN_FILE (${file})`);
        }
        return entraToken(e, tenant, { grant_type: 'client_credentials', client_id: clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }, `workload identity ${clientId}`);
      }),
    };
  }
  return {
    kind: 'bearer',
    source: CLI_SOURCE,
    token: cached(e, async () => {
      try {
        return await cliToken(e);
      } catch (err) {
        const mi = await managedIdentity(e);
        if (mi) return mi;
        throw err;
      }
    }),
  };
}
