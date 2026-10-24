import { appOrigin, tables, type Env } from './config.ts';
import { hash, randomToken, sign, verifyGoogleToken, verifySigned, type GoogleIdentity } from './crypto.ts';
import { cookie, cookieName, readCookie, SESSION_SECONDS, sessionFor, TRANSACTION_SECONDS } from './session.ts';
import { MAX_SNAPSHOT_BYTES, parseSnapshot } from './snapshot.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const headers = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

interface Dependencies {
  fetch: typeof fetch;
  verifyIdentity: (token: string, clientId: string, nonce: string) => Promise<GoogleIdentity>;
  now: () => number;
}
const defaults: Dependencies = { fetch: (...args) => fetch(...args), verifyIdentity: verifyGoogleToken, now: () => Date.now() };

interface Transaction { state: string; nonce: string; verifier: string; expires: number; popup: boolean }

async function transactionFor(request: Request, env: Env, now: number): Promise<Transaction> {
  const stored = readCookie(request, cookieName(env, 'oauth'));
  if (!stored || stored.length > 4096) throw new HttpError(400, 'Sign-in expired. Please try again.');
  const [encoded, signature, extra] = stored.split('.');
  if (!encoded || !signature || extra || !await verifySigned(`oauth:${encoded}`, signature, env.GOOGLE_CLIENT_SECRET)) throw new HttpError(400, 'Sign-in expired. Please try again.');
  try {
    const value: Transaction = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')));
    if (value.expires < now || value.expires > now + TRANSACTION_SECONDS * 1000 ||
        ![value.state, value.nonce, value.verifier].every((s) => typeof s === 'string' && /^[\w-]{43}$/.test(s)) ||
        typeof value.popup !== 'boolean') throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Sign-in expired. Please try again.'); }
}

function complete(env: Env, ok: boolean, popup: boolean, sessionCookie?: string): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.delete('Content-Type');
  resultHeaders.append('Set-Cookie', cookie(env, 'oauth', '', 0));
  if (sessionCookie) resultHeaders.append('Set-Cookie', sessionCookie);
  const target = `${appOrigin(env)}/?auth=${ok ? 'success' : 'failed'}`;
  if (!popup) {
    resultHeaders.set('Location', target);
    return new Response(null, { status: 303, headers: resultHeaders });
  }
  const nonce = randomToken();
  resultHeaders.set('Content-Type', 'text/html; charset=utf-8');
  resultHeaders.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
  const origin = JSON.stringify(appOrigin(env)).replaceAll('<', '\\u003c');
  const fallback = JSON.stringify(target).replaceAll('<', '\\u003c');
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>EIGA sign-in</title><body><p>${ok ? 'Signed in. You can return to EIGA.' : 'Sign-in could not finish. Return to EIGA and try again.'}</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage({type:'eiga-auth',ok:${ok}},${origin});window.close()}else{window.location.replace(${fallback})}</script></body></html>`, { headers: resultHeaders });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Send a JSON library.');
  const max = MAX_SNAPSHOT_BYTES + 1024;
  const length = request.headers.get('content-length');
  if (length && Number(length) > max) throw new HttpError(413, 'This library is too large to save. The limit is 1.5 MB of normalized data.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Send a JSON library.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new HttpError(413, 'This library is too large to save. The limit is 1.5 MB of normalized data.'); }
    chunks.push(value);
  }
  try {
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Send a valid JSON library.'); }
}

export function createHandler(deps: Dependencies = defaults) {
  return async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const now = deps.now();
    let callbackPopup = false;
    try {
      const origin = appOrigin(env);
      const t = tables(env);
      if (url.origin !== origin) throw new HttpError(421, 'Use the configured EIGA address.');

      if (path === '/api/health' && request.method === 'GET') {
        await env.DB.prepare(`SELECT user_id FROM ${t.maps} LIMIT 0`).all();
        return json({ ok: true, environment: env.APP_ENV, frontendCommit: env.FRONTEND_COMMIT ?? null, backendCommit: env.BACKEND_COMMIT ?? null });
      }
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, 'Sign-in is not configured yet. You can still import locally.');

      if (path === '/api/auth/google' && request.method === 'GET') {
        // Cross-site navigations may open this endpoint; the random browser-bound
        // transaction, not a caller-supplied return URL, controls the callback.
        const transaction: Transaction = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), expires: now + TRANSACTION_SECONDS * 1000, popup: url.searchParams.get('popup') === '1' };
        const encoded = btoa(JSON.stringify(transaction)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state: transaction.state, nonce: transaction.nonce, code_challenge: await hash(transaction.verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        return new Response(null, { status: 302, headers: { ...headers, Location: target.href, 'Set-Cookie': cookie(env, 'oauth', `${encoded}.${await sign(`oauth:${encoded}`, env.GOOGLE_CLIENT_SECRET)}`, TRANSACTION_SECONDS) } });
      }

      if (path === '/api/auth/google/callback' && request.method === 'GET') {
        const transaction = await transactionFor(request, env, now);
        callbackPopup = transaction.popup;
        if (url.searchParams.get('state') !== transaction.state || url.searchParams.has('error')) throw new HttpError(400, 'Sign-in was cancelled or expired.');
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) throw new HttpError(400, 'Sign-in was cancelled or expired.');
        const response = await deps.fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code_verifier: transaction.verifier, redirect_uri: `${origin}/api/auth/google/callback`, grant_type: 'authorization_code' }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new HttpError(502, 'Google sign-in is unavailable. Please try again.');
        const tokens = await response.json() as { id_token?: unknown };
        if (typeof tokens.id_token !== 'string') throw new HttpError(502, 'Google sign-in is unavailable. Please try again.');
        const identity = await deps.verifyIdentity(tokens.id_token, env.GOOGLE_CLIENT_ID, transaction.nonce);
        const user = await env.DB.prepare(`INSERT INTO ${t.users} (id, google_sub, name, email, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(google_sub) DO UPDATE SET name = excluded.name, email = excluded.email RETURNING id`)
          .bind(crypto.randomUUID(), identity.sub, identity.name, identity.email, now).first<{ id: string }>();
        if (!user) throw new Error('Account unavailable.');
        const token = randomToken();
        const oldToken = readCookie(request, cookieName(env, 'session'));
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM ${t.sessions} WHERE expires_at <= ?`).bind(now),
          ...(oldToken && /^[\w-]{43}$/.test(oldToken) ? [env.DB.prepare(`DELETE FROM ${t.sessions} WHERE token_hash = ?`).bind(await hash(oldToken))] : []),
          env.DB.prepare(`INSERT INTO ${t.sessions} (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(await hash(token), user.id, now, now + SESSION_SECONDS * 1000),
        ]);
        return complete(env, true, transaction.popup, cookie(env, 'session', token, SESSION_SECONDS));
      }

      const shared = /^\/api\/share\/([\w-]{43})$/.exec(path);
      if (shared && request.method === 'GET') {
        const map = await env.DB.prepare(`SELECT snapshot, updated_at FROM ${t.maps} WHERE share_id = ?`).bind(shared[1]).first<{ snapshot: string; updated_at: number }>();
        if (!map) throw new HttpError(404, 'This shared map is unavailable or its link has been revoked.');
        return json({ snapshot: JSON.parse(map.snapshot), updatedAt: map.updated_at });
      }
      const session = await sessionFor(request, env, now);
      if (path === '/api/auth/session' && request.method === 'GET') return json({ user: session?.user ?? null, csrfToken: session?.csrfToken ?? null });
      const known = ['/api/auth/logout', '/api/map', '/api/share'];
      if (!known.includes(path)) throw new HttpError(404, 'This endpoint does not exist.');
      const methods = path === '/api/map' ? ['GET', 'PUT', 'DELETE'] : path === '/api/share' ? ['POST', 'DELETE'] : ['POST'];
      if (!methods.includes(request.method)) throw new HttpError(405, 'This method is not supported.');
      if (!session) throw new HttpError(401, 'Sign in to save or share your map.');
      if (request.method !== 'GET') {
        if (request.headers.get('Origin') !== origin || request.headers.get('x-csrf-token') !== session.csrfToken) throw new HttpError(403, 'Refresh EIGA before trying again.');
      }
      if (path === '/api/auth/logout') {
        await env.DB.prepare(`DELETE FROM ${t.sessions} WHERE token_hash = ?`).bind(session.tokenHash).run();
        return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, 'Set-Cookie': cookie(env, 'session', '', 0) } });
      }
      if (path === '/api/map' && request.method === 'GET') {
        const row = await env.DB.prepare(`SELECT snapshot, revision, updated_at, share_id FROM ${t.maps} WHERE user_id = ?`).bind(session.user.id).first<{ snapshot: string; revision: number; updated_at: number; share_id: string | null }>();
        return json(row ? { snapshot: JSON.parse(row.snapshot), revision: row.revision, updatedAt: row.updated_at, shared: row.share_id !== null } : null);
      }
      if (path === '/api/map' && request.method === 'PUT') {
        const body = await readBody(request);
        if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, 'A valid saved-map revision is required.');
        let snapshot;
        try { snapshot = parseSnapshot(body.snapshot); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'The library is invalid.'); }
        const statement = body.revision === 0
          ? env.DB.prepare(`INSERT INTO ${t.maps} (user_id, snapshot, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING revision, updated_at, share_id`)
            .bind(session.user.id, JSON.stringify(snapshot), now)
          : env.DB.prepare(`UPDATE ${t.maps} SET snapshot = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING revision, updated_at, share_id`)
            .bind(JSON.stringify(snapshot), now, session.user.id, body.revision);
        const updated = await statement.first<{ revision: number; updated_at: number; share_id: string | null }>();
        if (!updated) throw new HttpError(409, 'Your saved map changed in another tab. Reload it before replacing it.');
        return json({ revision: updated.revision, updatedAt: updated.updated_at, shared: updated.share_id !== null });
      }
      if (path === '/api/map' && request.method === 'DELETE') {
        await env.DB.prepare(`DELETE FROM ${t.maps} WHERE user_id = ?`).bind(session.user.id).run();
        return json({ ok: true });
      }
      if (path === '/api/share' && request.method === 'POST') {
        const row = await env.DB.prepare(`UPDATE ${t.maps} SET share_id = COALESCE(share_id, ?) WHERE user_id = ? RETURNING share_id`).bind(randomToken(), session.user.id).first<{ share_id: string }>();
        if (!row) throw new HttpError(409, 'Save your library before sharing it.');
        return json({ url: `${origin}/?share=${row.share_id}` });
      }
      await env.DB.prepare(`UPDATE ${t.maps} SET share_id = NULL WHERE user_id = ?`).bind(session.user.id).run();
      return json({ ok: true });
    } catch (error) {
      // Never log request URLs, provider responses, imports, or exception details.
      if (path === '/api/auth/google/callback') {
        try { return complete(env, false, callbackPopup); } catch { return json({ error: 'Sign-in is not configured yet.' }, 503); }
      }
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'EIGA could not complete this request. Please try again.' }, 503);
    }
  };
}

export const handle = createHandler();
