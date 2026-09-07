/**
 * Posting rules.
 *
 * Each business event has exactly one rule that turns it into balanced journal
 * lines. These are pure functions: they take an event and a chart of accounts
 * and return lines. They read nothing and write nothing.
 *
 * Two constraints hold this file honest, and both are deliberate:
 *
 *   * no operator ever types a debit, so there is no "manual entry" rule here;
 *   * the rules are fixed code, not configuration. There is no formula engine,
 *     no SDL expression, and no plugin hook that can produce a posting.
 *
 * Sales and supplier settlements are intentionally absent. Those subledgers
 * remain the source of truth until a later phase brings them in, so the journal
 * covers fund, expense, allocation, and stakeholder events only.
 */

const ACCOUNTS = {
  CASH_TILL: '1000',
  CASH_SAFE: '1010',
  BANK: '1020',
  INVENTORY: '1200',
  STAKEHOLDER_PAYABLE: '2000',
  STAKEHOLDER_CAPITAL: '3000',
  STAKEHOLDER_DRAWINGS: '3100',
  ALLOCATED_PROFIT_SHARE: '3200',
  UNDISTRIBUTED_PROFIT: '3300',
  GOODS_COST: '5000',
  OVERHEAD_COST: '5100'
};

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/**
 * Where a fund's money sits on the balance sheet. A stakeholder pocket is not a
 * business asset -- the business never held that cash -- so it resolves to what
 * the business owes that person instead.
 */
function fundAccountCode(fund, { stakeholderTreatment = 'capital' } = {}) {
  switch (fund.fundKind) {
    case 'pos_drawer': return ACCOUNTS.CASH_TILL;
    case 'cash_safe': return ACCOUNTS.CASH_SAFE;
    case 'bank': return ACCOUNTS.BANK;
    case 'stakeholder':
      return stakeholderTreatment === 'liability' ? ACCOUNTS.STAKEHOLDER_PAYABLE : ACCOUNTS.STAKEHOLDER_CAPITAL;
    default:
      throw new Error(`No ledger account is mapped for fund kind "${fund.fundKind}".`);
  }
}

function expenseAccountCode(treatment) {
  return treatment === 'lot_cost' ? ACCOUNTS.GOODS_COST : ACCOUNTS.OVERHEAD_COST;
}

function debit(accountCode, amount, dimensions = {}) {
  return { accountCode, debit: money(amount), credit: 0, ...dimensions };
}

function credit(accountCode, amount, dimensions = {}) {
  return { accountCode, debit: 0, credit: money(amount), ...dimensions };
}

/**
 * Money spent. The cost lands in an expense account; the pocket that paid it is
 * reduced, or -- for a partner's own pocket -- becomes a claim against the
 * business.
 */
function expensePosting({ expense, fund, category, stakeholder = null }) {
  const amount = money(expense.amount);
  const treatment = stakeholder ? stakeholder.borneCostTreatment : 'capital';
  return {
    narration: `${category.name}: ${expense.reason}`,
    lines: [
      debit(expenseAccountCode(category.defaultTreatment), amount, { expenseCategoryId: category.id, memo: expense.reason }),
      credit(fundAccountCode(fund, { stakeholderTreatment: treatment }), amount, {
        fundAccountId: fund.id,
        stakeholderId: stakeholder ? stakeholder.id : null,
        memo: stakeholder ? `Paid personally by ${stakeholder.displayName}` : `Paid from ${fund.name}`
      })
    ]
  };
}

/**
 * A cost attached to received goods stops being a period expense and becomes
 * part of what those goods are worth. A negative amount (a reallocation giving
 * the cost up) simply flips the two sides.
 */
function allocationPosting({ allocation, category, lot }) {
  const amount = money(allocation.amount);
  const goodsAccount = expenseAccountCode(category.defaultTreatment);
  const dimensions = { inventoryLotId: lot.id, expenseCategoryId: category.id, memo: allocation.reason };
  const magnitude = Math.abs(amount);
  return {
    narration: `${category.name} attached to lot ${lot.lotCode}`,
    lines: amount > 0
      ? [debit(ACCOUNTS.INVENTORY, magnitude, dimensions), credit(goodsAccount, magnitude, dimensions)]
      : [debit(goodsAccount, magnitude, dimensions), credit(ACCOUNTS.INVENTORY, magnitude, dimensions)]
  };
}

