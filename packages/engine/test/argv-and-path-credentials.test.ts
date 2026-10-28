import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, credentialFreeArgv, credentialFreeCallName, credentialFreeQuery, credentialFreeUrl, maskJsonTextCredentials, maskPathCredentials, sameCommandLine, withoutCredentials, withoutStoredCredentials } from '../src/http.js';

/**
 * What the review found reaching a pack, an HTML file, a push, a share link and a trace: a key
 * passed on the agent's command line, the token a webhook's address carries in its path, and a
 * session in a captured call's query. Its planted values, the rest as sent.
 */

const b64u = (s: string) => Buffer.from(s).toString('base64url');
const jwt = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u('{"sub":"SLSEC_ARGV_JWT","iat":1}')}.c2ln`;

describe('a command line', () => {
  it("masks a credential flag's value, as --flag value and --flag=value, with one dash or two", () => {
    expect(credentialFreeArgv(['node', 'agent.mjs', '--api-key', 'SLSEC_ARGV_0123456789'])).toEqual(['node', 'agent.mjs', '--api-key', C]);
    expect(credentialFreeArgv(['node', 'agent.mjs', '--api-key=SLSEC_ARGV_0123456789', '--model', 'claude'])).toEqual(['node', 'agent.mjs', `--api-key=${C}`, '--model', 'claude']);
    // Go's flags take one dash; a token is one whatever its value, a password, a secret, a bearer too.
    expect(credentialFreeArgv(['./agent', '-token', 'abc', '--password', 'hunter2', '--client-secret=s3cr3t', '--auth', 'user:pass', '--session', 'SLSEC_ARGV_SESSION'])).toEqual(['./agent', '-token', C, '--password', C, `--client-secret=${C}`, '--auth', C, '--session', C]);
    // A bare --key or --code is one only when its value reads as one.
    expect(credentialFreeArgv(['tool', '--key', 'cache.json', '--code', 'EU'])).toEqual(['tool', '--key', 'cache.json', '--code', 'EU']);
    expect(credentialFreeArgv(['tool', '--key', 'sk-ant-api03-SLSEC0123456789abcdef'])).toEqual(['tool', '--key', C]);
  });

  it('keeps a flag that says where a credential is, a flag with no value, and the program', () => {
    const argv = ['node', 'agent.mjs', '--password-file', '/run/secrets/db', '--token-env', 'AGENT_TOKEN', '--api-key-path', 'key.txt', '--password-stdin', '--auth', '--verbose', 'refund'];
    // `--auth` is followed by a flag: it has no value to mask.
    expect(credentialFreeArgv(argv)).toBe(argv);
    expect(credentialFreeArgv(['--api-key', 'x'])).toEqual(['--api-key', 'x']);
  });

  it('masks a JWT, an assignment, a header line and a URL in any argument', () => {
    expect(credentialFreeArgv(['env', 'OPENAI_API_KEY=SLSEC_ARGV_ENVKEY_0123', 'MODE=fast', 'node', 'agent.mjs'])).toEqual(['env', `OPENAI_API_KEY=${C}`, 'MODE=fast', 'node', 'agent.mjs']);
    expect(credentialFreeArgv(['helm', 'install', '--set', 'auth.password=SLSEC_ARGV_HELM', '--set', 'image.tag=v2'])).toEqual(['helm', 'install', '--set', `auth.password=${C}`, '--set', 'image.tag=v2']);
    expect(credentialFreeArgv(['curl', '-H', 'Authorization: Bearer SLSEC_ARGV_BEARER', '-H', 'Accept: application/json', 'https://api.example.com/x'])).toEqual(['curl', '-H', `Authorization: ${C}`, '-H', 'Accept: application/json', 'https://api.example.com/x']);
    expect(credentialFreeArgv(['agent', jwt])).toEqual(['agent', C]);
    expect(credentialFreeArgv(['agent', '--db', 'postgres://app:SLSEC_ARGV_DBPASS@db/app', '--notify=https://hooks.slack.com/services/T0/B0/SLSEC_ARGV_HOOK', 'https://api.example.com/v1?access_token=SLSEC_ARGV_QS'])).toEqual(['agent', '--db', `postgres://app:${C}@db/app`, `--notify=https://hooks.slack.com/services/T0/B0/${C}`, `https://api.example.com/v1?access_token=${C}`]);
  });

  it('is the same command line as the one it masks, and masking it again changes nothing', () => {
    const argv = ['node', 'agent.mjs', '--api-key', 'SLSEC_ARGV_0123456789'];
    const masked = credentialFreeArgv(argv);
    expect(credentialFreeArgv(masked)).toBe(masked);
    expect(sameCommandLine(argv, masked)).toBe(true);
    expect(sameCommandLine(argv, ['node', 'agent.mjs', '--api-key', 'other'])).toBe(true);
    expect(sameCommandLine(argv, ['node', 'other.mjs', '--api-key', 'SLSEC_ARGV_0123456789'])).toBe(false);
  });
});

