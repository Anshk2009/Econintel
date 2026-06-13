# Why signup fails — and the one step that fixes it

Everything is now on **one origin** (frontend + functions both on EdgeOne), so
**there is no CORS to configure**. I tested the live backend directly:

- `/auth?action=signup` **reaches the function** (routing is correct). ✅
- It returns **HTTP 500** because the **`users` table does not exist** in Supabase.
  The old migration used SQLite's `DATETIME` type, which PostgreSQL rejects, so
  the table was never created. (The `kv_store` table used `TIMESTAMPTZ`, which is
  why it exists and rate-limiting works.)

## The fix (1 step)

1. Supabase dashboard → **SQL Editor** → **New query**
2. Paste the entire contents of **`schema_supabase.sql`** → **Run**
3. You should see "Success. No rows returned."

That's it — signup will work immediately. The schema disables RLS (the Supabase
key only lives server-side in the EdgeOne functions, never in the browser, so RLS
would only block our own backend).

## Verify
```bash
curl -s -X POST "https://econintel.edgeone.app/auth?action=signup" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"a-strong-password-12","username":"yourname"}'
```
Expect `201` with `{ "userId": "...", "jwt": "...", "message": "Account created" }`.

## Optional hardening (later, not required)
- Set `SUPABASE_SERVICE_KEY` (Supabase → Settings → API → service_role) in EdgeOne
  and flip the `DISABLE` lines in the schema to `ENABLE`. The functions already
  prefer the service key, so just re-upload `functions/*.js`.
