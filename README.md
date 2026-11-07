```text
 _____ ___ ____    _
| ____|_ _/ ___|  / \
|  _|  | | |  _  / _ \
| |___ | | |_| |/ ___ \
|_____|___\____/_/   \_\
```

**Persistence for your cinema map.**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Pages Functions](https://img.shields.io/badge/Pages_Functions-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Cloudflare D1](https://img.shields.io/badge/Cloudflare_D1-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Google OAuth](https://img.shields.io/badge/Google_OAuth-4285F4?style=flat-square&logo=google&logoColor=white)

[Live app](https://eiga.pages.dev/) · [Staging](https://eiga-staging.pages.dev/) · [Frontend](https://github.com/aryansaves/eiga)

The server behind EIGA: Google sign-in, saved atlases, public share links, and combined
Cloudflare Pages deployments. The frontend remains a separate static Next.js app.

## What lives here

- Google OAuth with PKCE, verified ID tokens, and hashed application sessions.
- D1 storage for normalized library snapshots, with revision checks against stale saves.
- Share links that always resolve the latest saved atlas and can be revoked.
- Database migrations, release assembly, CI checks, and deployment smoke tests.

## Run locally

Requires **Node.js 22.18+**. Keep both repositories in sibling directories.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run configure -- staging
npx wrangler d1 migrations apply eiga-db --local --config wrangler.json
```

Add development Google credentials to the ignored `.dev.vars` file. Allow
`http://localhost:8788/api/auth/google/callback` in the Google OAuth client.
To run the complete app, build the frontend and copy its static output:

```bash
npm --prefix ../eiga ci
npm --prefix ../eiga run build -- --webpack
cp -R ../eiga/out/. public/
npm run dev
```

Open [localhost:8788](http://localhost:8788). Local development uses local SQLite.
Run `npm run check` for types, lint, integration tests, and the Functions build.

## Data and privacy

```text
Browser → same-origin Pages Functions → D1
          Google sign-in                 saved atlas + sessions
```

Raw exports are parsed in the browser. Only signed-in users save normalized library
data. Shared atlases include reviews; a new upload updates the existing link.
Returning users open their saved atlas, and can explicitly upload an export to replace it.
Mutations require a session and CSRF protection. Google access and refresh tokens are not stored.

Staging and production use separate tables and migration ledgers in one D1 database.
This is logical separation, not database-level isolation. Keep migrations additive;
rolling back a deployment does not undo SQL.

## Checks and releases

1. Open feature PRs against `staging`; merge to deploy and test the combined app.
2. Promote the tested frontend to `main`, pin its SHA in `release.json` on backend
   `staging`, and verify that release pair there.
3. Merge backend `staging` into `main` to release production. CI checks both repos,
   applies migrations, deploys assets and Functions together, and verifies the live commit pair.

For your own deployment, set projects, origins, and D1 details in `deploy.json`.
Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub Actions, and
`GOOGLE_CLIENT_ID` plus encrypted `GOOGLE_CLIENT_SECRET` in each Pages project.
The frontend's `EIGA_DEPLOY_DISPATCH_TOKEN` needs Actions Write on this repository.
A private frontend also needs `EIGA_FRONTEND_READ_TOKEN` with Contents Read here.

Do not commit credentials, exports, generated configuration, or database files.
Never apply `migrations/*.sql` templates directly; `configure` generates environment-specific SQL.

[Frontend development guide](https://github.com/aryansaves/eiga/blob/main/docs/development.md) · [Deployment workflow](.github/workflows/deploy.yml)
