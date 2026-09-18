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
 * Operational subledgers remain authoritative; their accounting synchronizer
 * invokes these rules idempotently.  That keeps the till fast and makes old POS
 * records backfillable without inviting operators to hand-write debits.
 */

const ACCOUNTS = {
  CASH_TILL: '1000',
  CASH_SAFE: '1010',
  BANK: '1020',
  INCOMING_CHEQUES: '1100',
  CUSTOMER_RECEIVABLES: '1110',
  INVENTORY: '1200',
  DEFERRED_CONSIGNMENT_COST: '1210',
  STAKEHOLDER_PAYABLE: '2000',
  SUPPLIER_PAYABLES: '2010',
  ISSUED_CHEQUES: '2050',
  CUSTOMER_ADVANCES: '2100',
  STAKEHOLDER_CAPITAL: '3000',
  STAKEHOLDER_DRAWINGS: '3100',
  ALLOCATED_PROFIT_SHARE: '3200',
  UNDISTRIBUTED_PROFIT: '3300',
  MERCHANDISE_SALES: '4000',
  PACKAGING_INCOME: '4010',
  MEASURED_SERVICE_INCOME: '4020',
  OTHER_CASH_INCOME: '4030',
  SALES_RETURNS: '4090',
  GOODS_COST: '5000',
  CONSIGNMENT_SUPPLIER_COST: '5010',
  OVERHEAD_COST: '5100',
  SALARIES: '5200',
  UNCLASSIFIED_MONEY: '5900'
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

function expenseAccountCode(treatment, categoryCode = '') {
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
      debit(category.categoryCode === 'wages' ? ACCOUNTS.SALARIES : expenseAccountCode(category.defaultTreatment), amount, { expenseCategoryId: category.id, memo: expense.reason }),
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
  const inventoryAccount = lot.ownershipModel === 'consignment'
    ? ACCOUNTS.DEFERRED_CONSIGNMENT_COST
    : ACCOUNTS.INVENTORY;
  const magnitude = Math.abs(amount);
  return {
    narration: `${category.name} attached to lot ${lot.lotCode}`,
    lines: amount > 0
      ? [debit(inventoryAccount, magnitude, dimensions), credit(goodsAccount, magnitude, dimensions)]
      : [debit(goodsAccount, magnitude, dimensions), credit(inventoryAccount, magnitude, dimensions)]
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

/** Recognize (or reverse) the sold share of a lot's current landed cost. */
function lotCostRecognitionPosting({ lot, delta, reason }) {
  const amount = Math.abs(money(delta));
  const inventoryAccount = lot.ownershipModel === 'consignment'
    ? ACCOUNTS.DEFERRED_CONSIGNMENT_COST
    : ACCOUNTS.INVENTORY;
  const dimensions = { inventoryLotId: lot.id, memo: reason };
  return {
    narration: reason,
    lines: delta > 0
      ? [debit(ACCOUNTS.GOODS_COST, amount, dimensions), credit(inventoryAccount, amount, dimensions)]
      : [debit(inventoryAccount, amount, dimensions), credit(ACCOUNTS.GOODS_COST, amount, dimensions)]
  };
}

function invoiceSalePosting({ invoice }) {
  const total = money(invoice.grandTotal);
  const packaging = Math.max(0, money(invoice.bagChargeTotal));
  const measuredService = Math.max(0, money(invoice.wageChargeTotal));
  const merchandise = money(Math.max(0, total - packaging - measuredService));
  const lines = [debit(ACCOUNTS.CUSTOMER_RECEIVABLES, total, { memo: invoice.invoiceNumber })];
  if (merchandise) lines.push(credit(ACCOUNTS.MERCHANDISE_SALES, merchandise));
  if (packaging) lines.push(credit(ACCOUNTS.PACKAGING_INCOME, packaging));
  if (measuredService) lines.push(credit(ACCOUNTS.MEASURED_SERVICE_INCOME, measuredService));
  return { narration: `Sale ${invoice.invoiceNumber}`, lines };
}

function paymentAssetCode(payment) {
  if (payment.assetAccountCode) return payment.assetAccountCode;
  if (payment.method === 'cash') return ACCOUNTS.CASH_TILL;
  if (payment.method === 'cheque') return ACCOUNTS.INCOMING_CHEQUES;
  return ACCOUNTS.BANK;
}

function customerPaymentPosting({ payment, amount = payment.amount, refund = false }) {
  const value = money(amount);
  const dimensions = payment.fundAccountId ? { fundAccountId: payment.fundAccountId } : {};
  if (payment.method === 'advance') {
    return {
      narration: `${refund ? 'Restore' : 'Apply'} customer advance: ${payment.reference || ''}`.trim(),
      lines: refund
        ? [debit(ACCOUNTS.CUSTOMER_RECEIVABLES, value), credit(ACCOUNTS.CUSTOMER_ADVANCES, value)]
        : [debit(ACCOUNTS.CUSTOMER_ADVANCES, value), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, value)]
    };
  }
  const asset = paymentAssetCode(payment);
  return {
    narration: `${refund ? 'Refund paid' : 'Customer payment'} by ${payment.method}`,
    lines: refund
      ? [debit(ACCOUNTS.CUSTOMER_RECEIVABLES, value), credit(asset, value, dimensions)]
      : [debit(asset, value, dimensions), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, value)]
  };
}

function refundPosting({ refund }) {
  const total = money(refund.grandTotal);
  return {
    narration: `Sales return ${refund.refundNumber}`,
    lines: [debit(ACCOUNTS.SALES_RETURNS, total), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, total)]
  };
}

