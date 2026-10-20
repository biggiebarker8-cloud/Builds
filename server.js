import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const SESSION_AGE = 8 * 60 * 60 * 1000;
const TIMEZONES = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Hobart'];
const MARKETS = ['AU', 'UK'];
const STATUSES = ['prospect', 'onboarding', 'active', 'paused'];
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const invalid = (message = 'Invalid request.') => { throw new HttpError(400, message); };
const string = (value, max, empty = false) =>
  typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const number = (value, max) => typeof value === 'number' && Number.isFinite(value) &&
  value >= 0 && value <= max && Number(value.toFixed(2)) === value;
const date = value => value === '' || (
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
);
const creatorRules = {
  handle: v => string(v, 100),
  market: v => MARKETS.includes(v),
  manager: v => string(v, 100, true),
  status: v => STATUSES.includes(v),
  liveHours: v => number(v, 1_000_000),
  revenue: v => number(v, 1_000_000_000),
  targetHours: v => number(v, 1_000_000),
};
const taskRules = {
  title: v => string(v, 200),
  market: v => MARKETS.includes(v),
  dueDate: date,
  done: v => typeof v === 'boolean',
};
const settingsRules = {
  agencyName: v => string(v, 100),
  accountHandle: v => string(v, 100),
  auTimezone: v => TIMEZONES.includes(v),
  ukEnabled: v => typeof v === 'boolean',
};

function validate(body, rules, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !Object.hasOwn(rules, key) || !rules[key](body[key])) ||
      required.some(key => !Object.hasOwn(body, key))) invalid('Invalid or missing fields.');
  return body;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      throw new HttpError(413, 'Request body too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Use application/json.');
  }
  try {
    return JSON.parse(req.bodyBytes.toString('utf8'));
  } catch {
    invalid('Invalid JSON.');
  }
}

