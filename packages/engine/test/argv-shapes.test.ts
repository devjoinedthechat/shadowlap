import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, credentialFreeArgv, credentialFreeCommandLine, quoteArgv } from '../src/index.js';

/**
 * The shapes the security re-check found a command line's credentials in, which every copy of a run
 * (a pack, an HTML report, a push, a share link, a trace, a dataset) and a fix a push sends must
 * mask: a password after a short option or a user's colon, a body sent with curl, a URL or a JWT an
 * assignment gives, git's extra header, and the scripts programs other than a POSIX shell run. And
 * what masking must leave alone: a command line with no credential stays as it was. Every value is
 * invented.
 */

const T = 'ghp_FAKEfakeFAKEfake0123456789abcdefABCD';
const PW = 'pw_FAKE_0123';
const URL = 'https://api.example.com/x';
const b64u = (s: string) => Buffer.from(s).toString('base64url');
const JWT = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u('{"sub":"FAKE_ARGV_JWT"}')}.c2ln`;

describe("a password a program takes under a name that doesn't say so", () => {
  it("masks curl's user:password, keeping the user, and leaves a user alone, a uid:gid and a drive's path", () => {
    expect(credentialFreeArgv(['curl', '-u', `alice:${PW}`, URL])).toEqual(['curl', '-u', `alice:${C}`, URL]);
    expect(credentialFreeArgv(['curl', `--user=alice:${PW}`, '-sSu', `bob:${PW}`, `-ucarol:${PW}`, '--proxy-user', `dan:${PW}`, URL])).toEqual(['curl', `--user=alice:${C}`, '-sSu', `bob:${C}`, `-ucarol:${C}`, '--proxy-user', `dan:${C}`, URL]);
    for (const argv of [['curl', '-u', 'alice', URL], ['docker', 'run', '-u', '1000:1000', '--user', 'app:app', 'img'], ['python', '-u', 'C:\\agent\\main.py']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });

  it('masks -p where the program takes a password there, and leaves it a port or a path everywhere else', () => {
    // mysql's own -p takes its password glued (`-pPW`): a word after a bare -p is the database.
    expect(credentialFreeArgv(['mysql', '-u', 'root', `-p${PW}`, 'shop'])).toEqual(['mysql', '-u', 'root', `-p${C}`, 'shop']);
    expect(credentialFreeArgv(['mongosh', '-u', 'admin', '-p', PW, '--authenticationDatabase', 'admin'])).toEqual(['mongosh', '-u', 'admin', '-p', C, '--authenticationDatabase', 'admin']);
    expect(credentialFreeArgv(['sshpass', '-p', PW, 'ssh', 'deploy@host', 'uptime'])).toEqual(['sshpass', '-p', C, 'ssh', 'deploy@host', 'uptime']);
    expect(credentialFreeArgv(['docker', 'login', '-u', 'bot', '-p', PW, 'registry.example.com'])).toEqual(['docker', 'login', '-u', 'bot', '-p', C, 'registry.example.com']);
    // The same password under another letter: redis-cli's -a, sqlcmd's -P, an LDAP tool's -w, smbclient's user%password.
    expect(credentialFreeArgv(['redis-cli', '-h', 'cache', '-p', '6380', '-a', PW])).toEqual(['redis-cli', '-h', 'cache', '-p', '6380', '-a', C]);
    expect(credentialFreeArgv(['sqlcmd', '-S', 'db', '-U', 'sa', '-P', PW])).toEqual(['sqlcmd', '-S', 'db', '-U', 'sa', '-P', C]);
    expect(credentialFreeArgv(['ldapsearch', '-D', 'cn=admin,dc=example,dc=com', '-w', PW])).toEqual(['ldapsearch', '-D', 'cn=admin,dc=example,dc=com', '-w', C]);
    expect(credentialFreeArgv(['smbclient', '//files/share', '-U', `alice%${PW}`])).toEqual(['smbclient', '//files/share', '-U', `alice%${C}`]);
    for (const argv of [['ssh', '-p', '2222', 'deploy@host', 'uptime'], ['docker', 'run', '-p', '8080:80', 'img'], ['mkdir', '-p', 'out/a'], ['psql', '-h', 'db', '-p', '5432', '-U', 'app', '-d', 'shop'], ['mysql', '-p', 'shop']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });
});

describe('a body curl sends', () => {
  it("reads -d, --data…, --json and -F as a form's or a JSON body's fields", () => {
    expect(credentialFreeArgv(['curl', '-d', `grant_type=client_credentials&client_secret=${PW}&scope=read`, URL])).toEqual(['curl', '-d', `grant_type=client_credentials&client_secret=${C}&scope=read`, URL]);
    expect(credentialFreeArgv(['curl', '--data-urlencode', `password=${PW}`, '--data', `{"client_id":"app","client_secret":"${PW}"}`, '--json', `{"api_key":"${T}"}`, '-F', `api_key=${PW}`, '-F', 'file=@report.pdf', `-dtoken=${T}`, URL])).toEqual([
      'curl',
      '--data-urlencode',
      `password=${C}`,
      '--data',
      `{"client_id":"app","client_secret":"${C}"}`,
      '--json',
      `{"api_key":"${C}"}`,
      '-F',
      `api_key=${C}`,
      '-F',
      'file=@report.pdf',
      `-dtoken=${C}`,
      URL,
    ]);
    for (const argv of [['curl', '-d', 'q=refund&page=2', URL], ['date', '-d', 'next monday'], ['docker', 'run', '-d', 'img']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });
});

describe('an assignment whose name says nothing', () => {
  it('masks the credential its value holds: a URL with a password, a JWT, the header git sends', () => {
    expect(credentialFreeArgv(['env', `DATABASE_URL=postgres://app:${PW}@db.internal/app`, `WHO=${JWT}`, 'MODE=fast', 'node', 'agent.js'])).toEqual(['env', `DATABASE_URL=postgres://app:${C}@db.internal/app`, `WHO=${C}`, 'MODE=fast', 'node', 'agent.js']);
    expect(credentialFreeArgv(['git', '-c', `http.extraheader=AUTHORIZATION: basic ${T}`, 'clone', 'https://github.com/o/r.git'])).toEqual(['git', '-c', `http.extraheader=AUTHORIZATION: ${C}`, 'clone', 'https://github.com/o/r.git']);
    // A URL's password in a flag's text, where it isn't the whole value.
    expect(credentialFreeArgv(['node', 'agent.js', '--endpoint', `curl https://u:${PW}@h.example.com/x`])).toEqual(['node', 'agent.js', '--endpoint', `curl https://u:${C}@h.example.com/x`]);
  });
});

