/**
 * Sending goods out to another shop.
 *
 * The load and its weighing fee are recorded in one operator action. They are
 * two separate documents underneath — a stock issue and an expense — because
 * the goods movement must stand on its own even if the fee is entered wrongly.
 * The issue is written first for that reason; the fee is then attached to the
 * lot the goods came from, so the cost lands on the right stock.
 */
const requestContext = require('../security/request-context');

function createInventoryIssueService({ inventoryIssueRepository, expenseRepository, lotCostingRepository }) {
  if (!inventoryIssueRepository) throw new Error('Inventory issue service requires its repository.');

  async function listIssues(filters) {
    return inventoryIssueRepository.listIssues(filters || {});
  }

  async function recordIssue(rawInput = {}) {
    // The load leaves the signed-in workstation's location on its business date,
    // whatever the screen sent.
    const origin = requestContext.resolveOrigin({ locCode: rawInput.locCode, macCode: rawInput.macCode, txnDate: rawInput.businessDate });
    const input = {
      ...rawInput,
      locCode: origin.locCode,
      macCode: origin.macCode,
      businessDate: origin.txnDate,
      userId: requestContext.resolveUserId(rawInput)
    };
    const issue = await inventoryIssueRepository.createIssue(input);

    const charge = Math.round(Number(input.weighbridgeCharge || 0) * 100) / 100;
    if (!(charge > 0)) return { ...issue, weighbridgeExpense: null };

    // From here the goods have already moved. A failure attaching the fee must
    // report itself without pretending the load was not recorded.
    if (!expenseRepository || !lotCostingRepository) {
      return { ...issue, weighbridgeExpense: null, weighbridgeError: 'This build cannot record expenses, so the weighing fee was not entered.' };
    }
    if (!input.weighbridgeFundAccountId) {
      return { ...issue, weighbridgeExpense: null, weighbridgeError: 'The load was recorded. Choose which fund paid the weighing fee to attach it.' };
    }

    try {
      const categories = await expenseRepository.listCategories();
      const category = categories.find((row) => row.categoryCode === 'weighbridge')
        || categories.find((row) => row.defaultTreatment === 'lot_cost');
      if (!category) throw new Error('No goods-related expense category is set up.');

      const expense = await expenseRepository.recordExpense({
        locCode: input.locCode,
        macCode: input.macCode,
        txnDate: input.businessDate,
        expenseCategoryId: category.id,
        fundAccountId: input.weighbridgeFundAccountId,
        amount: charge,
        reason: `Weighing for load ${issue.issueNo} to ${issue.destination}`,
        payee: input.weighbridgePaidTo || null,
        reference: input.weighbridgeTicket || null,
        // Re-running the same load cannot charge twice.
        requestId: `inventory-issue-${issue.id}`,
        userId: input.userId
      });

      await inventoryIssueRepository.linkWeighbridgeExpense(issue.id, expense.id);

      // One load, one lot in the ordinary case. A mixed load splits the fee
      // across its lots by the weight that actually moved, so the heavier lot
      // carries the larger share; the last lot absorbs the rounding remainder.
      const lots = (input.lines || []).filter((line) => line.inventoryLotId);
      const weights = lots.map((line) => Number(line.baseQuantity || line.handlingQuantity || 0));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let assigned = 0;
      for (let index = 0; index < lots.length; index += 1) {
        const isLast = index === lots.length - 1;
        const share = isLast || totalWeight <= 0
          ? Math.round((charge - assigned) * 100) / 100
          : Math.round((charge * weights[index] / totalWeight) * 100) / 100;
        assigned = Math.round((assigned + share) * 100) / 100;
        if (share <= 0) continue;
        await lotCostingRepository.allocateExpense({
          locCode: input.locCode, macCode: input.macCode, txnDate: input.businessDate,
          expenseEntryId: expense.id, inventoryLotId: lots[index].inventoryLotId,
          basis: 'direct', amount: share,
          reason: `Weighing for load ${issue.issueNo}`, userId: input.userId
        });
      }
      return { ...issue, weighbridgeExpense: { id: expense.id, amount: charge } };
    } catch (error) {
      return {
        ...issue,
        weighbridgeExpense: null,
        weighbridgeError: `The load was recorded, but its weighing fee was not: ${error.message}`
      };
    }
  }

  return { recordIssue, listIssues };
}

module.exports = { createInventoryIssueService };
