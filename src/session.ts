import type { Env } from "./config.ts";
import { appOrigin, tables } from "./config.ts";
import { hash, sign } from "./crypto.ts";

export const SESSION_SECONDS = 60 * 60 * 24 * 30;
export const TRANSACTION_SECONDS = 60 * 10;

export function cookieName(env: Env, kind: "session" | "oauth"): string {
  return `${appOrigin(env).startsWith("https:") ? "__Host-" : ""}eiga-${kind}`;
}

export function cookie(
  env: Env,
  kind: "session" | "oauth",
  value: string,
  seconds: number,
): string {
  return `${cookieName(env, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${appOrigin(env).startsWith("https:") ? "; Secure" : ""}`;
}

export function readCookie(request: Request, name: string): string | null {
  const entries = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim());
  return (
    entries
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}

export interface Session {
  tokenHash: string;
  user: { id: string; name: string };
  csrfToken: string;
}

export async function sessionFor(
  request: Request,
  env: Env,
  now: number,
): Promise<Session | null> {
  const token = readCookie(request, cookieName(env, "session"));
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const tokenHash = await hash(token);
  const t = tables(env);
  const row = await env.DB.prepare(
    `SELECT u.id, u.name FROM ${t.sessions} s JOIN ${t.users} u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<{ id: string; name: string }>();
  if (!row) return null;
  return {
    tokenHash,
    user: row,
    csrfToken: await sign(
      `csrf:${env.APP_ENV}:${tokenHash}`,
      env.GOOGLE_CLIENT_SECRET,
    ),
  };
}
