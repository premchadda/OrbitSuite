/** Optional PostgreSQL adapter for the shared D1-shaped OrbitSuite query contract.
 *
 * No PostgreSQL package is loaded for the default SQLite runtime. Operators
 * enabling this adapter must install `pg` (or use Dockerfile.postgres).
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const migrationDir = fileURLToPath(new URL('../../worker/migrations/', import.meta.url));

/** Change anonymous parameters outside SQL string/identifier/comment literals. */
export function placeholders(sql) {
  let result = '';
  let state = 'code';
  let index = 0;
  for (let i = 0; i < sql.length; i++) {
    const character = sql[i];
    const next = sql[i + 1];
    if (state === 'code') {
      if (character === "'") state = 'single';
      else if (character === '"') state = 'double';
      else if (character === '-' && next === '-') state = 'comment';
      else if (character === '?') { result += '$' + (++index); continue; }
    } else if (state === 'single' && character === "'") {
      if (next === "'") { result += "''"; i++; continue; }
      state = 'code';
    } else if (state === 'double' && character === '"') {
      if (next === '"') { result += '""'; i++; continue; }
      state = 'code';
    } else if (state === 'comment' && character === '\n') state = 'code';
    result += character;
  }
  return result;
}

/** A constrained translation of SQL emitted by the active OrbitSuite worker. */
export function postgresSql(sql, {migration = false} = {}) {
  let out = sql;
  if (migration) {
    // sqlite INTEGER PRIMARY KEY auto-increments, unlike plain PostgreSQL bigint.
    out = out.replace(/\bid\s+INTEGER\s+PRIMARY\s+KEY\b/gi, 'id BIGSERIAL PRIMARY KEY');
    out = out.replace(/\bINTEGER\b/gi, 'BIGINT');
  }
  if (/\bINSERT\s+OR\s+REPLACE\s+INTO\s+topics\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/i, 'INSERT INTO');
    out = out.replace(/;\s*$/, '') + ' ON CONFLICT(chat,thread) DO UPDATE SET title=EXCLUDED.title';
  } else if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    out = out.replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }
  return placeholders(out);
}

/** Split migration files into statements, preserving semicolons in quoted literals. */
export function migrationStatements(sql) {
  const statements = [];
  let current = '';
  let single = false;
  let double = false;
  let comment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (!single && !double && c === '-' && next === '-') comment = true;
    if (comment && c === '\n') comment = false;
    if (!comment && !double && c === "'") {
      if (single && next === "'") {current += "''"; i++; continue;}
      single = !single;
    } else if (!comment && !single && c === '"') double = !double;
    if (!single && !double && !comment && c === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += c;
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter(stmt => stmt.replace(/--[^\n]*/g, '').trim().length);
}

export function postgresStoreFromPool(pool) {
  const prepare = sql => ({bind: (...values) => {
    const text = postgresSql(sql);
    const query = client => client.query(text, values);
    return {
      first: async () => (await query(pool)).rows[0] || null,
      all: async () => ({results: (await query(pool)).rows}),
      run: async () => ({meta: {changes: (await query(pool)).rowCount || 0}}),
      execute: query,
    };
  }});
  return {
    prepare,
    async batch(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        for (const statement of statements) {
          const result = await statement.execute(client);
          results.push({meta: {changes: result.rowCount || 0}});
        }
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {client.release();}
    },
    close: () => pool.end(),
  };
}

export async function migratePostgres(pool, directory = migrationDir) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['orbitsuite_schema_migrations']);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const files = readdirSync(directory).filter(f => /^\d+.*\.sql$/.test(f)).sort();
    for (const name of files) {
      const found = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
      if (found.rows.length) continue;
      await client.query('BEGIN');
      try {
        const file = readFileSync(join(directory, name), 'utf8');
        for (const statement of migrationStatements(file)) {
          await client.query(postgresSql(statement, {migration: true}));
        }
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error('PostgreSQL schema migration failed at ' + name, {cause: error});
      }
    }
  } finally {
    try {await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['orbitsuite_schema_migrations']);}
    finally {client.release();}
  }
}

export async function openPostgresStore(config, options = {}) {
  const pg = options.pg || await import('pg');
  // CommonJS pg imported through ESM exposes the authoritative `default`
  // namespace; its `types` registry must match the Pool client instances.
  const driver = pg.default || pg;
  // All int8 database identifiers, timestamps and counts are inside JS safe range.
  // Source chat identifiers are TEXT and therefore remain losslessly strings.
  driver.types?.setTypeParser?.(20, value => {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError('PostgreSQL bigint out of JS safe range');
    return number;
  });
  const pool = options.pool || new driver.Pool({
    ...(config.DATABASE_URL ? {connectionString: config.DATABASE_URL} : {}),
    ...(!config.DATABASE_URL ? {
      ...(config.PGHOST ? {host: config.PGHOST} : {}),
      ...(config.PGPORT ? {port: Number(config.PGPORT)} : {}),
      ...(config.PGDATABASE ? {database: config.PGDATABASE} : {}),
      ...(config.PGUSER ? {user: config.PGUSER} : {}),
      ...(config.PGPASSWORD ? {password: config.PGPASSWORD} : {}),
    } : {}),
    max: 5,
  });
  try {await migratePostgres(pool);}
  catch (error) {await pool.end(); throw error;}
  return postgresStoreFromPool(pool);
}
