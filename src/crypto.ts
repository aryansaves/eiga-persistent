import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export function randomToken(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`eiga-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function verifySigned(
  value: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expected = await sign(value, secret);
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}

export interface GoogleIdentity {
  sub: string;
  name: string;
  email: string | null;
}

export async function verifyGoogleToken(
  token: string,
  clientId: string,
  nonce: string,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "nonce"],
    maxTokenAge: "10m",
  });
  if (
    payload.nonce !== nonce ||
    typeof payload.sub !== "string" ||
    payload.sub.length > 255 ||
    (payload.azp !== undefined && payload.azp !== clientId)
  )
    throw new Error("Invalid identity token.");
  return {
    sub: payload.sub,
    name:
      typeof payload.name === "string"
        ? payload.name.slice(0, 120)
        : "Your account",
    email:
      payload.email_verified === true && typeof payload.email === "string"
        ? payload.email.slice(0, 320)
        : null,
  };
}
