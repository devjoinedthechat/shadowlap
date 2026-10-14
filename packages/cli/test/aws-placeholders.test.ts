import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeholderAwsCredentials } from '../src/index.js';

const bedrock = [{ meta: { provider: 'anthropic' } }, { meta: { provider: 'bedrock' } }] as never[];
const emptyHome = () => mkdtempSync(join(tmpdir(), 'fp-home-'));

describe('placeholder AWS credentials for offline replays', () => {
  it('are given to a run with Bedrock calls when the environment has no credential source', () => {
    expect(placeholderAwsCredentials({}, bedrock, emptyHome())).toMatchObject({ AWS_ACCESS_KEY_ID: expect.any(String), AWS_SECRET_ACCESS_KEY: expect.any(String) });
  });

  it('are not given to a run without Bedrock calls', () => {
    expect(placeholderAwsCredentials({}, [{ meta: { provider: 'openai' } }] as never[], emptyHome())).toEqual({});
  });

  it('never replace credentials the environment provides', () => {
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI']) {
      expect(placeholderAwsCredentials({ [name]: 'x' }, bedrock, emptyHome())).toEqual({});
    }
    const home = emptyHome();
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.aws', 'config'), '[default]\n');
    expect(placeholderAwsCredentials({}, bedrock, home)).toEqual({});
    const file = join(emptyHome(), 'creds');
    writeFileSync(file, '[default]\n');
    expect(placeholderAwsCredentials({ AWS_SHARED_CREDENTIALS_FILE: file }, bedrock, emptyHome())).toEqual({});
  });
});
