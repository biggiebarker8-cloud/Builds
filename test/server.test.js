import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';

const TOKEN = 'unit-test-only-token-not-for-production-123456';
const MANAGER_TOKEN = 'unit-test-manager-only-not-for-production-654321';
const WORKSPACE_MCP_TOKEN = 'unit-test-workspace-mcp-owner-key-not-production-789012';
const creator = { handle: 'creator', market: 'AU', manager: '', status: 'prospect', liveHours: 0, revenue: 0, targetHours: 20 };
const task = { title: 'Review creator', market: 'AU', dueDate: '2026-10-21' };
const finance = { type: 'payment', description: 'Private manual payment', market: 'AU', amount: 12345.67, date: '2026-10-21', status: 'pending' };

async function fixture(t, options = {}) {
  const directory = mkdtempSync(resolve('agency-test-'));
  const dbPath = resolve(directory, 'agency.sqlite');
  let server;
  let base;
  let cookie = '';
  async function start(overrides = {}) {
    server = createApp({ dbPath, adminToken: TOKEN, managerToken: undefined, workspaceMcpToken: undefined, larkAutomationToken: undefined, publicOrigin: '', larkAppId: '', larkAppSecret: '', larkChatId: '', ...options, ...overrides });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  await start();
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function login(token = TOKEN) {
    const response = await request('/api/login', 'POST', typeof token === 'string' ? { token } : token);
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  return {
    request, login, stop, start, dbPath, get base() { return base; },
    get cookie() { return cookie; },
    setCookie(response) { cookie = response.headers.get('set-cookie').split(';')[0]; },
  };
}

test('startup requires a strong administrator token', () => {
  for (const adminToken of [null, '', 'short', 123]) {
    assert.throws(() => createApp({ dbPath: ':memory:', adminToken }), /AGENCY_ADMIN_TOKEN/);
  }
});

test('login, session, logout, headers, and unknown routes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/session')).status, 401);
  for (const [path, method] of [
    ['/api/export', 'GET'], ['/api/creators', 'POST'], ['/api/tasks', 'POST'],
    ['/api/settings', 'PATCH'], ['/api/integrations/lark/test', 'POST'], ['/api/logout', 'POST'],
    ...['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD', 'OPTIONS'].flatMap(method =>
      ['/api/finance', '/api/finance/00000000-0000-0000-0000-000000000000', '/api/finance/unknown'].map(path => [path, method])),
  ]) assert.equal((await f.request(path, method)).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { token: 'wrong' })).status, 401);
  const login = await f.login();
  assert.deepEqual(await login.json(), { authenticated: true, role: 'owner' });
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=28800/);
  assert.doesNotMatch(cookie, new RegExp(TOKEN));
  assert.deepEqual(await (await f.request('/api/session')).json(), { authenticated: true, role: 'owner' });
  const response = await f.request('/api/state');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const state = await response.json();
  assert.deepEqual(state.creators, []);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.finance, []);
  assert.equal(state.role, 'owner');
  assert.equal(state.settings.agencyName, 'The Alliance');
  assert.equal((await f.request('/api/missing')).status, 404);
  assert.equal((await f.request('/server.js')).status, 404);
  assert.equal((await f.request('/.env')).status, 404);
  assert.equal((await f.request('/api/logout', 'POST')).status, 200);
  assert.equal((await f.request('/api/session')).status, 401);
});

test('same-origin validation, JSON limits, invalid payloads, and rate limiting', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/login', 'POST', { token: TOKEN }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/login', 'POST', { token: TOKEN }, { Origin: 'null' })).status, 403);
  await f.login();
  assert.equal((await f.request('/api/creators', 'POST', creator, { Origin: f.base.replace('127.0.0.1', 'localhost') })).status, 201);
  assert.equal((await f.request('/api/creators', 'POST', creator, { Host: 'evil.example', Origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.request('/api/creators', 'POST', creator, { Origin: f.base })).status, 201);
  assert.equal((await f.request('/api/creators', 'POST', creator, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/creators', 'POST', { ...creator, handle: 'x'.repeat(70_000) })).status, 413);
  const oversizedChunked = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.base}/api/logout`, { method: 'POST' }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.write('x'.repeat(40_000));
    req.end('x'.repeat(40_000));
  });
  assert.equal(oversizedChunked, 413);
  const malformed = await fetch(`${f.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await f.request('/api/login', 'POST', { token: TOKEN }, { 'Content-Type': 'text/plain' })).status, 415);
  for (let i = 0; i < 10; i++) await f.request('/api/login', 'POST', { token: 'wrong' });
  const limited = await f.request('/api/login', 'POST', { token: TOKEN });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
});

test('trusted PUBLIC_ORIGIN enables HTTPS cookies without trusting forwarding headers', async t => {
  const f = await fixture(t, { publicOrigin: 'https://agency.example.com' });
  const response = await f.request('/api/login', 'POST', { token: TOKEN }, { Origin: 'https://agency.example.com' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal((await f.request('/api/login', 'POST', { token: TOKEN }, { Origin: f.base })).status, 403);
  assert.equal((await f.request('/api/login', 'POST', { token: TOKEN }, {
    Host: 'evil.example', Origin: 'https://evil.example', 'X-Forwarded-Proto': 'https',
  })).status, 403);
  const local = await fixture(t);
  const spoofed = await local.request('/api/login', 'POST', { token: TOKEN }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(spoofed.status, 200);
  assert.doesNotMatch(spoofed.headers.get('set-cookie'), /; Secure/);
  for (const publicOrigin of ['ftp://example.com', 'https://name@example.com', 'https://example.com/path', 'not-a-url']) {
    assert.throws(() => createApp({ dbPath: ':memory:', adminToken: TOKEN, publicOrigin }), /PUBLIC_ORIGIN/);
  }
});

test('creator CRUD, field validation, task CRUD, and settings', async t => {
  const f = await fixture(t);
  await f.login();
  for (const body of [
    [], null, {}, { ...creator, market: 'US' }, { ...creator, handle: '' },
    { ...creator, status: 'approved' },     { ...creator, revenue: -1 }, { ...creator, revenue: 1_000_000_001 },
    { ...creator, liveHours: '2' }, { ...creator, targetHours: 1_000_001 },
    { ...creator, liveHours: 0.001 }, { ...creator, targetHours: 1.111 }, { ...creator, revenue: 1.001 },
    { ...creator, id: 'injected' }, { ...creator, manager: 'x'.repeat(101) },
  ]) assert.equal((await f.request('/api/creators', 'POST', body)).status, 400);
  const created = await f.request('/api/creators', 'POST', creator);
  assert.equal(created.status, 201);
  const c = await created.json();
  assert.match(c.id, /^[a-f0-9-]{36}$/);
  assert.equal((await f.request(`/api/creators/${c.id}`, 'PATCH', {
    liveHours: 0.29, targetHours: 1_000_000, revenue: 1_000_000_000,
  })).status, 200);
  const updated = await f.request(`/api/creators/${c.id}`, 'PATCH', { status: 'active', liveHours: 3.5 });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).liveHours, 3.5);
  assert.equal((await f.request(`/api/creators/${c.id}`, 'PATCH', { revenue: null })).status, 400);
  for (const body of [
    { ...task, dueDate: '2026-02-30' }, { ...task, dueDate: 'today' },
    { ...task, done: 'yes' }, { ...task, title: '' }, { ...task, title: 'x'.repeat(201) }, { ...task, market: 'US' },
  ]) assert.equal((await f.request('/api/tasks', 'POST', body)).status, 400);
  const taskResponse = await f.request('/api/tasks', 'POST', task);
  assert.equal(taskResponse.status, 201);
  const taskRecord = await taskResponse.json();
  assert.equal(taskRecord.done, false);
  assert.equal((await f.request(`/api/tasks/${taskRecord.id}`, 'PATCH', { title: 'No' })).status, 400);
  assert.equal((await f.request(`/api/tasks/${taskRecord.id}`, 'PATCH', { done: 1 })).status, 400);
  assert.equal((await (await f.request(`/api/tasks/${taskRecord.id}`, 'PATCH', { done: true })).json()).done, true);
  const secondTask = await (await f.request('/api/tasks', 'POST', { ...task, dueDate: '', done: true })).json();
  assert.equal(secondTask.done, true);
  for (const body of [{ ukEnabled: 1 }, { auTimezone: 'Europe/London' }, { agencyName: '' }, { unknown: true }]) {
    assert.equal((await f.request('/api/settings', 'PATCH', body)).status, 400);
  }
  const settings = { agencyName: 'Agency', accountHandle: 'alliance', auTimezone: 'Australia/Perth', ukEnabled: true };
  assert.deepEqual(await (await f.request('/api/settings', 'PATCH', settings)).json(), settings);
  assert.equal((await f.request(`/api/creators/${c.id}`, 'DELETE')).status, 204);
  assert.equal((await f.request(`/api/creators/${c.id}`, 'DELETE')).status, 404);
  assert.equal((await f.request(`/api/tasks/${taskRecord.id}`, 'DELETE')).status, 204);
  const state = await (await f.request('/api/state')).json();
  assert.deepEqual(state.creators, []);
  assert.equal(state.tasks.length, 1);
});

test('actual SQLite persistence survives server recreation, but sessions do not', async t => {
  const f = await fixture(t);
  await f.login();
  const c = await (await f.request('/api/creators', 'POST', creator)).json();
  await f.request('/api/tasks', 'POST', { ...task, done: true });
  await f.request('/api/settings', 'PATCH', { ukEnabled: true });
  const disk = new DatabaseSync(f.dbPath);
  assert.throws(() => disk.prepare('UPDATE creators SET market=?').run('US'), /CHECK constraint/);
  assert.throws(() => disk.prepare('UPDATE tasks SET done=?').run(2), /CHECK constraint/);
  assert.throws(() => disk.prepare('UPDATE settings SET ukEnabled=?').run(2), /CHECK constraint/);
  disk.close();
  await f.stop();
  await f.start();
  assert.equal((await f.request('/api/state')).status, 401);
  await f.login();
  const state = await (await f.request('/api/state')).json();
  assert.deepEqual(state.creators, [c]);
  assert.equal(state.tasks[0].done, true);
  assert.equal(state.settings.ukEnabled, true);
});

test('sessions expire after eight hours', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp });
  await f.login();
  timestamp += 8 * 60 * 60 * 1000;
  assert.equal((await f.request('/api/session')).status, 401);
});

