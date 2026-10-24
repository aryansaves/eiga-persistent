import { readFile, writeFile } from "node:fs/promises";

const environment = process.argv[2];
if (!["staging", "production"].includes(environment))
  throw new Error("Choose a deployment environment.");
const deployment = JSON.parse(await readFile("deploy.json", "utf8"));
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token)
  throw new Error(
    "Configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the backend repository.",
  );
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects/${deployment[environment].project}`,
  {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  },
);
if (!response.ok)
  throw new Error(
    `Cannot read the configured Pages project (${response.status}). Check the account ID and Pages permission.`,
  );
const payload = await response.json();
if (!payload.success || !payload.result)
  throw new Error("The configured Pages project is unavailable.");
const variables = payload.result.deployment_configs?.production?.env_vars ?? {};
const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter(
  (name) => !variables[name],
);
if (missing.length)
  throw new Error(
    `Configure ${missing.join(" and ")} in ${deployment[environment].project}'s Production variables/secrets before deployment.`,
  );
if (variables.GOOGLE_CLIENT_SECRET.type !== "secret_text")
  throw new Error("GOOGLE_CLIENT_SECRET must be an encrypted Pages secret.");
// Wrangler owns plain-text variables once configuration is deployed. Preserve
// the already configured public Google client ID; encrypted secrets stay remote.
const config = JSON.parse(await readFile("wrangler.json", "utf8"));
if (variables.GOOGLE_CLIENT_ID.type === "plain_text")
  config.vars.GOOGLE_CLIENT_ID = variables.GOOGLE_CLIENT_ID.value;
await writeFile("wrangler.json", `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `Verified ${environment} Pages configuration and configured Google credentials.`,
);