function csvCell(value) {
  let text = String(value);
  // Spreadsheet applications can evaluate formulas even after leading whitespace.
  if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createApp({
  dbPath = process.env.AGENCY_DB_PATH || resolve(ROOT, 'data/agency.sqlite'),
  adminToken = process.env.AGENCY_ADMIN_TOKEN,
  publicOrigin = process.env.PUBLIC_ORIGIN,
  larkAppId = process.env.LARK_APP_ID,
  larkAppSecret = process.env.LARK_APP_SECRET,
  larkChatId = process.env.LARK_CHAT_ID,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (typeof adminToken !== 'string' || adminToken.length < 32 || adminToken.length > 4096) {
    throw new Error('AGENCY_ADMIN_TOKEN must contain between 32 and 4096 characters.');
  }
  let trustedOrigin;
  if (publicOrigin !== undefined && publicOrigin !== '') {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('Invalid PUBLIC_ORIGIN.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid PUBLIC_ORIGIN.');
    trustedOrigin = parsed.origin;
  }
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY NOT NULL,
      handle TEXT NOT NULL CHECK(length(handle) BETWEEN 1 AND 100),
      market TEXT NOT NULL CHECK(market IN ('AU','UK')),
      manager TEXT NOT NULL CHECK(length(manager) <= 100),
      status TEXT NOT NULL CHECK(status IN ('prospect','onboarding','active','paused')),
      liveHours REAL NOT NULL CHECK(liveHours BETWEEN 0 AND 1000000),
      revenue REAL NOT NULL CHECK(revenue BETWEEN 0 AND 1000000000),
      targetHours REAL NOT NULL CHECK(targetHours BETWEEN 0 AND 1000000)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      market TEXT NOT NULL CHECK(market IN ('AU','UK')),
      dueDate TEXT NOT NULL CHECK(dueDate = '' OR (length(dueDate) = 10 AND dueDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
      done INTEGER NOT NULL CHECK(done IN (0,1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      agencyName TEXT NOT NULL CHECK(length(agencyName) BETWEEN 1 AND 100),
      accountHandle TEXT NOT NULL CHECK(length(accountHandle) BETWEEN 1 AND 100),
      auTimezone TEXT NOT NULL CHECK(auTimezone IN ('Australia/Sydney','Australia/Melbourne','Australia/Brisbane','Australia/Perth','Australia/Adelaide','Australia/Darwin','Australia/Hobart')),
      ukEnabled INTEGER NOT NULL CHECK(ukEnabled IN (0,1))
    ) STRICT;
    INSERT OR IGNORE INTO settings VALUES (1, 'The Alliance', 'sarcasm_the_alliance', 'Australia/Sydney', 0);
  `);
  const sessions = new Map();
  const attempts = new Map();
  const expectedTokenHash = createHash('sha256').update(adminToken).digest();
  const larkConfigured = Boolean(larkAppId && larkAppSecret && larkChatId);
  const getSettings = () => {
    const { id, ...settings } = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    return { ...settings, ukEnabled: Boolean(settings.ukEnabled) };
  };
  const getTasks = () => db.prepare('SELECT * FROM tasks ORDER BY rowid').all().map(t => ({ ...t, done: Boolean(t.done) }));
  const getCreators = () => db.prepare('SELECT * FROM creators ORDER BY rowid').all();
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  const sessionId = req => {
    const cookie = req.headers.cookie || '';
    return cookie.split(';').map(c => c.trim()).find(c => c.startsWith('agency_session='))?.slice(15);
  };
  const cookie = (req, value, age) =>
    `agency_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${req.socket.encrypted || trustedOrigin?.startsWith('https:') ? '; Secure' : ''}`;
  async function larkTest() {
    if (!larkConfigured) throw new HttpError(503, 'Lark is not configured.');
    try {
      const signal = AbortSignal.timeout(10_000);
      const authResponse = await fetchImpl('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: larkAppId, app_secret: larkAppSecret }), signal,
        redirect: 'error',
      });
      if (!authResponse.ok) throw new Error();
      const auth = await authResponse.json();
      if (auth.code !== 0 || typeof auth.tenant_access_token !== 'string' || !auth.tenant_access_token) throw new Error();
      const messageResponse = await fetchImpl('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: ['Bearer', auth.tenant_access_token].join(' ') },
        body: JSON.stringify({
          receive_id: larkChatId, msg_type: 'text',
          content: JSON.stringify({ text: 'The Alliance: Lark integration test message.' }),
        }), signal, redirect: 'error',
      });
      if (!messageResponse.ok || (await messageResponse.json()).code !== 0) throw new Error();
    } catch {
      throw new HttpError(502, 'Unable to send the Lark test message.');
    }
  }
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = req.method;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const origin = req.headers.origin;
        const protocol = req.socket.encrypted ? 'https' : 'http';
        const allowedOrigins = trustedOrigin ? [trustedOrigin] :
          ['127.0.0.1', 'localhost', '[::1]'].map(host => new URL(`${protocol}://${host}:${req.socket.localPort}`).origin);
        if (origin !== undefined && !allowedOrigins.includes(origin)) throw new HttpError(403, 'Origin not allowed.');
        if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) {
          throw new HttpError(413, 'Request body too large.');
        }
        req.bodyBytes = await readBody(req);
      }
      if (!path.startsWith('/api/')) {
        const entry = STATIC_FILES.get(path);
        if (!entry || !['GET', 'HEAD'].includes(method)) throw new HttpError(404, 'Not found.');
        let content;
        try { content = readFileSync(resolve(ROOT, 'public', entry[0])); }
        catch { throw new HttpError(404, 'Not found.'); }
        res.writeHead(200, { 'Content-Type': entry[1] });
        res.end(method === 'HEAD' ? undefined : content);
        return;
      }
      if (path === '/api/login' && method === 'POST') {
        const timestamp = now();
        for (const [key, attempt] of attempts) if (attempt.until <= timestamp) attempts.delete(key);
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) || { count: 0, until: timestamp + 15 * 60 * 1000 };
        if (attempt.count >= 10 || (!attempts.has(ip) && attempts.size >= 10_000)) {
          res.setHeader('Retry-After', '900');
          throw new HttpError(429, 'Too many login attempts. Try again later.');
        }
        attempt.count += 1;
        attempts.set(ip, attempt);
        const body = validate(await readJson(req), { token: v => typeof v === 'string' && v.length <= 4096 }, ['token']);
        if (!timingSafeEqual(createHash('sha256').update(body.token).digest(), expectedTokenHash)) {
          throw new HttpError(401, 'Invalid credentials.');
        }
        for (const [id, expiry] of sessions) if (expiry <= timestamp) sessions.delete(id);
        if (sessions.size >= 10_000) throw new HttpError(503, 'Session capacity reached.');
        sessions.delete(sessionId(req));
        const id = randomBytes(32).toString('hex');
        sessions.set(id, timestamp + SESSION_AGE);
        res.setHeader('Set-Cookie', cookie(req, id, SESSION_AGE / 1000));
        send(res, 200, { authenticated: true });
        return;
      }
      const id = sessionId(req);
      if (!id || !sessions.has(id) || sessions.get(id) <= now()) {
        if (id) sessions.delete(id);
        throw new HttpError(401, 'Authentication required.');
      }
      if (path === '/api/session' && method === 'GET') {
        send(res, 200, { authenticated: true });
      } else if (path === '/api/logout' && method === 'POST') {
        sessions.delete(id);
        res.setHeader('Set-Cookie', cookie(req, '', 0));
        send(res, 200, { authenticated: false });
      } else if (path === '/api/state' && method === 'GET') {
        send(res, 200, {
          creators: getCreators(), tasks: getTasks(), settings: getSettings(),
          integrations: { tiktok: { status: 'not_connected' }, lark: { status: larkConfigured ? 'configured' : 'not_configured' } },
        });
      } else if (path === '/api/settings' && method === 'PATCH') {
        const body = validate(await readJson(req), settingsRules);
        const settings = { ...getSettings(), ...body };
        db.prepare('UPDATE settings SET agencyName=?, accountHandle=?, auTimezone=?, ukEnabled=? WHERE id=1')
          .run(settings.agencyName, settings.accountHandle, settings.auTimezone, Number(settings.ukEnabled));
        send(res, 200, settings);
      } else if (path === '/api/export' && method === 'GET') {
        const keys = ['id', ...Object.keys(creatorRules)];
        const rows = [keys, ...getCreators().map(c => keys.map(key => c[key]))];
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="alliance-creators.csv"',
        });
        res.end(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
      } else if (path === '/api/integrations/lark/test' && method === 'POST') {
        await larkTest();
        send(res, 200, { message: 'Test message sent to Lark.' });
      } else {
        const match = /^\/api\/(creators|tasks)(?:\/([a-f0-9-]{36}))?$/u.exec(path);
        if (!match) throw new HttpError(404, 'Not found.');
        const [, table, recordId] = match;
        const rules = table === 'creators' ? creatorRules : taskRules;
        if (!recordId && method === 'POST') {
          const required = Object.keys(rules).filter(key => key !== 'done');
          const body = validate(await readJson(req), rules, required);
          const record = { id: randomUUID(), ...body };
          if (table === 'tasks') record.done ??= false;
          const keys = ['id', ...Object.keys(rules)];
          db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
            .run(...keys.map(key => typeof record[key] === 'boolean' ? Number(record[key]) : record[key]));
          send(res, 201, record);
        } else if (recordId && ['PATCH', 'DELETE'].includes(method)) {
          const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(recordId);
          if (!existing) throw new HttpError(404, 'Not found.');
          if (method === 'DELETE') {
            db.prepare(`DELETE FROM ${table} WHERE id=?`).run(recordId);
            send(res, 204);
          } else {
            const body = validate(await readJson(req), table === 'tasks' ? { done: taskRules.done } : rules);
            const keys = Object.keys(body);
            db.prepare(`UPDATE ${table} SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`)
              .run(...keys.map(key => typeof body[key] === 'boolean' ? Number(body[key]) : body[key]), recordId);
            const record = { ...existing, ...body };
            if (table === 'tasks') record.done = Boolean(record.done);
            send(res, 200, record);
          }
        } else throw new HttpError(404, 'Not found.');
      }
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Internal server error.' });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => { sessions.clear(); attempts.clear(); db.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
    const server = createApp();
    server.on('error', () => { console.error('Unable to start server. Check host, port, and database configuration.'); process.exitCode = 1; });
    server.listen(port, process.env.HOST || '127.0.0.1', () => {
      console.log(`Agency server listening on port ${port}.`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch {
    console.error('Unable to start server. Set AGENCY_ADMIN_TOKEN (32–4096 characters) and check PUBLIC_ORIGIN, database, and port configuration.');
    process.exitCode = 1;
  }
}
