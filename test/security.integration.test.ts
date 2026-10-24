import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, SignJWT } from "jose";
import { createHandler } from "../src/app.ts";
import { verifyGoogleToken } from "../src/crypto.ts";
import type { Env } from "../src/config.ts";

const origin = "https://eiga.example";
const clientId = "test-client.apps.googleusercontent.com";
const clientSecret = "a-test-client-secret-with-enough-entropy";
let mf: Miniflare;
let db: D1Database;

const now = () => Date.UTC(2026, 9, 24, 12, 0, 0);
const jwtNow = () => Math.floor(Date.now() / 1000);
const goodIdentity = {
  sub: "google-user-1",
  name: "Test User",
  email: "user@example.test",
};
const secondIdentity = {
  sub: "google-user-2",
  name: "Second User",
  email: "second@example.test",
};
const handler = createHandler({
  fetch: async (_input, init) =>
    Response.json({
      id_token:
        new URLSearchParams(String(init?.body ?? "")).get("code") ??
        "missing-code",
    }),
  verifyIdentity: async (token) =>
    token === "auth-code-second" ? secondIdentity : goodIdentity,
  now,
});

function env(appEnv: "staging" | "production" = "staging"): Env {
  return {
    DB: db,
    APP_ENV: appEnv,
    APP_ORIGIN: origin,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
  };
}

async function call(
  path: string,
  options: RequestInit = {},
  appEnv: "staging" | "production" = "staging",
) {
  return handler(new Request(`${origin}${path}`, options), env(appEnv));
}

function cookieValue(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const entry = setCookie
    .split(/, (?=[^;]+=)/)
    .find((part) => part.startsWith(`${name}=`));
  assert.ok(entry, `expected Set-Cookie for ${name}; got ${setCookie}`);
  return entry.slice(name.length + 1).split(";", 1)[0];
}

function jsonRequest(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } satisfies RequestInit;
}

const sampleSnapshot = (title = "A Film") => ({
  version: 1,
  films: [
    {
      id: "film-1",
      title,
      year: 2020,
      uri: "https://letterboxd.com/film/a-film/",
      directors: ["Director"],
    },
  ],
  watches: [{ filmId: "film-1", watchedOn: "2024-03-20", rewatch: false }],
  ratings: [["film-1", 4.5]],
  reviews: [["film-1", "A thoughtful review."]],
  likes: ["film-1"],
});

async function beginLogin(popup = false) {
  const response = await call(`/api/auth/google${popup ? "?popup=1" : ""}`);
  assert.equal(response.status, 302);
  const oauthCookie = cookieValue(response, "__Host-eiga-oauth");
  const encoded = oauthCookie.split(".")[0];
  const transaction = JSON.parse(
    atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
  );
  return { response, oauthCookie, transaction };
}

async function finishLogin(code = "auth-code") {
  const begun = await beginLogin();
  const response = await call(
    `/api/auth/google/callback?code=${code}&state=${begun.transaction.state}`,
    {
      headers: { cookie: `__Host-eiga-oauth=${begun.oauthCookie}` },
    },
  );
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location") ?? "", /auth=success/);
  const token = cookieValue(response, "__Host-eiga-session");
  const sessionCookie = `__Host-eiga-session=${token}`;
  const session = await call("/api/auth/session", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(session.status, 200);
  const data = (await session.json()) as { csrfToken: string };
  return { token, sessionCookie, csrfToken: data.csrfToken };
}

async function authed(
  path: string,
  sessionCookie: string,
  csrfToken: string,
  options: RequestInit = {},
) {
  const headers = new Headers(options.headers);
  headers.set("cookie", sessionCookie);
  if (options.method && options.method !== "GET") {
    headers.set("origin", origin);
    headers.set("x-csrf-token", csrfToken);
  }
  return call(path, { ...options, headers });
}

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2026-10-01",
      d1Databases: { DB: "eiga-test" },
    }),
  );
  db = await mf.getD1Database("DB");
  const fs = await import("node:fs/promises");
  const schema = await fs.readFile(
    `${import.meta.dirname}/../migrations/0001_library.sql`,
    "utf8",
  );
  for (const prefix of ["staging", "production"]) {
    const statements = schema
      .replace(/^--[^\n]*\n/m, "")
      .replaceAll("__ENV__", prefix)
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
});

after(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  const statements = ["staging", "production"].flatMap((prefix) => [
    db.prepare(`DELETE FROM ${prefix}_maps`),
    db.prepare(`DELETE FROM ${prefix}_sessions`),
    db.prepare(`DELETE FROM ${prefix}_users`),
  ]);
  await db.batch(statements);
});

