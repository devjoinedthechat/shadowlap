import { describe, expect, it } from 'vitest';
import { guessImportFormat, IMPORT_FILE_FORMATS } from '../src/import-format.js';

describe('guessImportFormat', () => {
  it('goes by the extension, and for .json by what the name says', () => {
    expect(guessImportFormat('traffic.har')).toEqual({ format: 'har' });
    expect(guessImportFormat('capture-worker-3.jsonl')).toEqual({ format: 'litellm' });
    expect(guessImportFormat('otel-traces.json')).toEqual({ format: 'otel' });
    expect(guessImportFormat('export-OTLP.json')).toEqual({ format: 'otel' });
    expect(guessImportFormat('support-trace.json')).toEqual({ format: 'otel' });
    expect(guessImportFormat('refund_cassette.json')).toEqual({ format: 'vcr' });
    expect(guessImportFormat('VCR-session.JSON')).toEqual({ format: 'vcr' });
    expect(guessImportFormat('recording.json')).toEqual({ format: 'nock' });
  });

  it('looks at the name only, not the folders it sits in', () => {
    expect(guessImportFormat('/home/me/traces/recording.json')).toEqual({ format: 'nock' });
    expect(guessImportFormat('C:\\captures\\vcr\\session.har')).toEqual({ format: 'har' });
  });

  it('refuses YAML and anything else, with the reason to show', () => {
    const yaml = guessImportFormat('cassette.yaml');
    expect(yaml.format).toBeNull();
    expect(yaml.reason).toMatch(/converted to JSON first/);
    expect(guessImportFormat('cassette.YML').format).toBeNull();
    for (const name of ['notes.txt', 'archive.json.gz', 'Makefile', '.json', 'trace']) {
      const guess = guessImportFormat(name);
      expect(guess.format).toBeNull();
      expect(guess.reason).toMatch(/Not a format shadowlap imports/);
    }
  });

  it('goes by the top-level keys when the name says nothing about the format', () => {
    const otlp = '{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[]}]}';
    expect(guessImportFormat('export.json', otlp)).toEqual({ format: 'otel' });
    expect(guessImportFormat('collector-out.jsonl', otlp + '\n' + otlp)).toEqual({ format: 'otel' });
    expect(guessImportFormat('collector-logs.json', '{"resourceLogs":[]}')).toEqual({ format: 'otel' });
    expect(guessImportFormat('tempo-download.json', '{"batches":[]}')).toEqual({ format: 'otel' });
    expect(guessImportFormat('session.json', '{\n  "log": {\n    "version": "1.2",\n    "entries": []\n  }\n}')).toEqual({ format: 'har' });
    expect(guessImportFormat('refunds.json', '{"interactions":[{"request":{}}],"version":1}')).toEqual({ format: 'vcr' });
    expect(guessImportFormat('gateway.json', '{"format":"shadowlap-capture","v":1}')).toEqual({ format: 'litellm' });
    expect(guessImportFormat('recording.json', '[{"scope":"https://api.openai.com:443","method":"POST"}]')).toEqual({ format: 'nock' });
    // Bytes work as well as text, and a byte-order mark is no obstacle.
    expect(guessImportFormat('export.json', new TextEncoder().encode('\uFEFF' + otlp))).toEqual({ format: 'otel' });
    // Only the start of a long file is given: its first key is enough.
    expect(guessImportFormat('export.json', `{"resourceSpans":[${'{"x":1},'.repeat(1000)}`)).toEqual({ format: 'otel' });
  });

  it('reads nothing a body or a span holds, and never lets content override a name that says the format', () => {
    // A nock recording of a call that sent a tool schema with "log" and "entries" properties.
    const schema = JSON.stringify([{ scope: 'https://api.anthropic.com:443', method: 'POST', path: '/v1/messages', body: { tools: [{ input_schema: { properties: { log: { type: 'object', properties: { entries: { type: 'array' } } } } } }] } }]);
    expect(guessImportFormat('recording.json', schema)).toEqual({ format: 'nock' });
    // A cassette whose recorded response mentions resourceSpans is still a cassette.
    expect(guessImportFormat('cassette.json', JSON.stringify({ interactions: [{ response: { body: { string: '{"resourceSpans":[]}' } } }] }))).toEqual({ format: 'vcr' });
    expect(guessImportFormat('refunds.json', JSON.stringify({ interactions: [{ response: { body: { resourceSpans: [] } } }] }))).toEqual({ format: 'vcr' });
    expect(guessImportFormat('trace.json', '{"interactions":[{"request":{}}],"version":1}')).toEqual({ format: 'otel' });
    expect(guessImportFormat('otel.json', '[{"scope":"https://api.openai.com:443","method":"POST"}]')).toEqual({ format: 'otel' });
    expect(guessImportFormat('traffic.har', '{"resourceSpans":[]}')).toEqual({ format: 'har' });
    expect(guessImportFormat('otel-export.jsonl', '{"format":"shadowlap-capture"}')).toEqual({ format: 'otel' });
    expect(guessImportFormat('shadowlap-4121.jsonl', '{"format":"shadowlap-capture","v":1}')).toEqual({ format: 'litellm' });
  });

  it('keeps the name-based guess when the content says nothing, and never un-refuses YAML', () => {
    expect(guessImportFormat('otel.json', '{"something":"else"}')).toEqual({ format: 'otel' });
    expect(guessImportFormat('recording.json', 'not json at all')).toEqual({ format: 'nock' });
    expect(guessImportFormat('recording.json', '{"note":"a \\"log\\": here","log2":{}}')).toEqual({ format: 'nock' });
    expect(guessImportFormat('cassette.yaml', '{"interactions":[]}').format).toBeNull();
  });

  it('names every format for the dialog', () => {
    expect(Object.keys(IMPORT_FILE_FORMATS)).toEqual(['har', 'nock', 'vcr', 'litellm', 'otel']);
    expect(IMPORT_FILE_FORMATS.vcr).toBe('VCR (JSON)');
  });
});
