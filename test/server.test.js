import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';

const TOKEN = 'unit-test-only-token-not-for-production-123456';
const creator = { handle: 'creator', market: 'AU', manager: '', status: 'prospect', liveHours: 0, revenue: 0, targetHours: 20 };
const task = { title: 'Review creator', market: 'AU', dueDate: '2026-10-21' };

async function fixture(t, options = {}) {
  mkdirSync('.test-data', { recursive: true });
  const directory = mkdtempSync(resolve('.test-data', 'server-'));
  const dbPath = resolve(directory, 'agency.sqlite');
  let server;
  let base;
  let cookie = '';
  async function start() {
    server = createApp({ dbPath, adminToken: TOKEN, publicOrigin: '', larkAppId: '', larkAppSecret: '', larkChatId: '', ...options });
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
  async function login() {
    const response = await request('/api/login', 'POST', { token: TOKEN });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  return { request, login, stop, start, dbPath, get base() { return base; } };
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
  ]) assert.equal((await f.request(path, method)).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { token: 'wrong' })).status, 401);
  const login = await f.login();
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=28800/);
  assert.doesNotMatch(cookie, new RegExp(TOKEN));
  assert.deepEqual(await (await f.request('/api/session')).json(), { authenticated: true });
  const response = await f.request('/api/state');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const state = await response.json();
  assert.deepEqual(state.creators, []);
  assert.deepEqual(state.tasks, []);
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
    { ...creator, id: 'injected' }, { ...creator, manager: 'x'.repeat(101) },
  ]) assert.equal((await f.request('/api/creators', 'POST', body)).status, 400);
  const created = await f.request('/api/creators', 'POST', creator);
  assert.equal(created.status, 201);
  const c = await created.json();
  assert.match(c.id, /^[a-f0-9-]{36}$/);
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