test('manager configuration is optional, length bounded, and distinct from the mandatory owner credential', async t => {
  for (const managerToken of [null, '', 'short', 123, {}, 'x'.repeat(31), 'x'.repeat(4097), TOKEN]) {
    assert.throws(() => createApp({ dbPath: ':memory:', adminToken: TOKEN, managerToken }), /AGENCY_MANAGER_TOKEN/);
  }
  assert.throws(() => createApp({ dbPath: ':memory:', adminToken: '', managerToken: MANAGER_TOKEN }), /AGENCY_ADMIN_TOKEN/);
  const disabled = await fixture(t);
  assert.equal((await disabled.request('/api/login', 'POST', { token: MANAGER_TOKEN })).status, 401);
  await disabled.login();
  for (const managerToken of ['a'.repeat(32), 'b'.repeat(4096)]) {
    const f = await fixture(t, { managerToken });
    assert.deepEqual(await (await f.login(managerToken)).json(), { authenticated: true, role: 'manager' });
  }
});

test('roles come exclusively from credentials, with no credential exposure or role injection', async t => {
  const f = await fixture(t, { managerToken: MANAGER_TOKEN });
  for (const token of [TOKEN, MANAGER_TOKEN]) {
    for (const role of ['owner', 'manager']) {
      assert.equal((await f.request('/api/login', 'POST', { token, role })).status, 400);
    }
  }
  assert.equal((await f.request('/api/login', 'POST', { token: MANAGER_TOKEN, authenticated: true })).status, 400);
  for (const [token, role] of [[TOKEN, 'owner'], [MANAGER_TOKEN, 'manager']]) {
    const login = await f.login(token);
    assert.deepEqual(await login.json(), { authenticated: true, role });
    assert.doesNotMatch(login.headers.get('set-cookie'), new RegExp(`${TOKEN}|${MANAGER_TOKEN}`));
    assert.deepEqual(await (await f.request('/api/session')).json(), { authenticated: true, role });
    const response = await f.request('/api/state');
    const text = await response.text();
    assert.equal(JSON.parse(text).role, role);
    assert.doesNotMatch(text, new RegExp(`${TOKEN}|${MANAGER_TOKEN}|Token|tokenHash`));
    assert.equal((await f.request('/api/session', 'PATCH', { role: 'owner' })).status, 404);
    assert.equal((await f.request('/api/creators', 'POST', { ...creator, role: 'owner' })).status, 400);
    assert.equal((await f.request('/api/tasks', 'POST', { ...task, role: 'owner' })).status, 400);
  }
});

test('manager can manage creators, tasks, revenue, CSV and Lark, but cannot change settings', async t => {
  const calls = [];
  const f = await fixture(t, {
    managerToken: MANAGER_TOKEN, larkAppId: 'private-app-id', larkAppSecret: 'private-lark-secret', larkChatId: 'private-chat-id',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.includes('/auth/')
        ? { code: 0, tenant_access_token: 'private-tenant-token' } : { code: 0 } };
    },
  });
  await f.login(MANAGER_TOKEN);
  const initial = await (await f.request('/api/state')).json();
  const created = await f.request('/api/creators', 'POST', creator);
  assert.equal(created.status, 201);
  const c = await created.json();
  const updated = await f.request(`/api/creators/${c.id}`, 'PATCH', { revenue: 432.19, liveHours: 12, manager: 'Agency manager' });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).revenue, 432.19);
  const createdTask = await f.request('/api/tasks', 'POST', task);
  assert.equal(createdTask.status, 201);
  const taskRecord = await createdTask.json();
  assert.equal((await f.request(`/api/tasks/${taskRecord.id}`, 'PATCH', { done: true })).status, 200);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.creators[0].revenue, 432.19);
  assert.equal(state.tasks[0].done, true);
  const exported = await f.request('/api/export');
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /432\.19/);
  const lark = await f.request('/api/integrations/lark/test', 'POST');
  assert.equal(lark.status, 200);
  assert.equal(calls.length, 2);
  for (const body of [{ agencyName: 'Forged' }, { ukEnabled: true }, { role: 'owner' }, {}]) {
    const blocked = await f.request('/api/settings', 'PATCH', body);
    assert.equal(blocked.status, 403);
    assert.doesNotMatch(await blocked.text(), /private-|Forged/);
  }
  assert.deepEqual((await (await f.request('/api/state')).json()).settings, initial.settings);
  assert.doesNotMatch(JSON.stringify(state), /private-/);
  assert.equal((await f.request(`/api/creators/${c.id}`, 'DELETE')).status, 204);
  assert.equal((await f.request(`/api/tasks/${taskRecord.id}`, 'DELETE')).status, 204);
  const empty = await (await f.request('/api/state')).json();
  assert.deepEqual(empty.creators, []);
  assert.deepEqual(empty.tasks, []);
  await f.login();
  assert.deepEqual((await (await f.request('/api/state')).json()).settings, initial.settings);
  assert.equal((await f.request('/api/settings', 'PATCH', { ukEnabled: true })).status, 200);
});