function customerAdvanceReceiptPosting({ receipt, payment }) {
  const value = money(payment.amount);
  const dimensions = payment.fundAccountId ? { fundAccountId: payment.fundAccountId } : {};
  return {
    narration: `Customer advance ${receipt.advanceNumber}`,
    lines: [debit(paymentAssetCode(payment), value, dimensions), credit(ACCOUNTS.CUSTOMER_ADVANCES, value)]
  };
}

function customerAdvanceRefundPosting({ refund }) {
  const value = money(refund.amount);
  const dimensions = refund.fundAccountId ? { fundAccountId: refund.fundAccountId } : {};
  return {
    narration: `Customer advance refund ${refund.refundNumber}`,
    lines: [debit(ACCOUNTS.CUSTOMER_ADVANCES, value), credit(paymentAssetCode(refund), value, dimensions)]
  };
}

function supplierObligationPosting({ obligation }) {
  const value = Math.abs(money(obligation.amount));
  const isConsignment = obligation.entryType === 'consignment_accrual';
  const debitAccount = isConsignment ? ACCOUNTS.CONSIGNMENT_SUPPLIER_COST : ACCOUNTS.INVENTORY;
  return {
    narration: obligation.reason || 'Supplier obligation',
    lines: obligation.amount >= 0
      ? [debit(debitAccount, value, { inventoryLotId: obligation.inventoryLotId || null }), credit(ACCOUNTS.SUPPLIER_PAYABLES, value)]
      : [debit(ACCOUNTS.SUPPLIER_PAYABLES, value), credit(debitAccount, value, { inventoryLotId: obligation.inventoryLotId || null })]
  };
}

function supplierPaymentPosting({ payment, reversal = false }) {
  const value = money(payment.amount);
  const dimensions = payment.fundAccountId ? { fundAccountId: payment.fundAccountId } : {};
  const asset = payment.method === 'cash'
    ? ACCOUNTS.CASH_TILL
    : payment.method === 'cheque' ? ACCOUNTS.ISSUED_CHEQUES : ACCOUNTS.BANK;
  return {
    narration: `${reversal ? 'Reverse' : 'Pay'} supplier by ${payment.method}`,
    lines: reversal
      ? [debit(asset, value, dimensions), credit(ACCOUNTS.SUPPLIER_PAYABLES, value)]
      : [debit(ACCOUNTS.SUPPLIER_PAYABLES, value), credit(asset, value, dimensions)]
  };
}

