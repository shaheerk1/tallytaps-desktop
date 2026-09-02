function createCustomerAdvanceService({ repository, paymentModes, paymentModeRepository, cashManagementService }) {
  if (!repository || !paymentModes || !cashManagementService) throw new Error('Customer advance service dependencies are incomplete.');
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  // MySQL DATE columns arrive as Date objects, and a shift carries its business
  // date straight from the database. Stringifying one gives "Wed Sep 02", which
  // matches no business day, so the calendar parts are read explicitly.
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);

  async function refreshModes() {
    if (paymentModeRepository) paymentModes.replaceConfigured(await paymentModeRepository.listModes());
  }

  async function shiftContext(input) {
    const shift = await cashManagementService.getActiveShiftForSession(input.sessionId);
    if (!shift || shift.status !== 'open') throw new Error('Open a cash shift before recording a customer advance.');
    if (Number(shift.userId) !== Number(input.userId)) throw new Error('The active cash shift belongs to another cashier.');
    return {
      locCode: shift.locationCode,
      macCode: shift.machineCode,
      txnDate: dateOnly(shift.businessDate),
      cashShiftId: shift.id
    };
  }

  function normalizePayment(payment, { allowAdvance = false } = {}) {
    const method = String(payment?.method || '').trim().toLowerCase();
    const mode = paymentModes.getMode(method);
    if (!mode || mode.type !== 'tender' || (!allowAdvance && method === 'advance')) {
      throw new Error('Select an enabled tender method for the customer advance.');
    }
    if (method === 'cheque') throw new Error('Cheque advances require clearance tracking and are not available yet.');
    const amount = money(payment?.amount);
    if (amount <= 0) throw new Error('Advance payment amount must be greater than zero.');
    return { method, amount, providerRef: String(payment?.providerRef || '').trim() || null, details: payment?.details || {} };
  }

  async function receive(input) {
    await refreshModes();
    if (!Number(input?.customerAccountId) || !Number(input?.userId)) throw new Error('A customer account and signed-in user are required.');
    const reason = String(input.reason || '').trim();
    if (!reason) throw new Error('A reason is required for an advance receipt.');
    const payments = (input.payments || []).map((payment) => normalizePayment(payment));
    if (!payments.length) throw new Error('Add at least one payment for the advance.');
    return repository.receive({ ...input, ...(await shiftContext(input)), reason, payments });
  }

  async function refundUnused(input) {
    await refreshModes();
    if (!Number(input?.customerAccountId) || !Number(input?.userId)) throw new Error('A customer account and signed-in user are required.');
    const reason = String(input.reason || '').trim();
    if (!reason) throw new Error('A reason is required to refund unused advance money.');
    const payment = normalizePayment({ method: input.method, amount: input.amount, providerRef: input.providerRef });
    const context = await shiftContext(input);
    const available = await repository.getBalance(input.customerAccountId, context.locCode);
    if (payment.amount > available + 0.005) throw new Error(`Only ${available.toFixed(2)} of unused advance is available at this location.`);
    return repository.refundUnused({ ...input, ...context, ...payment, reason });
  }

  return {
    getBalance: ({ customerAccountId, locCode }) => repository.getBalance(customerAccountId, locCode),
    getSummary: ({ customerAccountId, locCode }) => repository.getSummary(customerAccountId, locCode),
    receive,
    refundUnused
  };
}

module.exports = { createCustomerAdvanceService };
