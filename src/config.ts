export interface Env {
  DB: D1Database;
  APP_ENV: "staging" | "production";
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  FRONTEND_COMMIT?: string;
  BACKEND_COMMIT?: string;
}

/** SQL identifiers are fixed here, never assembled from request data. */
export function tables(env: Env) {
  if (env.APP_ENV === "staging")
    return {
      users: "staging_users",
      sessions: "staging_sessions",
      maps: "staging_maps",
    };
  if (env.APP_ENV === "production")
    return {
      users: "production_users",
      sessions: "production_sessions",
      maps: "production_maps",
    };
  throw new Error("Invalid server environment.");
}

export function appOrigin(env: Env): string {
  const url = new URL(env.APP_ORIGIN);
  if (
    url.origin !== env.APP_ORIGIN ||
    (url.protocol !== "https:" &&
      !(url.hostname === "localhost" && url.protocol === "http:"))
  )
    throw new Error("Invalid app origin.");
  return url.origin;
}