test("Google ID tokens require a valid RS256 signature, issuer, audience, expiry, and matching nonce", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = async () => publicKey;
  const claims = (
    extra: { nonce?: string; aud?: string; iss?: string; exp?: number } = {},
  ) =>
    new SignJWT({
      nonce: extra.nonce ?? "expected-nonce",
      email_verified: true,
      email: "verified@example.test",
      name: "Verified",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(extra.iss ?? "https://accounts.google.com")
      .setAudience(extra.aud ?? clientId)
      .setSubject("google-sub")
      .setIssuedAt(jwtNow())
      .setExpirationTime(extra.exp ?? jwtNow() + 300)
      .sign(privateKey);

  const valid = await verifyGoogleToken(
    await claims(),
    clientId,
    "expected-nonce",
    keys,
  );
  assert.deepEqual(valid, {
    sub: "google-sub",
    name: "Verified",
    email: "verified@example.test",
  });
  await assert.rejects(async () =>
    verifyGoogleToken(await claims(), clientId, "wrong-nonce", keys),
  );
  await assert.rejects(async () =>
    verifyGoogleToken(
      await claims({ aud: "other-client" }),
      clientId,
      "expected-nonce",
      keys,
    ),
  );
  await assert.rejects(async () =>
    verifyGoogleToken(
      await claims({ iss: "https://attacker.example" }),
      clientId,
      "expected-nonce",
      keys,
    ),
  );
  await assert.rejects(async () =>
    verifyGoogleToken(
      await claims({ exp: jwtNow() - 1 }),
      clientId,
      "expected-nonce",
      keys,
    ),
  );

  const { privateKey: otherPrivate } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ nonce: "expected-nonce" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(clientId)
    .setSubject("google-sub")
    .setIssuedAt(jwtNow())
    .setExpirationTime(jwtNow() + 300)
    .sign(otherPrivate);
  await assert.rejects(() =>
    verifyGoogleToken(forged, clientId, "expected-nonce", keys),
  );
});

test("OAuth start sets a short-lived browser-bound secure cookie and callback rejects state mismatch", async () => {
  const { response, oauthCookie, transaction } = await beginLogin(true);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=600/);
  const target = new URL(response.headers.get("location")!);
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.ok(target.searchParams.get("nonce"));

  const mismatch = await call(
    `/api/auth/google/callback?code=x&state=wrong-${transaction.state}`,
    { headers: { cookie: `__Host-eiga-oauth=${oauthCookie}` } },
  );
  assert.equal(mismatch.status, 200);
  assert.match(await mismatch.text(), /Sign-in could not finish/);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM staging_users")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("OAuth callback handles provider denial and expired signed transaction without creating a session", async () => {
  const started = await beginLogin();
  const denied = await call(
    `/api/auth/google/callback?error=access_denied&state=${started.transaction.state}`,
    { headers: { cookie: `__Host-eiga-oauth=${started.oauthCookie}` } },
  );
  assert.equal(denied.status, 303);
  assert.match(denied.headers.get("location") ?? "", /auth=failed/);

  const expired = { ...started.transaction, expires: now() - 1 };
  const encoded = btoa(JSON.stringify(expired))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const { sign } = await import("../src/crypto.ts");
  const signature = await sign(`oauth:${encoded}`, clientSecret);
  const expiredResponse = await call(
    `/api/auth/google/callback?code=x&state=${started.transaction.state}`,
    { headers: { cookie: `__Host-eiga-oauth=${encoded}.${signature}` } },
  );
  assert.equal(expiredResponse.status, 303);
  assert.match(expiredResponse.headers.get("location") ?? "", /auth=failed/);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM staging_sessions")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("session creation, map ownership, normalized review sharing, and share revocation work end to end", async () => {
  const owner = await finishLogin();
  const put = await authed(
    "/api/map",
    owner.sessionCookie,
    owner.csrfToken,
    jsonRequest("PUT", { revision: 0, snapshot: sampleSnapshot() }),
  );
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { revision: number };
  assert.equal(saved.revision, 1);

  const stale = await authed(
    "/api/map",
    owner.sessionCookie,
    owner.csrfToken,
    jsonRequest("PUT", { revision: 0, snapshot: sampleSnapshot("Overwrite") }),
  );
  assert.equal(stale.status, 409);
  const updated = await authed(
    "/api/map",
    owner.sessionCookie,
    owner.csrfToken,
    jsonRequest("PUT", { revision: 1, snapshot: sampleSnapshot("Updated") }),
  );
  assert.equal(updated.status, 200);
  const ownMap = await authed(
    "/api/map",
    owner.sessionCookie,
    owner.csrfToken,
    { method: "GET" },
  );
  assert.equal(ownMap.status, 200);
  const ownData = (await ownMap.json()) as {
    snapshot: ReturnType<typeof sampleSnapshot>;
    revision: number;
  };
  assert.equal(ownData.revision, 2);
  assert.equal(ownData.snapshot.films[0].title, "Updated");

  const shared = await authed(
    "/api/share",
    owner.sessionCookie,
    owner.csrfToken,
    { method: "POST" },
  );
  assert.equal(shared.status, 200);
  const sharedUrl = new URL(((await shared.json()) as { url: string }).url);
  const shareId = sharedUrl.searchParams.get("share")!;
  const publicMap = await call(`/api/share/${shareId}`);
  assert.equal(publicMap.status, 200);
  const publicData = (await publicMap.json()) as {
    snapshot: ReturnType<typeof sampleSnapshot>;
  };
  assert.equal(publicData.snapshot.films[0].title, "Updated");
  assert.deepEqual(publicData.snapshot.reviews, [
    ["film-1", "A thoughtful review."],
  ]);

  const other = await finishLogin("auth-code-second");
  const otherMap = await authed(
    "/api/map",
    other.sessionCookie,
    other.csrfToken,
    { method: "GET" },
  );
  assert.equal(await otherMap.json(), null);
  const revoke = await authed(
    "/api/share",
    owner.sessionCookie,
    owner.csrfToken,
    { method: "DELETE" },
  );
  assert.equal(revoke.status, 200);
  assert.equal((await call(`/api/share/${shareId}`)).status, 404);
});

