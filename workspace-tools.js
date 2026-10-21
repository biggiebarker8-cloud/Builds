const skillGuides = {
  campaign_strategy: `Build a campaign brief from the stated business goal, audience, offer, budget, timeline, markets, and success metric. Separate facts supplied by the owner from assumptions. Recommend channel roles, a test plan, creative angles, and measurement. Never invent platform performance or claim a campaign is live.`,
  audience_research: `Define audience segments from provided evidence, needs, objections, and buying context. Flag unsupported demographic claims. Suggest ethical research questions and distinguish observations from hypotheses. Do not infer sensitive traits.`,
  brand_and_creative: `Turn approved brand guidance into a message framework, content pillars, hooks, and channel-specific creative briefs. Label drafts as drafts, respect supplied rights and disclosure requirements, and do not publish or claim approval.`,
  content_and_social: `Create an editorial calendar with audience, format, channel, owner, due date, and objective. Adapt copy to each requested platform without claiming a connection, scheduled post, or published result.`,
  paid_advertising: `Plan paid-media experiments using the owner's stated budget, objective, audience, creative, and conversion event. Propose capped test allocations and measurement; never place orders, change budgets, or claim access to ad accounts.`,
  performance_analysis: `Analyze only the metrics and reporting period supplied by the owner. Show calculations and caveats, separate correlation from causation, compare like-for-like periods, and recommend measurable next tests. Do not fabricate missing data.`,
  search_and_email: `Develop search-intent clusters, landing-page briefs, and permission-based email journeys from supplied business context. Avoid unsupported claims, spam practices, or implying an email or analytics platform is connected.`,
};

export const marketingSkills = Object.freeze(skillGuides);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const noArguments = { type: 'object', properties: {}, additionalProperties: false };
const idArguments = {
  type: 'object', properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required: ['id'], additionalProperties: false,
};
const mutationArguments = properties => ({
  type: 'object',
  properties: { ...properties },
  required: Object.keys(properties),
  additionalProperties: false,
});

const tools = [
  { name: 'get_workspace_state', description: 'Read creators, tasks, settings, and honest integration status. Payment and charge records are never included.', inputSchema: noArguments, annotations: { readOnlyHint: true } },
  { name: 'create_creator', description: 'Add a creator record using the agency roster fields.', inputSchema: mutationArguments({
    handle: { type: 'string', maxLength: 100 }, market: { type: 'string', enum: ['AU', 'UK'] },
    manager: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: ['prospect', 'onboarding', 'active', 'paused'] },
    liveHours: { type: 'number', minimum: 0 }, revenue: { type: 'number', minimum: 0 }, targetHours: { type: 'number', minimum: 0 },
  }), annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false } },
  { name: 'update_creator', description: 'Update validated fields on a creator record.', inputSchema: {
    type: 'object', properties: { id: idArguments.properties.id, changes: { type: 'object' } },
    required: ['id', 'changes'], additionalProperties: false,
  }, annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false } },
  { name: 'delete_creator', description: 'Permanently delete a creator record.', inputSchema: idArguments, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'create_task', description: 'Add an agency task.', inputSchema: mutationArguments({
    title: { type: 'string', maxLength: 200 }, market: { type: 'string', enum: ['AU', 'UK'] },
    dueDate: { type: 'string' },
  }), annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false } },
  { name: 'update_task', description: 'Update a task title, market, due date, or completion state.', inputSchema: {
    type: 'object', properties: { id: idArguments.properties.id, changes: { type: 'object' } },
    required: ['id', 'changes'], additionalProperties: false,
  }, annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false } },
  { name: 'delete_task', description: 'Permanently delete a task.', inputSchema: idArguments, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'update_agency_settings', description: 'Update non-financial agency settings. Provider connections still require their own authorization.', inputSchema: {
    type: 'object', properties: {
      agencyName: { type: 'string', maxLength: 100 }, accountHandle: { type: 'string', maxLength: 100 },
      auTimezone: { type: 'string' }, ukEnabled: { type: 'boolean' },
    }, minProperties: 1, additionalProperties: false,
  }, annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false } },
  { name: 'list_marketing_skills', description: 'List practical advertising and marketing skill guides available to the assistant.', inputSchema: noArguments, annotations: { readOnlyHint: true } },
  { name: 'get_marketing_skill', description: 'Retrieve one advertising or marketing skill guide.', inputSchema: mutationArguments({
    skill: { type: 'string', enum: Object.keys(skillGuides) },
  }), annotations: { readOnlyHint: true } },
];

