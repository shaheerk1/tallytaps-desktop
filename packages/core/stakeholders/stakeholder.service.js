/**
 * Stakeholders.
 *
 * Answers "whose money is in this business, and what can each person take out".
 * Taking more than the available claim is not silently blocked and not silently
 * allowed: it needs a named approver and a reason.
 */
const requestContext = require('../security/request-context');
const { resolveEntryDate, backdateMetadata } = require('../security/entry-date');

function createStakeholderService({ stakeholderRepository }) {
  if (!stakeholderRepository) throw new Error('Stakeholder service requires a repository.');

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

  function movementInput(input) {
    const origin = requireOrigin(input);
    if (!Number(input.userId)) throw new Error('A signed-in user is required.');
    if (!Number(input.stakeholderId)) throw new Error('Choose a stakeholder.');
    if (!Number(input.fundAccountId)) throw new Error('Choose which fund the money moves through.');
    if (money(input.amount) <= 0) throw new Error('The amount must be greater than zero.');
    if (!text(input.reason)) throw new Error('Write why this money is moving.');
    const entryDate = resolveEntryDate(input, origin);
    return {
      ...origin,
      txnDate: entryDate.txnDate,
      backdate: backdateMetadata(entryDate),
      userId: Number(input.userId),
      stakeholderId: Number(input.stakeholderId),
      fundAccountId: Number(input.fundAccountId),
      amount: money(input.amount),
      reason: text(input.reason),
      overrideApprovedBy: input.overrideApprovedBy ? Number(input.overrideApprovedBy) : null,
      overrideReason: text(input.overrideReason)
    };
  }

  async function list(input = {}) {
    if (!text(input.locCode)) throw new Error('A location is required to list stakeholders.');
    return stakeholderRepository.listStakeholders({ locCode: text(input.locCode), includeInactive: Boolean(input.includeInactive) });
  }

  async function save(input = {}) {
    if (!text(input.locCode)) throw new Error('A stakeholder belongs to a location.');
    return stakeholderRepository.saveStakeholder(input);
  }

  async function statement(input = {}) {
    if (!Number(input.stakeholderId)) throw new Error('Select a stakeholder.');
    if (!text(input.locCode)) throw new Error('A location is required for a partner statement.');
    return stakeholderRepository.getStatement(input);
  }

  async function saveShare(input = {}) {
    if (!Number(input.stakeholderId)) throw new Error('Choose a stakeholder.');
    if (!Number(input.userId)) throw new Error('A signed-in user is required.');
    return stakeholderRepository.saveShare(input);
  }

  async function allocateProfitShare(input = {}) {
    const origin = requireOrigin(input);
    if (!Number(input.userId)) throw new Error('A signed-in user is required.');
    if (!Number(input.stakeholderId)) throw new Error('Choose a stakeholder.');
    if (money(input.amount) <= 0) throw new Error('A profit share must be greater than zero.');
    if (!text(input.reason)) throw new Error('Write what period or lot this share covers.');
    return stakeholderRepository.allocateProfitShare({
      ...origin,
      userId: Number(input.userId),
      stakeholderId: Number(input.stakeholderId),
      amount: money(input.amount),
      inventoryLotId: Number(input.inventoryLotId) || null,
      reason: text(input.reason)
    });
  }

  return {
    list,
    save,
    statement,
    listShares: (input = {}) => stakeholderRepository.listShares(input),
    saveShare,
    contribute: (input = {}) => stakeholderRepository.recordContribution(movementInput(input)),
    draw: (input = {}) => stakeholderRepository.recordDrawing(movementInput(input)),
    settle: (input = {}) => stakeholderRepository.recordSettlement(movementInput(input)),
    allocateProfitShare,
    reconcile: (input = {}) => stakeholderRepository.reconcileEquity({ locCode: text(input.locCode) })
  };
}

module.exports = { createStakeholderService };
