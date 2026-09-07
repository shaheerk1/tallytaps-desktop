/**
 * Lot costing.
 *
 * Turns "what did this delivery really cost me" into a number by attaching
 * expenses to the goods they belong to. The service holds the rules a person
 * can get wrong; the repository holds the ledger writes.
 */
function createLotCostingService({ lotCostingRepository }) {
  if (!lotCostingRepository) throw new Error('Lot costing service requires a repository.');

  const text = (value) => String(value || '').trim();
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const BASES = ['direct', 'base_quantity', 'handling_quantity', 'sale_value', 'equal'];

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

  async function listLots(input = {}) {
    if (!text(input.locCode)) throw new Error('A location is required to list lots.');
    return lotCostingRepository.listLots(input);
  }

  async function allocateExpense(input = {}) {
    const origin = requireOrigin(input);
    if (!Number(input.userId)) throw new Error('A signed-in user is required.');
    if (!Number(input.expenseEntryId)) throw new Error('Choose the expense to attach.');
    const lotId = Number(input.inventoryLotId) || null;
    const grnId = Number(input.goodsReceiptId) || null;
    if (!lotId && !grnId) throw new Error('Choose a lot, or a delivery to spread the cost across.');
    if (lotId && grnId) throw new Error('Attach the cost either to one lot or to a whole delivery, not both.');
    const basis = text(input.basis) || (lotId ? 'direct' : 'base_quantity');
    if (!BASES.includes(basis)) throw new Error('Choose how the cost should be divided.');
    if (lotId && basis !== 'direct') {
      throw new Error('A cost on a single lot is not divided, so its basis is direct.');
    }
    return lotCostingRepository.allocateExpense({
      ...origin,
      userId: Number(input.userId),
      expenseEntryId: Number(input.expenseEntryId),
      inventoryLotId: lotId,
      goodsReceiptId: grnId,
      basis,
      amount: input.amount == null ? null : money(input.amount),
      reason: text(input.reason)
    });
  }

  async function reallocate(input = {}) {
    const origin = requireOrigin(input);
    if (!Number(input.userId)) throw new Error('A signed-in user is required.');
    if (!Number(input.expenseEntryId)) throw new Error('Choose the expense to move.');
    if (!text(input.reason)) throw new Error('Moving a cost between lots needs a recorded reason.');
    return lotCostingRepository.reallocate({
      ...origin,
      userId: Number(input.userId),
      expenseEntryId: Number(input.expenseEntryId),
      fromInventoryLotId: Number(input.fromInventoryLotId),
      toInventoryLotId: Number(input.toInventoryLotId),
      amount: money(input.amount),
      reason: text(input.reason)
    });
  }

  async function getProfitability(input = {}) {
    if (!text(input.locCode)) throw new Error('A location is required for the profitability report.');
    return lotCostingRepository.getLotProfitability(input);
  }

  async function getLotCostDetail(input = {}) {
    if (!Number(input.inventoryLotId)) throw new Error('Select a lot.');
    return lotCostingRepository.getLotCostDetail(input);
  }

  async function reconcile(input = {}) {
    if (!text(input.locCode)) throw new Error('A location is required to reconcile landed cost.');
    return lotCostingRepository.reconcileLandedCost(input);
  }

  return { listLots, allocateExpense, reallocate, getProfitability, getLotCostDetail, reconcile };
}

module.exports = { createLotCostingService };