test('owner finance CRUD returns decimal amounts while storing integer minor units and persisting records', async t => {
  const f = await fixture(t);
  await f.login();
  assert.deepEqual(await (await f.request('/api/finance')).json(), { finance: [] });
  const created = await f.request('/api/finance', 'POST', finance);
  assert.equal(created.status, 201);
  const payment = await created.json();
  assert.match(payment.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.deepEqual(payment, { id: payment.id, ...finance });
  const chargeResponse = await f.request('/api/finance', 'POST', {
    ...finance, type: 'administrative_charge', description: 'Administrative fee', market: 'UK', amount: 0.29, status: 'recorded',
  });
  assert.equal(chargeResponse.status, 201);
  const charge = await chargeResponse.json();
  const disk = new DatabaseSync(f.dbPath);
  assert.equal(disk.prepare('SELECT amountMinor FROM finance WHERE id=?').get(charge.id).amountMinor, 29);
  for (const [column, value] of [['amountMinor', 0], ['amountMinor', 100000000001], ['amountMinor', 1.5], ['type', 'refund'], ['market', 'US'], ['status', 'paid']]) {
    assert.throws(() => disk.prepare(`UPDATE finance SET ${column}=? WHERE id=?`).run(value, charge.id));
  }
  disk.close();
  const changes = { type: 'administrative_charge', description: 'Adjusted administrative charge', market: 'UK', amount: 1_000_000_000, date: '2024-02-29', status: 'void' };
  const updated = await f.request(`/api/finance/${payment.id}`, 'PATCH', changes);
  assert.equal(updated.status, 200);
  const record = { id: payment.id, ...changes };
  assert.deepEqual(await updated.json(), record);
  assert.deepEqual(await (await f.request('/api/finance')).json(), { finance: [record, charge] });
  assert.deepEqual((await (await f.request('/api/state')).json()).finance, [record, charge]);
  await f.stop();
  await f.start();
  assert.equal((await f.request('/api/finance')).status, 401);
  await f.login();
  assert.deepEqual(await (await f.request('/api/finance')).json(), { finance: [record, charge] });
  const partial = await f.request(`/api/finance/${payment.id}`, 'PATCH', { amount: 0.01 });
  assert.deepEqual(await partial.json(), { ...record, amount: 0.01 });
  assert.equal((await f.request(`/api/finance/${payment.id}`, 'DELETE')).status, 204);
  assert.equal((await f.request(`/api/finance/${payment.id}`, 'DELETE')).status, 404);
  assert.equal((await f.request(`/api/finance/${payment.id}`, 'PATCH', { status: 'recorded' })).status, 404);
  assert.deepEqual((await (await f.request('/api/state')).json()).finance, [charge]);
  await f.stop();
  await f.start();
  await f.login();
  assert.deepEqual(await (await f.request('/api/finance')).json(), { finance: [charge] });
});

test('finance rejects missing, extra and invalid fields without modifying records', async t => {
  const f = await fixture(t);
  await f.login();
  const record = await (await f.request('/api/finance', 'POST', finance)).json();
  const invalidBodies = [null, [], {}, { id: record.id }, { role: 'owner' },
    ...['', ' ', 'x'.repeat(201), 'line\nbreak', 123, null].map(description => ({ description })),
    ...['refund', '', null].map(type => ({ type })),
    ...['US', '', null].map(market => ({ market })),
    ...[0, -1, 0.001, 1.001, 1_000_000_000.01, '10', null].map(amount => ({ amount })),
    ...['', 'today', '2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '2026-10-21T00:00:00Z', null].map(date => ({ date })),
    ...['paid', '', null].map(status => ({ status })),
  ];
  for (const body of invalidBodies) {
    assert.equal((await f.request(`/api/finance/${record.id}`, 'PATCH', body)).status, 400, JSON.stringify(body));
    const postBody = body && !Array.isArray(body) && Object.keys(body).length ? { ...finance, ...body } : body;
    assert.equal((await f.request('/api/finance', 'POST', postBody)).status, 400, JSON.stringify(postBody));
  }
  for (const key of Object.keys(finance)) {
    const incomplete = { ...finance };
    delete incomplete[key];
    assert.equal((await f.request('/api/finance', 'POST', incomplete)).status, 400);
  }
  assert.deepEqual(await (await f.request('/api/finance')).json(), { finance: [record] });
});

test('finance migration adds a ledger to a pre-existing agency database without replacing data', async t => {
  const f = await fixture(t);
  await f.login();
  const c = await (await f.request('/api/creators', 'POST', creator)).json();
  const taskRecord = await (await f.request('/api/tasks', 'POST', task)).json();
  await f.request('/api/settings', 'PATCH', { agencyName: 'Existing agency', ukEnabled: true });
  await f.stop();
  const disk = new DatabaseSync(f.dbPath);
  disk.exec('DROP TABLE finance');
  disk.close();
  await f.start();
  await f.login();
  const state = await (await f.request('/api/state')).json();
  assert.deepEqual(state.creators, [c]);
  assert.deepEqual(state.tasks, [taskRecord]);
  assert.equal(state.settings.agencyName, 'Existing agency');
  assert.equal(state.settings.ukEnabled, true);
  assert.deepEqual(state.finance, []);
  assert.equal((await f.request('/api/finance', 'POST', finance)).status, 201);
});

test('finance authorization fails closed on every method, unknown finance path, and forged role', async t => {
  const f = await fixture(t, { managerToken: MANAGER_TOKEN });
  await f.login();
  const record = await (await f.request('/api/finance', 'POST', finance)).json();
  await f.login(MANAGER_TOKEN);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/finance', `/api/finance/${record.id}`, '/api/finance/unknown', '/api/finance/unknown/nested', '/api/finance-extra']) {
      const response = await f.request(path, method, ['POST', 'PUT', 'PATCH'].includes(method) ? { ...finance, role: 'owner' } : undefined);
      assert.equal(response.status, 403, `${method} ${path}`);
      const text = await response.text();
      assert.ok(!text.includes(finance.description));
      assert.ok(!text.includes(String(finance.amount)));
      assert.doesNotMatch(text, new RegExp(`${TOKEN}|${MANAGER_TOKEN}`));
    }
  }
  const managerState = await (await f.request('/api/state')).json();
  assert.equal(managerState.role, 'manager');
  assert.equal(Object.hasOwn(managerState, 'finance'), false);
  assert.ok(!JSON.stringify(managerState).includes(finance.description));
  assert.ok(!JSON.stringify(managerState).includes(String(finance.amount)));
  const exported = await (await f.request('/api/export')).text();
  assert.ok(!exported.includes(finance.description));
  assert.ok(!exported.includes(String(finance.amount)));
  await f.login();
  assert.deepEqual(await (await f.request('/api/finance')).json(), { finance: [record] });
});

