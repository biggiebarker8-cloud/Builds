export const messageRules = {
  message: value => typeof value === 'string' && value.length <= 2000 && value.trim().length > 0,
};

const messageSchema = {
  type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' } },
  required: ['message'], additionalProperties: false,
};
const statusSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['configured', 'not_configured'] },
    capabilities: { type: 'array', items: { type: 'string', enum: ['send_message'] } },
    note: { type: 'string', const: 'Configuration does not verify connectivity.' },
  },
  required: ['status', 'capabilities', 'note'], additionalProperties: false,
};
const sentSchema = {
  type: 'object', properties: { message: { type: 'string', const: 'Message sent to Lark.' } },
  required: ['message'], additionalProperties: false,
};
const tools = [
  {
    name: 'lark_status', description: 'Check configuration only; does not verify connectivity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lark_send_message', description: 'Send text to the server-configured Lark chat. No recipient selection.',
    inputSchema: messageSchema,
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false, readOnlyHint: false },
  },
];

export function larkOpenApi(origin) {
  const response = (description, schema) => ({
    description, content: { 'application/json': { schema } },
  });
  const errorSchema = {
    type: 'object', properties: { error: { type: 'string' } }, required: ['error'], additionalProperties: false,
  };
  const errors = Object.fromEntries([400, 401, 403, 413, 415, 429, 502, 503].map(code =>
    [code, response('Request failed. Errors are sanitized.', errorSchema)]));
  return {
    openapi: '3.1.0', info: { title: 'Alliance Lark Messaging', version: '1.0.0' },
    servers: [{ url: origin }],
    components: { securitySchemes: { larkBearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ larkBearer: [] }],
    paths: {
      '/api/automation/lark/status': {
        get: {
          operationId: 'getLarkConnectionStatus', summary: 'Check Lark configuration, not connectivity',
          responses: { 200: response('Configuration status', statusSchema), ...errors },
        },
      },
      '/api/automation/lark/messages': {
        post: {
          operationId: 'sendLarkMessage', summary: 'Send text to the configured Lark chat',
          'x-openai-isConsequential': true,
          requestBody: { required: true, content: { 'application/json': { schema: messageSchema } } },
          responses: { 200: response('Message sent', sentSchema), ...errors },
        },
      },
    },
  };
}

export async function handleMcp(req, res, { send, status, sendMessage }) {
  const error = (httpStatus, code, message, id = null) =>
    send(res, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return error(415, -32600, 'Use application/json.');
  }
  if (req.headers.accept && !req.headers.accept.split(',').some(range => {
    const [type, ...parameters] = range.trim().toLowerCase().split(';');
    return ['application/json', '*/*'].includes(type.trim()) &&
      !parameters.some(parameter => /^q\s*=\s*0(?:\.0*)?$/u.test(parameter.trim()));
  })) return error(406, -32600, 'Accept must allow application/json.');
  if (req.headers['mcp-protocol-version'] !== undefined &&
      req.headers['mcp-protocol-version'] !== '2025-06-18') {
    return error(400, -32600, 'Unsupported protocol version.');
  }
  let body;
  try { body = JSON.parse(req.bodyBytes.toString('utf8')); }
  catch { return error(400, -32700, 'Parse error.'); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validId = value => value === null || typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value));
  if (!object(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
      (Object.hasOwn(body, 'id') && !validId(body.id))) {
    return error(400, -32600, 'Invalid Request.');
  }
  const id = Object.hasOwn(body, 'id') ? body.id : null;
  if (body.params !== undefined && !object(body.params)) return error(400, -32602, 'Invalid params.', id);
  if (!Object.hasOwn(body, 'id')) {
    if (['notifications/initialized', 'notifications/cancelled'].includes(body.method)) {
      if (body.method === 'notifications/cancelled' &&
          (!Object.hasOwn(body.params || {}, 'requestId') || !validId(body.params.requestId) ||
           (body.params.reason !== undefined && typeof body.params.reason !== 'string'))) {
        return error(400, -32602, 'Invalid params.');
      }
      return send(res, 202);
    }
    return error(400, -32600, 'Requests require an id.');
  }
  const result = value => send(res, 200, { jsonrpc: '2.0', id, result: value });
  switch (body.method) {
    case 'initialize':
      if (!object(body.params) || typeof body.params.protocolVersion !== 'string' ||
          !object(body.params.capabilities) || !object(body.params.clientInfo) ||
          typeof body.params.clientInfo.name !== 'string' || typeof body.params.clientInfo.version !== 'string') {
        return error(400, -32602, 'Invalid params.', id);
      }
      return result({
        protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'alliance-lark', version: '1.0.0' },
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools });
    case 'tools/call': {
      const params = body.params;
      if (!object(params) || !['lark_status', 'lark_send_message'].includes(params.name) ||
          Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key)) ||
          (params.arguments !== undefined && !object(params.arguments))) {
        return error(400, -32602, 'Invalid params.', id);
      }
      const args = params.arguments || {};
      if (params.name === 'lark_status') {
        if (Object.keys(args).length) return error(400, -32602, 'Invalid params.', id);
        return result({ content: [{ type: 'text', text: JSON.stringify(status()) }] });
      }
      if (Object.keys(args).length !== 1 || !messageRules.message(args.message)) {
        return error(400, -32602, 'Invalid params.', id);
      }
      try {
        await sendMessage(args.message.trim());
        return result({ content: [{ type: 'text', text: 'Message sent to Lark.' }] });
      } catch (failure) {
        // Do not reflect upstream exceptions or credentials into tool responses.
        const message = failure.status === 503 ? 'Lark is not configured.' :
          failure.status === 429 ? 'Too many Lark messages. Try again later.' : 'Unable to send the Lark message.';
        return result({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return error(400, -32601, 'Method not found.', id);
  }
}
