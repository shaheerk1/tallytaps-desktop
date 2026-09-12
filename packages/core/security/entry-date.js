const requestContext = require('./request-context');

/**
 * Which day a money entry belongs to.
 *
 * By default it is the day you are signed in to. People also remember things
 * late -- a transfer made last week, a lorry someone paid for on Monday that we
 * only hear about on Friday -- so an entry may name an earlier day it actually
 * happened on. The rules, in one place because expenses, transfers and partner
 * money all follow them:
 *
 *   1. only backwards, never into the future;
 *   2. only a day the shop was open here (the repositories check that);
 *   3. only with the `money.backdate` permission, and a reason that is kept;
 *   4. never money paid from a till -- that drawer was counted and signed off,
 *      so the repositories refuse it (see expense.repository.js);
 *   5. never inside a closed accounting period -- the journal already refuses
 *      that, and reopening a period stays a deliberate, recorded act.
 *
 * The entry is stamped with the day it happened, and keeps the day it was
 * typed in, so "when did this happen" and "when did we hear about it" are both
 * answerable.
 */
const BACKDATE_PERMISSION = 'money.backdate';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveEntryDate(input = {}, origin = {}) {
  const asked = String(input.paidOn || '').slice(0, 10);
  const today = String(origin.txnDate || '').slice(0, 10);
  if (!asked || asked === today) return { txnDate: today, enteredOn: today, backdated: false, reason: '' };
  if (!ISO_DATE.test(asked)) throw new Error('Write the date it happened as year-month-day.');
  if (asked > today) throw new Error('An entry cannot be dated in the future. Record it on the day it happens.');

  const context = requestContext.current();
  // Outside a request the caller is trusted main-process code (verifiers, tools).
  if (context && !(context.permissions || []).includes(BACKDATE_PERMISSION)) {
    throw new Error('Recording money on an earlier date needs permission. Ask an administrator for "Record money on an earlier date".');
  }
  const reason = String(input.paidOnReason || '').trim();
  if (!reason) throw new Error('Write why this is being recorded on an earlier date.');
  return { txnDate: asked, enteredOn: today, backdated: true, reason: reason.slice(0, 255) };
}

/** What is kept on the entry itself, so the late entry is never hidden. */
function backdateMetadata(entryDate) {
  if (!entryDate || !entryDate.backdated) return null;
  return { backdated: true, enteredOn: entryDate.enteredOn, reason: entryDate.reason };
}

module.exports = { resolveEntryDate, backdateMetadata, BACKDATE_PERMISSION };
