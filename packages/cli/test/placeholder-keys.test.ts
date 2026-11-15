import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { PLACEHOLDER_AWS_ACCESS_KEY_ID, PLACEHOLDER_KEY } from '@shadowlap/sidecar';
import { hasCredentials, keyEnvOf, placeholderKeys } from '../src/index.js';
import { keyEnvNote, stampKeyEnv } from '../src/placeholder-keys.js';

/**
 * Which keys a replay's agent gets as placeholders: one for each provider its recording called whose
 * credentials the environment lacks, never in place of a credential of any kind; in `shadowlap
 * replay` only for the providers whose key the recording's own environment held; and Azure OpenAI's
 * only where the recording's environment held its key.
 */

const calls = (...providers: string[]) => providers.map((provider) => ({ meta: { provider } })) as never[];
const emptyHome = () => mkdtempSync(join(tmpdir(), 'fp-home-'));
const ALL = calls('anthropic', 'openai', 'gemini', 'azure', 'bedrock', 'vertex');
const AZURE_HELD = { azure: ['AZURE_OPENAI_API_KEY'] };

describe('placeholder keys on an offline replay', () => {
  it('are given for each provider the recording called, in the variables its SDKs read', () => {
    expect(placeholderKeys({}, { calls: ALL, keyEnv: AZURE_HELD }, 'offline', emptyHome())).toEqual({
      ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
      OPENAI_API_KEY: PLACEHOLDER_KEY,
      GEMINI_API_KEY: PLACEHOLDER_KEY,
      GOOGLE_API_KEY: PLACEHOLDER_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: PLACEHOLDER_KEY,
      AZURE_OPENAI_API_KEY: PLACEHOLDER_KEY,
      AWS_ACCESS_KEY_ID: PLACEHOLDER_AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: PLACEHOLDER_KEY,
    });
    // Vertex AI's clients fetch a token before they call it: no placeholder stands in for that.
    expect(placeholderKeys({}, { calls: calls('vertex') }, 'offline', emptyHome())).toEqual({});
  });

  it("give Azure OpenAI's only where the recording's environment held its key: a token provider refuses one beside it", () => {
    expect(placeholderKeys({}, { calls: calls('azure'), keyEnv: AZURE_HELD }, 'offline', emptyHome())).toEqual({ AZURE_OPENAI_API_KEY: PLACEHOLDER_KEY });
    // Signed in with Microsoft Entra ID, or a recording that doesn't say: none, offline too.
    expect(placeholderKeys({}, { calls: calls('azure'), keyEnv: { azure: [] } }, 'offline', emptyHome())).toEqual({});
    expect(placeholderKeys({}, { calls: calls('azure'), keyEnv: {} }, 'offline', emptyHome())).toEqual({});
    expect(placeholderKeys({}, { calls: calls('azure') }, 'offline', emptyHome())).toEqual({});
    // The AI SDK's Azure provider (Mastra's model router on it) and LiteLLM read AZURE_API_KEY: theirs goes there, and only there.
    expect(placeholderKeys({}, { calls: calls('azure'), keyEnv: { azure: ['AZURE_API_KEY'] } }, 'offline', emptyHome())).toEqual({ AZURE_API_KEY: PLACEHOLDER_KEY });
    expect(placeholderKeys({}, { calls: calls('azure'), keyEnv: { azure: ['AZURE_API_KEY'] } }, 'replay', emptyHome())).toEqual({ AZURE_API_KEY: PLACEHOLDER_KEY });
  });

  it("give Claude on Foundry its own key, only where the recording's environment held it, and not Anthropic's", () => {
    // Recorded as Anthropic's calls, through foundry: the key is Foundry's.
    const foundry = [{ meta: { provider: 'anthropic', via: 'foundry' } }] as never[];
    expect(placeholderKeys({}, { calls: foundry, keyEnv: { foundry: ['ANTHROPIC_FOUNDRY_API_KEY'] } }, 'offline', emptyHome())).toEqual({ ANTHROPIC_FOUNDRY_API_KEY: PLACEHOLDER_KEY });
    // A client signed in with a Microsoft Entra token refuses a key beside it: none unless the recording's key was one.
    expect(placeholderKeys({}, { calls: foundry }, 'offline', emptyHome())).toEqual({});
    expect(placeholderKeys({ ANTHROPIC_FOUNDRY_API_KEY: 'real' }, { calls: foundry, keyEnv: { foundry: ['ANTHROPIC_FOUNDRY_API_KEY'] } }, 'offline', emptyHome())).toEqual({});
    expect(keyEnvOf({ ANTHROPIC_FOUNDRY_API_KEY: 'real' }, emptyHome())).toMatchObject({ foundry: ['ANTHROPIC_FOUNDRY_API_KEY'] });
  });

  it('are not given for a provider only the judge called, or one the recording never called', () => {
    const judged = [{ meta: { provider: 'anthropic' } }, { meta: { provider: 'gemini', scope: 'shadowlap:judge' } }] as never[];
    expect(placeholderKeys({}, { calls: judged }, 'offline', emptyHome())).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY });
    expect(placeholderKeys({}, { calls: [{ meta: {} }] as never[] }, 'offline', emptyHome())).toEqual({});
  });

  it('never replace a credential the environment holds, of any kind its SDKs use', () => {
    const home = emptyHome();
    const holds: Array<[string, string]> = [
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['anthropic', 'ANTHROPIC_AUTH_TOKEN'],
      ['anthropic', 'ANTHROPIC_PROFILE'],
      ['anthropic', 'ANTHROPIC_FEDERATION_RULE_ID'],
      ['openai', 'OPENAI_API_KEY'],
      ['openai', 'OPENAI_ADMIN_KEY'],
      ['gemini', 'GEMINI_API_KEY'],
      ['gemini', 'GOOGLE_API_KEY'],
      ['azure', 'AZURE_OPENAI_API_KEY'],
      ['azure', 'AZURE_OPENAI_AD_TOKEN'],
      ['azure', 'AZURE_CLIENT_ID'],
      ['azure', 'AZURE_FEDERATED_TOKEN_FILE'],
      ['azure', 'IDENTITY_ENDPOINT'],
      ['azure', 'MSI_ENDPOINT'],
      ['bedrock', 'AWS_ACCESS_KEY_ID'],
      ['bedrock', 'AWS_PROFILE'],
      ['bedrock', 'AWS_WEB_IDENTITY_TOKEN_FILE'],
      ['bedrock', 'AWS_CONTAINER_CREDENTIALS_FULL_URI'],
      ['bedrock', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'],
      ['bedrock', 'AWS_BEARER_TOKEN_BEDROCK'],
    ];
    for (const [provider, name] of holds) {
      expect(placeholderKeys({ [name]: 'the-real-one' }, { calls: calls(provider), keyEnv: AZURE_HELD }, 'offline', home), `${name} for ${provider}`).toEqual({});
    }
    // Another provider's key is no key for this one.
    expect(placeholderKeys({ OPENAI_API_KEY: 'the-real-one' }, { calls: calls('anthropic', 'openai') }, 'offline', home)).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY });
  });

  it('take an empty variable for none, as a CI secret a pull request from a fork does not get', () => {
    expect(placeholderKeys({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '  ' }, { calls: calls('anthropic', 'openai') }, 'offline', emptyHome())).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY, OPENAI_API_KEY: PLACEHOLDER_KEY });
  });

  it('never replace credentials the SDKs read from files: an AWS profile that holds them, an Anthropic profile', () => {
    const aws = emptyHome();
    mkdirSync(join(aws, '.aws'));
    writeFileSync(join(aws, '.aws', 'config'), '[default]\nregion = eu-west-1\n\n[profile work]\nsso_session = corp\n');
    // A config file that names a region, and a profile the SDKs don't use, hold no credential: the client would have none.
    expect(placeholderKeys({}, { calls: calls('bedrock') }, 'offline', aws)).toEqual({ AWS_ACCESS_KEY_ID: PLACEHOLDER_AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: PLACEHOLDER_KEY });
    // The profile they use does: an SSO session, keys, a process, a role, web identity, aws login.
    for (const setting of ['sso_session = corp', 'sso_start_url = https://corp.awsapps.com/start', 'aws_access_key_id = AKIAEXAMPLE', 'credential_process = /usr/local/bin/creds', 'role_arn = arn:aws:iam::1:role/r', 'web_identity_token_file = /var/run/token', 'login_session = arn:aws:iam::1:user/u']) {
      writeFileSync(join(aws, '.aws', 'config'), `# mine\n[default]\nregion = eu-west-1\n${setting}\n`);
      expect(placeholderKeys({}, { calls: calls('bedrock') }, 'offline', aws), setting).toEqual({});
    }
    writeFileSync(join(aws, '.aws', 'config'), '[profile ci]\ncredential_process = /usr/local/bin/creds\n');
    expect(placeholderKeys({}, { calls: calls('bedrock') }, 'offline', aws)).toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(placeholderKeys({ AWS_DEFAULT_PROFILE: 'ci' }, { calls: calls('bedrock') }, 'offline', aws)).toEqual({});
    // The credentials file's [default], where AWS_SHARED_CREDENTIALS_FILE says.
    const file = join(emptyHome(), 'creds');
    writeFileSync(file, '[default]\n');
    expect(placeholderKeys({ AWS_SHARED_CREDENTIALS_FILE: file }, { calls: calls('bedrock') }, 'offline', emptyHome())).toHaveProperty('AWS_ACCESS_KEY_ID');
    writeFileSync(file, '[default]\r\naws_access_key_id = AKIAEXAMPLE\r\naws_secret_access_key = secret\r\n');
    expect(placeholderKeys({ AWS_SHARED_CREDENTIALS_FILE: file }, { calls: calls('bedrock') }, 'offline', emptyHome())).toEqual({});

    const profile = emptyHome();
    mkdirSync(join(profile, 'configs'), { recursive: true });
    writeFileSync(join(profile, 'configs', 'work.json'), '{"authentication":{"type":"user_oauth"}}');
    // Only the active profile counts: none is named, so the default one, which isn't there.
    expect(placeholderKeys({ ANTHROPIC_CONFIG_DIR: profile }, { calls: calls('anthropic') }, 'offline', emptyHome())).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY });
    writeFileSync(join(profile, 'active_config'), 'work\n');
    expect(placeholderKeys({ ANTHROPIC_CONFIG_DIR: profile }, { calls: calls('anthropic') }, 'offline', emptyHome())).toEqual({});
  });

  it("give OpenAI's SDK on Bedrock its Bedrock API key where a config file holds no credential, and none where a profile does", () => {
    const mantle = [{ meta: { provider: 'openai', via: 'bedrock-mantle' } }] as never[];
    const held = { 'bedrock-mantle': ['AWS_BEARER_TOKEN_BEDROCK'] };
    const home = emptyHome();
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = us-east-1\n');
    expect(placeholderKeys({}, { calls: mantle, keyEnv: held }, 'offline', home)).toEqual({ AWS_BEARER_TOKEN_BEDROCK: PLACEHOLDER_KEY });
    expect(placeholderKeys({}, { calls: mantle, keyEnv: held }, 'replay', home)).toEqual({ AWS_BEARER_TOKEN_BEDROCK: PLACEHOLDER_KEY });
    // Only where the recording's environment held the key, as a client that signs with SigV4 reads none.
    expect(placeholderKeys({}, { calls: mantle }, 'offline', home)).toEqual({});
    expect(placeholderKeys({ AWS_BEARER_TOKEN_BEDROCK: 'real' }, { calls: mantle, keyEnv: held }, 'offline', home)).toEqual({});
    writeFileSync(join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret\n');
    expect(placeholderKeys({}, { calls: mantle, keyEnv: held }, 'offline', home)).toEqual({});
  });

  it('give Azure OpenAI and Claude on Foundry their key whatever the Azure CLI has signed in to, which neither client reads', () => {
    const azure = emptyHome();
    mkdirSync(join(azure, '.azure'));
    writeFileSync(join(azure, '.azure', 'msal_token_cache.json'), '{}');
    writeFileSync(join(azure, '.azure', 'service_principal_entries.json'), '[]');
    const foundry = [{ meta: { provider: 'anthropic', via: 'foundry' } }] as never[];
    expect(placeholderKeys({}, { calls: calls('azure'), keyEnv: AZURE_HELD }, 'offline', azure)).toEqual({ AZURE_OPENAI_API_KEY: PLACEHOLDER_KEY });
    expect(placeholderKeys({ AZURE_CONFIG_DIR: join(azure, '.azure') }, { calls: foundry, keyEnv: { foundry: ['ANTHROPIC_FOUNDRY_API_KEY'] } }, 'offline', emptyHome())).toEqual({ ANTHROPIC_FOUNDRY_API_KEY: PLACEHOLDER_KEY });
    expect(keyEnvOf({}, azure)).toEqual({});
  });

  it.skipIf(process.platform === 'win32')("find the Anthropic profile where either SDK looks: XDG_CONFIG_HOME's, then the home folder's", () => {
    const signedIn = (root: string) => {
      mkdirSync(join(root, 'configs'), { recursive: true });
      writeFileSync(join(root, 'configs', 'default.json'), '{"authentication":{"type":"user_oauth"}}');
    };
    const xdg = emptyHome();
    signedIn(join(xdg, 'anthropic'));
    expect(placeholderKeys({ XDG_CONFIG_HOME: xdg }, { calls: calls('anthropic') }, 'offline', emptyHome())).toEqual({});
    // The Python SDK reads ~/.config/anthropic whatever XDG_CONFIG_HOME says.
    const home = emptyHome();
    signedIn(join(home, '.config', 'anthropic'));
    expect(placeholderKeys({ XDG_CONFIG_HOME: emptyHome() }, { calls: calls('anthropic') }, 'offline', home)).toEqual({});
    expect(placeholderKeys({}, { calls: calls('anthropic') }, 'offline', home)).toEqual({});
  });

  it('are not given, with in-process capture off, for a provider only capture brings to the sidecar', () => {
    expect(placeholderKeys({ SHADOWLAP_CAPTURE: 'off' }, { calls: ALL, keyEnv: AZURE_HELD }, 'offline', emptyHome())).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY, OPENAI_API_KEY: PLACEHOLDER_KEY, GEMINI_API_KEY: PLACEHOLDER_KEY, GOOGLE_API_KEY: PLACEHOLDER_KEY, GOOGLE_GENERATIVE_AI_API_KEY: PLACEHOLDER_KEY });
    expect(placeholderKeys({ SHADOWLAP_CAPTURE: 'off' }, { calls: calls('azure', 'bedrock'), keyEnv: { azure: ['AZURE_OPENAI_API_KEY'], bedrock: ['AWS_ACCESS_KEY_ID'] } }, 'replay', emptyHome())).toEqual({});
  });
});

