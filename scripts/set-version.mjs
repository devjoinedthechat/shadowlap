// Sets one version across every publishable package, their internal dependencies, the Python SDK and
// the Claude Code plugin in coding-agents/.
// Usage: node scripts/set-version.mjs 0.1.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <semver>');
  process.exit(2);
}

const PACKAGES = ['packages/engine', 'packages/sidecar', 'packages/sdk', 'packages/adapters', 'packages/tui', 'packages/remote', 'packages/dashboard', 'packages/cli', 'packages/test', 'packages/collector'];
const PRIVATE = ['testing/mock-anthropic', 'testing/mock-openai', 'testing/mock-gemini', 'testing/reference-agent'];
const INTERNAL = new Set(['@shadowlap/engine', '@shadowlap/sidecar', '@shadowlap/sdk', '@shadowlap/adapters', '@shadowlap/tui', '@shadowlap/remote', '@shadowlap/dashboard', '@shadowlap/collector', '@shadowlap/test', 'shadowlap', '@shadowlap-testing/mock-anthropic', '@shadowlap-testing/mock-openai', '@shadowlap-testing/mock-gemini', '@shadowlap-testing/reference-agent']);

for (const dir of [...PACKAGES, ...PRIVATE]) {
  const file = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) if (INTERNAL.has(name)) pkg[field][name] = `^${version}`;
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

const py = 'sdks/python/pyproject.toml';
writeFileSync(py, readFileSync(py, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`));
const init = 'sdks/python/shadowlap/__init__.py';
writeFileSync(init, readFileSync(init, 'utf8').replace(/^__version__ = ".*"$/m, `__version__ = "${version}"`));

// The Claude Code plugin is versioned with the CLI whose commands its skill names.
const plugin = 'coding-agents/claude-code/.claude-plugin/plugin.json';
const manifest = JSON.parse(readFileSync(plugin, 'utf8'));
manifest.version = version;
writeFileSync(plugin, JSON.stringify(manifest, null, 2) + '\n');

console.log(`version ${version} set in ${PACKAGES.length} packages, the Python SDK and the Claude Code plugin; run npm install to refresh the lockfile`);
