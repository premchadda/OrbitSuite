/** Bounded owner-private question forms with persistent step/resume state.
 * Responses are plain text, not arbitrary code or public surveys.
 */
const VALID_ID = /^[1-9]\d{0,8}$/;
const MAX_FORMS = 20;
const MAX_QUESTIONS = 8;
const TIMEOUT = 1800;
const limitText = text => String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
const validText = (text, max) => text.length >= 2 && text.length <= max;

export async function formCommand(env, name, args, helpers) {
  const query = helpers.query;
  const owner = String(helpers.ownerId);
  const now = helpers.now();
  const usage = 'Forms: /formnew TITLE | QUESTION 1 | QUESTION 2 [up to 8]; '
    + '/formlist; /formopen ID; /formresults ID; /formcancel; /formdelete ID CONFIRM.';
  if (!['/formnew','/formlist','/formopen','/formresults','/formcancel','/formdelete'].includes(name)) return null;
  if (name === '/formnew') {
    const parts = args.join(' ').split('|').map(limitText);
    if (parts.length < 3 || parts.length > MAX_QUESTIONS + 1 || !validText(parts[0], 70)
        || parts.slice(1).some(q => !validText(q, 180))) return {text: usage};
    const n = Number((await query('SELECT count(*) AS n FROM owner_forms').first()).n);
    if (n >= MAX_FORMS) return {text: 'Maximum 20 saved forms. Delete an unused form first.'};
    const result = await query('INSERT INTO owner_forms(title,questions_json,created_at) VALUES(?,?,?) RETURNING id',
      parts[0], JSON.stringify(parts.slice(1)), now).first();
    return {text: 'Private form #' + result.id + ' saved. Open it with /formopen ' + result.id + '.'};
  }
  if (name === '/formlist') {
    const items = (await query('SELECT id,title FROM owner_forms ORDER BY id DESC LIMIT 20').all()).results;
    return {text: items.length ? items.map(r => '#' + r.id + ' ' + r.title).join('\n') : 'No forms.'};
  }
  if (name === '/formcancel') {
    await query('DELETE FROM owner_form_runs WHERE owner_id=?', owner).run();
    return {text: 'Active form cancelled.'};
  }
  const id = String(args[0] || '');
  if (!VALID_ID.test(id)) return {text: usage};
  const form = await query('SELECT * FROM owner_forms WHERE id=?', Number(id)).first();
  if (!form) return {text: 'Form not found.'};
  if (name === '/formdelete') {
    if (args.length !== 2 || args[1] !== 'CONFIRM') return {text: usage};
    await query('DELETE FROM owner_form_runs WHERE form_id=?', Number(id)).run();
    await query('DELETE FROM owner_form_submissions WHERE form_id=?', Number(id)).run();
    await query('DELETE FROM owner_forms WHERE id=?', Number(id)).run();
    return {text: 'Form and its recorded responses deleted.'};
  }
  if (args.length !== 1) return {text: usage};
  if (name === '/formresults') {
    const rows = (await query('SELECT id,answers_json FROM owner_form_submissions '
      + 'WHERE form_id=? ORDER BY id DESC LIMIT 5', Number(id)).all()).results;
    const questions = JSON.parse(form.questions_json);
    const text = rows.map(row => '#'+row.id+'\n'+JSON.parse(row.answers_json)
      .map((answer, i) => questions[i] + ': ' + answer).join('\n')).join('\n\n');
    return {text: text.slice(0, 3800) || 'No submitted responses for this form.'};
  }
  if (name === '/formopen') {
    await query('INSERT INTO owner_form_runs(owner_id,form_id,state,next_index,answers_json,started_at) '
      + "VALUES(?,?,'waiting',0,'[]',?) ON CONFLICT(owner_id) DO UPDATE SET "
      + "form_id=excluded.form_id,state='waiting',next_index=0,answers_json='[]',started_at=excluded.started_at",
      owner, Number(id), now).run();
    return {text: 'Start private form: ' + form.title + ' (' + JSON.parse(form.questions_json).length + ' questions)',
      reply_markup: {inline_keyboard: [[{text: 'Start form', callback_data: 'form:' + id + ':start'}]]}};
  }
  return {text: usage};
}