test('manager sessions expire, logout invalidates them, and restart clears both roles', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { managerToken: MANAGER_TOKEN, now: () => timestamp });
  const ownerLogin = await f.login();
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  const managerLogin = await f.login(MANAGER_TOKEN);
  const managerCookie = managerLogin.headers.get('set-cookie').split(';')[0];
  timestamp += 8 * 60 * 60 * 1000 - 1;
  assert.equal((await f.request('/api/session')).status, 200);
  timestamp += 1;
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie: ownerCookie })).status, 401);
  await f.login(MANAGER_TOKEN);
  const logout = await f.request('/api/logout', 'POST');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie: managerCookie })).status, 401);
  const renewedOwner = await f.login();
  const renewedOwnerCookie = renewedOwner.headers.get('set-cookie').split(';')[0];
  await f.login(MANAGER_TOKEN);
  await f.stop();
  await f.start();
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie: renewedOwnerCookie })).status, 401);
  assert.deepEqual(await (await f.login(MANAGER_TOKEN)).json(), { authenticated: true, role: 'manager' });
});

const PASSWORD = '  password with spaces  ';
const NEXT_PASSWORD = 'next-password-for-tests';
const savePassword = (f, currentCredential, password = PASSWORD, headers) =>
  f.request('/api/security/password', 'PUT', { currentCredential, password }, headers);

test('password setup, salted strong hashes, persistence, rotation, and token recovery', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/security')).status, 401);
  assert.equal((await savePassword(f, TOKEN)).status, 401);
  await f.login();
  assert.deepEqual(await (await f.request('/api/security')).json(), { role: 'owner', hasPassword: false });
  const saved = await savePassword(f, TOKEN);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { message: 'Password saved. Other sessions for your role were signed out.' });
  f.setCookie(saved);
  assert.deepEqual(await (await f.request('/api/security')).json(), { role: 'owner', hasPassword: true });
  const disk = new DatabaseSync(f.dbPath);
  const first = disk.prepare('SELECT * FROM credentials').get();
  assert.equal(first.role, 'owner');
  assert.equal(first.salt.length, 64);
  assert.equal(first.hash.length, 128);
  const derived = await promisify(scryptCallback)(PASSWORD, Buffer.from(first.salt, 'hex'), 64,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  assert.equal(derived.toString('hex'), first.hash);
  for (const path of ['/api/state', '/api/security']) {
    const text = await (await f.request(path)).text();
    for (const secret of [PASSWORD, TOKEN, first.salt, first.hash]) assert.ok(!text.includes(secret));
  }
  disk.close();
  await f.stop();
  assert.ok(!readFileSync(f.dbPath).includes(Buffer.from(PASSWORD)));
  await f.start();
  assert.deepEqual(await (await f.login({ role: 'owner', password: PASSWORD })).json(), { authenticated: true, role: 'owner' });
  assert.equal((await f.request('/api/login', 'POST', { role: 'owner', password: PASSWORD.trim() })).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { role: 'manager', password: PASSWORD })).status, 401);
  const rotated = await savePassword(f, PASSWORD, NEXT_PASSWORD);
  assert.equal(rotated.status, 200);
  f.setCookie(rotated);
  const secondDisk = new DatabaseSync(f.dbPath);
  const second = secondDisk.prepare('SELECT * FROM credentials').get();
  assert.notEqual(second.salt, first.salt);
  assert.notEqual(second.hash, first.hash);
  secondDisk.close();
  const rejected = await f.request('/api/login', 'POST', { role: 'owner', password: PASSWORD });
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: 'Invalid credentials.' });
  await f.login({ role: 'owner', password: NEXT_PASSWORD });
  await f.login();
  assert.equal((await savePassword(f, TOKEN)).status, 200);
});

test('password endpoints reject extra fields, invalid lengths, and credentials for another role', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { managerToken: MANAGER_TOKEN, now: () => timestamp });
  await f.login(MANAGER_TOKEN);
  for (const body of [
    null, [], {}, { password: PASSWORD }, { currentCredential: MANAGER_TOKEN },
    { currentCredential: MANAGER_TOKEN, password: PASSWORD, role: 'owner' },
    { currentCredential: MANAGER_TOKEN, password: PASSWORD, extra: true },
    { currentCredential: MANAGER_TOKEN, password: 123 },
    { currentCredential: MANAGER_TOKEN, password: 'a'.repeat(11) },
    { currentCredential: MANAGER_TOKEN, password: 'a'.repeat(129) },
  ]) assert.equal((await f.request('/api/security/password', 'PUT', body)).status, 400);
  timestamp += 15 * 60 * 1000;
  for (const credential of [TOKEN, 'wrong-own-password']) {
    const response = await savePassword(f, credential);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Invalid current credential.' });
  }
  const minimum = await savePassword(f, MANAGER_TOKEN, 'a'.repeat(12));
  assert.equal(minimum.status, 200);
  f.setCookie(minimum);
  const maximum = await savePassword(f, 'a'.repeat(12), 'b'.repeat(128));
  assert.equal(maximum.status, 200);
  f.setCookie(maximum);
  assert.equal((await f.request('/api/settings', 'PATCH', { agencyName: 'forbidden' })).status, 403);
  assert.equal((await f.request('/api/finance')).status, 403);
  const disk = new DatabaseSync(f.dbPath);
  assert.deepEqual(disk.prepare('SELECT role FROM credentials').all().map(row => row.role), ['manager']);
  disk.close();
  for (const body of [
    { role: 'owner', password: 'b'.repeat(128), token: TOKEN },
    { role: 'manager', password: 'b'.repeat(128), extra: true },
    { role: 'admin', password: PASSWORD }, { password: PASSWORD },
    { role: 'manager', password: 'a'.repeat(11) }, { role: 'manager', password: 'a'.repeat(129) },
  ]) assert.equal((await f.request('/api/login', 'POST', body)).status, 400);
  await f.login({ role: 'manager', password: 'b'.repeat(128) });
  assert.equal((await f.request('/api/login', 'POST', { role: 'owner', password: 'b'.repeat(128) })).status, 401);
});

test('password update revokes every own-role session but preserves the other role', async t => {
  const f = await fixture(t, { managerToken: MANAGER_TOKEN });
  const loginCookie = async token => {
    const response = await f.request('/api/login', 'POST', { token }, { Cookie: '' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const owners = [await loginCookie(TOKEN), await loginCookie(TOKEN)];
  const managers = [await loginCookie(MANAGER_TOKEN), await loginCookie(MANAGER_TOKEN)];
  const savedOwner = await savePassword(f, TOKEN, PASSWORD, { Cookie: owners[0] });
  assert.equal(savedOwner.status, 200);
  f.setCookie(savedOwner);
  const currentOwner = f.cookie;
  for (const Cookie of owners) assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie })).status, 401);
  for (const Cookie of managers) assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie })).status, 200);
  const savedManager = await savePassword(f, MANAGER_TOKEN, NEXT_PASSWORD, { Cookie: managers[0] });
  assert.equal(savedManager.status, 200);
  f.setCookie(savedManager);
  for (const Cookie of managers) assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie })).status, 401);
  assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie: currentOwner })).status, 200);
  assert.deepEqual(await (await f.request('/api/security')).json(), { role: 'manager', hasPassword: true });
  await f.stop();
  await f.start({ managerToken: undefined });
  assert.equal((await f.request('/api/login', 'POST', { role: 'manager', password: NEXT_PASSWORD })).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { token: MANAGER_TOKEN })).status, 401);
  await f.login({ role: 'owner', password: PASSWORD });
});