test("anonymous map and share mutation are denied; authenticated writes enforce CSRF and payload validation", async () => {
  assert.equal((await call("/api/map")).status, 401);
  assert.equal(
    (await call("/api/share", { method: "POST", headers: { origin } })).status,
    401,
  );
  const user = await finishLogin();

  const missingCsrf = await call("/api/map", {
    ...jsonRequest("PUT", { revision: 0, snapshot: sampleSnapshot() }),
    headers: { cookie: user.sessionCookie, origin },
  });
  assert.equal(missingCsrf.status, 403);
  const crossOrigin = await call("/api/map", {
    ...jsonRequest(
      "PUT",
      { revision: 0, snapshot: sampleSnapshot() },
      { cookie: user.sessionCookie, "x-csrf-token": user.csrfToken },
    ),
    headers: {
      cookie: user.sessionCookie,
      origin: "https://evil.example",
      "x-csrf-token": user.csrfToken,
    },
  });
  assert.equal(crossOrigin.status, 403);

  const malformed = await authed(
    "/api/map",
    user.sessionCookie,
    user.csrfToken,
    jsonRequest("PUT", {
      revision: 0,
      snapshot: { ...sampleSnapshot(), extra: "bad" },
    }),
  );
  // Unknown snapshot properties are intentionally discarded, so use an invalid reference instead.
  assert.equal(malformed.status, 200);
  const invalidSnapshot = await authed(
    "/api/map",
    user.sessionCookie,
    user.csrfToken,
    jsonRequest("PUT", {
      revision: 1,
      snapshot: {
        ...sampleSnapshot(),
        watches: [{ filmId: "missing", watchedOn: null, rewatch: false }],
      },
    }),
  );
  assert.equal(invalidSnapshot.status, 400);
  const oversized = await call("/api/map", {
    method: "PUT",
    headers: {
      cookie: user.sessionCookie,
      origin,
      "x-csrf-token": user.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ revision: 1, snapshot: "x".repeat(1_502_000) }),
  });
  assert.equal(oversized.status, 413);
});

test("staging writes never touch production tables and logout revokes the opaque session", async () => {
  const user = await finishLogin();
  const save = await authed(
    "/api/map",
    user.sessionCookie,
    user.csrfToken,
    jsonRequest("PUT", { revision: 0, snapshot: sampleSnapshot() }),
  );
  assert.equal(save.status, 200);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM staging_users")
        .first<{ n: number }>()
    )?.n,
    1,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM staging_sessions")
        .first<{ n: number }>()
    )?.n,
    1,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM staging_maps")
        .first<{ n: number }>()
    )?.n,
    1,
  );
  for (const table of [
    "production_users",
    "production_sessions",
    "production_maps",
  ]) {
    assert.equal(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      `${table} must remain untouched`,
    );
  }

  const storedHash = await db
    .prepare("SELECT token_hash FROM staging_sessions")
    .first<{ token_hash: string }>();
  assert.ok(storedHash);
  assert.notEqual(
    storedHash.token_hash,
    user.token,
    "D1 must contain only a hash of the bearer cookie",
  );
  const logout = await authed(
    "/api/auth/logout",
    user.sessionCookie,
    user.csrfToken,
    { method: "POST" },
  );
  assert.equal(logout.status, 200);
  assert.equal(
    (await call("/api/map", { headers: { cookie: user.sessionCookie } }))
      .status,
    401,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM staging_sessions")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