describe('placeholder keys on shadowlap replay, which goes live from a fork', () => {
  it("are given only for the providers whose key the recording's environment held", () => {
    const recording = { calls: calls('anthropic', 'openai'), keyEnv: { anthropic: ['ANTHROPIC_API_KEY'] } };
    expect(placeholderKeys({}, recording, 'replay', emptyHome())).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY });
    // An agent that brought its own key (one it loads from .env, a local server's dummy key) gets none: its fork goes live with it.
    expect(placeholderKeys({}, { calls: calls('openai'), keyEnv: {} }, 'replay', emptyHome())).toEqual({});
    // A Bedrock agent on an instance role keeps no AWS key in its note: the role is left to it.
    expect(placeholderKeys({}, { calls: calls('bedrock'), keyEnv: {} }, 'replay', emptyHome())).toEqual({});
    // A recording that doesn't say (an import, an older one) gets none.
    expect(placeholderKeys({}, { calls: calls('anthropic') }, 'replay', emptyHome())).toEqual({});
    // And never in place of a key this environment holds.
    expect(placeholderKeys({ ANTHROPIC_API_KEY: 'the-real-one' }, recording, 'replay', emptyHome())).toEqual({});
  });

  it("put Gemini's placeholder in the variable the recording's environment held its key in", () => {
    expect(placeholderKeys({}, { calls: calls('gemini'), keyEnv: { gemini: ['GOOGLE_API_KEY'] } }, 'replay', emptyHome())).toEqual({ GOOGLE_API_KEY: PLACEHOLDER_KEY });
    expect(placeholderKeys({}, { calls: calls('gemini'), keyEnv: { gemini: ['GEMINI_API_KEY'] } }, 'offline', emptyHome())).toEqual({ GEMINI_API_KEY: PLACEHOLDER_KEY });
    // The AI SDK's Google provider, and Mastra's model router on it, read GOOGLE_GENERATIVE_AI_API_KEY.
    expect(placeholderKeys({}, { calls: calls('gemini'), keyEnv: { gemini: ['GOOGLE_GENERATIVE_AI_API_KEY'] } }, 'replay', emptyHome())).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: PLACEHOLDER_KEY });
    // A credential of another kind: each.
    expect(placeholderKeys({}, { calls: calls('gemini'), keyEnv: { gemini: [] } }, 'replay', emptyHome())).toEqual({ GEMINI_API_KEY: PLACEHOLDER_KEY, GOOGLE_API_KEY: PLACEHOLDER_KEY, GOOGLE_GENERATIVE_AI_API_KEY: PLACEHOLDER_KEY });
    // AWS's two go together, whichever of them the note names.
    expect(placeholderKeys({}, { calls: calls('bedrock'), keyEnv: { bedrock: ['AWS_ACCESS_KEY_ID'] } }, 'replay', emptyHome())).toEqual({ AWS_ACCESS_KEY_ID: PLACEHOLDER_AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: PLACEHOLDER_KEY });
  });

  it("read a pack's note as untrusted: only providers and variables shadowlap knows count", () => {
    const hostile = { anthropic: ['ANTHROPIC_API_KEY', 'NODE_OPTIONS'], gemini: ['PATH'], vertex: ['GOOGLE_API_KEY'], made_up: ['X'], openai: 'OPENAI_API_KEY' };
    expect(keyEnvNote(hostile)).toEqual({ anthropic: ['ANTHROPIC_API_KEY'], gemini: [] });
    expect(placeholderKeys({}, { calls: calls('anthropic', 'gemini', 'openai'), keyEnv: hostile }, 'replay', emptyHome())).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER_KEY, GEMINI_API_KEY: PLACEHOLDER_KEY, GOOGLE_API_KEY: PLACEHOLDER_KEY, GOOGLE_GENERATIVE_AI_API_KEY: PLACEHOLDER_KEY });
    for (const junk of [null, 'anthropic', ['anthropic'], 7]) expect(keyEnvNote(junk)).toBeNull();
  });
});