describe("a webhook's address", () => {
  it("masks the secret in Slack's, Discord's and a Telegram bot's path, wherever they are served from", () => {
    expect(maskPathCredentials('/services/T0123/B0456/SLSEC_TP_SLACKHOOK_q1w2')).toBe(`/services/T0123/B0456/${C}`);
    expect(maskPathCredentials('/workflows/T0123/A0456/7890/SLSEC_TP_SLACKWF')).toBe(`/workflows/T0123/A0456/7890/${C}`);
    expect(maskPathCredentials('/triggers/T0123/7890/SLSEC_TP_SLACKTRIGGER/')).toBe(`/triggers/T0123/7890/${C}/`);
    expect(maskPathCredentials('/api/webhooks/123456/SLSEC_R2_DISCORDTOKEN_q1w2e3r4')).toBe(`/api/webhooks/123456/${C}`);
    expect(maskPathCredentials('/api/v10/webhooks/123456/SLSEC_DISCORD/messages/42')).toBe(`/api/v10/webhooks/123456/${C}/messages/42`);
    expect(maskPathCredentials('/bot123456789:AAH_SLSEC_TP_TELEGRAM_0123456789abcdefghij/sendMessage')).toBe(`/bot123456789:${C}/sendMessage`);
    expect(maskPathCredentials('/file/bot123456789:AAH_SLSEC_TP_TELEGRAMFILE/photos/1.jpg')).toBe(`/file/bot123456789:${C}/photos/1.jpg`);
    expect(maskPathCredentials('/cb;jsessionid=SLSEC_PT_JSESSIONID_q1w2e3;lang=en')).toBe(`/cb;jsessionid=${C};lang=en`);
    // Paths of the same words that carry none stay as they are.
    for (const path of ['/services/billing/v1/invoices', '/api/webhooks', '/api/webhooks/list', '/api/webhooks/123', '/botanist/123', '/bot/help', '/v1/messages']) expect(maskPathCredentials(path), path).toBe(path);
  });

  it("masks it in a captured call's name and address, a URL in a body, and a call's stored arguments", () => {
    expect(credentialFreeCallName('POST hooks.slack.com/services/T0/B0/SLSEC_TP_SLACKHOOK')).toBe(`POST hooks.slack.com/services/T0/B0/${C}`);
    expect(credentialFreeCallName('POST 127.0.0.1:53050/api/webhooks/123456/SLSEC_R2_DISCORDTOKEN')).toBe(`POST 127.0.0.1:53050/api/webhooks/123456/${C}`);
    expect(credentialFreeCallName('POST /v1/messages')).toBe('POST /v1/messages');
    expect(credentialFreeCallName('send_email')).toBe('send_email');
    expect(credentialFreeUrl('http://127.0.0.1:53050/bot123:AAH_SLSEC/sendMessage?chat_id=1&session=SLSEC_QS_SESSION')).toBe(`http://127.0.0.1:53050/bot123:${C}/sendMessage?chat_id=1&session=${C}`);
    expect(withoutStoredCredentials({ method: 'POST', url: 'https://hooks.slack.com/services/T0/B0/SLSEC_TP_SLACKHOOK', body: '{"text":"hi"}', encoding: 'text' })).toEqual({ method: 'POST', url: `https://hooks.slack.com/services/T0/B0/${C}`, body: '{"text":"hi"}', encoding: 'text' });
    const body = '{"dsn":"x","webhook_url":"https://hooks.slack.com/services/T0/B0/SLSEC_JWB_WEBHOOKURL_q1w2"}';
    expect(maskJsonTextCredentials(body)).toBe(`{"dsn":"x","webhook_url":"https://hooks.slack.com/services/T0/B0/${C}"}`);
  });
});

describe("a captured call's query", () => {
  it('masks a session, a ticket and a signed proof, and a secret key, an access key or a hash that reads as one', () => {
    const query = '?session=SLSEC_QS_SESSION_q1w2e3&sid=SLSEC_QS_SID_q1w2e3&ticket=ST-1-SLSEC&appsecret_proof=SLSEC_QS_PROOF&sk=SLSEC_QS_BAIDUSK_q1w2e3&ak=SLSEC_QS_BAIDUAK_q1w2e3&hash=5d41402abc4b2a76b9719d911017c592&q=refund';
    expect(withoutCredentials(query)).toBe(`?session=${C}&sid=${C}&ticket=${C}&appsecret_proof=${C}&sk=${C}&ak=${C}&hash=${C}&q=refund`);
    // A short value of a name that is a lookup as often stays.
    expect(withoutCredentials('hash=v2&sk=en&ak=1')).toBe('hash=v2&sk=en&ak=1');
    // A model call's query keeps none of them, by name alone.
    expect(credentialFreeQuery('beta=true&session=SLSEC_MQ_SESSION_q1w2e3&sk=SLSEC_MQ_BAIDUSK_q1w2e3')).toBe('beta=true');
  });
});
