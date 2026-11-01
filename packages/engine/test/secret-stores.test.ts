import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, credentialFreeBody, credentialFreeResult, maskJsonCredentials, maskJsonTextCredentials, maskTextCredentials, responseBodyWithoutCredentials, resultBlob, withoutStoredCredentials } from '../src/http.js';
import { times, timesOf } from './timing.js';

/**
 * The secret a secret store hands back under a member whose name says nothing of one (`data`,
 * `value`, `payload`) is masked by the shape of its answer, and what says which secret it is kept.
 * Every value is invented.
 */

const b64 = (text: string) => Buffer.from(text).toString('base64');
const KEY = 'ghp_EXAMPLE16C7e42F292c6912E7710c838347A';

/** A document as a recording stores it, read as JSON text: masked, or as it was when nothing is. */
function stored(doc: unknown, callName?: string): unknown {
  const masked = maskJsonTextCredentials(JSON.stringify(doc), callName);
  return masked === null ? doc : (JSON.parse(masked) as unknown);
}

describe('a Kubernetes Secret', () => {
  const data = { 'tls.crt': b64('EXAMPLE-cert'), 'tls.key': b64('EXAMPLE-tls-key'), '.dockerconfigjson': b64(JSON.stringify({ auths: { 'registry.example.com': { auth: b64('app:EXAMPLE-pw') } } })), webhook: b64('https://hooks.example.com/EXAMPLE') };
  const masked = { 'tls.crt': C, 'tls.key': C, '.dockerconfigjson': C, webhook: C };
  const metadata = { name: 'db', namespace: 'prod', labels: { app: 'api' }, resourceVersion: '4711' };

  it('has every entry of its data and stringData masked, what names it kept, its kind before them (as the API writes it) or after (as kubectl sorts it)', () => {
    const api = { kind: 'Secret', apiVersion: 'v1', metadata, immutable: false, data, stringData: { note: 'EXAMPLE-note-0123' }, type: 'kubernetes.io/tls' };
    expect(stored(api)).toEqual({ ...api, data: masked, stringData: { note: C } });
    const sorted = { apiVersion: 'v1', data, kind: 'Secret', metadata, stringData: { note: 'EXAMPLE-note-0123' }, type: 'kubernetes.io/tls' };
    expect(JSON.stringify(stored(sorted))).toBe(JSON.stringify({ apiVersion: 'v1', data: masked, kind: 'Secret', metadata, stringData: { note: C }, type: 'kubernetes.io/tls' }));
  });

  it('is masked in a list: a SecretList’s items, which name no kind, its kind before them or after; kubectl’s List of them; a watch event, and a stream of them', () => {
    const items = [
      { metadata: { name: 'a' }, data: { password: b64('EXAMPLE-a') }, type: 'Opaque' },
      { metadata: { name: 'b' }, data: { token: b64('EXAMPLE-b') }, type: 'Opaque' },
    ];
    const maskedItems = [
      { metadata: { name: 'a' }, data: { password: C }, type: 'Opaque' },
      { metadata: { name: 'b' }, data: { token: C }, type: 'Opaque' },
    ];
    expect(stored({ kind: 'SecretList', apiVersion: 'v1', metadata: { resourceVersion: '7' }, items })).toEqual({ kind: 'SecretList', apiVersion: 'v1', metadata: { resourceVersion: '7' }, items: maskedItems });
    expect(stored({ apiVersion: 'v1', items, kind: 'SecretList', metadata: {} })).toEqual({ apiVersion: 'v1', items: maskedItems, kind: 'SecretList', metadata: {} });
    expect(stored({ apiVersion: 'v1', items: items.map((item) => ({ ...item, kind: 'Secret' })), kind: 'List' })).toEqual({ apiVersion: 'v1', items: maskedItems.map((item) => ({ ...item, kind: 'Secret' })), kind: 'List' });
    const event = (type: string, value: string) => JSON.stringify({ type, object: { kind: 'Secret', metadata: { name: 'a' }, data: { password: value } } });
    expect(maskTextCredentials(`${event('ADDED', b64('EXAMPLE-1'))}\n${event('MODIFIED', b64('EXAMPLE-2'))}\n`)).toBe(`${event('ADDED', C)}\n${event('MODIFIED', C)}\n`);
  });

  it('is masked in the copy of its manifest kubectl keeps in an annotation, the rest of the copy kept', () => {
    const applied = (stringData: Record<string, string>) => `${JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db', namespace: 'prod' }, stringData })}\n`;
    const secret = { apiVersion: 'v1', data: { url: b64('EXAMPLE-url') }, kind: 'Secret', metadata: { name: 'db', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': applied({ url: 'EXAMPLE-url' }) } } };
    expect(stored(secret)).toEqual({ ...secret, data: { url: C }, metadata: { name: 'db', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': applied({ url: C }) } } });
  });

  it('is masked in a manifest a call sends, as JSON and as text', () => {
    const manifest = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db' }, type: 'Opaque', stringData: { url: 'EXAMPLE-url', region: 'eu' } };
    const sent = { ...manifest, stringData: { url: C, region: C } };
    expect(credentialFreeBody({ body: manifest, encoding: 'json' })).toEqual({ body: sent, encoding: 'json' });
    expect(credentialFreeBody({ body: JSON.stringify(manifest), encoding: 'text' })).toEqual({ body: JSON.stringify(sent), encoding: 'text' });
  });

  it('is read by its kind: a ConfigMap’s data, and data under no kind, kept as sent', () => {
    for (const doc of [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg' }, data: { greeting: 'hello' } }, { kind: 'Service', data: { port: '80' } }, { data: { greeting: 'hello' } }]) expect(maskJsonCredentials(doc)).toBe(doc);
  });

  it('names a TLS key `tls.key` wherever it stands, its certificate and the path to a key file kept', () => {
    expect(maskJsonCredentials({ 'tls.key': 'EXAMPLE-key', tlsKey: 'EXAMPLE-key', 'tls.crt': 'EXAMPLE-cert', tls_key_file: '/etc/tls/tls.key' })).toEqual({ 'tls.key': C, tlsKey: C, 'tls.crt': 'EXAMPLE-cert', tls_key_file: '/etc/tls/tls.key' });
  });
});

describe('a Google Cloud Secret Manager version', () => {
  it('has its payload’s data, and the checksum that would confirm a guess of it, masked, its name kept, in a location or not', () => {
    for (const name of ['projects/123456/secrets/db/versions/4', 'projects/acme/locations/europe-west1/secrets/db/versions/latest']) {
      const version = { name, payload: { data: b64('EXAMPLE-gcp-0123'), dataCrc32c: '3013472386' } };
      expect(stored(version)).toEqual({ name, payload: { data: C, dataCrc32c: C } });
    }
  });

  it('is read by its name: a payload under another name kept', () => {
    const message = { name: 'projects/acme/subscriptions/orders', payload: { data: b64('order 4417') } };
    expect(maskJsonCredentials(message)).toBe(message);
  });
});

describe('an Azure Key Vault secret', () => {
  it('has its value masked, its id, attributes, tags and content type kept, in each of Azure’s clouds', () => {
    for (const id of ['https://acme-vault.vault.azure.net/secrets/db/0123456789abcdef0123456789abcdef', 'https://acme.vault.azure.cn/secrets/db', 'https://acme.vault.usgovcloudapi.net/secrets/db/']) {
      const bundle = { value: 'EXAMPLE-azure-0123', contentType: 'text/plain', id, attributes: { enabled: true, created: 1761825600 }, tags: { team: 'data' } };
      expect(stored(bundle)).toEqual({ ...bundle, value: C });
    }
  });

  it('is read by its id: a value beside another address kept, and a list of secrets, which holds no value, as it was', () => {
    const other = { value: 'hello', id: 'https://api.example.com/secrets/db' };
    expect(maskJsonCredentials(other)).toBe(other);
    const list = { value: [{ id: 'https://acme.vault.azure.net/secrets/db', attributes: { enabled: true } }], nextLink: null };
    expect(maskJsonCredentials(list)).toBe(list);
  });
});

describe('a Vault KV answer', () => {
  const envelope = { request_id: 'b0e1c2d3-0000-4000-8000-000000000001', lease_id: '', renewable: false, lease_duration: 0, wrap_info: null, warnings: null, auth: null };
  const metadata = { created_time: '2026-10-30T12:00:00.000000Z', custom_metadata: { owner: 'data' }, deletion_time: '', destroyed: false, version: 3 };
  const v2 = { ...envelope, data: { data: { db: 'EXAMPLE-db-0123', user: 'app', config: { region: 'eu' }, hosts: ['db1', 'db2'] }, metadata } };
  const v2Masked = { ...v2, data: { data: { db: C, user: C, config: { region: C }, hosts: [C, C] }, metadata } };
  const v1 = { ...envelope, lease_duration: 2764800, data: { db: 'EXAMPLE-db-0123', user: 'app' } };
  const READ = 'GET vault.example.com:8200/v1/secret/prod/db';

  it('in version 2, has every field of its secret masked, its metadata and the rest of the answer kept', () => {
    expect(stored(v2)).toEqual(v2Masked);
  });

  it('in version 2, is read by its metadata’s version: data beside metadata without one kept', () => {
    const page = { data: { data: [{ id: 1, name: 'a' }], metadata: { total: 1 } } };
    expect(maskJsonCredentials(page)).toBe(page);
  });

  it('in version 1, has its data masked when the call read a path under /v1/secret/, the rest of the answer kept', () => {
    expect(stored(v1, READ)).toEqual({ ...v1, data: { db: C, user: C } });
    for (const name of [undefined, 'GET vault.example.com:8200/v1/sys/mounts', 'GET api.example.com/v2/secret/db']) expect(stored(v1, name), name).toEqual(v1);
  });

  it('in version 1, keeps a list of the secrets’ names, unless one reads as a key, and reads version 2’s answer under the same path as version 2’s', () => {
    const list = (keys: string[]) => ({ ...envelope, data: { keys } });
    expect(stored(list(['db', 'app/']), 'GET vault.example.com:8200/v1/secret/')).toEqual(list(['db', 'app/']));
    expect(stored(list(['db', KEY]), 'GET vault.example.com:8200/v1/secret/')).toEqual(list([C, C]));
    expect(stored(v2, 'GET vault.example.com:8200/v1/secret/data/prod/db')).toEqual(v2Masked);
  });

  it('in version 1, is masked as the sidecar stores the answer and as a copy reads it, by the name of the call it answers, whatever the body’s encoding', () => {
    const body = JSON.stringify(v1);
    for (const encoding of ['json', 'text', 'base64']) {
      expect(responseBodyWithoutCredentials(Buffer.from(body), encoding, READ).toString(), encoding).toBe(JSON.stringify({ ...v1, data: { db: C, user: C } }));
      expect(responseBodyWithoutCredentials(Buffer.from(body), encoding).toString(), encoding).toBe(body);
    }
    const asJson = resultBlob({ status: 200, headers: { 'content-type': 'application/json' }, encoding: 'json' }, body);
    const asText = Buffer.from(JSON.stringify({ result: { status: 200, headers: {}, body, encoding: 'text' } }));
    const bodyOf = (blob: Buffer | null): unknown => {
      const { result } = JSON.parse(blob?.toString() ?? '{"result":{}}') as { result: { body?: unknown } };
      return typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
    };
    for (const blob of [asJson, asText]) {
      expect(bodyOf(credentialFreeResult(blob, READ))).toEqual({ ...v1, data: { db: C, user: C } });
      expect(credentialFreeResult(blob)).toBeNull();
    }
  });
});

/** What a call sends as a recording stores it and a replay matches it: its arguments' body, masked as a stored call's are, by the call its method and address name. */
function sent(method: string, url: string, body: unknown): unknown {
  return (withoutStoredCredentials({ method, url, body, encoding: 'json' }) as { body: unknown }).body;
}

describe('a secret a call writes to a store', () => {
  const fields = { db: 'EXAMPLE-db-0123', user: 'app', port: 5432 };
  const masked = { db: C, user: C, port: 5432 };

  it("masks every field a Vault KV write puts: version 2's data at any mount, beside its options, and version 1's at secret/ and cubbyhole/", () => {
    for (const url of ['https://vault.example.com:8200/v1/secret/data/prod/db', 'https://vault.example.com:8200/v1/kv/data/prod/db', 'https://vault.example.com:8200/v1/team/kv/data/prod/db']) {
      expect(sent('PUT', url, { data: fields, options: { cas: 0 } }), url).toEqual({ data: masked, options: { cas: 0 } });
      expect(sent('PATCH', url, { data: fields }), url).toEqual({ data: masked });
    }
    for (const url of ['https://vault.example.com:8200/v1/secret/prod/db', 'https://vault.example.com:8200/v1/cubbyhole/notes']) expect(sent('POST', url, fields), url).toEqual(masked);
    // What sys/wrapping/wrap wraps, to be handed out once.
    expect(sent('POST', 'https://vault.example.com:8200/v1/sys/wrapping/wrap', { note: 'EXAMPLE-wrap', n: 1 })).toEqual({ note: C, n: 1 });
  });

  it("keeps what a write sends that holds no secret: KV version 2's metadata and settings, Vault's other paths, and data at an address that isn't Vault's KV", () => {
    const keep: Array<[string, string, unknown]> = [
      ['POST', 'https://vault.example.com:8200/v1/secret/metadata/prod/db', { max_versions: 5, custom_metadata: { owner: 'data' } }],
      ['POST', 'https://vault.example.com:8200/v1/secret/config', { max_versions: 5, delete_version_after: '3h' }],
      ['POST', 'https://vault.example.com:8200/v1/secret/delete/prod/db', { versions: [1, 2] }],
      ['PUT', 'https://vault.example.com:8200/v1/sys/policies/acl/app', { policy: 'path "secret/*" { capabilities = ["read"] }' }],
      // Data beside anything but its options is no KV write, whatever its address; nor data at another API's.
      ['POST', 'https://api.example.com/v1/projects/data/rows', { data: { name: 'refund' }, meta: { page: 1 } }],
      ['POST', 'https://api.example.com/v2/data/rows', { data: { name: 'refund' } }],
    ];
    for (const [method, url, body] of keep) expect(sent(method, url, body), url).toEqual(body);
  });

  it("masks an Azure Key Vault secret's value a write sends, and a certificate's an import does, in each of Azure's clouds", () => {
    const secret = { value: 'EXAMPLE-azure-0123', contentType: 'text/plain', attributes: { enabled: true }, tags: { team: 'data' } };
    for (const url of ['https://acme.vault.azure.net/secrets/db?api-version=7.4', 'https://acme.vault.azure.cn/secrets/db', 'https://acme.vault.usgovcloudapi.net/secrets/restore?api-version=7.4']) expect(sent('PUT', url, secret), url).toEqual({ ...secret, value: C });
    expect(sent('POST', 'https://acme.vault.azure.net/certificates/web/import?api-version=7.4', { value: b64('EXAMPLE-pfx'), policy: { contentType: 'application/x-pkcs12' } })).toEqual({ value: C, policy: { contentType: 'application/x-pkcs12' } });
    // Another host's value.
    expect(sent('PUT', 'https://api.example.com/secrets/db', secret)).toEqual(secret);
  });

  it("masks the payload Secret Manager's addVersion sends, in a location or not, and keeps a secret's settings", () => {
    const version = { payload: { data: b64('EXAMPLE-gcp-0123'), dataCrc32c: '3013472386' } };
    for (const url of ['https://secretmanager.googleapis.com/v1/projects/acme/secrets/db:addVersion', 'https://secretmanager.europe-west1.rep.googleapis.com/v1/projects/acme/locations/europe-west1/secrets/db:addVersion']) expect(sent('POST', url, version), url).toEqual({ payload: { data: C, dataCrc32c: C } });
    const created = { replication: { automatic: {} }, labels: { team: 'data' } };
    expect(sent('POST', 'https://secretmanager.googleapis.com/v1/projects/acme/secrets?secretId=db', created)).toEqual(created);
  });

  it("masks a Kubernetes Secret's data and stringData a create, a replace or a patch sends, with no kind to say so, and a JSON patch's value under them", () => {
    const at = 'https://k8s.example.com/api/v1/namespaces/prod/secrets';
    expect(sent('POST', at, { metadata: { name: 'db' }, stringData: { url: 'EXAMPLE-url' } })).toEqual({ metadata: { name: 'db' }, stringData: { url: C } });
    expect(sent('PATCH', `${at}/db`, { data: { password: b64('EXAMPLE-pw') }, metadata: { labels: { app: 'api' } } })).toEqual({ data: { password: C }, metadata: { labels: { app: 'api' } } });
    const patch = [
      { op: 'replace', path: '/data/password', value: b64('EXAMPLE-pw') },
      { op: 'add', path: '/stringData', value: { note: 'EXAMPLE-note' } },
      { op: 'add', path: '/metadata/labels/app', value: 'api' },
    ];
    expect(sent('PATCH', `${at}/db`, patch)).toEqual([{ ...patch[0], value: C }, { ...patch[1], value: { note: C } }, patch[2]]);
    // A ConfigMap's data is no secret.
    expect(sent('PATCH', 'https://k8s.example.com/api/v1/namespaces/prod/configmaps/cfg', { data: { region: 'eu' } })).toEqual({ data: { region: 'eu' } });
  });

  it('masks it however the body is stored, as text or as bytes, by the call that sends it', () => {
    const body = JSON.stringify({ data: { db: 'EXAMPLE-db-0123' } });
    const name = 'PUT vault.example.com:8200/v1/secret/data/prod/db';
    expect(credentialFreeBody({ body, encoding: 'text' }, name)).toEqual({ body: JSON.stringify({ data: { db: C } }), encoding: 'text' });
    expect(credentialFreeBody({ body: b64(body), encoding: 'base64' }, name)).toEqual({ body: b64(JSON.stringify({ data: { db: C } })), encoding: 'base64' });
    expect(credentialFreeBody({ body, encoding: 'text' })).toEqual({ body, encoding: 'text' });
  });
});

describe('a Vault answer that holds a secret by its address', () => {
  const envelope = { request_id: 'b0e1c2d3-0000-4000-8000-000000000001', lease_id: '', renewable: false, lease_duration: 2764800, wrap_info: null, warnings: null, auth: null };
  const v1 = { ...envelope, data: { db: 'EXAMPLE-db-0123', user: 'app' }, mount_type: 'kv' };

  it("masks KV version 1's data at another mount when the answer names its mount kv, and keeps a list of names and version 2's own answers", () => {
    expect(stored(v1, 'GET vault.example.com:8200/v1/kv/prod/db')).toEqual({ ...v1, data: { db: C, user: C } });
    const list = { ...envelope, data: { keys: ['db', 'app/'] }, mount_type: 'kv' };
    expect(stored(list, 'LIST vault.example.com:8200/v1/kv/prod/')).toEqual(list);
    const metadata = { ...envelope, data: { current_version: 3, created_time: '2026-10-30T12:00:00Z', versions: { '3': { created_time: '2026-10-30T12:00:00Z', destroyed: false } } }, mount_type: 'kv' };
    expect(stored(metadata, 'GET vault.example.com:8200/v1/kv/metadata/prod/db')).toEqual(metadata);
    // Another engine's answer, and one that names no mount, as an older Vault's does.
    const noMount = { ...envelope, data: v1.data };
    for (const doc of [{ ...v1, mount_type: 'transit' }, noMount]) expect(stored(doc, 'GET vault.example.com:8200/v1/kv/prod/db')).toEqual(doc);
  });

  it("masks a cubbyhole's data, as secret/'s is, and all the data sys/wrapping/unwrap hands back", () => {
    expect(stored({ ...envelope, data: { note: 'EXAMPLE-note' } }, 'GET vault.example.com:8200/v1/cubbyhole/notes')).toEqual({ ...envelope, data: { note: C } });
    expect(stored({ ...envelope, data: { keys: ['db'], note: 'EXAMPLE-wrapped' } }, 'POST vault.example.com:8200/v1/sys/wrapping/unwrap')).toEqual({ ...envelope, data: { keys: [C], note: C } });
  });
});

describe('a secret store’s answer inside a string', () => {
  it('is masked where a tool’s result carries it as text, and among other text', () => {
    const bundle = { value: 'EXAMPLE-azure-0123', id: 'https://acme.vault.azure.net/secrets/db' };
    const result = { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: JSON.stringify(bundle) }] } };
    expect(stored(result)).toEqual({ ...result, result: { content: [{ type: 'text', text: JSON.stringify({ ...bundle, value: C }) }] } });
    expect(maskTextCredentials(`created: ${JSON.stringify({ kind: 'Secret', data: { a: b64('EXAMPLE-a') } })}; done`)).toBe(`created: {"kind":"Secret","data":{"a":"${C}"}}; done`);
  });
});

describe('the reading of an answer for its shape', () => {
  it('reads a text once, however deep its objects nest and however many items its list holds', () => {
    const nested = (n: number) => `${'{"data":'.repeat(n)}{"data":{"a":"x"},"metadata":{"version":1}}${',"metadata":{"version":1}}'.repeat(n)}`;
    const list = (n: number) => `{"kind":"SecretList","items":[${Array.from({ length: n }, (_, i) => `{"data":{"k${i}":"v"}}`).join(',')}]}`;
    const t = timesOf({ nested: () => maskJsonTextCredentials(nested(1000)), nested16: () => maskJsonTextCredentials(nested(16_000)), list: () => maskJsonTextCredentials(list(1000)), list16: () => maskJsonTextCredentials(list(16_000)) }, { rounds: 2 });
    expect(t.nested16, `16 times the nesting took ${times(t.nested16, t.nested)} as long`).toBeLessThan(48 * t.nested);
    expect(t.list16, `16 times the items took ${times(t.list16, t.list)} as long`).toBeLessThan(48 * t.list);
  });

  it('stops where the masking’s walk stops, so JSON among other text that stops being JSON is read once', () => {
    // Each object stops at its string's escape JSON has none of; read on past it, each would read all the rest.
    const text = (n: number) => `text ${'{"kind":"Secret","x":"\\q","y":'.repeat(n)}1${'}'.repeat(n)}`;
    const t = timesOf({ short: () => maskTextCredentials(text(1000)), long: () => maskTextCredentials(text(16_000)) }, { rounds: 2 });
    expect(t.long, `16 times the objects took ${times(t.long, t.short)} as long`).toBeLessThan(48 * t.short);
  });
});