test('password attempts have an independent expiring rate limit shared with password logins', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp });
  await f.login();
  const saved = await savePassword(f, TOKEN);
  assert.equal(saved.status, 200);
  f.setCookie(saved);
  for (let i = 0; i < 9; i++) assert.equal((await savePassword(f, 'wrong')).status, 403);
  const limited = await savePassword(f, TOKEN);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
  for (let i = 0; i < 9; i++) {
    assert.equal((await f.request('/api/login', 'POST', { role: 'owner', password: NEXT_PASSWORD })).status, 401);
  }
  assert.equal((await f.request('/api/login', 'POST', { token: TOKEN })).status, 429);
  timestamp += 15 * 60 * 1000;
  await f.login({ role: 'owner', password: PASSWORD });
  assert.equal((await savePassword(f, PASSWORD)).status, 200);
});

test('overlapping password work is bounded and same-role updates conflict', async t => {
  const f = await fixture(t);
  await f.login();
  const saved = await savePassword(f, TOKEN);
  assert.equal(saved.status, 200);
  f.setCookie(saved);
  const updates = await Promise.all([
    savePassword(f, PASSWORD, NEXT_PASSWORD),
    savePassword(f, PASSWORD, 'competing-password-value'),
  ]);
  assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);
  const winner = updates.find(response => response.status === 200);
  f.setCookie(winner);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    f.request('/api/login', 'POST', { role: 'owner', password: PASSWORD }, { Cookie: '' })));
  assert.ok(results.some(response => response.status === 503));
  assert.ok(results.some(response => response.status === 401));
  for (const response of results) {
    assert.ok([401, 503].includes(response.status));
    assert.equal(response.headers.has('set-cookie'), false);
    const text = await response.text();
    for (const secret of [PASSWORD, TOKEN, NEXT_PASSWORD]) assert.ok(!text.includes(secret));
  }
});

test('in-flight password updates cannot outlive logout or session expiration', async t => {
  for (const expire of [false, true]) {
    let timestamp = Date.now();
    let clockRead;
    const f = await fixture(t, { now: () => { clockRead?.(); return timestamp; } });
    await f.login();
    const Cookie = f.cookie;
    let reads = 0;
    const started = new Promise(resolve => {
      clockRead = () => { if (++reads === 2) resolve(); };
    });
    const pending = savePassword(f, TOKEN);
    await started;
    clockRead = undefined;
    if (expire) timestamp += 8 * 60 * 60 * 1000;
    else assert.equal((await f.request('/api/logout', 'POST', undefined, { Cookie })).status, 200);
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal(response.headers.has('set-cookie'), false);
    const disk = new DatabaseSync(f.dbPath);
    assert.equal(disk.prepare('SELECT count(*) AS count FROM credentials').get().count, 0);
    disk.close();
  }
});

test('an old-password login overlapping rotation cannot retain access after rotation', async t => {
  let onClock;
  const f = await fixture(t, { now: () => { onClock?.(); return Date.now(); } });
  await f.login();
  const setup = await savePassword(f, TOKEN);
  assert.equal(setup.status, 200);
  f.setCookie(setup);
  let reads = 0;
  const started = new Promise(resolve => {
    onClock = () => { if (++reads === 3) resolve(); };
  });
  const rotation = savePassword(f, TOKEN, NEXT_PASSWORD);
  await started;
  onClock = undefined;
  const login = f.request('/api/login', 'POST', { role: 'owner', password: PASSWORD }, { Cookie: '' });
  const [updated, attempted] = await Promise.all([rotation, login]);
  assert.equal(updated.status, 200);
  assert.ok([200, 401].includes(attempted.status));
  if (attempted.status === 200) {
    const Cookie = attempted.headers.get('set-cookie').split(';')[0];
    assert.equal((await f.request('/api/session', 'GET', undefined, { Cookie })).status, 401);
  } else assert.equal(attempted.headers.has('set-cookie'), false);
  await f.login({ role: 'owner', password: NEXT_PASSWORD });
});

test('password reauthentication never accepts the other role password', async t => {
  const f = await fixture(t, { managerToken: MANAGER_TOKEN });
  await f.login();
  const owner = await savePassword(f, TOKEN);
  assert.equal(owner.status, 200);
  const ownerCookie = owner.headers.get('set-cookie').split(';')[0];
  await f.login(MANAGER_TOKEN);
  const manager = await savePassword(f, MANAGER_TOKEN, NEXT_PASSWORD);
  assert.equal(manager.status, 200);
  f.setCookie(manager);
  assert.equal((await savePassword(f, PASSWORD)).status, 403);
  assert.equal((await savePassword(f, NEXT_PASSWORD, 'new-owner-password-value', { Cookie: ownerCookie })).status, 403);
  assert.deepEqual(await (await f.request('/api/security')).json(), { role: 'manager', hasPassword: true });
});

test('CSV attachment escapes quotes and neutralizes spreadsheet formulas', async t => {
  const f = await fixture(t);
  await f.login();
  await f.request('/api/creators', 'POST', { ...creator, handle: '=SUM(1,2)', manager: '  +cmd,"quoted"' });
  const response = await f.request('/api/export');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  const csv = await response.text();
  assert.ok(csv.includes(`"'=SUM(1,2)"`));
  assert.ok(csv.includes(`"'  +cmd,""quoted"""`));
  assert.ok(csv.endsWith('\r\n'));
});

test('unavailable integrations are honest and never expose credentials', async t => {
  const f = await fixture(t, { larkAppSecret: 'secret-must-not-appear' });
  await f.login();
  const response = await f.request('/api/state');
  const text = await response.text();
  assert.doesNotMatch(text, /secret-must-not-appear/);
  assert.deepEqual(JSON.parse(text).integrations, { tiktok: { status: 'not_connected' }, lark: { status: 'not_configured' } });
  const unavailable = await f.request('/api/integrations/lark/test', 'POST');
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /secret-must-not-appear/);
  assert.equal((await f.request('/api/integrations/tiktok/connect', 'POST')).status, 404);
});

test('Lark uses official URLs, sends real requests, and sanitizes upstream failures', async t => {
  const calls = [];
  let fail = false;
  let rejectMessage = false;
  const f = await fixture(t, {
    larkAppId: 'app-id', larkAppSecret: 'private-app-secret', larkChatId: 'chat-id',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('private-app-secret and private-tenant-token');
      return { ok: true, json: async () => url.includes('/auth/') ? { code: 0, tenant_access_token: 'private-tenant-token' } : { code: rejectMessage ? 1 : 0 } };
    },
  });
  await f.login();
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.integrations.lark.status, 'configured');
  assert.doesNotMatch(JSON.stringify(state), /private/);
  const success = await f.request('/api/integrations/lark/test', 'POST');
  assert.deepEqual(await success.json(), { message: 'Test message sent to Lark.' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(calls[1].url, 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id');
  assert.deepEqual(JSON.parse(calls[0].options.body), { app_id: 'app-id', app_secret: 'private-app-secret' });
  assert.equal(calls[1].options.headers.Authorization, ['Bearer', 'private-tenant-token'].join(' '));
  assert.equal(JSON.parse(calls[1].options.body).receive_id, 'chat-id');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  rejectMessage = true;
  assert.equal((await f.request('/api/integrations/lark/test', 'POST')).status, 502);
  fail = true;
  const failure = await f.request('/api/integrations/lark/test', 'POST');
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /private/);
});

