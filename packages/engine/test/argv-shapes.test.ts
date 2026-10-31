import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, credentialFreeArgv, credentialFreeCommandLine, quoteArgv, sameCommandLine } from '../src/index.js';

/**
 * The shapes the security re-check found a command line's credentials in, which every copy of a run
 * (a pack, an HTML report, a push, a share link, a trace, a dataset) and a fix a push sends must
 * mask: a password after a short option or a user's colon, a body sent with curl, a URL or a JWT an
 * assignment gives, git's extra header, the scripts programs other than a POSIX shell run, a secret
 * a tool takes by a word's place, a connection string's password and a string code gives a key. And
 * what masking must leave alone: a command line with no credential stays as it was, and one an
 * earlier version masked is the same command. Every value is invented.
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

describe("a secret a program takes by a word's place", () => {
  const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const AWS_ID = 'AKIAIOSFODNN7EXAMPLE';
  const VAULT = 'hvs.EXAMPLEtokenEXAMPLEtoken0123';

  it("masks the value config set gives a credential's name, by its words or its last part, and keeps every other setting", () => {
    expect(credentialFreeArgv(['aws', 'configure', 'set', 'aws_secret_access_key', AWS_SECRET])).toEqual(['aws', 'configure', 'set', 'aws_secret_access_key', C]);
    // A flag's value before the command or between it and the name, and a profile's own key.
    expect(credentialFreeArgv(['aws', '--profile', 'dev', 'configure', 'set', 'profile.dev.aws_session_token', T])).toEqual(['aws', '--profile', 'dev', 'configure', 'set', 'profile.dev.aws_session_token', C]);
    expect(credentialFreeArgv(['aws', 'configure', 'set', '--profile', 'dev', 'aws_secret_access_key', AWS_SECRET])).toEqual(['aws', 'configure', 'set', '--profile', 'dev', 'aws_secret_access_key', C]);
    expect(credentialFreeArgv(['npm', 'config', 'set', '//registry.example.com/:_authToken', T])).toEqual(['npm', 'config', 'set', '//registry.example.com/:_authToken', C]);
    // npm's `_auth` read by the part after its registry's colon, given apart or after `=`.
    expect(credentialFreeArgv(['npm', 'config', 'set', '//registry.example.com/:_auth', PW])).toEqual(['npm', 'config', 'set', '//registry.example.com/:_auth', C]);
    expect(credentialFreeArgv(['pnpm', 'config', 'set', `//registry.example.com/:_auth=${PW}`])).toEqual(['pnpm', 'config', 'set', `//registry.example.com/:_auth=${C}`]);
    expect(credentialFreeArgv(['yarn', 'config', 'set', 'npmAuthToken', T])).toEqual(['yarn', 'config', 'set', 'npmAuthToken', C]);
    expect(credentialFreeArgv(['kubectl', 'config', 'set', 'users.admin.token', T])).toEqual(['kubectl', 'config', 'set', 'users.admin.token', C]);
    // An access key's id names the key pair, as a user names a user: kept, its secret masked.
    for (const argv of [['aws', 'configure', 'set', 'aws_access_key_id', AWS_ID], ['aws', 'configure', 'set', 'region', 'us-east-1'], ['npm', 'config', 'set', 'registry', 'https://registry.example.com/'], ['git', 'config', 'set', 'user.name', 'Shadowlap demo'], ['aws', 'configure', 'get', 'aws_secret_access_key']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });

  it("masks mc's secret key and a user's password, vault's token and unseal key, and every value vault kv put writes", () => {
    expect(credentialFreeArgv(['mc', 'alias', 'set', 'store', 'https://minio.example.com', AWS_ID, AWS_SECRET])).toEqual(['mc', 'alias', 'set', 'store', 'https://minio.example.com', AWS_ID, C]);
    // mc's --api and --path take a word of their own, wherever they stand.
    expect(credentialFreeArgv(['mc', 'alias', 'set', '--api', 'S3v4', 'store', 'https://minio.example.com', AWS_ID, AWS_SECRET, '--path', 'auto'])).toEqual(['mc', 'alias', 'set', '--api', 'S3v4', 'store', 'https://minio.example.com', AWS_ID, C, '--path', 'auto']);
    expect(credentialFreeArgv(['mc', 'config', 'host', 'add', 'store', 'https://minio.example.com', AWS_ID, AWS_SECRET])).toEqual(['mc', 'config', 'host', 'add', 'store', 'https://minio.example.com', AWS_ID, C]);
    expect(credentialFreeArgv(['mc', 'admin', 'user', 'add', 'store', 'alice', PW])).toEqual(['mc', 'admin', 'user', 'add', 'store', 'alice', C]);
    expect(credentialFreeArgv(['vault', 'login', VAULT])).toEqual(['vault', 'login', C]);
    expect(credentialFreeArgv(['vault', 'login', '-address', 'https://vault.example.com:8200', '-no-print', VAULT])).toEqual(['vault', 'login', '-address', 'https://vault.example.com:8200', '-no-print', C]);
    expect(credentialFreeArgv(['vault', 'unwrap', VAULT])).toEqual(['vault', 'unwrap', C]);
    expect(credentialFreeArgv(['vault', 'operator', 'unseal', PW])).toEqual(['vault', 'operator', 'unseal', C]);
    expect(credentialFreeArgv(['vault', 'kv', 'put', '-mount=secret', 'db', 'user=app', `password=${PW}`, 'region=eu'])).toEqual(['vault', 'kv', 'put', '-mount=secret', 'db', `user=${C}`, `password=${C}`, `region=${C}`]);
    // A method that signs in with assignments has its password masked by its name, as any assignment's.
    expect(credentialFreeArgv(['vault', 'login', '-method=userpass', 'username=alice', `password=${PW}`])).toEqual(['vault', 'login', '-method=userpass', 'username=alice', `password=${C}`]);
    // In a script, the token alone: the next command's words are its own.
    expect(credentialFreeArgv(['sh', '-c', `vault login ${VAULT} && make deploy`])).toEqual(['sh', '-c', `vault login "${C}" && make deploy`]);
    for (const argv of [['vault', 'login', '-method', 'github'], ['vault', 'login', '-'], ['vault', 'kv', 'get', '-mount=secret', 'db'], ['vault', 'kv', 'put', 'secret/db', '@data.json'], ['mc', 'alias', 'set', 'store', 'https://minio.example.com'], ['mc', 'ls', 'store/bucket']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });

  it('masks the password az login and twine take after -p, and every literal kubectl create secret makes', () => {
    expect(credentialFreeArgv(['az', 'login', '--service-principal', '-u', 'app-id', '-p', PW, '--tenant', 'example.onmicrosoft.com'])).toEqual(['az', 'login', '--service-principal', '-u', 'app-id', '-p', C, '--tenant', 'example.onmicrosoft.com']);
    // As Azure writes one that starts with a dash, and glued; --password as any program's.
    expect(credentialFreeArgv(['az', 'login', '-u', 'alice@example.com', `-p=-${PW}`])).toEqual(['az', 'login', '-u', 'alice@example.com', `-p${C}`]);
    expect(credentialFreeArgv(['az', 'acr', 'login', '-n', 'registry', '-u', 'bot', `-p${PW}`])).toEqual(['az', 'acr', 'login', '-n', 'registry', '-u', 'bot', `-p${C}`]);
    expect(credentialFreeArgv(['az', 'login', '-u', 'alice@example.com', '--password', PW])).toEqual(['az', 'login', '-u', 'alice@example.com', '--password', C]);
    expect(credentialFreeArgv(['twine', 'upload', '-u', '__token__', '-p', 'pypi-EXAMPLE0123456789', 'dist/*'])).toEqual(['twine', 'upload', '-u', '__token__', '-p', C, 'dist/*']);
    expect(credentialFreeArgv(['python', '-m', 'twine', 'upload', '-p', 'pypi-EXAMPLE0123456789', 'dist/*'])).toEqual(['python', '-m', 'twine', 'upload', '-p', C, 'dist/*']);
    expect(credentialFreeArgv(['kubectl', 'create', 'secret', 'generic', 'db', `--from-literal=password=${PW}`, '--from-literal', 'url=postgres://db.example.com/app', '--from-literal=region=eu'])).toEqual(['kubectl', 'create', 'secret', 'generic', 'db', `--from-literal=password=${C}`, '--from-literal', `url=${C}`, `--from-literal=region=${C}`]);
    expect(credentialFreeArgv(['oc', 'create', 'secret', 'generic', 'db', `--from-literal=key=${PW}`])).toEqual(['oc', 'create', 'secret', 'generic', 'db', `--from-literal=key=${C}`]);
    // -p is az's parameters file elsewhere; a ConfigMap's literals are no secret.
    for (const argv of [['az', 'deployment', 'group', 'create', '-g', 'rg', '-f', 'main.bicep', '-p', 'params.json'], ['kubectl', 'create', 'configmap', 'cfg', '--from-literal=region=eu']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });

  it("masks a libpq connection string's password, and --user's password for a program no rule names", () => {
    expect(credentialFreeArgv(['psql', `host=db.example.com port=5432 user=app password=${PW} dbname=shop`])).toEqual(['psql', `host=db.example.com port=5432 user=app password=${C} dbname=shop`]);
    // Its spaces around `=`, a quoted value, the key file's password; and in an assignment.
    expect(credentialFreeArgv(['pg_dump', '-d', "host = db sslpassword = 'pw with spaces' dbname=shop"])).toEqual(['pg_dump', '-d', `host = db sslpassword = ${C} dbname=shop`]);
    expect(credentialFreeArgv(['env', `PG_DSN=host=db user=app password=${PW}`, 'node', 'agent.js'])).toEqual(['env', `PG_DSN=host=db user=app password=${C}`, 'node', 'agent.js']);
    expect(credentialFreeArgv(['etcdctl', '--user', `root:${PW}`, 'get', 'config'])).toEqual(['etcdctl', '--user', `root:${C}`, 'get', 'config']);
    expect(credentialFreeArgv(['agent', `--user=alice@example.com:${PW}`, '--user', 'u:p'])).toEqual(['agent', `--user=alice@example.com:${C}`, '--user', `u:${C}`]);
    // A user and group, a URL, a drive's path, a user alone and a flag that takes nothing stay.
    for (const argv of [['psql', 'host=db dbname=shop'], ['docker-compose', 'run', '--user', '1000:1000', 'agent'], ['podman', 'run', '--user', 'app:app', 'img'], ['pip', 'install', '--user', 'git+https://github.com/o/r'], ['pip', 'install', '--user', 'C:\\wheels\\agent.whl'], ['systemctl', '--user', 'start', 'agent'], ['wget', '--user', 'alice', 'https://example.com/x']]) expect(credentialFreeArgv(argv), argv.join(' ')).toBe(argv);
  });

  it('masks a string a script assigns a credential with spaces around its =, or gives one as a member, in its own quotes', () => {
    expect(credentialFreeArgv(['python', '-c', `api_key = "${T}"; run()`])).toEqual(['python', '-c', `api_key = "${C}"; run()`]);
    expect(credentialFreeArgv(['python', '-c', `import openai; openai.api_key = '${T}'; import agent`])).toEqual(['python', '-c', `import openai; openai.api_key = '${C}'; import agent`]);
    expect(credentialFreeArgv(['python', '-c', `api_key= "${T}"; token ="${T}"`])).toEqual(['python', '-c', `api_key= "${C}"; token ="${C}"`]);
    expect(credentialFreeArgv(['node', '-e', `const apiKey = '${T}'; main({ apiKey: '${T}', model: 'm' })`])).toEqual(['node', '-e', `const apiKey = '${C}'; main({ apiKey: '${C}', model: 'm' })`]);
    expect(credentialFreeArgv(['python', '-c', `run({"api_key": "${T}", "model": "m"})`])).toEqual(['python', '-c', `run({"api_key": "${C}", "model": "m"})`]);
    // Code is kept: what reads a key from elsewhere, a type, a comparison, and a value that isn't a credential's.
    for (const argv of [['python', '-c', 'import os; api_key = os.environ["OPENAI_API_KEY"]; run(api_key)'], ['python', '-c', 'def run(api_key: str): pass'], ['python', '-c', 'if password == "": run()'], ['python', '-c', 'retries = "3"; run(retries)']]) expect(credentialFreeArgv(argv), argv[2]).toBe(argv);
  });

  it('reads a command line an earlier version kept these in as the same command, and two commands as two', () => {
    // As a pack an earlier version wrote it, the secrets these rules read as they ran, the rest masked its way.
    const ran = ['sh', '-c', `aws configure set aws_secret_access_key ${AWS_SECRET} && mc alias set store https://minio.example.com ${AWS_ID} ${AWS_SECRET} && vault login ${VAULT} && node agent.js --api-key ${T}`];
    const earlier = ['sh', '-c', `aws configure set aws_secret_access_key ${AWS_SECRET} && mc alias set store https://minio.example.com ${AWS_ID} ${AWS_SECRET} && vault login ${VAULT} && node agent.js --api-key "${C}"`];
    expect(sameCommandLine(ran, earlier)).toBe(true);
    expect(sameCommandLine(ran, credentialFreeArgv(ran))).toBe(true);
    // Masking leaves apart what isn't a secret: another account's address, another secret's name.
    expect(sameCommandLine(['vault', 'login', '-address', 'https://a.example.com', VAULT], ['vault', 'login', '-address', 'https://b.example.com', VAULT])).toBe(false);
    expect(sameCommandLine(['kubectl', 'create', 'secret', 'generic', 'db', `--from-literal=password=${PW}`], ['kubectl', 'create', 'secret', 'generic', 'cache', `--from-literal=password=${PW}`])).toBe(false);
    expect(sameCommandLine(['mc', 'alias', 'set', 'a', 'https://minio.example.com', AWS_ID, AWS_SECRET], ['mc', 'alias', 'set', 'a', 'https://minio.example.com', 'AKIAI44QH8DHBEXAMPLE', AWS_SECRET])).toBe(false);
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
