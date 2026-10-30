import { describe, expect, it } from 'vitest';
import { quoteArgv } from '../src/text.js';
import { credentialFreeArgv, credentialFreeCommandLine, sameCommandLine } from '../src/argv-credentials.js';
import { CREDENTIAL_PLACEHOLDER as C, credentialFreeCallName, credentialFreeQuery, credentialFreeUrl, maskJsonTextCredentials, maskPathCredentials, withoutCredentials, withoutStoredCredentials } from '../src/http.js';

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

  it("masks a script a shell runs word by word: an assignment's value to where its word ends, and the rest of the script kept", () => {
    expect(credentialFreeArgv(['sh', '-c', 'OPENAI_API_KEY=sk-test-EXAMPLE0000 node agent.js --task refund'])).toEqual(['sh', '-c', `OPENAI_API_KEY="${C}" node agent.js --task refund`]);
    // Its words as a shell reads them: quoted, after `;`, a flag's value and a header line too; bash -lc after env.
    const script = `export API_KEY='sk-test-EXAMPLE0001'; node agent.js --api-key sk-test-EXAMPLE0002 -H 'Authorization: Bearer sk-test-EXAMPLE0003' && echo "done"`;
    const masked = credentialFreeArgv(['env', 'MODE=fast', '/bin/bash', '-lc', script]);
    expect(masked).toEqual(['env', 'MODE=fast', '/bin/bash', '-lc', `export API_KEY="${C}"; node agent.js --api-key "${C}" -H "Authorization: ${C}" && echo "done"`]);
    expect(credentialFreeArgv(masked)).toBe(masked);
    // A script inside a script, and one with nothing to mask, kept as it is.
    expect(credentialFreeArgv(['docker', 'exec', 'app', 'sh', '-c', `bash -c 'TOKEN=sk-test-EXAMPLE0004 ./run' > out.log`])).toEqual(['docker', 'exec', 'app', 'sh', '-c', `bash -c 'TOKEN="${C}" ./run' > out.log`]);
    const plain = ['sh', '-c', 'MODE=fast node agent.js | tee out.log'];
    expect(credentialFreeArgv(plain)).toBe(plain);
    // Outside a script, an assignment's value with spaces is masked whole, as before; so is a script whose quote is left open.
    expect(credentialFreeArgv(['env', 'DB_PASSWORD=correct horse battery staple', 'node', 'agent.js'])).toEqual(['env', `DB_PASSWORD=${C}`, 'node', 'agent.js']);
    // Python's code is a script too, its value masked in the quotes Python wrote it in (argv-shapes.test.ts has the other languages).
    expect(credentialFreeArgv(['python', '-c', 'API_KEY="sk-test-EXAMPLE0005"; run()'])).toEqual(['python', '-c', `API_KEY="${C}"; run()`]);
    expect(credentialFreeArgv(['sh', '-c', "OPENAI_API_KEY='sk-test-EXAMPLE0006 node agent.js"])).toEqual(['sh', '-c', `OPENAI_API_KEY=${C}`]);
  });

  it('masks a command line written as one text, as quoteArgv writes it, each word as an argument, the rest as it was', () => {
    // A blame's command as the CLI printed it: a request field it set, and the command given after `--`.
    const line = quoteArgv(['shadowlap', 'blame', '01K5CQ4V3H', '--set', 'api_key=sk-test-EXAMPLE0000', '--', 'node', 'agent.js', '--api-key', 'sk-test-EXAMPLE0001', '--note', 'a ‮ word']);
    const masked = credentialFreeCommandLine(line);
    expect(masked).toBe(`shadowlap blame 01K5CQ4V3H --set 'api_key=${C}' -- node agent.js --api-key '${C}' --note $'a \\u202e word'`);
    expect(credentialFreeCommandLine(masked)).toBe(masked);
    // A script after `sh -c`, word by word; one with nothing to mask, and one whose quote is left open.
    const script = quoteArgv(['shadowlap', 'verify', '--', 'sh', '-c', "OPENAI_API_KEY=sk-test-EXAMPLE0002 node agent.js --task 'refund it'"]);
    expect(credentialFreeCommandLine(script)).toBe(quoteArgv(['shadowlap', 'verify', '--', 'sh', '-c', `OPENAI_API_KEY="${C}" node agent.js --task 'refund it'`]));
    const plain = quoteArgv(['shadowlap', 'repair', '--fixes', 'label:refund', '--', 'python', 'agent.py']);
    expect(credentialFreeCommandLine(plain)).toBe(plain);
    expect(credentialFreeCommandLine("shadowlap blame 01K5 -- node agent.js --api-key sk-test-EXAMPLE0003 --note 'open")).toBe(`shadowlap blame 01K5 -- node agent.js --api-key '${C}' --note 'open`);
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