describe('the note a run keeps of the keys its environment held', () => {
  it('names the providers and variables, never a value', () => {
    const home = emptyHome();
    expect(keyEnvOf({ ANTHROPIC_API_KEY: 'sk-secret', GOOGLE_API_KEY: 'g-secret', AWS_PROFILE: 'ci', OPENAI_API_KEY: '' }, home)).toEqual({ anthropic: ['ANTHROPIC_API_KEY'], gemini: ['GOOGLE_API_KEY'], bedrock: [], 'bedrock-mantle': [] });
    expect(JSON.stringify(keyEnvOf({ ANTHROPIC_API_KEY: 'sk-secret' }, home))).not.toContain('sk-secret');
    expect(hasCredentials({ id: 'vertex' } as never, {}, home)).toBe(false);
  });

  it("is kept on each run, and a replay adds its recording's, so a replay of the replay knows too", () => {
    const store = Store.open(':memory:');
    try {
      const parent = store.createRun({ mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.js'], cwd: '/' }, codeVersion: null, startedAt: Date.now() });
      stampKeyEnv(store, parent.runId, { ANTHROPIC_API_KEY: 'sk-secret' });
      expect(store.getRun(parent.runId)!.meta?.keyEnv).toMatchObject({ anthropic: ['ANTHROPIC_API_KEY'] });
      const replay = store.createRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['node', 'agent.js'], cwd: '/' }, codeVersion: null, startedAt: Date.now() });
      // Replayed where there is no key: the agent ran on a placeholder, and took its key from the environment all the same.
      stampKeyEnv(store, replay.runId, {});
      expect(store.getRun(replay.runId)!.meta?.keyEnv).toMatchObject({ anthropic: ['ANTHROPIC_API_KEY'] });
    } finally {
      store.close();
    }
  });
});
