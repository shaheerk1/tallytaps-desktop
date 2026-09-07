/**
 * Expenses and fund accounts.
 *
 * The rule this service exists to hold: money always has a named location.
 * Every expense and transfer states which fund it left, so no amount can enter
 * or leave the business without a place it came from.
 */
function createExpenseService({ expenseRepository }) {
  if (!expenseRepository) throw new Error('Expense service requires a repository.');

  const text = (value) => String(value || '').trim();
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;

  function requireOrigin(input) {
    const origin = {
      locCode: text(input?.origin?.locCode ?? input?.locCode),
      macCode: text(input?.origin?.macCode ?? input?.macCode),
      txnDate: text(input?.origin?.txnDate ?? input?.txnDate).slice(0, 10)
    };
    if (!origin.locCode || !origin.macCode || !/^\d{4}-\d{2}-\d{2}$/.test(origin.txnDate)) {
      throw new Error('An active workstation session is required to record this.');
    }
    return origin;
  }

  function requireUser(input) {
    const userId = Number(input?.userId);
    if (!userId) throw new Error('A signed-in user is required.');
    return userId;
  }

  async function listFundAccounts(input = {}) {
    const locCode = text(input.locCode);
    if (!locCode) throw new Error('A location is required to list fund accounts.');
    return expenseRepository.listFundAccounts({ locCode, includeInactive: Boolean(input.includeInactive) });
  }

  async function saveFundAccount(input = {}) {
    if (!text(input.locCode)) throw new Error('A fund belongs to a location.');
    return expenseRepository.saveFundAccount(input);
  }

  async function getFundLedger(input = {}) {
    if (!Number(input.fundAccountId)) throw new Error('Select a fund account.');
    if (!text(input.locCode)) throw new Error('A location is required to read a fund ledger.');
    return expenseRepository.getFundLedger(input);
  }

  async function listCategories(input = {}) {
    return expenseRepository.listCategories({ includeInactive: Boolean(input.includeInactive) });
  }

  async function saveCategory(input = {}) {
    return expenseRepository.saveCategory(input);
  }

  async function recordExpense(input = {}) {
    const origin = requireOrigin(input);
    const userId = requireUser(input);
    if (!Number(input.expenseCategoryId)) throw new Error('Choose what this expense was for.');
    if (!Number(input.fundAccountId)) throw new Error('Choose which fund paid this expense.');
    if (money(input.amount) <= 0) throw new Error('An expense amount must be greater than zero.');
    if (!text(input.reason)) throw new Error('Write what this money was for.');
    return expenseRepository.recordExpense({
      ...origin,
      userId,
      expenseCategoryId: Number(input.expenseCategoryId),
      fundAccountId: Number(input.fundAccountId),
      amount: money(input.amount),
      payee: text(input.payee),
      reference: text(input.reference),
      reason: text(input.reason)
    });
  }

  async function listExpenses(input = {}) {
    const locCode = text(input.locCode);
    if (!locCode) throw new Error('A location is required to list expenses.');
    return expenseRepository.listExpenses({ ...input, locCode });
  }

  async function transferFunds(input = {}) {
    const origin = requireOrigin(input);
    const userId = requireUser(input);
    if (money(input.amount) <= 0) throw new Error('A transfer amount must be greater than zero.');
    if (!text(input.reason)) throw new Error('Write why this money is moving.');
    return expenseRepository.transferFunds({
      ...origin,
      userId,
      fromFundAccountId: Number(input.fromFundAccountId),
      toFundAccountId: Number(input.toFundAccountId),
      amount: money(input.amount),
      reason: text(input.reason)
    });
  }

  return {
    listFundAccounts,
    saveFundAccount,
    getFundLedger,
    listCategories,
    saveCategory,
    recordExpense,
    listExpenses,
    transferFunds
  };
}

module.exports = { createExpenseService };
