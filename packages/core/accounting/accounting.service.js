/**
 * Accountant mode.
 *
 * Read-only over the journal, plus period control. There is deliberately no
 * "create journal entry" method: every posting is derived by a fixed rule from
 * a business event, so an operator has nothing to type here.
 */
function createAccountingService({ journalRepository }) {
  if (!journalRepository) throw new Error('Accounting service requires the journal repository.');

  const text = (value) => String(value || '').trim();

  function requireLocation(input, action) {
    const locCode = text(input.locCode);
    if (!locCode) throw new Error(`A location is required to ${action}.`);
    return locCode;
  }

  // Every method is async so a validation failure arrives as a rejected
  // promise, the way every other service in this codebase behaves. A
  // synchronous throw would escape a caller that only awaits the result.
  return {
    listAccounts: async () => journalRepository.listAccounts(),
    listJournal: async (input = {}) => journalRepository.listJournal({ ...input, locCode: requireLocation(input, 'read the journal') }),
    trialBalance: async (input = {}) => journalRepository.getTrialBalance({ ...input, locCode: requireLocation(input, 'run a trial balance') }),
    profitAndLoss: async (input = {}) => journalRepository.getProfitAndLoss({ ...input, locCode: requireLocation(input, 'run a profit and loss') }),
    balanceSheet: async (input = {}) => journalRepository.getBalanceSheet({ ...input, locCode: requireLocation(input, 'run a balance sheet') }),
    listPeriods: async (input = {}) => journalRepository.listPeriods({ ...input, locCode: requireLocation(input, 'list accounting periods') }),
    closePeriod: async (input = {}) => {
      if (!Number(input.userId)) throw new Error('A signed-in user is required to close a period.');
      return journalRepository.closePeriod({ ...input, locCode: requireLocation(input, 'close a period') });
    },
    reopenPeriod: async (input = {}) => {
      if (!Number(input.periodId)) throw new Error('Select the period to reopen.');
      if (!Number(input.userId)) throw new Error('A signed-in user is required to reopen a period.');
      if (!text(input.reason)) throw new Error('Reopening a closed period needs a recorded reason.');
      return journalRepository.reopenPeriod(input);
    }
  };
}

module.exports = { createAccountingService };
