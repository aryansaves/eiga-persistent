import { readFile } from "node:fs/promises";

/** Inspect production readiness; change Git builds only with an explicit cutover flag. */
export async function prepareProduction({
  account,
  token,
  project,
  fetcher = fetch,
  disableAutomaticGitBuilds = false,
}) {
  if (!account || !token || !project)
    throw new Error("Configure the Cloudflare deployment credentials.");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}`;
  async function request(method = "GET", body) {
    const response = await fetcher(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        `Production Pages configuration request failed (${response.status}).`,
      );
    const payload = await response.json();
    if (!payload.success || !payload.result)
      throw new Error("Production Pages configuration is unavailable.");
    return payload.result;
  }
  const current = await request();
  const variables = current.deployment_configs?.production?.env_vars ?? {};
  if (!variables.GOOGLE_CLIENT_ID || !variables.GOOGLE_CLIENT_SECRET)
    throw new Error(
      "Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the production Pages project.",
    );
  if (variables.GOOGLE_CLIENT_SECRET.type !== "secret_text")
    throw new Error("Production GOOGLE_CLIENT_SECRET must be encrypted.");
  if (
    current.source &&
    current.source.config?.production_deployments_enabled !== false
  ) {
    if (!disableAutomaticGitBuilds)
      throw new Error(
        "Automatic production Git deployments are enabled. Explicit cutover approval is required before changing that setting.",
      );
    await request("PATCH", {
      source: { config: { production_deployments_enabled: false } },
    });
    const updated = await request();
    if (updated.source?.config?.production_deployments_enabled !== false)
      throw new Error(
        "Cloudflare did not disable automatic production Git deployments.",
      );
  }
}

if (process.argv[1] === import.meta.filename) {
  const release = JSON.parse(await readFile("release.json", "utf8"));
  if (release.productionEnabled === true) {
    const deployment = JSON.parse(await readFile("deploy.json", "utf8"));
    await prepareProduction({
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      project: deployment.production.project,
      disableAutomaticGitBuilds:
        release.disableAutomaticProductionGitBuilds === true,
    });
    console.log(
      "Verified production Google credential configuration; combined CI owns production deployment.",
    );
  } else console.log("Production cutover is not enabled.");
}
