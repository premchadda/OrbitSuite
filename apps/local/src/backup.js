/** Safe SQLite backup/restore CLI; run backups outside media work directories. */
import {backup, DatabaseSync} from 'node:sqlite';
import {existsSync, linkSync, rmSync, mkdirSync, chmodSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDirectEntrypoint} from './entrypoint.js';

export async function backupSqlite(source, destination) {
  const from = resolve(source);
  const to = resolve(destination);
  if (from === to) throw new Error('Backup cannot overwrite the live database');
  if (!existsSync(from) || !statSync(from).isFile()) throw new Error('Source database does not exist');
  if (existsSync(to) || existsSync(to + '-wal') || existsSync(to + '-shm')) {
    throw new Error('Backup destination already exists or has SQLite sidecars');
  }
  mkdirSync(dirname(to), {recursive: true, mode: 0o700});
  const temporary = to + '.' + randomUUID() + '.tmp';
  const db = new DatabaseSync(from, {readOnly: true});
  try {
    await backup(db, temporary);
    chmodSync(temporary, 0o600);
    // Atomic create-if-absent; a concurrent backup must never be overwritten.
    linkSync(temporary, to);
  } finally {
    db.close();
    if (existsSync(temporary)) rmSync(temporary);
  }
  return to;
}

/** Restore only to an absent target. Stop the bot and move the old DB first. */
export async function restoreSqlite(source, target) {
  const from = resolve(source);
  const to = resolve(target);
  if (from === to || existsSync(to) || existsSync(to + '-wal') || existsSync(to + '-shm')) {
    throw new Error('Restore target must not exist, including stale SQLite sidecars');
  }
  if (!existsSync(from) || !statSync(from).isFile()) throw new Error('Backup file does not exist');
  const check = new DatabaseSync(from, {readOnly: true});
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
  } finally {check.close();}
  return backupSqlite(from, to);
}

if (isDirectEntrypoint(import.meta.url)) {
  const [, , action, source, destination] = process.argv;
  if (!['backup', 'restore'].includes(action) || !source || !destination) {
    process.stderr.write('Usage: node apps/local/src/backup.js backup|restore source.sqlite destination.sqlite\n');
    process.exitCode = 2;
  } else {
    (action === 'backup' ? backupSqlite : restoreSqlite)(source, destination)
      .then(path => process.stdout.write('SQLite file written: ' + path + '\n'))
      .catch(error => {process.stderr.write('Backup operation failed: ' + error.message + '\n'); process.exitCode = 1;});
  }
}