export async function handleWorkspaceMcp(req, res, { send, execute }) {
  const error = (status, code, message, id = null) =>
    send(res, status, { jsonrpc: '2.0', id, error: { code, message } });
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
  if (!object(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
      (Object.hasOwn(body, 'id') && !(body.id === null || typeof body.id === 'string' ||
        (typeof body.id === 'number' && Number.isFinite(body.id))))) {
    return error(400, -32600, 'Invalid Request.');
  }
  const id = Object.hasOwn(body, 'id') ? body.id : null;
  if (body.params !== undefined && !object(body.params)) return error(400, -32602, 'Invalid params.', id);
  if (!Object.hasOwn(body, 'id')) {
    if (['notifications/initialized', 'notifications/cancelled'].includes(body.method)) {
      if (body.method === 'notifications/cancelled' &&
          (!Object.hasOwn(body.params || {}, 'requestId') ||
            (body.params.requestId !== null && typeof body.params.requestId !== 'string' &&
              !(typeof body.params.requestId === 'number' && Number.isFinite(body.params.requestId))))) {
        return error(400, -32602, 'Invalid params.');
      }
      return send(res, 202);
    }
    return error(400, -32600, 'Requests require an id.');
  }
  const result = value => send(res, 200, { jsonrpc: '2.0', id, result: value });
  if (body.method === 'ping') return result({});
  if (body.method === 'initialize') {
    const params = body.params;
    if (!object(params) || typeof params.protocolVersion !== 'string' ||
        !object(params.capabilities) || !object(params.clientInfo) ||
        typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
      return error(400, -32602, 'Invalid params.', id);
    }
    return result({
      protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'alliance-workspace', version: '1.0.0' },
    });
  }
  if (body.method === 'tools/list') return result({ tools });
  if (body.method !== 'tools/call') return error(400, -32601, 'Method not found.', id);
  const params = body.params;
  if (!object(params) || typeof params.name !== 'string' ||
      !tools.some(tool => tool.name === params.name) ||
      Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key)) ||
      (params.arguments !== undefined && !object(params.arguments))) {
    return error(400, -32602, 'Invalid params.', id);
  }
  const args = params.arguments || {};
  try {
    let value;
    if (params.name === 'list_marketing_skills') {
      if (Object.keys(args).length) return error(400, -32602, 'Invalid params.', id);
      value = { skills: Object.keys(skillGuides) };
    } else if (params.name === 'get_marketing_skill') {
      if (Object.keys(args).length !== 1 || !Object.hasOwn(skillGuides, args.skill)) {
        return error(400, -32602, 'Invalid params.', id);
      }
      value = { skill: args.skill, guide: skillGuides[args.skill] };
    } else {
      value = await execute(params.name, args);
    }
    return result({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  } catch (failure) {
    const message = failure.status === 404 ? 'Record not found.' :
      failure.status === 400 ? 'Invalid tool arguments.' : 'Workspace operation failed.';
    return result({ content: [{ type: 'text', text: message }], isError: true });
  }
}

export function workspaceOpenApi(origin) {
  const response = (description, schema) => ({
    description, content: { 'application/json': { schema } },
  });
  const errorSchema = {
    type: 'object', properties: { error: { type: 'string' } }, required: ['error'], additionalProperties: false,
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Alliance Workspace MCP Gateway', version: '1.0.0' },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { workspaceBearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        JsonRpcRequest: {
          type: 'object', properties: {
            jsonrpc: { const: '2.0' }, id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            method: { type: 'string', enum: ['initialize', 'ping', 'tools/list', 'tools/call'] },
            params: { type: 'object' },
          }, required: ['jsonrpc', 'id', 'method'], additionalProperties: false,
        },
        JsonRpcResponse: { type: 'object', properties: { jsonrpc: { const: '2.0' } }, required: ['jsonrpc'] },
        Error: errorSchema,
      },
    },
    security: [{ workspaceBearer: [] }],
    paths: {
      '/mcp': {
        post: {
          operationId: 'callAllianceWorkspaceMcp',
          summary: 'Read or manage non-financial agency records and retrieve marketing skill guides',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } } } },
          responses: {
            200: response('MCP JSON-RPC response', { $ref: '#/components/schemas/JsonRpcResponse' }),
            400: response('Invalid request', errorSchema), 401: response('Authentication required', errorSchema),
            403: response('Origin not allowed', errorSchema), 413: response('Request too large', errorSchema),
            415: response('JSON required', errorSchema), 503: response('Workspace MCP is not configured', errorSchema),
          },
        },
      },
    },
  };
}
