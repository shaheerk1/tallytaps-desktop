/**
 * Supplier accounts: the running balance of what the business owes each
 * supplier, from finalized statements, payments, an opening balance and
 * adjustments. See supplier-account.repository.js for how lines are built.
 */
const requestContext = require('../security/request-context');
const { resolveEntryDate, backdateMetadata } = require('../security/entry-date');

function createSupplierAccountService({ repository }) {
  if (!repository) throw new Error('Supplier accounts require a repository.');

  const text = (value) => String(value ?? '').trim();
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;

  // Inside an IPC request the origin and user come from the signed-in session.
  function context(input) {
    const origin = requestContext.resolveOrigin(input || {});
    if (!origin.locCode || !origin.macCode || !/^\d{4}-\d{2}-\d{2}$/.test(origin.txnDate)) {
      throw new Error('An active workstation session is required to record this.');
    }
    const userId = Number(requestContext.resolveUserId(input || {}));
    if (!userId) throw new Error('A signed-in user is required.');
    return { origin, userId };
  }

  /** Money and balances may be recorded on the day they happened; see entry-date.js. */
  function dated(input, origin) {
    const entryDate = resolveEntryDate(input, origin);
    return { txnDate: entryDate.txnDate, backdate: backdateMetadata(entryDate) };
  }

  return {
    list: (filters = {}) => repository.listAccounts(filters),
    sheet: (filters = {}) => repository.getSheet(filters),

    async recordPayment(input = {}) {
      const { origin, userId } = context(input);
      if (!Number(input.supplierId)) throw new Error('Choose the supplier being paid.');
      if (!Number(input.fundAccountId)) throw new Error('Choose which fund the money is paid from.');
      if (money(input.amount) <= 0) throw new Error('A payment must be more than zero.');
      return repository.recordPayment({
        ...origin, ...dated(input, origin), userId,
        supplierId: Number(input.supplierId), fundAccountId: Number(input.fundAccountId), amount: money(input.amount),
        reference: text(input.reference), note: text(input.note), requestId: text(input.requestId)
      });
    },

    async recordOpeningBalance(input = {}) {
      const { origin, userId } = context(input);
      if (!Number(input.supplierId)) throw new Error('Choose the supplier.');
      return repository.recordOpeningBalance({
        ...origin, ...dated(input, origin), userId,
        supplierId: Number(input.supplierId), amount: money(input.amount), effect: input.effect,
        note: text(input.note), requestId: text(input.requestId)
      });
    },

    async recordAdjustment(input = {}) {
      const { origin, userId } = context(input);
      if (!Number(input.supplierId)) throw new Error('Choose the supplier.');
      return repository.recordAdjustment({
        ...origin, ...dated(input, origin), userId,
        supplierId: Number(input.supplierId), amount: money(input.amount), effect: input.effect,
        reason: text(input.reason), reference: text(input.reference), requestId: text(input.requestId)
      });
    },

    async reverseEntry(input = {}) {
      const { origin, userId } = context(input);
      if (!Number(input.entryId)) throw new Error('Choose the entry to reverse.');
      return repository.reverseEntry({ ...origin, userId, entryId: Number(input.entryId), reason: text(input.reason) });
    }
  };
}

module.exports = { createSupplierAccountService };
