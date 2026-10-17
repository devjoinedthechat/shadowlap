/**
 * The import dialog's sample trace ("Use a sample: otel-traces.json"): one agent run as an
 * OpenTelemetry collector exports it (OTLP JSON, the GenAI semantic conventions), with two model
 * calls and the tool call between them. It is the trace the CLI's own import tests read, and the one
 * the demo store imports as captures/otel-traces.json. No DOM here: the tests import it.
 */

export interface OtlpEvent {
  timeUnixNano?: string;
  [field: string]: unknown;
}

export interface OtlpSpan {
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  events?: OtlpEvent[];
  [field: string]: unknown;
}

export interface OtlpTrace {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[]; [field: string]: unknown }>; [field: string]: unknown }>;
}

/** The file name the dialog shows and the run keeps as its source. */
export const OTEL_SAMPLE_NAME = 'otel-traces.json';

export const OTEL_SAMPLE: OtlpTrace = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'support-agent' } },
          { key: 'telemetry.sdk.language', value: { stringValue: 'python' } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'opentelemetry.instrumentation.anthropic', version: '0.52b1' },
          spans: [
            {
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              spanId: '00f067aa0ba902b7',
              parentSpanId: '',
              name: 'invoke_agent support',
              kind: 1,
              startTimeUnixNano: '1790849800000000000',
              endTimeUnixNano: '1790849802600000000',
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
                { key: 'gen_ai.agent.name', value: { stringValue: 'support' } },
              ],
              status: { code: 1 },
            },
            {
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              spanId: 'a1b2c3d4e5f60001',
              parentSpanId: '00f067aa0ba902b7',
              name: 'chat claude-haiku-4-5',
              kind: 3,
              startTimeUnixNano: '1790849800010000000',
              endTimeUnixNano: '1790849800910000000',
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                { key: 'gen_ai.provider.name', value: { stringValue: 'anthropic' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'claude-haiku-4-5' } },
                { key: 'gen_ai.request.max_tokens', value: { intValue: '512' } },
                { key: 'gen_ai.request.temperature', value: { intValue: '0' } },
                { key: 'gen_ai.system_instructions', value: { stringValue: '[{"type": "text", "content": "You are a support agent. Look the order up before you answer."}]' } },
                { key: 'gen_ai.tool.definitions', value: { stringValue: '[{"type": "function", "name": "lookup_order", "description": "Look an order up by its id.", "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}}]' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role": "user", "parts": [{"type": "text", "content": "Where is my order A-1042?"}]}]' } },
                { key: 'gen_ai.output.messages', value: { stringValue: '[{"role": "assistant", "parts": [{"type": "tool_call", "id": "toolu_01A", "name": "lookup_order", "arguments": {"order_id": "A-1042"}}], "finish_reason": "tool_use"}]' } },
                { key: 'gen_ai.response.id', value: { stringValue: 'msg_01A' } },
                { key: 'gen_ai.response.model', value: { stringValue: 'claude-haiku-4-5' } },
                { key: 'gen_ai.response.finish_reasons', value: { arrayValue: { values: [{ stringValue: 'tool_use' }] } } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '412' } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '38' } },
              ],
              status: { code: 1 },
            },
            {
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              spanId: 'a1b2c3d4e5f60002',
              parentSpanId: '00f067aa0ba902b7',
              name: 'execute_tool lookup_order',
              kind: 1,
              startTimeUnixNano: '1790849800920000000',
              endTimeUnixNano: '1790849800960000000',
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
                { key: 'gen_ai.tool.name', value: { stringValue: 'lookup_order' } },
                { key: 'gen_ai.tool.call.id', value: { stringValue: 'toolu_01A' } },
                { key: 'gen_ai.tool.call.arguments', value: { stringValue: '{"order_id": "A-1042"}' } },
                { key: 'gen_ai.tool.call.result', value: { stringValue: '{"order_id":"A-1042","amount":240,"status":"delivered"}' } },
              ],
              status: { code: 1 },
            },
            {
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              spanId: 'a1b2c3d4e5f60003',
              parentSpanId: 'a1b2c3d4e5f60002',
              name: 'GET',
              kind: 3,
              startTimeUnixNano: '1790849800925000000',
              endTimeUnixNano: '1790849800955000000',
              attributes: [
                { key: 'http.request.method', value: { stringValue: 'GET' } },
                { key: 'url.full', value: { stringValue: 'https://orders.internal/api/orders/A-1042' } },
                { key: 'http.response.status_code', value: { intValue: '200' } },
              ],
              status: { code: 1 },
            },
            {
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              spanId: 'a1b2c3d4e5f60004',
              parentSpanId: '00f067aa0ba902b7',
              name: 'chat claude-haiku-4-5',
              kind: 3,
              startTimeUnixNano: '1790849800970000000',
              endTimeUnixNano: '1790849802550000000',
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                { key: 'gen_ai.provider.name', value: { stringValue: 'anthropic' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'claude-haiku-4-5' } },
                { key: 'gen_ai.request.max_tokens', value: { intValue: '512' } },
                { key: 'gen_ai.request.temperature', value: { intValue: '0' } },
                { key: 'gen_ai.system_instructions', value: { stringValue: '[{"type": "text", "content": "You are a support agent. Look the order up before you answer."}]' } },
                { key: 'gen_ai.tool.definitions', value: { stringValue: '[{"type": "function", "name": "lookup_order", "description": "Look an order up by its id.", "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}}]' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role": "user", "parts": [{"type": "text", "content": "Where is my order A-1042?"}]}, {"role": "assistant", "parts": [{"type": "tool_call", "id": "toolu_01A", "name": "lookup_order", "arguments": {"order_id": "A-1042"}}]}, {"role": "tool", "parts": [{"type": "tool_call_response", "id": "toolu_01A", "response": "{\\"order_id\\":\\"A-1042\\",\\"amount\\":240,\\"status\\":\\"delivered\\"}"}]}]' } },
                { key: 'gen_ai.output.messages', value: { stringValue: '[{"role": "assistant", "parts": [{"type": "text", "content": "Order A-1042 was delivered; it cost $240."}], "finish_reason": "end_turn"}]' } },
                { key: 'gen_ai.response.id', value: { stringValue: 'msg_01B' } },
                { key: 'gen_ai.response.finish_reasons', value: { arrayValue: { values: [{ stringValue: 'end_turn' }] } } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '471' } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '19' } },
              ],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
};
