/** Opt-in owner-only assembly of Telegram file parts. No media bytes in Worker. */
const PART = /^([A-Za-z0-9][A-Za-z0-9._ -]{0,116})\.part(\d{3})$/;
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_TOTAL = 1900 * 1024 * 1024;

export function partInfo(filename) {
  const match = PART.exec(String(filename || ''));
  if (!match || ['.', '..'].includes(match[1])) return null;
  return {base: match[1], number: Number(match[2])};
}

export async function recordOwnerPart(env, message, helpers) {
  const document = message.document;
  if (!document || message.has_protected_content) return null;
  const part = partInfo(document.file_name);
  const size = Number(document.file_size);
  const fileId = String(document.file_id || '');
  if (!part || part.number < 1 || part.number > 10 || !Number.isSafeInteger(size)
      || size < 1 || size > MAX_FILE_SIZE || !/^[A-Za-z0-9_-]{16,512}$/.test(fileId)) return null;
  await helpers.query('INSERT OR IGNORE INTO media_part_inputs(owner_id,message_id,file_id,filename,file_size,recorded_at) '
    + 'VALUES(?,?,?,?,?,?)', String(helpers.ownerId), message.message_id,
    fileId, document.file_name, size, helpers.now()).run();
  return 'Received ' + document.file_name + '. Send all parts in order, then /joinparts COUNT (2–10).';
}

export async function queueOwnerJoin(env, args, helpers) {
  const count = Number(args[0]);
  if (args.length !== 1 || !Number.isSafeInteger(count) || count < 2 || count > 10) {
    return 'Usage: /joinparts COUNT (2–10 recently sent .part001/.part002 files).';
  }
  if (!(await helpers.featureEnabled('media_downloads'))) return 'Media worker is OFF; enable it first.';
  const parts = await helpers.rows('SELECT file_id,filename,file_size,message_id FROM media_part_inputs '
    + 'WHERE owner_id=? ORDER BY message_id DESC LIMIT ?', String(helpers.ownerId), count);
  if (parts.length !== count) return 'Not enough recently received part files.';
  parts.reverse();
  const basenames = new Set(parts.map(file => partInfo(file.filename)?.base));
  const numbering = parts.map(file => partInfo(file.filename)?.number);
  if (basenames.size !== 1 || basenames.has(undefined)
      || numbering.some((n, i) => n !== i + 1)
      || parts.reduce((sum, file) => sum + file.file_size, 0) > MAX_TOTAL) {
    return 'Parts must share a filename and be sent in contiguous part001–partNNN order.';
  }
  const pending = await helpers.query("SELECT count(*) AS n FROM media_jobs WHERE state IN ('queued','running','uncertain')").first();
  if (pending.n >= 50) return 'Media worker queue is full.';
  const archive = await helpers.setting('archive_dest');
  const topic = Number(await helpers.setting('archive_topic') || 0);
  const dest = /^-100\d{5,16}$/.test(String(archive)) ? String(archive) : String(helpers.ownerId);
  const result = await helpers.query(
    'INSERT INTO media_jobs(url,kind,dest,dest_topic,created_at,parts_json) VALUES(?,?,?,?,?,?) RETURNING id',
    'telegram-parts://owner', 'video', dest, dest === String(helpers.ownerId) ? 0 : topic,
    helpers.now(), JSON.stringify(parts.map(file => ({file_id: file.file_id,
      filename: file.filename, file_size: file.file_size})))).first();
  await helpers.audit('media_join_queued', null, result?.id, 'owner_parts');
  return 'Join job #' + result?.id + ' queued for ' + count + ' parts. A separately configured '
    + 'local Bot API server is needed when limits exceed the public Bot API.';
}