describe('a script a program other than a POSIX shell runs', () => {
  it("masks it word by word, as sh -c's is, each word in the quotes its language wrote it in", () => {
    expect(credentialFreeArgv(['cmd', '/c', `set GITHUB_TOKEN=${T} && node agent.js`])).toEqual(['cmd', '/c', `set GITHUB_TOKEN=${C} && node agent.js`]);
    expect(credentialFreeArgv(['pwsh', '-Command', `$env:GITHUB_TOKEN='${T}'; node agent.js`])).toEqual(['pwsh', '-Command', `$env:GITHUB_TOKEN='${C}'; node agent.js`]);
    expect(credentialFreeArgv(['python', '-c', `import os; os.environ['GITHUB_TOKEN']='${T}'; import agent`])).toEqual(['python', '-c', `import os; os.environ['GITHUB_TOKEN']='${C}'; import agent`]);
    expect(credentialFreeArgv(['node', '-e', `process.env.GITHUB_TOKEN='${T}'; require('./agent')`])).toEqual(['node', '-e', `process.env.GITHUB_TOKEN='${C}'; require('./agent')`]);
  });

  it("masks an ssh remote command and a --build script as a shell's", () => {
    expect(credentialFreeArgv(['ssh', 'deploy@host', `export API_TOKEN=${T}; ./deploy.sh`])).toEqual(['ssh', 'deploy@host', `export API_TOKEN="${C}"; ./deploy.sh`]);
    expect(credentialFreeArgv(['shadowlap', 'verify', '--build', `pip install -i https://__token__:${PW}@pypi.example.com/simple -r req.txt`])).toEqual(['shadowlap', 'verify', '--build', `pip install -i "https://__token__:${C}@pypi.example.com/simple" -r req.txt`]);
    // A verdict's command line and flags as a fix keeps them: the build script's header and URL, the flags' script.
    const line = `shadowlap verify --fixes x --build 'curl -sH "Authorization: Bearer ${T}" https://ci:${PW}@build.example.com/x' -- node agent.js`;
    expect(credentialFreeCommandLine(line)).toBe(`shadowlap verify --fixes x --build 'curl -sH "Authorization: ${C}" "https://ci:${C}@build.example.com/x"' -- node agent.js`);
    expect(credentialFreeArgv(['', '--build', `export GITHUB_TOKEN=${T} && make`, '--base', 'HEAD~1'])).toEqual(['', '--build', `export GITHUB_TOKEN="${C}" && make`, '--base', 'HEAD~1']);
  });
});

describe('a command line with no credential', () => {
  it("stays as it was, the demo's among them", () => {
    const plain = [
      ['node', 'agent.mjs', 'A-1042'],
      ['shadowlap', 'blame', '01K5CQ4V3H', '--expect', '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}', '--concurrency', '4'],
      ['shadowlap', 'repair', '--fixes', 'label:refund-bug', '--keeps', 'label:good', '--expect', '@refund-check.json'],
      ['python', 'agent.py', '--model', 'claude-sonnet-4-5', '--task', 'Refund order A-1042 for $240 to alice@example.com'],
      ['npx', 'tsx', 'src/agent.ts', '--set', 'temperature=0.2', '--prompt', 'title: Refund policy'],
      ['docker', 'run', '--rm', '-u', '1000:1000', '-p', '8080:80', '-d', '-e', 'MODE=fast', 'img', 'python', '-u', 'agent.py'],
      ['bash', '-lc', 'cd app && npm test -- --watch=false'],
      ['cmd', '/c', 'npm run agent'],
      ['pwsh', '-Command', 'Get-ChildItem; node agent.js'],
      ['python', '-c', 'import agent; agent.main(retries=3)'],
      ['git', '-c', 'user.name=Shadowlap demo', '-c', 'core.autocrlf=false', 'commit', '-m', 'fix: escalate refunds'],
      ['curl', '-sS', '-H', 'Accept: application/json', '-d', 'q=refund&page=2', 'https://api.example.com/search?q=refund'],
      ['ssh', '-p', '2222', 'deploy@host', 'cd /srv/app && ./deploy.sh --env=staging'],
    ];
    for (const argv of plain) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
    // As the CLI keeps a step's command line: the same text.
    for (const line of plain.map((a) => quoteArgv(a))) expect(credentialFreeCommandLine(line), line).toBe(line);
  });
});
