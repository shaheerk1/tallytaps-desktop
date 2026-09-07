/**
 * Accountant mode.
 *
 * Read-only over the journal, plus period control. There is deliberately no
 * "create journal entry" method: every posting is derived by a fixed rule from
 * a business event, so an operator has nothing to type here.
 */
function createAccountingService({ journalRepository, operationalAccountingRepository, lotCostingRepository }) {
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
    reconcile: async (input = {}) => {
      if (!operationalAccountingRepository || !lotCostingRepository) throw new Error('Accounting reconciliation dependencies are incomplete.');
      const locCode = requireLocation(input, 'refresh accounting');
      const userId = Number(input.userId);
      if (!userId) throw new Error('A signed-in user is required to refresh accounting.');
      const operational = await operationalAccountingRepository.syncAll({ locCode, userId });
      let lotCosts = { checked: 0, changed: 0, lots: [] };
      const macCode = text(input.macCode);
      const txnDate = text(input.txnDate).slice(0, 10);
      if (macCode && /^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
        lotCosts = await lotCostingRepository.reconcileRecognizedCosts({ locCode, macCode, txnDate, userId });
      }
      return { operational, lotCosts, posted: Number(operational.posted || 0) + Number(lotCosts.changed || 0) };
    },
    listAccounts: async () => journalRepository.listAccounts(),
    listJournal: async (input = {}) => journalRepository.listJournal({ ...input, locCode: requireLocation(input, 'read the journal') }),
    trialBalance: async (input = {}) => journalRepository.getTrialBalance({ ...input, locCode: requireLocation(input, 'run a trial balance') }),
    profitAndLoss: async (input = {}) => journalRepository.getProfitAndLoss({ ...input, locCode: requireLocation(input, 'run a profit and loss') }),
    balanceSheet: async (input = {}) => journalRepository.getBalanceSheet({ ...input, locCode: requireLocation(input, 'run a balance sheet') }),
    listPeriods: async (input = {}) => journalRepository.listPeriods({ ...input, locCode: requireLocation(input, 'list accounting periods') }),
    closePeriod: async (input = {}) => {
      if (!Number(input.userId)) throw new Error('A signed-in user is required to close a period.');
      const locCode = requireLocation(input, 'close a period');
      if (operationalAccountingRepository) {
        await operationalAccountingRepository.syncAll({ locCode, userId: Number(input.userId) });
      }
      const macCode = text(input.macCode);
      const txnDate = text(input.txnDate).slice(0, 10);
      if (lotCostingRepository && macCode && /^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
        await lotCostingRepository.reconcileRecognizedCosts({ locCode, macCode, txnDate, userId: Number(input.userId) });
      }
      return journalRepository.closePeriod({ ...input, locCode });
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