export async function formCallback(raw, helpers) {
  const match = /^form:([1-9]\d{0,8}):start$/.exec(String(raw || ''));
  if (!match) return null;
  const query = helpers.query;
  const run = await query('SELECT * FROM owner_form_runs WHERE owner_id=?', String(helpers.ownerId)).first();
  if (!run || String(run.form_id) !== match[1] || run.state !== 'waiting') return 'Form expired or replaced.';
  if (helpers.now() - run.started_at > TIMEOUT) {
    await query('DELETE FROM owner_form_runs WHERE owner_id=?', String(helpers.ownerId)).run();
    return 'Form expired after 30 minutes. Open it again.';
  }
  const form = await query('SELECT questions_json FROM owner_forms WHERE id=?', run.form_id).first();
  if (!form) return 'Form removed.';
  const updated = await query("UPDATE owner_form_runs SET state='answering' WHERE owner_id=? AND state='waiting'",
    String(helpers.ownerId)).run();
  if (updated.meta?.changes !== 1) return 'Form already started.';
  return 'Question 1/' + JSON.parse(form.questions_json).length + ': ' + JSON.parse(form.questions_json)[0]
    + '\nReply with plain text, or /formcancel.';
}

export async function formAnswer(message, helpers) {
  if (!message || message.chat?.type !== 'private'
    || String(message.from?.id) !== String(helpers.ownerId) || typeof message.text !== 'string'
    || message.text.startsWith('/') || message.has_protected_content) return false;
  const query = helpers.query;
  const run = await query("SELECT * FROM owner_form_runs WHERE owner_id=? AND state='answering'",
    String(helpers.ownerId)).first();
  if (!run) return false;
  if (helpers.now() - run.started_at > TIMEOUT) {
    await query('DELETE FROM owner_form_runs WHERE owner_id=?', String(helpers.ownerId)).run();
    await helpers.telegram('sendMessage', {chat_id: helpers.ownerId, text: 'Form expired. Open it again.'});
    return true;
  }
  const input = limitText(message.text);
  if (input.length < 1 || input.length > 500) {
    await helpers.telegram('sendMessage', {chat_id: helpers.ownerId,
      text: 'Answer must be 1–500 characters, or /formcancel.'});
    return true;
  }
  const form = await query('SELECT questions_json FROM owner_forms WHERE id=?', run.form_id).first();
  if (!form) return false;
  const questions = JSON.parse(form.questions_json);
  const answers = JSON.parse(run.answers_json);
  if (answers.length !== run.next_index || run.next_index >= questions.length) return false;
  answers.push(input);
  if (run.next_index + 1 === questions.length) {
    const result = await query('UPDATE owner_form_runs SET next_index=?,answers_json=? '
      + 'WHERE owner_id=? AND next_index=? RETURNING owner_id', answers.length,
      JSON.stringify(answers), String(helpers.ownerId), run.next_index).first();
    if (!result) return true;
    await query('INSERT INTO owner_form_submissions(form_id,answers_json,created_at) VALUES(?,?,?)',
      run.form_id, JSON.stringify(answers), helpers.now()).run();
    await query('DELETE FROM owner_form_submissions WHERE form_id=? AND id NOT IN ('
      + 'SELECT id FROM owner_form_submissions WHERE form_id=? ORDER BY id DESC LIMIT 50)',
      run.form_id, run.form_id).run();
    await query('DELETE FROM owner_form_runs WHERE owner_id=?', String(helpers.ownerId)).run();
    await helpers.telegram('sendMessage', {chat_id: helpers.ownerId,
      text: 'Private form completed (' + answers.length + ' answers). Review with /formresults ' + run.form_id + '.'});
    return true;
  }
  const updated = await query('UPDATE owner_form_runs SET answers_json=?,next_index=? '
    + 'WHERE owner_id=? AND next_index=? RETURNING owner_id', JSON.stringify(answers), answers.length,
    String(helpers.ownerId), run.next_index).first();
  if (updated) await helpers.telegram('sendMessage', {chat_id: helpers.ownerId,
    text: 'Question ' + (answers.length + 1) + '/' + questions.length + ': ' + questions[answers.length]});
  return true;
}
