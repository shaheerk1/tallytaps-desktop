function createCashManagementService({ cashManagementRepository }) {
  if (!cashManagementRepository) throw new Error('Cash management service requires a repository.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const manualMovementTypes = new Map([
    ['cash_in', 'in'],
    ['cash_out', 'out'],
    ['safe_drop', 'out'],
    ['bank_drop', 'out'],
    ['correction_in', 'in'],
    ['correction_out', 'out']
  ]);

  function normalizeLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines
      .map((line) => ({ denomination: money(line.denomination), quantity: Math.max(0, Math.floor(Number(line.quantity || 0))) }))
      .filter((line) => line.denomination > 0 && line.quantity > 0);
  }

  async function openShift({ workstationSessionId, workstationId, userId, businessDate, openingLines }) {
    if (!workstationSessionId || !workstationId || !userId || !businessDate) {
      throw new Error('A workstation session, workstation, cashier, and business date are required to open a shift.');
    }
    return cashManagementRepository.createShift({
      workstationSessionId, workstationId, userId, businessDate, openingLines: normalizeLines(openingLines)
    });
  }

  async function recordMovement({ shiftId, type, amount, reason, userId }) {
    const direction = manualMovementTypes.get(type);
    if (!direction) throw new Error('Unsupported cash movement type.');
    if (money(amount) <= 0) throw new Error('Cash movement amount must be greater than zero.');
    if (!String(reason || '').trim()) throw new Error('A reason is required for every cash movement.');
    return cashManagementRepository.addMovement({
      shiftId,
      movementType: type.startsWith('correction_') ? 'correction' : type,
      direction,
      amount: money(amount),
      reason: String(reason).trim(),
      userId
    });
  }

  async function correctMovement({ movementId, direction, amount, reason, userId }) {
    if (!movementId || !userId) throw new Error('A cash movement and signed-in user are required.');
    if (direction !== 'in' && direction !== 'out') throw new Error('Choose whether the corrected cash came in or went out.');
    if (money(amount) <= 0) throw new Error('Cash movement amount must be greater than zero.');
    if (!String(reason || '').trim()) throw new Error('A reason is required for a cash correction.');
    return cashManagementRepository.updateMovement({
      movementId, direction, amount: money(amount), reason: String(reason).trim(), userId
    });
  }

  async function removeMovement({ movementId, reason, userId }) {
    if (!movementId || !userId) throw new Error('A cash movement and signed-in user are required.');
    if (!String(reason || '').trim()) throw new Error('A reason is required to remove a cash movement.');
    return cashManagementRepository.voidMovement({ movementId, reason: String(reason).trim(), userId });
  }

  async function blindClose({ shiftId, userId, closingLines }) {
    if (!shiftId || !userId) throw new Error('A shift and cashier are required to submit a closing count.');
    return cashManagementRepository.submitClosingCount({ shiftId, userId, lines: normalizeLines(closingLines) });
  }

  async function closeShift({ shiftId, userId, varianceReason }) {
    if (!shiftId || !userId) throw new Error('A shift and authorized user are required to close the shift.');
    return cashManagementRepository.closeShift({ shiftId, userId, varianceReason: String(varianceReason || '').trim() });
  }

  async function listReportHistory({ shiftId }) {
    if (!shiftId) return [];
    return cashManagementRepository.listReportHistory(shiftId);
  }

  async function archiveReportPrint({ shiftId, reportType, reportNo, snapshot, userId }) {
    if (!shiftId || !userId) throw new Error('A shift and user are required to archive a report print.');
    return cashManagementRepository.archiveReportPrint({
      shiftId,
      reportType,
      reportNo,
      snapshot: snapshot || {},
      printedBy: userId
    });
  }

  async function prepareSale({ sessionId, userId, payments, grandTotal }) {
    const shift = await cashManagementRepository.getActiveShiftForSession(sessionId, userId);
    if (!shift) throw new Error('Open a cash shift before finalizing a sale.');
    if (shift.status !== 'open') throw new Error('The cash shift has a pending closing count and cannot accept transactions.');
    if (Number(shift.userId) !== Number(userId)) throw new Error('The active cash shift belongs to another cashier.');
    const cashReceived = money((payments || []).filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + money(payment.amount), 0));
    const tenderTotal = money((payments || []).filter((payment) => payment.type === 'tender').reduce((sum, payment) => sum + money(payment.amount), 0));
    const change = money(Math.max(tenderTotal - money(grandTotal), 0));
    if (change > 0 && cashReceived <= 0) throw new Error('Change can only be given when cash is tendered.');
    return { cashShiftId: shift.id, movements: [
      { movementType: 'sale_cash', direction: 'in', amount: cashReceived },
      { movementType: 'change_given', direction: 'out', amount: change }
    ].filter((movement) => movement.amount > 0) };
  }

  async function prepareRefund({ sessionId, userId, payments }) {
    const shift = await cashManagementRepository.getActiveShiftForSession(sessionId, userId);
    if (!shift) throw new Error('Open a cash shift before completing a refund.');
    if (shift.status !== 'open') throw new Error('The cash shift has a pending closing count and cannot accept transactions.');
    if (Number(shift.userId) !== Number(userId)) throw new Error('The active cash shift belongs to another cashier.');
    const cashPayout = money((payments || []).filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + money(payment.amount), 0));
    return { cashShiftId: shift.id, movements: [{ movementType: 'refund_cash', direction: 'out', amount: cashPayout }].filter((movement) => movement.amount > 0) };
  }

  async function prepareCollection({ sessionId, userId, payments }) {
    const shift = await cashManagementRepository.getActiveShiftForSession(sessionId, userId);
    if (!shift) throw new Error('Open a cash shift before collecting an outstanding balance.');
    if (shift.status !== 'open') throw new Error('The cash shift has a pending closing count and cannot accept transactions.');
    if (Number(shift.userId) !== Number(userId)) throw new Error('The active cash shift belongs to another cashier.');
    const cashReceived = money((payments || [])
      .filter((payment) => payment.method === 'cash')
      .reduce((sum, payment) => sum + money(payment.amount), 0));
    return {
      cashShiftId: shift.id,
      locCode: shift.locationCode,
      macCode: shift.machineCode,
      businessDate: shift.businessDate,
      movements: [{ movementType: 'receivable_collection_cash', direction: 'in', amount: cashReceived }]
        .filter((movement) => movement.amount > 0)
    };
  }

  return {
    getActiveShiftForSession: (sessionId) => cashManagementRepository.getActiveShiftForSession(sessionId),
    getRecoverableShiftForWorkstation: ({ workstationId, userId }) => {
      if (!workstationId || !userId) return null;
      return cashManagementRepository.getRecoverableShiftForWorkstation({ workstationId, userId });
    },
    getShift: (shiftId) => cashManagementRepository.getShift(shiftId),
    openShift,
    recordMovement,
    correctMovement,
    removeMovement,
    listMovementHistory: (filters) => cashManagementRepository.listMovementHistory(filters || {}),
    blindClose,
    closeShift,
    prepareSale,
    prepareRefund,
    prepareCollection,
    listReportHistory,
    archiveReportPrint
  };
}

module.exports = { createCashManagementService };
