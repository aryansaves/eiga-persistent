import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configure } from './configure.mjs';

const [environment, frontendRoot, frontendCommit, backendCommit] = process.argv.slice(2);
if (!frontendRoot || !/^[a-f0-9]{40}$/.test(frontendCommit ?? '') || !/^[a-f0-9]{40}$/.test(backendCommit ?? '')) throw new Error('Assembly requires immutable frontend and backend commit IDs.');
await configure(environment, process.cwd(), { FRONTEND_COMMIT: frontendCommit, BACKEND_COMMIT: backendCommit });
await mkdir('public', { recursive: true });
await cp(resolve(frontendRoot, 'out'), resolve('public'), { recursive: true });
await writeFile('public/_routes.json', JSON.stringify({ version: 1, include: ['/api/*', '/'], exclude: [] }));
await writeFile('public/_headers', `${environment === 'staging' ? '/*\n  X-Robots-Tag: noindex, nofollow\n' : ''}/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n`);
await writeFile('.generated/release.json', `${JSON.stringify({ frontendCommit, backendCommit, environment }, null, 2)}\n`);
