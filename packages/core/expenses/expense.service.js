/**
 * Expenses and fund accounts.
 *
 * The rule this service exists to hold: money always has a named location.
 * Every expense and transfer states which fund it left, so no amount can enter
 * or leave the business without a place it came from.
 */
const requestContext = require('../security/request-context');

function createExpenseService({ expenseRepository }) {
  if (!expenseRepository) throw new Error('Expense service requires a repository.');

  const text = (value) => String(value || '').trim();
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;

  // Inside an IPC request the origin is the signed-in workstation's own; what
  // the screen sent is ignored. Outside one, the caller is trusted main-process code.
  function requireOrigin(input) {
    const origin = requestContext.resolveOrigin(input || {});
    if (!origin.locCode || !origin.macCode || !/^\d{4}-\d{2}-\d{2}$/.test(origin.txnDate)) {
      throw new Error('An active workstation session is required to record this.');
    }
    return origin;
  }

  function requireUser(input) {
    const userId = Number(requestContext.resolveUserId(input || {}));
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
      reason: text(input.reason),
      requestId: text(input.requestId)
    });
  }

  /** Undoes a mistaken expense; see expenseRepository.reverseExpense for what that covers. */
  async function reverseExpense(input = {}) {
    const origin = requireOrigin(input);
    const userId = requireUser(input);
    if (!Number(input.expenseEntryId)) throw new Error('Choose the expense to reverse.');
    if (!text(input.reason)) throw new Error('Write why this expense is being reversed.');
    return expenseRepository.reverseExpense({ ...origin, userId, expenseEntryId: Number(input.expenseEntryId), reason: text(input.reason) });
  }

  async function listExpenses(input = {}) {
    const locCode = text(input.locCode);
    if (!locCode) throw new Error('A location is required to list expenses.');
    return expenseRepository.listExpenses({ ...input, locCode });
  }

  async function listRecurringExpenses(input = {}) {
    const locCode = text(input.locCode);
    if (!locCode) throw new Error('A location is required to list recurring expenses.');
    return expenseRepository.listRecurringExpenses({ locCode, includeInactive: Boolean(input.includeInactive) });
  }

  async function saveRecurringExpense(input = {}) {
    const userId = requireUser(input);
    if (!text(input.locCode)) throw new Error('A recurring expense belongs to a location.');
    return expenseRepository.saveRecurringExpense({ ...input, userId });
  }

  async function recordRecurringExpense(input = {}) {
    const origin = requireOrigin(input);
    const userId = requireUser(input);
    const templates = await expenseRepository.listRecurringExpenses({ locCode: origin.locCode, includeInactive: true });
    const template = templates.find((row) => row.id === Number(input.templateId));
    if (!template || !template.isActive) throw new Error('This recurring expense is not active.');
    if (template.nextDueDate > origin.txnDate) throw new Error(`This expense is next due on ${template.nextDueDate}.`);
    const expense = await recordExpense({
      origin, userId,
      expenseCategoryId: template.expenseCategoryId,
      fundAccountId: template.fundAccountId,
      amount: template.amount,
      payee: template.payee,
      reference: template.reference || `Due ${template.nextDueDate}`,
      reason: template.reason,
      requestId: `recurring:${template.id}:${template.nextDueDate}`
    });
    const schedule = await expenseRepository.completeRecurringExpense({
      templateId: template.id, dueDate: template.nextDueDate, expenseEntryId: expense.id, userId
    });
    return { expense, schedule };
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
    reverseExpense,
    listExpenses,
    listRecurringExpenses,
    saveRecurringExpense,
    recordRecurringExpense,
    transferFunds
  };
}

module.exports = { createExpenseService };