const AUTOMATION_TOKEN = 'unit-test-automation-separate-credential-123456';
const automationHeaders = { Authorization: ['Bearer', AUTOMATION_TOKEN].join(' ') };
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialized = {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
};
const statusResult = configured => ({
  status: configured ? 'configured' : 'not_configured',
  capabilities: ['send_message'], note: 'Configuration does not verify connectivity.',
});
function larkMock() {
  const calls = [];
  return {
    calls,
    options: {
      larkAutomationToken: AUTOMATION_TOKEN,
      larkAppId: 'private-app-id', larkAppSecret: 'private-app-secret', larkChatId: 'private-chat-id',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => url.includes('/auth/') ?
          { code: 0, tenant_access_token: 'private-tenant-token' } : { code: 0 } };
      },
    },
  };
}

test('automation credentials are optional, strong, distinct, and isolated from dashboard authentication', async t => {
  for (const larkAutomationToken of ['', 'short', null, 123, 'x'.repeat(4097), TOKEN, MANAGER_TOKEN]) {
    assert.throws(() => createApp({
      dbPath: ':memory:', adminToken: TOKEN, managerToken: MANAGER_TOKEN, larkAutomationToken,
    }), /LARK_AUTOMATION_TOKEN/);
  }
  const disabled = await fixture(t);
  for (const [path, method] of [['/api/automation/lark/status', 'GET'], ['/api/automation/lark/messages', 'POST'], ['/mcp', 'POST']]) {
    assert.equal((await disabled.request(path, method, undefined, automationHeaders)).status, 503);
  }
  const f = await fixture(t, { larkAutomationToken: AUTOMATION_TOKEN });
  assert.equal((await f.request('/api/login', 'POST', { token: AUTOMATION_TOKEN })).status, 401);
  for (const [path, method, body] of [
    ['/api/state', 'GET'], ['/api/finance', 'GET'], ['/api/export', 'GET'], ['/api/security', 'GET'],
    ['/api/settings', 'PATCH', { agencyName: 'no' }], ['/api/security/password', 'PUT', {}],
    ['/api/integrations/lark/messages', 'POST', { message: 'no' }],
  ]) assert.equal((await f.request(path, method, body, automationHeaders)).status, 401);
  await f.login();
  for (const path of ['/mcp', '/api/automation/lark/messages']) {
    assert.equal((await f.request(path, 'POST', {})).status, 401);
  }
  for (const token of [TOKEN, MANAGER_TOKEN, 'wrong', '']) {
    const response = await f.request('/api/automation/lark/status', 'GET', undefined, { Authorization: ['Bearer', token].join(' ') });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Authentication required.' });
  }
  const status = await f.request('/api/automation/lark/status', 'GET', undefined, automationHeaders);
  assert.deepEqual(await status.json(), statusResult(false));
});