/**
 * Paying a supplier on their account: what the business owes suppliers goes
 * down, and the fund that paid goes down with it. A partner's own pocket is
 * not business money, so paying from it becomes what the business owes them.
 */
function supplierAccountPaymentPosting({ amount, fund, stakeholderTreatment = 'capital', supplierName = '' }) {
  const value = money(amount);
  return {
    narration: `Pay supplier${supplierName ? ` ${supplierName}` : ''} from ${fund.name}`,
    lines: [
      debit(ACCOUNTS.SUPPLIER_PAYABLES, value),
      credit(fundAccountCode(fund, { stakeholderTreatment }), value, { fundAccountId: fund.id })
    ]
  };
}

function incomingChequeStatusPosting({ cheque, status }) {
  const value = money(cheque.amount);
  const bankDimensions = cheque.fundAccountId ? { fundAccountId: cheque.fundAccountId } : {};
  if (status === 'cleared') {
    return {
      narration: `Incoming cheque ${cheque.chequeNumber} cleared`,
      lines: [debit(ACCOUNTS.BANK, value, bankDimensions), credit(ACCOUNTS.INCOMING_CHEQUES, value)]
    };
  }
  return {
    narration: `Incoming cheque ${cheque.chequeNumber} ${status}`,
    lines: [debit(ACCOUNTS.CUSTOMER_RECEIVABLES, value), credit(ACCOUNTS.INCOMING_CHEQUES, value)]
  };
}

function issuedChequeClearancePosting({ cheque }) {
  const value = money(cheque.amount);
  return {
    narration: `Issued cheque ${cheque.chequeNumber} cleared`,
    lines: [debit(ACCOUNTS.ISSUED_CHEQUES, value), credit(ACCOUNTS.BANK, value, cheque.fundAccountId ? { fundAccountId: cheque.fundAccountId } : {})]
  };
}

function otherIssuedChequePosting({ cheque, reversal = false }) {
  const value = money(cheque.amount);
  const lines = [
    debit(ACCOUNTS.UNCLASSIFIED_MONEY, value, { memo: cheque.purpose || 'Other issued cheque' }),
    credit(ACCOUNTS.ISSUED_CHEQUES, value)
  ];
  return {
    narration: `${reversal ? 'Reverse' : 'Record'} issued cheque ${cheque.chequeNumber}`,
    lines: reversal
      ? lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit }))
      : lines
  };
}

function manualCashMovementPosting({ movement, before = null, after = null, voided = false }) {
  const linesFor = (state) => {
    const value = money(state.amount);
    return state.direction === 'in'
      ? [debit(ACCOUNTS.CASH_TILL, value), credit(ACCOUNTS.OTHER_CASH_INCOME, value)]
      : [debit(ACCOUNTS.UNCLASSIFIED_MONEY, value), credit(ACCOUNTS.CASH_TILL, value)];
  };
  const reverse = (lines) => lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit }));
  const lines = before
    ? [...reverse(linesFor(before)), ...(voided ? [] : linesFor(after))]
    : linesFor(movement);
  return { narration: `${voided ? 'Remove' : before ? 'Correct' : 'Record'} manual cash movement: ${movement.reason || ''}`.trim(), lines };
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
  lotCostRecognitionPosting,
  invoiceSalePosting,
  customerPaymentPosting,
  refundPosting,
  customerAdvanceReceiptPosting,
  customerAdvanceRefundPosting,
  supplierObligationPosting,
  supplierPaymentPosting,
  supplierAccountPaymentPosting,
  incomingChequeStatusPosting,
  issuedChequeClearancePosting,
  otherIssuedChequePosting,
  manualCashMovementPosting,
  assertBalanced
};
