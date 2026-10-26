# EIGA persistence

Cloudflare Pages Functions for the [EIGA frontend](https://github.com/aryansaves/eiga). This repository owns Google authentication, D1 persistence, share links, migrations, and combined app deployments. The Next.js frontend remains a static export in its own repository.

## Development

Use Node 22.18 or newer. Run `npm ci`, copy `.dev.vars.example` to ignored `.dev.vars`, and enter the development Google client credentials there. Never commit credentials. `npm run dev` serves the API at `http://localhost:8788`; copy the frontend's built `out/` contents into ignored `public/` to run the full app on that origin. Google must allow `http://localhost:8788/api/auth/google/callback`.

`npm run check` runs types, lint, D1-backed integration tests, and the Functions build. Local development and tests use local SQLite, never the remote database.

## Data and authentication

The browser parses raw exports locally. Only a signed-in user's normalized library is saved. Snapshot v1 contains films, watches, rating/review entry arrays and liked IDs; limits are 20,000 films, 100,000 viewing events, and 1.5 MB encoded JSON. Derived graph coordinates and metrics are recomputed by the frontend. Reviews are escaped text and are included in explicitly shared maps.

Google uses authorization code + PKCE, a signed browser-bound ten-minute transaction, and verified ID tokens. Application sessions are random opaque cookies; D1 stores their hashes, with a 30-day expiry. Mutations require a same-origin request and a session-bound CSRF token. Google access and refresh tokens are not stored. No film titles, reviews, import contents, or provider response bodies are logged.

One D1 database contains fixed `staging_` and `production_` users, sessions and maps tables. This is logical separation, not a security boundary: either binding can access the whole database. SQL identifiers are selected by server configuration. `migrations/*.sql` are templates; `npm run configure -- staging` generates staging-only SQL and an ignored root `wrangler.json`. Production uses the same templates with its own table prefix and migration ledger. Do not apply template SQL directly or manually edit remote tables.

## Runtime settings

Both Pages projects bind `DB` to the database specified in `deploy.json`. Each project's production deployment environment needs its own `GOOGLE_CLIENT_ID` and encrypted `GOOGLE_CLIENT_SECRET`. The Google callback is `<APP_ORIGIN>/api/auth/google/callback`. `APP_ENV`, `APP_ORIGIN`, and the deployed commit pair come from generated Wrangler configuration. CI preflight verifies credential names without reading encrypted values and preserves a plain-text client ID in generated config. Secrets stay in the dashboard and do not enter the static build.

API: `GET /api/auth/session`, `GET /api/auth/google`, `GET /api/auth/google/callback`, `POST /api/auth/logout`, `GET|PUT|DELETE /api/map`, `POST|DELETE /api/share`, `GET /api/share/:token`, and `GET /api/health`. Every authenticated mutation requires `x-csrf-token`. Map writes send `{snapshot, revision}` and return 409 on stale revisions. Owner map responses include the current share URL so it remains available to copy after a reload. Explicit uploads while signed in automatically replace the saved snapshot, keeping its existing share URL. Restored local drafts and stale revisions still require a choice. Share URLs resolve the owner's latest saved snapshot; deleting a map or revoking its share removes public access.

## Staging and production

Backend pushes on `codex/**` deploy staging. Frontend feature pushes dispatch this repository's `deploy.yml`. Set `STAGING_FRONTEND_REF` and `STAGING_BACKEND_REF` repository variables to the active feature branches (defaults are `codex/auth-persistence`). Workflow dispatch can choose other refs. CI resolves both refs once to immutable SHAs, checks both repositories, applies staging-only migrations, and uploads frontend assets plus root-level Functions together to `eiga-staging`. The staging project uses `--branch main` deliberately so the stable project root points at the tested release. CI verifies the live health endpoint matches both commits and checks the app, D1, configured login, and anonymous access rules.

Backend GitHub settings:

- Secret `CLOUDFLARE_API_TOKEN`: account-scoped Pages Edit and D1 Edit.
- Variable (or secret) `CLOUDFLARE_ACCOUNT_ID`.
- Optional secret `EIGA_FRONTEND_READ_TOKEN`: Contents Read for a private frontend repository.
- Environments `staging` and `production`, with production limited to `main` where supported.

Frontend secret `EIGA_DEPLOY_DISPATCH_TOKEN` needs Actions Write on this repository. If absent, frontend CI fails clearly rather than silently skipping deployment.

`release.json` pins the production frontend SHA. To release, pin the reviewed frontend SHA in the backend feature branch, set `productionEnabled: true`, and stage that pair. After staging smoke tests pass, CI checks production Google credentials and automatic production Git build settings. By default this is read-only. The explicitly approved cutover flag `disableAutomaticProductionGitBuilds: true` disables only automatic production Git builds and verifies the setting before merging. Merge the tested frontend to main, then merge the backend release to main. Main pushes deploy production only when that flag is enabled; the workflow verifies the frontend commit belongs to frontend main. Frontend main pushes alone do not deploy production. Disable the legacy automatic production Git build before merging; Wrangler deployment and preview builds remain available.

All deployment jobs share a concurrency group because D1 is shared. Use additive, backwards-compatible migrations: rolling back a Pages deployment does not undo SQL. Staging table resets must never delete production tables. Staging users and sessions are independent of production.

Before a production release, manually test Google sign-in/cancel, redirect import preservation, saved/local conflict selection, returning-user restore, save retry, stale-tab rejection, shared reviews, revoked links, logout, and mobile/theme behavior. CI does not pretend to complete a real person's Google login.
