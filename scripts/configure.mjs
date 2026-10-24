import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function configure(environment, root = process.cwd(), overrides = {}) {
  if (!['staging', 'production'].includes(environment)) throw new Error('Choose staging or production.');
  const deployment = JSON.parse(await readFile(resolve(root, 'deploy.json'), 'utf8'));
  const selected = deployment[environment];
  const directory = resolve(root, '.generated');
  const migrations = resolve(directory, environment, 'migrations');
  await mkdir(migrations, { recursive: true });
  for (const filename of (await readdir(resolve(root, 'migrations'))).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort()) {
    const template = await readFile(resolve(root, 'migrations', filename), 'utf8');
    const sql = template.replaceAll('__ENV__', environment);
    // Generated SQL cannot reference the other environment's tables.
    if (sql.includes(environment === 'staging' ? 'production_' : 'staging_')) throw new Error('Migration crosses environments.');
    await writeFile(resolve(migrations, filename), sql);
  }
  const config = {
    $schema: './node_modules/wrangler/config-schema.json',
    name: selected.project,
    pages_build_output_dir: resolve(root, 'public'),
    compatibility_date: '2026-10-01',
    vars: { APP_ENV: environment, APP_ORIGIN: selected.origin, ...overrides },
    d1_databases: [{ binding: 'DB', database_name: deployment.databaseName, database_id: deployment.databaseId, migrations_dir: migrations, migrations_table: `${environment}_d1_migrations` }],
  };
  const file = resolve(root, 'wrangler.json');
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  await mkdir(resolve(root, 'public'), { recursive: true });
  return file;
}

if (process.argv[1] === import.meta.filename) await configure(process.argv[2]);
