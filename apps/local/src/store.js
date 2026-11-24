/** SQLite-backed adapter for the same D1 prepare/bind/first/all/batch contract. */
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync, mkdirSync, chmodSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const migrationDir = fileURLToPath(new URL('../../worker/migrations/', import.meta.url));

function adapter(db) {
  const prepare = sql => ({
    bind(...args) {
      return {
        run: async () => {
          const result = db.prepare(sql).run(...args);
          return {meta: {changes: result.changes}};
        },
        first: async () => db.prepare(sql).get(...args) || null,
        all: async () => ({results: db.prepare(sql).all(...args)}),
        execute: () => db.prepare(sql).run(...args),
      };
    },
  });
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(s => ({meta: {changes: s.execute().changes}}));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
    _raw: db,
  };
}

export function openStore(path = 'data/orbitsuite.sqlite') {
  const location = path === ':memory:' ? path : resolve(path);
  if (location !== ':memory:') mkdirSync(dirname(location), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(location, {timeout: 5000});
  if (location !== ':memory:') chmodSync(location, 0o600);
  db.exec('PRAGMA foreign_keys=ON');
  if (location !== ':memory:') db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(migrationDir).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(file)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(resolve(migrationDir, file), 'utf8'));
      db.prepare("INSERT INTO schema_migrations(name,applied_at) VALUES(?,datetime('now'))").run(file);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw new Error('Could not apply migration ' + file, {cause: error});
    }
  }
  return adapter(db);
}
