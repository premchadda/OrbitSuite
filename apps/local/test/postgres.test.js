import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {placeholders, migrationStatements, postgresSql, postgresStoreFromPool, migratePostgres} from '../src/postgres.js';

test('SQL placeholders skip quoted literals, identifiers and comments', () => {
  assert.equal(placeholders("SELECT '?' AS literal, \"?\", x FROM t WHERE a=? AND b='it''s ?' -- ?\n AND c=?"),
    "SELECT '?' AS literal, \"?\", x FROM t WHERE a=$1 AND b='it''s ?' -- ?\n AND c=$2");
});

test('PostgreSQL translation supports id sequences and SQLite insert variants', () => {
  assert.equal(postgresSql('CREATE TABLE x(id INTEGER PRIMARY KEY,n INTEGER)', {migration: true}),
    'CREATE TABLE x(id BIGSERIAL PRIMARY KEY,n BIGINT)');
  assert.equal(postgresSql('INSERT OR IGNORE INTO x(a) VALUES(?)'),
    'INSERT INTO x(a) VALUES($1) ON CONFLICT DO NOTHING');
  assert.equal(postgresSql('INSERT OR REPLACE INTO topics(chat,thread,title) VALUES(?,?,?)'),
    'INSERT INTO topics(chat,thread,title) VALUES($1,$2,$3) ON CONFLICT(chat,thread) DO UPDATE SET title=EXCLUDED.title');
});

test('all worker migrations can be split and translated for PostgreSQL', () => {
  const directory = fileURLToPath(new URL('../../worker/migrations/', import.meta.url));
  const files = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name));
  assert.ok(files.length >= 9);
  for (const file of files) {
    const statements = migrationStatements(readFileSync(join(directory, file), 'utf8'));
    assert.ok(statements.length, file);
    for (const statement of statements) {
      const translated = postgresSql(statement, {migration: true});
      assert.doesNotMatch(translated, /\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/i, file);
      assert.doesNotMatch(translated, /\bid\s+INTEGER\s+PRIMARY\s+KEY\b/i, file);
    }
  }
});

test('PostgreSQL batch executes statements on one client and rolls back failures', async () => {
  const calls = [];
  let released = 0;
  let fail = false;
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (fail && sql.includes('INSERT INTO invalid')) throw new Error('invalid');
      return {rows: [{value: 'ok'}], rowCount: 1};
    },
    release() {released++;},
  };
  const pool = {query: client.query.bind(client), connect: async () => client, end: async () => {}};
  const db = postgresStoreFromPool(pool);
  const statement = db.prepare('INSERT INTO x(value) VALUES(?)').bind('safe');
  assert.deepEqual(await db.batch([statement]), [{meta: {changes: 1}}]);
  assert.deepEqual(calls.map(c => c[0]), ['BEGIN', 'INSERT INTO x(value) VALUES($1)', 'COMMIT']);
  assert.deepEqual(calls[1][1], ['safe']);
  calls.length = 0;
  fail = true;
  await assert.rejects(db.batch([db.prepare('INSERT INTO invalid(value) VALUES(?)').bind(1)]));
  assert.deepEqual(calls.map(c => c[0]), ['BEGIN', 'INSERT INTO invalid(value) VALUES($1)', 'ROLLBACK']);
  assert.equal(released, 2);
});

test('PostgreSQL migrator tracks applied versions and releases advisory lock', async () => {
  const directory = fileURLToPath(new URL('../../worker/migrations/', import.meta.url));
  const names = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name));
  const applied = new Set();
  const log = [];
  const client = {
    async query(sql, params) {
      log.push(sql);
      if (sql.startsWith('SELECT 1 FROM schema_migrations')) return {rows: applied.has(params[0]) ? [{one: 1}] : []};
      if (sql.startsWith('INSERT INTO schema_migrations')) applied.add(params[0]);
      return {rows: [], rowCount: 1};
    },
    release() {log.push('RELEASE');},
  };
  const pool = {connect: async () => client};
  await migratePostgres(pool, directory);
  assert.equal(applied.size, names.length);
  const count = log.filter(s => s.startsWith('INSERT INTO schema_migrations')).length;
  await migratePostgres(pool, directory);
  assert.equal(log.filter(s => s.startsWith('INSERT INTO schema_migrations')).length, count);
  assert.ok(log.includes('SELECT pg_advisory_unlock(hashtext($1))'));
  assert.equal(log.at(-1), 'RELEASE');
});
