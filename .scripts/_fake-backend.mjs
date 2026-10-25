// Test helper: an in-memory stand-in for Supabase's REST API (PostgREST) plus
// any other HTTP service the edge functions call (NVIDIA, Google, Discord...).
//
// WHY THIS EXISTS
// The edge functions talk to the outside world ONLY through global fetch(). So a
// test can swap fetch for this fake and then call the real onRequest() handler
// exactly the way EdgeOne would — real auth code, real cookies, real rate-limit
// keys — with no network and no secrets. That is what lets the security fixes
// (lockout, OAuth merge, CSRF binding...) have tests that fail when the fix is
// reverted.
//
// The leading underscore keeps it out of CI's `.scripts/test-*.mjs` loop: this
// file is a tool the tests import, not a test itself.
//
// SCOPE: only the PostgREST features the functions actually use —
//   filters  col=eq.X  col=gt.X  col=lt.X  col=is.null  col=not.is.null
//            col=like.*X*  col=in.("a","b")
//   params   select, order, limit, offset, on_conflict
//   writes   POST (insert / upsert with Prefer: resolution=merge-duplicates),
//            PATCH, DELETE
// ponytail: a deliberately tiny PostgREST. If a function starts using a filter
// this does not understand, the fake THROWS rather than guessing, so a test can
// never pass by accident.

// Primary key of each table — what an upsert / duplicate check keys on.
const PRIMARY_KEY = { users: 'id', kv_store: 'key', chat_history: 'id', documents: 'id', security_events: 'id' };
// Unique columns besides the primary key (a duplicate here is HTTP 409, like Postgres).
const UNIQUE = { users: ['email', 'username'] };

export function makeFakeBackend({ supabaseUrl = 'https://sb.test', external = null, rpc = {} } = {}) {
  // tables[name] = array of row objects
  const tables = { users: [], kv_store: [], chat_history: [], documents: [], security_events: [] };
  // Every request seen, so a test can assert "no call to NVIDIA happened".
  const calls = [];

  // Turn one "col=op.value" filter into a predicate over a row.
  function predicate(col, expr) {
    if (expr === 'is.null') return r => r[col] == null;
    if (expr === 'not.is.null') return r => r[col] != null;
    const dot = expr.indexOf('.');
    const op = expr.slice(0, dot), val = expr.slice(dot + 1);
    switch (op) {
      case 'eq': return r => String(r[col]) === val;
      case 'gt': return r => r[col] != null && String(r[col]) > val;
      case 'lt': return r => r[col] != null && String(r[col]) < val;
      case 'like': {
        // PostgREST uses * as the wildcard; SQL LIKE also treats _ as "any char".
        const re = new RegExp('^' + val.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*') + '$');
        return r => r[col] != null && re.test(String(r[col]));
      }
      case 'in': {
        const list = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
        return r => list.includes(String(r[col]));
      }
      default: throw new Error(`fake PostgREST does not understand filter ${col}=${expr}`);
    }
  }

  // Parse the query string into { filters: [pred], select, order, limit, offset }.
  function parseQuery(search) {
    const out = { preds: [], select: null, order: null, limit: null, offset: 0 };
    for (const part of search.replace(/^\?/, '').split('&').filter(Boolean)) {
      const eq = part.indexOf('=');
      const key = decodeURIComponent(part.slice(0, eq));
      const value = decodeURIComponent(part.slice(eq + 1));
      if (key === 'select') out.select = value.split(',');
      else if (key === 'order') out.order = value;
      else if (key === 'limit') out.limit = Number(value);
      else if (key === 'offset') out.offset = Number(value);
      else if (key === 'on_conflict') { /* upsert target — PK is assumed */ }
      else out.preds.push(predicate(key, value));
    }
    return out;
  }

  // 204 must have a null body — the Response constructor throws otherwise.
  const json = (status, body) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  function handleRest(table, method, search, bodyText, headers) {
    if (!tables[table]) throw new Error(`fake PostgREST has no table "${table}"`);
    const rows = tables[table];
    const q = parseQuery(search);
    const match = r => q.preds.every(p => p(r));
    const prefer = (headers.get?.('Prefer') || headers.Prefer || '');
    const representation = /return=representation/.test(prefer);

    if (method === 'GET') {
      let out = rows.filter(match);
      if (q.order) {
        const [col, dir] = q.order.split('.');
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
      }
      out = out.slice(q.offset, q.limit == null ? undefined : q.offset + q.limit);
      if (q.select) out = out.map(r => Object.fromEntries(q.select.map(c => [c, r[c]])));
      return json(200, out);
    }
    if (method === 'POST') {
      const incoming = [].concat(JSON.parse(bodyText));
      const pk = PRIMARY_KEY[table];
      const merge = /merge-duplicates/.test(prefer);
      const ignore = /ignore-duplicates/.test(prefer);
      const inserted = [];
      for (const row of incoming) {
        const existing = rows.find(r => r[pk] != null && r[pk] === row[pk]);
        if (existing) {
          if (merge) { Object.assign(existing, row); inserted.push(existing); continue; }
          if (ignore) continue;
          return json(409, { code: '23505', message: 'duplicate key' });
        }
        for (const col of UNIQUE[table] || []) {
          if (row[col] != null && rows.some(r => r[col] === row[col])) return json(409, { code: '23505', message: `duplicate ${col}` });
        }
        const copy = { ...row };
        if (copy[pk] == null) copy[pk] = rows.length + 1;
        rows.push(copy);
        inserted.push(copy);
      }
      return representation ? json(201, inserted) : json(201);
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(bodyText);
      const hit = rows.filter(match);
      hit.forEach(r => Object.assign(r, patch));
      return representation ? json(200, hit) : json(204);
    }
    if (method === 'DELETE') {
      const keep = rows.filter(r => !match(r));
      const removed = rows.length - keep.length;
      rows.length = 0; rows.push(...keep);
      return new Response('', { status: 204, headers: { 'Content-Range': `*/${removed}` } });
    }
    throw new Error(`fake PostgREST: unsupported method ${method}`);
  }

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const bodyText = init.body == null ? '' : String(init.body);
    calls.push({ url: url.href, method, headers, body: bodyText });

    if (url.origin === new URL(supabaseUrl).origin) {
      const path = url.pathname.replace(/^\/rest\/v1\//, '');
      if (path.startsWith('rpc/')) {
        const fn = rpc[path.slice(4)];
        if (!fn) return json(404, { code: 'PGRST202', message: `function ${path.slice(4)} not found` });
        return json(200, await fn(JSON.parse(bodyText || '{}'), tables));
      }
      return handleRest(path, method, url.search, bodyText, headers);
    }
    if (external) {
      const res = await external(url, { ...init, method, headers, body: bodyText });
      if (res) return res;
    }
    throw new Error(`fake backend: unexpected request to ${url.href}`);
  }

  return { fetch, tables, calls };
}

// Shared env for every handler test. JWT_SECRET is >= 32 chars because the
// functions refuse to start with a shorter one.
export const TEST_ENV = {
  JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
  ALLOWED_ORIGIN: 'https://econintel.test',
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  NVIDIA_API_KEY: 'nvapi-test',
};

// Build a Request the way a browser on the real site would send it.
export function req(path, { method = 'GET', body, cookies = {}, headers = {}, ip = '203.0.113.7' } = {}) {
  const h = new Headers({ 'EO-Connecting-IP': ip, ...headers });
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookieStr) h.set('Cookie', cookieStr);
  if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
  return new Request(`https://econintel.test${path}`, {
    method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

// Pull name=value pairs out of every Set-Cookie header on a response.
export function setCookies(res) {
  const out = {};
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of all) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
