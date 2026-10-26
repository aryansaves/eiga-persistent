import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [environment, frontendCommit, backendCommit] = process.argv.slice(2);
const config = JSON.parse(await readFile("deploy.json", "utf8"));
const origin = config[environment]?.origin;
if (!origin) throw new Error("Choose a deployment environment.");
const request = (path, init = {}) =>
  fetch(`${origin}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
// A successful upload can precede the stable alias reaching every edge. Wait
// for this exact release, rather than treating a previous healthy release as it.
const deadline = Date.now() + 60_000;
let body;
while (Date.now() < deadline) {
  try {
    const health = await request(`/api/health?deployment=${backendCommit}`);
    if (health.ok) {
      body = await health.json();
      if (
        body.frontendCommit === frontendCommit &&
        body.backendCommit === backendCommit
      )
        break;
    }
  } catch {
    // A brief network or routing failure during propagation is retryable.
  }
  await delay(2000);
}
assert.ok(body, "The deployed health endpoint must become available.");
assert.equal(body.ok, true);
assert.equal(body.environment, environment);
assert.equal(
  body.frontendCommit,
  frontendCommit,
  "Deployment must serve the requested frontend.",
);
assert.equal(
  body.backendCommit,
  backendCommit,
  "Deployment must serve the requested backend.",
);
const home = await request("/");
assert.equal(home.status, 200);
assert.match(await home.text(), /EIGA/);
const session = await request("/api/auth/session");
assert.equal(session.status, 200, "Google credentials must be configured.");
assert.deepEqual(await session.json(), { user: null, csrfToken: null });
const denied = await request("/api/map", {
  method: "PUT",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: "{}",
});
assert.equal(denied.status, 401);
const missing = await request(`/api/share/${"x".repeat(43)}`);
assert.equal(missing.status, 404);
const login = await request("/api/auth/google");
assert.equal(login.status, 302);
assert.equal(
  new URL(login.headers.get("Location")).origin,
  "https://accounts.google.com",
);
assert.match(login.headers.get("Set-Cookie") ?? "", /HttpOnly; SameSite=Lax/);
const invalidCallback = await request(
  "/api/auth/google/callback?code=invalid&state=invalid",
);
assert.equal(invalidCallback.status, 303);
assert.equal(new URL(invalidCallback.headers.get("Location")).origin, origin);
console.log(
  `Verified ${environment}: static app, commit pair, D1 schema, configured login, anonymous access checks, and rejected invalid callback.`,
);
