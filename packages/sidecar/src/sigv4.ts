import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Signing a Bedrock request again after an intervention changed it. AWS clients sign every request
 * for its exact path and body (Signature Version 4), so an injected instruction, a patched field or
 * another model in the path breaks the signature the agent made. The request is signed again with
 * the same credentials: those in the environment or in the shared credentials and config files,
 * when their access key is the one the agent signed with. Credentials an SSO session or an assumed
 * role hands the client in memory reach neither, and then the change is refused with that reason.
 * Nothing is stored; the secret is read when a request needs it.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type CredentialsFor = (accessKeyId: string) => AwsCredentials | null;

const AUTH = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=[0-9a-f]{64}$/;

/** The access key a request was signed with, or null when it carries no SigV4 signature. */
export function signingKeyId(authorization: string | undefined): string | null {
  return AUTH.exec(authorization ?? '')?.[1] ?? null;
}

/** INI sections of the shared files, by name: `[default]`, `[profile ci]`. */
function iniSections(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      current = {};
      out.set(section[1]!.trim(), current);
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && current) current[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }
  return out;
}

/** Credentials for an access key from the environment, then the shared credentials and config files. */
export function credentialsFromEnvironment(env: NodeJS.ProcessEnv = process.env, home = homedir()): CredentialsFor {
  return (accessKeyId) => {
    if (env.AWS_ACCESS_KEY_ID === accessKeyId && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
    }
    for (const file of [env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials'), env.AWS_CONFIG_FILE || join(home, '.aws', 'config')]) {
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const values of iniSections(text).values()) {
        if (values.aws_access_key_id === accessKeyId && values.aws_secret_access_key) {
          return { accessKeyId, secretAccessKey: values.aws_secret_access_key, ...(values.aws_session_token ? { sessionToken: values.aws_session_token } : {}) };
        }
      }
    }
    return null;
  };
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  /** The path as it is sent, still percent-encoded the way the client encoded it. */
  path: string;
  /** The query string without its `?`. */
  query: string;
  /** Lower-cased request headers as they arrived, including `authorization` and `x-amz-date`. */
  headers: Record<string, string>;
  body: Buffer;
  /** The host the client signed for: `bedrock-runtime.<region>.amazonaws.com`. */
  host: string;
}

/**
 * The request's headers with a new signature for its new path or body, made with the credentials of
 * the access key it was signed with; or why it can't be signed again. The date, region, service and
 * the list of signed headers stay as the client chose them.
 */
export function resignSigV4(input: SignInput, credentialsFor: CredentialsFor): { headers: Record<string, string> } | { error: string } {
  const m = AUTH.exec(input.headers.authorization ?? '');
  if (!m) return { error: 'the request carries no AWS Signature Version 4 to sign again' };
  const [, keyId, date, region, service, signedHeaders] = m as unknown as [string, string, string, string, string, string];
  // The reason is stored with the run and travels in packs: the key is named by its last characters only.
  const named = `the AWS access key ending in ${keyId.slice(-4)}`;
  const credentials = credentialsFor(keyId);
  if (!credentials) {
    return {
      error: `the agent signed it with ${named}, whose secret is in neither the environment nor the shared credentials files, so Shadowlap can't sign the changed request again. Credentials from an SSO session or an assumed role live only in the client: export them for the replay (aws configure export-credentials --format env) and run it again`,
    };
  }
  const token = input.headers['x-amz-security-token'];
  if (token !== undefined && credentials.sessionToken !== undefined && token !== credentials.sessionToken) {
    return { error: `the session token found for ${named} is not the one the agent signed with, so the changed request can't be signed again` };
  }
  const amzDate = input.headers['x-amz-date'];
  if (!amzDate) return { error: 'the request carries no x-amz-date to sign with' };
  const headers = { ...input.headers };
  const bodyHash = sha256(input.body);
  // A client that sends the payload hash signs it; it has to describe the new body.
  if (headers['x-amz-content-sha256'] !== undefined && headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD') headers['x-amz-content-sha256'] = bodyHash;
  const payloadHash = headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD' ? 'UNSIGNED-PAYLOAD' : bodyHash;
  // Services other than S3 sign the path encoded once more, segment by segment, as it is sent.
  const canonicalUri = input.path.split('/').map((s) => rfc3986(s)).join('/');
  const canonicalQuery = [...new URLSearchParams(input.query)]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const names = signedHeaders.split(';');
  const canonicalHeaders = names
    .map((name) => {
      const value = name === 'host' ? input.host : name === 'content-length' ? String(input.body.length) : (headers[name] ?? '');
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const canonical = [input.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers };
}