/** The same money in a different place: one fund down, another up. */
function transferPosting({ transfer, fromFund, toFund, fromStakeholder = null, toStakeholder = null }) {
  const amount = money(transfer.amount);
  return {
    narration: `Moved from ${fromFund.name} to ${toFund.name}: ${transfer.reason}`,
    lines: [
      debit(fundAccountCode(toFund, { stakeholderTreatment: toStakeholder ? toStakeholder.borneCostTreatment : 'capital' }), amount, {
        fundAccountId: toFund.id, stakeholderId: toStakeholder ? toStakeholder.id : null, memo: `Into ${toFund.name}`
      }),
      credit(fundAccountCode(fromFund, { stakeholderTreatment: fromStakeholder ? fromStakeholder.borneCostTreatment : 'capital' }), amount, {
        fundAccountId: fromFund.id, stakeholderId: fromStakeholder ? fromStakeholder.id : null, memo: `Out of ${fromFund.name}`
      })
    ]
  };
}

/** A partner puts money in: the business gains cash, the partner gains a claim. */
function contributionPosting({ entry, stakeholder, fund }) {
  const amount = money(entry.amount);
  return {
    narration: `Capital from ${stakeholder.displayName}: ${entry.reason}`,
    lines: [
      debit(fundAccountCode(fund), amount, { fundAccountId: fund.id, memo: `Received into ${fund.name}` }),
      credit(ACCOUNTS.STAKEHOLDER_CAPITAL, amount, { stakeholderId: stakeholder.id, memo: entry.reason })
    ]
  };
}

/** A partner takes money out: their claim falls and a fund is reduced. */
function drawingPosting({ entry, stakeholder, fund }) {
  const amount = Math.abs(money(entry.amount));
  return {
    narration: `Drawing by ${stakeholder.displayName}: ${entry.reason}`,
    lines: [
      debit(ACCOUNTS.STAKEHOLDER_DRAWINGS, amount, { stakeholderId: stakeholder.id, memo: entry.reason }),
      credit(fundAccountCode(fund), amount, { fundAccountId: fund.id, memo: `Paid from ${fund.name}` })
    ]
  };
}

/** The business repays what a partner spent on its behalf. */
function settlementPosting({ entry, stakeholder, fund }) {
  const amount = Math.abs(money(entry.amount));
  return {
    narration: `Settled with ${stakeholder.displayName}: ${entry.reason}`,
    lines: [
      debit(ACCOUNTS.STAKEHOLDER_PAYABLE, amount, { stakeholderId: stakeholder.id, memo: entry.reason }),
      credit(fundAccountCode(fund), amount, { fundAccountId: fund.id, memo: `Paid from ${fund.name}` })
    ]
  };
}

/** Profit stops being unclaimed and becomes one partner's share. */
function profitSharePosting({ entry, stakeholder }) {
  const amount = money(entry.amount);
  return {
    narration: `Profit share to ${stakeholder.displayName}: ${entry.reason}`,
    lines: [
      debit(ACCOUNTS.UNDISTRIBUTED_PROFIT, amount, { stakeholderId: stakeholder.id, memo: entry.reason }),
      credit(ACCOUNTS.ALLOCATED_PROFIT_SHARE, amount, {
        stakeholderId: stakeholder.id,
        inventoryLotId: entry.inventoryLotId || null,
        memo: entry.reason
      })
    ]
  };
}

/** Every rule produces balanced lines, or it is a bug and must not be written. */
function assertBalanced(posting) {
  const totalDebit = money(posting.lines.reduce((sum, line) => sum + money(line.debit), 0));
  const totalCredit = money(posting.lines.reduce((sum, line) => sum + money(line.credit), 0));
  if (totalDebit !== totalCredit) {
    throw new Error(`Posting rule produced unbalanced lines: ${totalDebit.toFixed(2)} debit vs ${totalCredit.toFixed(2)} credit.`);
  }
  if (totalDebit <= 0) throw new Error('A posting must move a non-zero amount.');
  return { ...posting, totalDebit, totalCredit };
}

module.exports = {
  ACCOUNTS,
  fundAccountCode,
  expenseAccountCode,
  expensePosting,
  allocationPosting,
  transferPosting,
  contributionPosting,
  drawingPosting,
  settlementPosting,
  profitSharePosting,
  assertBalanced
};
