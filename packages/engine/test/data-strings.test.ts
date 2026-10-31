import { describe, expect, it } from 'vitest';
import { dataStrings, yamlPlainProblem, type DataLanguage } from '../src/data-strings.js';

/**
 * The string values of YAML, JSON and TOML, as their parsers read them, each under its key path:
 * where a repair may rewrite text in such a file (repair-patch.ts), and what the path says of it.
 */

/** Each value as `path: text`, marked `(plain)` for a YAML plain scalar and `(anchored)` under an anchor. */
function values(source: string, language: DataLanguage): string[] {
  return dataStrings(source, language).map((d) => `${d.path.join('.')}: ${source.slice(d.start, d.end)}${d.plain ? ' (plain)' : ''}${d.anchored ? ' (anchored)' : ''}`);
}

describe('dataStrings in YAML', () => {
  it("reads CrewAI's agents.yaml and tasks.yaml: plain, quoted and block scalars, a line of a block or a plain scalar at a time", () => {
    const agents = [
      'researcher:',
      '  role: Senior Data Researcher on {topic}',
      '  goal: "Uncover cutting-edge developments in {topic}"',
      '  backstory: >',
      "    You're a seasoned researcher with a knack for uncovering the latest developments in {topic}.",
      '    Known for your ability to find the most relevant information and present it clearly.',
      '  verbose: true',
      "  llm: 'small-model'  # the cheap one",
      '',
    ].join('\n');
    expect(values(agents, 'yaml')).toEqual([
      'researcher.role: Senior Data Researcher on {topic} (plain)',
      'researcher.goal: Uncover cutting-edge developments in {topic}',
      "researcher.backstory: You're a seasoned researcher with a knack for uncovering the latest developments in {topic}.",
      'researcher.backstory: Known for your ability to find the most relevant information and present it clearly.',
      'researcher.llm: small-model',
    ]);
    const tasks = [
      'research_task:',
      '  description: |',
      '    Conduct a thorough research about {topic}.',
      '',
      '    Make sure you find any interesting and relevant information.',
      '  expected_output: A list with 10 bullet points',
      '    of the most relevant information about {topic}',
      '  tools:',
      '    - search',
      '    - scrape_website',
      '  agent: researcher',
      '',
    ].join('\r\n');
    expect(values(tasks, 'yaml')).toEqual([
      'research_task.description: Conduct a thorough research about {topic}.',
      'research_task.description: Make sure you find any interesting and relevant information.',
      'research_task.expected_output: A list with 10 bullet points (plain)',
      'research_task.expected_output: of the most relevant information about {topic} (plain)',
      'research_task.tools.0: search (plain)',
      'research_task.tools.1: scrape_website (plain)',
      'research_task.agent: researcher (plain)',
    ]);
  });

  it('follows sequences at their key\'s indentation, quoted keys with escapes, and anchors down the nodes under them', () => {
    const compose = [
      'services:',
      '  app:',
      '    image: "agent:latest"',
      '    command: ["python", "agent.py"]',
      '    entrypoint:',
      '      - python',
      '    environment:',
      '      SYSTEM_PROMPT: You are a support agent.',
      '      "\\x63ommand": go',
      'x-common: &common',
      '  restart: always',
      'steps:',
      '- name: one',
      '  run: echo hi',
      '- name: two',
      '',
    ].join('\n');
    expect(values(compose, 'yaml')).toEqual([
      'services.app.image: agent:latest',
      'services.app.entrypoint.0: python (plain)',
      'services.app.environment.SYSTEM_PROMPT: You are a support agent. (plain)',
      'services.app.environment.command: go (plain)',
      'x-common.restart: always (plain) (anchored)',
      'steps.0.name: one (plain)',
      'steps.0.run: echo hi (plain)',
      'steps.1.name: two (plain)',
    ]);
  });

  it('leaves out what it does not read: a quoted scalar over lines, a flow collection, an alias, a complex key, a null, a boolean, a number, a date', () => {
    const yaml = ['a: "starts here', '  and ends here"', 'b: [one,', '  two]', 'c: *ref', 'd: plain # a comment', '? complex', ': value', 'e: ~', 'f: 42', 'g: 2026-10-31', 'h: off', '---', 'i: next document', ''].join('\n');
    expect(values(yaml, 'yaml')).toEqual(['d: plain (plain)', 'i: next document (plain)']);
  });

  it('says why a plain scalar rewritten so would read as YAML syntax or as no text', () => {
    expect(yamlPlainProblem('Senior Data Researcher')).toBeNull();
    expect(yamlPlainProblem('*alias')).toBe('would start it with "*", which YAML reads as its own syntax there');
    expect(yamlPlainProblem('!!python/object/apply:os.system')).toMatch(/^would start it with "!"/);
    expect(yamlPlainProblem('Research: anything')).toBe("would put a ': ' in it, which YAML reads as a key");
    expect(yamlPlainProblem('Research #now')).toBe("would put a ' #' in it, which YAML reads as a comment");
    expect(yamlPlainProblem('true')).toBe('would make it "true", which YAML reads as no text');
  });
});

describe('dataStrings in JSON', () => {
  it('reads every string value under its keys and indexes, and no key; comments, as JSONC writes them, skipped', () => {
    const json = '{\n  "name": "agent",\n  "description": "A support agent",\n  "scripts": { "test": "vitest run", "build": "tsc -b" },\n  "files": ["dist", "README.md"],\n  // a comment with a "quote"\n  "nested": { "\\u0073cripts": "x", "n": 1, "ok": true }\n}\n';
    expect(values(json, 'json')).toEqual(['name: agent', 'description: A support agent', 'scripts.test: vitest run', 'scripts.build: tsc -b', 'files.0: dist', 'files.1: README.md', 'nested.scripts: x']);
  });
});

describe('dataStrings in TOML', () => {
  it('reads basic and literal strings, on one line or several, under their table, keys and indexes', () => {
    const toml = [
      '# A config',
      '[project]',
      'name = "agent"',
      "description = 'A support agent'",
      'dependencies = ["httpx>=0.27", # the client',
      '  "pydantic"]',
      'scripts = { cli = "agent:main" }',
      '',
      '[project.entry-points."pytest11"]',
      'plugin = "agent.plugin"',
      '',
      '[tool.agent]',
      'prompt = """',
      'You are a support agent.',
      'Follow the refund policy."""',
      "literal = '''C:\\path'''",
      'model = "small-model" # the cheap one',
      'a.b = "dotted"',
      'n = 3',
      '',
    ].join('\n');
    expect(values(toml, 'toml')).toEqual([
      'project.name: agent',
      'project.description: A support agent',
      'project.dependencies.0: httpx>=0.27',
      'project.dependencies.1: pydantic',
      'project.scripts.cli: agent:main',
      'project.entry-points.pytest11.plugin: agent.plugin',
      'tool.agent.prompt: \nYou are a support agent.\nFollow the refund policy.',
      'tool.agent.literal: C:\\path',
      'tool.agent.model: small-model',
      'tool.agent.a.b: dotted',
    ]);
  });
});