test('dashboard roles and machine API send only validated trimmed text to the fixed Lark chat', async t => {
  const mock = larkMock();
  const f = await fixture(t, { ...mock.options, managerToken: MANAGER_TOKEN });
  for (const path of ['/api/integrations/lark/messages', '/api/automation/lark/messages']) {
    if (path.includes('/integrations/')) await f.login(MANAGER_TOKEN);
    for (const body of [null, [], {}, { message: '' }, { message: ' \n\t ' }, { message: 1 },
      { message: 'x'.repeat(2001) }, { message: 'text', chat_id: 'another' }, { message: 'text', receive_id: 'another' }]) {
      assert.equal((await f.request(path, 'POST', body, automationHeaders)).status, 400);
    }
    const response = await f.request(path, 'POST', { message: '  Hi Lark\nSecond line  ' }, automationHeaders);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Message sent to Lark.' });
  }
  await f.login();
  assert.equal((await f.request('/api/integrations/lark/messages', 'POST', { message: 'x'.repeat(2000) })).status, 200);
  assert.equal(mock.calls.length, 6);
  for (let i = 0; i < mock.calls.length; i += 2) {
    assert.equal(mock.calls[i].url, 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal');
    assert.deepEqual(JSON.parse(mock.calls[i].options.body), { app_id: 'private-app-id', app_secret: 'private-app-secret' });
    assert.equal(mock.calls[i + 1].url, 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id');
    assert.equal(mock.calls[i + 1].options.headers.Authorization, ['Bearer', 'private-tenant-token'].join(' '));
    assert.deepEqual(JSON.parse(mock.calls[i + 1].options.body), {
      receive_id: 'private-chat-id', msg_type: 'text',
      content: JSON.stringify({ text: i === 4 ? 'x'.repeat(2000) : 'Hi Lark\nSecond line' }),
    });
    assert.equal(mock.calls[i].options.redirect, 'error');
    assert.equal(mock.calls[i + 1].options.redirect, 'error');
    assert.ok(mock.calls[i].options.signal instanceof AbortSignal);
    assert.equal(mock.calls[i].options.signal, mock.calls[i + 1].options.signal);
  }
});

test('MCP initializes statelessly, pings, lists exactly two narrow tools and calls both', async t => {
  const mock = larkMock();
  const f = await fixture(t, mock.options);
  const call = body => f.request('/mcp', 'POST', body, automationHeaders);
  const init = await call(rpc('initialize', initialized, 'init'));
  assert.equal(init.status, 200);
  assert.equal(init.headers.get('mcp-session-id'), null);
  assert.deepEqual(await init.json(), {
    jsonrpc: '2.0', id: 'init', result: {
      protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'alliance-lark', version: '1.0.0' },
    },
  });
  assert.deepEqual(await (await call(rpc('ping', undefined, null))).json(), { jsonrpc: '2.0', id: null, result: {} });
  const list = await (await call(rpc('tools/list'))).json();
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['lark_status', 'lark_send_message']);
  const [statusTool, sendTool] = list.result.tools;
  assert.deepEqual(statusTool.annotations, { readOnlyHint: true });
  assert.equal(statusTool.inputSchema.additionalProperties, false);
  assert.deepEqual(sendTool.inputSchema.required, ['message']);
  assert.equal(sendTool.inputSchema.additionalProperties, false);
  assert.equal(sendTool.inputSchema.properties.message.maxLength, 2000);
  assert.deepEqual(sendTool.annotations, { destructiveHint: true, openWorldHint: true, idempotentHint: false, readOnlyHint: false });
  const status = await (await call(rpc('tools/call', { name: 'lark_status', arguments: {} }))).json();
  assert.deepEqual(JSON.parse(status.result.content[0].text), statusResult(true));
  assert.equal(mock.calls.length, 0);
  const sent = await (await call(rpc('tools/call', { name: 'lark_send_message', arguments: { message: '  MCP message  ' } }, 2))).json();
  assert.deepEqual(sent, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Message sent to Lark.' }] } });
  assert.deepEqual(JSON.parse(JSON.parse(mock.calls[1].options.body).content), { text: 'MCP message' });
});

test('MCP JSON-RPC parse, request, method, parameter and notification errors never send messages', async t => {
  const mock = larkMock();
  const f = await fixture(t, mock.options);
  const cases = [
    [[], -32600], [null, -32600], [{}, -32600], [[rpc('ping')], -32600],
    [{ ...rpc('ping'), jsonrpc: '1.0' }, -32600], [{ ...rpc('ping'), id: {} }, -32600],
    [{ ...rpc('ping'), id: true }, -32600], [{ ...rpc('ping'), id: [] }, -32600],
    [{ ...rpc('ping'), method: 1 }, -32600], [rpc('ping', []), -32602],
    [rpc('initialize', {}), -32602], [rpc('unknown'), -32601],
    [rpc('tools/call', { name: 'finance' }), -32602],
    [rpc('tools/call', { name: 'lark_status', arguments: { message: 'bad' } }), -32602],
    [rpc('tools/call', { name: 'lark_status', arguments: [] }), -32602],
    [rpc('tools/call', { name: 'lark_send_message' }), -32602],
    [rpc('tools/call', { name: 'lark_send_message', arguments: { message: '   ' } }), -32602],
    [rpc('tools/call', { name: 'lark_send_message', arguments: { message: 42 } }), -32602],
    [rpc('tools/call', { name: 'lark_send_message', arguments: { message: 'x'.repeat(2001) } }), -32602],
    [rpc('tools/call', { name: 'lark_send_message', arguments: { message: 'bad', chat_id: 'other' } }), -32602],
    [{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'lark_send_message', arguments: { message: 'no id' } } }, -32600],
    [{ jsonrpc: '2.0', method: 'initialize', params: initialized }, -32600],
    [{ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, -32602],
  ];
  for (const [body, code] of cases) {
    const response = await f.request('/mcp', 'POST', body, automationHeaders);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = await response.json();
    assert.equal(error.jsonrpc, '2.0');
    assert.equal(error.error.code, code, JSON.stringify(body));
  }
  const malformed = await fetch(`${f.base}/mcp`, {
    method: 'POST', headers: { ...automationHeaders, 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
  for (const [method, params] of [['notifications/initialized', undefined], ['notifications/cancelled', { requestId: 1, reason: 'cancel' }]]) {
    const response = await f.request('/mcp', 'POST', { jsonrpc: '2.0', method, ...(params ? { params } : {}) }, automationHeaders);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
  }
  assert.equal(mock.calls.length, 0);
});

test('MCP requires bearer before parsing, protects origin, negotiates HTTP and enforces body limits', async t => {
  const mock = larkMock();
  const f = await fixture(t, { ...mock.options, publicOrigin: 'https://agency.example.com' });
  for (const headers of [{}, { Authorization: ['Bearer', TOKEN].join(' ') }, { Authorization: 'Basic ignored' }]) {
    const response = await fetch(`${f.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{' });
    assert.equal(response.status, 401);
  }
  for (const method of ['GET', 'DELETE']) {
    const response = await f.request('/mcp', method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  const checks = [
    [{ Origin: 'https://evil.example' }, 403],
    [{ Origin: 'null' }, 403],
    [{ 'Content-Type': 'text/plain' }, 415],
    [{ Accept: 'text/event-stream' }, 406],
    [{ Accept: 'application/json;q=0, text/event-stream' }, 406],
    [{ 'MCP-Protocol-Version': '2024-11-05' }, 400],
    [{ 'MCP-Protocol-Version': '2025-03-26' }, 400],
    [{ 'MCP-Protocol-Version': '2025-06-18', Origin: 'https://agency.example.com' }, 200],
    [{ Accept: 'application/json, text/event-stream' }, 200],
    [{ Accept: '*/*' }, 200],
  ];
  for (const [headers, expected] of checks) {
    const response = await f.request('/mcp', 'POST', rpc('ping'), { ...automationHeaders, ...headers });
    assert.equal(response.status, expected, JSON.stringify(headers));
  }
  assert.equal((await f.request('/mcp', 'POST', rpc('ping', { padding: 'x'.repeat(70_000) }), automationHeaders)).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.base}/mcp`, { method: 'POST', headers: automationHeaders }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write('x'.repeat(40_000));
    request.end('x'.repeat(40_000));
  });
  assert.equal(chunked, 413);
  assert.equal(mock.calls.length, 0);
});

test('Lark machine and MCP failures are sanitized and configuration never claims connectivity', async t => {
  const unconfigured = await fixture(t, { larkAutomationToken: AUTOMATION_TOKEN, larkAppSecret: 'private-app-secret' });
  const response = await unconfigured.request('/api/automation/lark/messages', 'POST', { message: 'Hello' }, automationHeaders);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Lark is not configured.' });
  const notConfigured = await (await unconfigured.request('/mcp', 'POST',
    rpc('tools/call', { name: 'lark_send_message', arguments: { message: 'Hello' } }), automationHeaders)).json();
  assert.deepEqual(notConfigured.result, { content: [{ type: 'text', text: 'Lark is not configured.' }], isError: true });
  const mock = larkMock();
  const f = await fixture(t, {
    ...mock.options, fetchImpl: async () => { throw new Error(`private-app-secret ${AUTOMATION_TOKEN} private-tenant-token`); },
  });
  const status = await f.request('/api/automation/lark/status', 'GET', undefined, automationHeaders);
  assert.deepEqual(await status.json(), statusResult(true));
  const failure = await f.request('/api/automation/lark/messages', 'POST', { message: 'Hello' }, automationHeaders);
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: 'Unable to send the Lark message.' });
  const toolFailure = await f.request('/mcp', 'POST',
    rpc('tools/call', { name: 'lark_send_message', arguments: { message: 'Hello' } }), automationHeaders);
  assert.equal(toolFailure.status, 200);
  assert.deepEqual((await toolFailure.json()).result, {
    content: [{ type: 'text', text: 'Unable to send the Lark message.' }], isError: true,
  });
});

test('all Lark sends share the same ten-per-minute IP limit and expire without affecting status', async t => {
  let time = 1000;
  const mock = larkMock();
  const f = await fixture(t, { ...mock.options, now: () => time });
  await f.login();
  const senders = [
    () => f.request('/api/integrations/lark/test', 'POST'),
    () => f.request('/api/integrations/lark/messages', 'POST', { message: 'UI' }),
    () => f.request('/api/automation/lark/messages', 'POST', { message: 'API' }, automationHeaders),
    () => f.request('/mcp', 'POST', rpc('tools/call', { name: 'lark_send_message', arguments: { message: 'MCP' } }), automationHeaders),
  ];
  for (let i = 0; i < 10; i++) assert.equal((await senders[i % 4]()).status, 200);
  assert.equal(mock.calls.length, 20);
  for (const sender of senders.slice(0, 3)) {
    const limited = await sender();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
  }
  const limitedMcp = await senders[3]();
  assert.equal((await limitedMcp.json()).result.isError, true);
  assert.equal(limitedMcp.headers.get('retry-after'), '60');
  assert.equal(mock.calls.length, 20);
  assert.equal((await f.request('/api/automation/lark/status', 'GET', undefined, automationHeaders)).status, 200);
  time += 60_000;
  assert.equal((await senders[2]()).status, 200);
  assert.equal(mock.calls.length, 22);
});

test('public GPT Actions OpenAPI requires trusted HTTPS and exposes only narrow bearer operations, never secrets', async t => {
  for (const publicOrigin of ['', 'http://localhost:3000']) {
    const f = await fixture(t, { publicOrigin });
    const response = await f.request('/api/openapi.json');
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /HTTPS PUBLIC_ORIGIN/);
  }
  const mock = larkMock();
  const f = await fixture(t, { ...mock.options, publicOrigin: 'https://custom.alliance.agency:8443' });
  const response = await f.request('/api/openapi.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const text = await response.text();
  for (const secret of [TOKEN, AUTOMATION_TOKEN, 'private-app-secret', 'private-app-id', 'private-chat-id']) assert.ok(!text.includes(secret));
  const schema = JSON.parse(text);
  assert.equal(schema.openapi, '3.1.0');
  assert.deepEqual(schema.servers, [{ url: 'https://custom.alliance.agency:8443' }]);
  assert.deepEqual(Object.keys(schema.paths), ['/api/automation/lark/status', '/api/automation/lark/messages']);
  assert.deepEqual(schema.components.securitySchemes, { larkBearer: { type: 'http', scheme: 'bearer' } });
  assert.deepEqual(schema.security, [{ larkBearer: [] }]);
  const status = schema.paths['/api/automation/lark/status'].get;
  assert.equal(status.operationId, 'getLarkConnectionStatus');
  const message = schema.paths['/api/automation/lark/messages'].post;
  assert.equal(message.operationId, 'sendLarkMessage');
  assert.equal(message['x-openai-isConsequential'], true);
  assert.equal(message.requestBody.required, true);
  assert.equal(message.requestBody.content['application/json'].schema.additionalProperties, false);
  assert.equal(message.requestBody.content['application/json'].schema.properties.message.maxLength, 2000);
  assert.equal(status.responses[200].content['application/json'].schema.properties.status.type, 'string');
  assert.equal(status.responses[200].content['application/json'].schema.properties.capabilities.type, 'array');
  assert.equal(message.responses[200].content['application/json'].schema.properties.message.type, 'string');
  assert.equal(mock.calls.length, 0);
});

test('workspace MCP credential is strong, owner-provisioned, and distinct from every other credential', async t => {
  for (const workspaceMcpToken of ['', 'short', null, 123, 'x'.repeat(4097), TOKEN, MANAGER_TOKEN, AUTOMATION_TOKEN]) {
    assert.throws(() => createApp({
      dbPath: ':memory:', adminToken: TOKEN, managerToken: MANAGER_TOKEN,
      larkAutomationToken: AUTOMATION_TOKEN, workspaceMcpToken,
    }), /AGENCY_MCP_TOKEN/);
  }
  const f = await fixture(t, { workspaceMcpToken: WORKSPACE_MCP_TOKEN });
  for (const headers of [{}, { Authorization: '' }, { Authorization: 'Basic ignored' }]) {
    const response = await f.request('/mcp', 'POST', rpc('ping'), headers);
    assert.equal(response.status, 401);
  }
  assert.equal((await f.request('/mcp', 'POST', rpc('ping'), {
    Authorization: ['Bearer', WORKSPACE_MCP_TOKEN].join(' '),
  })).status, 200);
});

test('workspace MCP manages only validated non-financial data and provides real marketing skill guides', async t => {
  const f = await fixture(t, {
    workspaceMcpToken: WORKSPACE_MCP_TOKEN, managerToken: MANAGER_TOKEN,
  });
  await f.login();
  await f.request('/api/finance', 'POST', finance);
  const workspaceHeaders = { Authorization: ['Bearer', WORKSPACE_MCP_TOKEN].join(' ') };
  const call = async (name, args) => {
    const response = await f.request('/mcp', 'POST',
      rpc('tools/call', { name, arguments: args }), workspaceHeaders);
    assert.equal(response.status, 200);
    return response.json();
  };
  const listed = await (await f.request('/mcp', 'POST', rpc('tools/list'), workspaceHeaders)).json();
  const names = listed.result.tools.map(tool => tool.name);
  assert.deepEqual(names, [
    'get_workspace_state', 'create_creator', 'update_creator', 'delete_creator',
    'create_task', 'update_task', 'delete_task', 'update_agency_settings',
    'list_marketing_skills', 'get_marketing_skill',
  ]);
  assert.ok(!names.some(name => /finance|payment|charge/iu.test(name)));
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'delete_creator').annotations,
    { destructiveHint: true, idempotentHint: false, readOnlyHint: false });

  const creatorResult = await call('create_creator', creator);
  const created = JSON.parse(creatorResult.result.content[0].text);
  assert.deepEqual(created, { id: created.id, ...creator });
  const invalidCreator = await call('create_creator', { ...creator, market: 'US' });
  assert.equal(invalidCreator.result.isError, true);
  const updatedCreator = await call('update_creator', { id: created.id, changes: { status: 'active', revenue: 125 } });
  assert.deepEqual(JSON.parse(updatedCreator.result.content[0].text), { ...created, status: 'active', revenue: 125 });

  const taskResult = await call('create_task', task);
  const createdTask = JSON.parse(taskResult.result.content[0].text);
  assert.deepEqual(createdTask, { id: createdTask.id, done: false, ...task });
  const updatedTask = await call('update_task', { id: createdTask.id, changes: { done: true } });
  assert.equal(JSON.parse(updatedTask.result.content[0].text).done, true);
  const settingsResult = await call('update_agency_settings', { agencyName: 'Updated agency' });
  assert.equal(JSON.parse(settingsResult.result.content[0].text).agencyName, 'Updated agency');

  const stateResult = await call('get_workspace_state', {});
  const stateText = stateResult.result.content[0].text;
  const state = JSON.parse(stateText);
  assert.deepEqual(state.creators, [{ ...created, status: 'active', revenue: 125 }]);
  assert.equal(state.tasks[0].done, true);
  assert.equal(state.settings.agencyName, 'Updated agency');
  assert.equal(Object.hasOwn(state, 'finance'), false);
  assert.doesNotMatch(stateText, /Private manual payment|12345\.67/u);

  const skills = JSON.parse((await call('list_marketing_skills', {})).result.content[0].text);
  assert.ok(skills.skills.includes('paid_advertising'));
  const guide = JSON.parse((await call('get_marketing_skill', { skill: 'paid_advertising' })).result.content[0].text);
  assert.match(guide.guide, /never place orders, change budgets/u);
  const invalidSkill = await f.request('/mcp', 'POST',
    rpc('tools/call', { name: 'get_marketing_skill', arguments: { skill: 'make_campaign_live' } }), workspaceHeaders);
  assert.equal(invalidSkill.status, 400);

  for (const name of ['get_finance', 'create_payment', 'list_charges']) {
    const forbidden = await f.request('/mcp', 'POST',
      rpc('tools/call', { name, arguments: {} }), workspaceHeaders);
    assert.equal((await forbidden.json()).error.code, -32602);
  }
  assert.equal((await fetch(`${f.base}/api/finance`, { headers: workspaceHeaders })).status, 401);
});

test('workspace OpenAPI schema requires HTTPS origin and never publishes the bearer token', async t => {
  for (const publicOrigin of ['', 'http://localhost:3000']) {
    const f = await fixture(t, { publicOrigin, workspaceMcpToken: WORKSPACE_MCP_TOKEN });
    assert.equal((await f.request('/api/workspace-openapi.json')).status, 503);
  }
  const f = await fixture(t, {
    publicOrigin: 'https://agency.example.com', workspaceMcpToken: WORKSPACE_MCP_TOKEN,
  });
  const response = await f.request('/api/workspace-openapi.json');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(WORKSPACE_MCP_TOKEN));
  const schema = JSON.parse(text);
  assert.equal(schema.openapi, '3.1.0');
  assert.deepEqual(schema.servers, [{ url: 'https://agency.example.com' }]);
  assert.deepEqual(schema.security, [{ workspaceBearer: [] }]);
  assert.ok(schema.paths['/mcp'].post);
  assert.deepEqual(schema.paths['/mcp'].post.requestBody.content['application/json'].schema,
    { $ref: '#/components/schemas/JsonRpcRequest' });
});
