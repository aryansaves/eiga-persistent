import assert from "node:assert/strict";
import test from "node:test";
import { prepareProduction } from "../scripts/prepare-production.mjs";

const project = (source) => ({
  source,
  deployment_configs: {
    production: {
      env_vars: {
        GOOGLE_CLIENT_ID: { type: "plain_text", value: "test-client" },
        GOOGLE_CLIENT_SECRET: { type: "secret_text" },
      },
    },
  },
});
const git = (enabled) => ({
  type: "github",
  config: { production_deployments_enabled: enabled },
});
function fixture(states) {
  const calls = [];
  return {
    calls,
    options: {
      account: "test-account",
      token: "test-token",
      project: "eiga",
      fetcher: async (url, init) => {
        calls.push({
          url,
          method: init.method,
          body: init.body ? JSON.parse(init.body) : null,
        });
        return Response.json({ success: true, result: states.shift() });
      },
    },
  };
}

test("cutover only disables automatic production Git builds and verifies the result", async () => {
  const f = fixture([
    project(git(true)),
    project(git(false)),
    project(git(false)),
  ]);
  await prepareProduction(f.options);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["GET", "PATCH", "GET"],
  );
  assert.deepEqual(f.calls[1].body, {
    source: { config: { production_deployments_enabled: false } },
  });
  assert.ok(
    f.calls.every((c) =>
      new URL(c.url).pathname.endsWith("/pages/projects/eiga"),
    ),
  );
});

test("direct upload and already paused projects need no configuration changes", async () => {
  for (const source of [undefined, git(false)]) {
    const f = fixture([project(source)]);
    await prepareProduction(f.options);
    assert.equal(f.calls.length, 1);
  }
});

test("missing or unencrypted production credentials prevent cutover mutations", async () => {
  for (const secret of [
    undefined,
    { type: "plain_text", value: "not-encrypted" },
  ]) {
    const state = project(git(true));
    state.deployment_configs.production.env_vars.GOOGLE_CLIENT_SECRET = secret;
    const f = fixture([state]);
    await assert.rejects(prepareProduction(f.options), /GOOGLE_CLIENT/);
    assert.equal(f.calls.length, 1);
  }
});

test("cutover fails if Cloudflare does not preserve the disabled production build setting", async () => {
  const f = fixture([
    project(git(true)),
    project(git(true)),
    project(git(true)),
  ]);
  await assert.rejects(prepareProduction(f.options), /must be disabled/);
});
