function createCustomerAdvanceRepository({ database, documentSequenceRepository, businessDayRepository }) {
  if (!database) throw new Error('Customer advance repository requires a database instance.');
  if (!documentSequenceRepository || !businessDayRepository) throw new Error('Customer advances require document numbering and business-day control.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);
  const json = (value) => {
    if (!value || typeof value === 'object') return value || {};
    try { return JSON.parse(value); } catch { return {}; }
  };

  async function activeAccount(connection, accountId) {
    const [rows] = await connection.execute(
      `SELECT ca.id, ca.account_number, ca.status, p.display_name, p.mobile AS primary_mobile
       FROM customer_accounts ca JOIN parties p ON p.id = ca.party_id
       WHERE ca.id = ? LIMIT 1`, [Number(accountId)]
    );
    if (!rows[0] || rows[0].status !== 'active') throw new Error('Select an active customer account.');
    return rows[0];
  }

  async function openShift(connection, shiftId, origin) {
    const [rows] = await connection.execute(
      `SELECT id, shift_no, loc_code, mac_code, business_date, status
       FROM cash_shifts WHERE id = ? FOR UPDATE`, [Number(shiftId)]
    );
    const shift = rows[0];
    if (!shift || shift.status !== 'open') throw new Error('Open a cash shift before recording a customer advance.');
    if (shift.loc_code !== origin.locCode || shift.mac_code !== origin.macCode || dateOnly(shift.business_date) !== origin.txnDate) {
      throw new Error('The customer advance must use the active shift location, terminal, and business date.');
    }
    return shift;
  }

  async function insertCashMovement(connection, { shift, movementType, direction, amount, referenceType, referenceId, reason, userId, metadata }) {
    if (money(amount) <= 0) return;
    const [numbers] = await connection.execute(
      'SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [shift.id]
    );
    await connection.execute(
      `INSERT INTO cash_movements
         (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
          movement_type, direction, amount, reference_type, reference_id, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [shift.id, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no, Number(numbers[0].max_no || 0) + 1,
        movementType, direction, money(amount), referenceType, String(referenceId), reason, userId, JSON.stringify(metadata || {})]
    );
  }

  async function receiptBalances(connection, { customerAccountId, locCode, lock = false }) {
    const [rows] = await connection.execute(
      `SELECT r.*, p.display_name AS customer_name, p.mobile AS primary_mobile
       FROM customer_advance_receipts r
       JOIN customer_accounts ca ON ca.id = r.customer_account_id
       JOIN parties p ON p.id = ca.party_id
       WHERE r.customer_account_id = ? AND r.loc_code = ? AND r.status <> 'void'
       ORDER BY r.txn_date, r.advance_no, r.id${lock ? ' FOR UPDATE' : ''}`,
      [Number(customerAccountId), String(locCode || '').trim()]
    );
    if (!rows.length) return [];
    const placeholders = rows.map(() => '?').join(',');
    const [balances] = await connection.execute(
      `SELECT advance_receipt_id,
              SUM(CASE WHEN entry_type IN ('receipt_credit','restore_credit') THEN amount ELSE -amount END) AS remaining_amount
       FROM customer_advance_entries WHERE advance_receipt_id IN (${placeholders}) GROUP BY advance_receipt_id`,
      rows.map((row) => row.id)
    );
    const byReceipt = new Map(balances.map((row) => [Number(row.advance_receipt_id), money(row.remaining_amount)]));
    return rows.map((row) => ({ ...row, remaining_amount: byReceipt.get(Number(row.id)) || 0 }))
      .filter((row) => row.remaining_amount > 0.005);
  }

  async function getBalance(customerAccountId, locCode) {
    return database.withConnection(async (connection) => {
      await activeAccount(connection, customerAccountId);
      const receipts = await receiptBalances(connection, { customerAccountId, locCode });
      return money(receipts.reduce((sum, row) => sum + money(row.remaining_amount), 0));
    });
  }

  async function getSummary(customerAccountId, locCode) {
    return database.withConnection(async (connection) => {
      const account = await activeAccount(connection, customerAccountId);
      const receipts = await receiptBalances(connection, { customerAccountId, locCode });
      const [entries] = await connection.execute(
        `SELECT e.*, r.advance_number, u.display_name AS user_name
         FROM customer_advance_entries e
         JOIN customer_advance_receipts r ON r.id = e.advance_receipt_id
         JOIN users u ON u.id = e.created_by
         WHERE e.customer_account_id = ? AND e.loc_code = ?
         ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
        [Number(customerAccountId), String(locCode || '').trim()]
      );
      return {
        customer: { id: Number(account.id), accountNumber: account.account_number, name: account.display_name, mobile: account.primary_mobile },
        locationCode: String(locCode || '').trim(),
        availableBalance: money(receipts.reduce((sum, row) => sum + money(row.remaining_amount), 0)),
        receipts: receipts.map((row) => ({
          id: Number(row.id), advanceNumber: row.advance_number, date: dateOnly(row.txn_date),
          originalAmount: money(row.original_amount), remainingAmount: money(row.remaining_amount), reason: row.reason,
          customerName: row.customer_name, createdAt: row.created_at
        })),
        entries: entries.map((row) => ({
          id: Number(row.id), advanceReceiptId: Number(row.advance_receipt_id), advanceNumber: row.advance_number,
          type: row.entry_type, amount: money(row.amount), reason: row.reason, date: dateOnly(row.txn_date),
          invoiceId: row.invoice_id == null ? null : Number(row.invoice_id), metadata: json(row.metadata),
          userName: row.user_name, createdAt: row.created_at
        }))
      };
    });
  }

  async function receive({ customerAccountId, locCode, macCode, txnDate, cashShiftId, userId, reason, payments }) {
    const origin = { locCode: String(locCode || '').trim(), macCode: String(macCode || '').trim(), txnDate: dateOnly(txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const account = await activeAccount(connection, customerAccountId);
        const day = await businessDayRepository.assertOpenWithConnection(connection, { locationCode: origin.locCode, businessDate: origin.txnDate });
        const shift = await openShift(connection, cashShiftId, origin);
        const total = money((payments || []).reduce((sum, payment) => sum + money(payment.amount), 0));
        if (total <= 0) throw new Error('Advance amount must be greater than zero.');
        const advanceNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'customer_advance', ...origin });
        const advanceNumber = `ADV-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(advanceNo).padStart(6, '0')}`;
        const [result] = await connection.execute(
          `INSERT INTO customer_advance_receipts
             (business_day_id, customer_account_id, cash_shift_id, loc_code, mac_code, txn_date,
              advance_no, advance_number, original_amount, reason, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [day.id, customerAccountId, shift.id, origin.locCode, origin.macCode, origin.txnDate,
            advanceNo, advanceNumber, total, String(reason || '').trim(), userId]
        );
        let paymentNo = 0;
        for (const payment of payments) {
          paymentNo += 1;
          await connection.execute(
            `INSERT INTO customer_advance_payments
               (advance_receipt_id, payment_no, method, fund_account_id, amount, provider_ref, details)
             VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [result.insertId, paymentNo, payment.method, Number(payment.fundAccountId) || null,
              money(payment.amount), payment.providerRef || null, JSON.stringify(payment.details || {})]
          );
        }
        await connection.execute(
          `INSERT INTO customer_advance_entries
             (advance_receipt_id, customer_account_id, business_day_id, loc_code, mac_code, txn_date,
              document_type, document_no, entry_no, entry_type, amount, reason, created_by, metadata)
           VALUES (?, ?, ?, ?, ?, ?, 'customer_advance', ?, 1, 'receipt_credit', ?, ?, ?, CAST(? AS JSON))`,
          [result.insertId, customerAccountId, day.id, origin.locCode, origin.macCode, origin.txnDate,
            advanceNo, total, String(reason || '').trim(), userId, JSON.stringify({ advanceNumber, customerName: account.display_name })]
        );
        const cash = money(payments.filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + money(payment.amount), 0));
        await insertCashMovement(connection, { shift, movementType: 'customer_advance_cash', direction: 'in', amount: cash,
          referenceType: 'customer_advance', referenceId: result.insertId, reason: 'Customer advance received', userId,
          metadata: { advanceNumber, customerAccountId: Number(customerAccountId) } });
        await connection.commit();
        return { id: Number(result.insertId), advanceNumber, amount: total, availableBalance: await getBalance(customerAccountId, origin.locCode) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function allocateDebit(connection, { customerAccountId, locCode, amount, entry }) {
    let remaining = money(amount);
    const receipts = await receiptBalances(connection, { customerAccountId, locCode, lock: true });
    const allocations = [];
    for (const receipt of receipts) {
      if (remaining <= 0.005) break;
      const applied = money(Math.min(remaining, money(receipt.remaining_amount)));
      const [result] = await connection.execute(
        `INSERT INTO customer_advance_entries
           (advance_receipt_id, customer_account_id, business_day_id, loc_code, mac_code, txn_date,
            document_type, document_no, entry_no, invoice_id, refund_id, advance_refund_id,
            entry_type, amount, reason, created_by, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [receipt.id, customerAccountId, entry.businessDayId, entry.locCode, entry.macCode, entry.txnDate,
          entry.documentType, entry.documentNo, entry.entryNo + allocations.length, entry.invoiceId || null,
          entry.refundId || null, entry.advanceRefundId || null, entry.entryType, applied, entry.reason, entry.userId,
          JSON.stringify(entry.metadata || {})]
      );
      allocations.push({ receiptId: Number(receipt.id), entryId: Number(result.insertId), amount: applied });
      remaining = money(remaining - applied);
      if (money(receipt.remaining_amount) - applied <= 0.005) {
        await connection.execute(`UPDATE customer_advance_receipts SET status = ? WHERE id = ?`,
          [entry.entryType === 'refund_debit' ? 'refunded' : 'applied', receipt.id]);
      }
    }
    if (remaining > 0.005) throw new Error(`Available customer advance is only ${money(amount - remaining).toFixed(2)}.`);
    return allocations;
  }

  /**
   * Spend advance money against one invoice. Used both when a sale is finalized
   * and when an outstanding balance is settled later, so the document type and
   * reason are supplied by the caller.
   */
  async function applyToInvoiceWithConnection(connection, input) {
    if (money(input.amount) <= 0) return [];
    const documentType = String(input.documentType || 'sale');
    const allocations = await allocateDebit(connection, {
      customerAccountId: input.customerAccountId, locCode: input.locCode, amount: input.amount,
      entry: { businessDayId: input.businessDayId, locCode: input.locCode, macCode: input.macCode, txnDate: input.txnDate,
        documentType, documentNo: input.documentNo, entryNo: Number(input.paymentNo) * 1000,
        invoiceId: input.invoiceId, entryType: 'application_debit',
        reason: documentType === 'collection' ? 'Applied to an outstanding invoice balance' : 'Applied to finalized invoice',
        userId: input.userId,
        metadata: { invoiceNumber: input.invoiceNumber, paymentId: Number(input.paymentId), documentType } }
    });
    // A sale and a later collection both allocate against the same invoice, so
    // the allocation number continues from what the invoice already holds.
    const [existing] = await connection.execute(
      'SELECT COALESCE(MAX(allocation_no), 0) AS max_no FROM invoice_advance_allocations WHERE invoice_id = ?', [input.invoiceId]
    );
    let allocationNo = Number(existing[0]?.max_no || 0);
    for (const allocation of allocations) {
      allocationNo += 1;
      await connection.execute(
        `INSERT INTO invoice_advance_allocations
           (invoice_id, payment_id, advance_receipt_id, advance_entry_id, allocation_no,
            loc_code, mac_code, txn_date, amount, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.invoiceId, input.paymentId, allocation.receiptId, allocation.entryId, allocationNo,
          input.locCode, input.macCode, input.txnDate, allocation.amount, input.userId]
      );
    }
    return allocations;
  }

  async function restoreFromRefundWithConnection(connection, input) {
    let remaining = money(input.amount);
    let [allocations] = await connection.execute(
      `SELECT a.* FROM invoice_advance_allocations a
       JOIN customer_advance_receipts r ON r.id = a.advance_receipt_id
       WHERE a.invoice_id = ? AND a.loc_code = ? AND r.customer_account_id = ?
       ORDER BY a.allocation_no, a.id`,
      [Number(input.sourceInvoiceId), String(input.locCode || '').trim(), Number(input.customerAccountId)]
    );
    if (allocations.length) {
      const receiptIds = [...new Set(allocations.map((allocation) => Number(allocation.advance_receipt_id)))].sort((a, b) => a - b);
      await connection.execute(
        `SELECT id FROM customer_advance_receipts WHERE id IN (${receiptIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, receiptIds
      );
      const [lockedAllocations] = await connection.execute(
        `SELECT a.* FROM invoice_advance_allocations a
         JOIN customer_advance_receipts r ON r.id = a.advance_receipt_id
         WHERE a.invoice_id = ? AND a.loc_code = ? AND r.customer_account_id = ?
         ORDER BY a.allocation_no, a.id FOR UPDATE`,
        [Number(input.sourceInvoiceId), String(input.locCode || '').trim(), Number(input.customerAccountId)]
      );
      allocations = lockedAllocations;
      const placeholders = allocations.map(() => '?').join(',');
      const [restored] = await connection.execute(
        `SELECT invoice_advance_allocation_id, COALESCE(SUM(amount), 0) AS restored_amount
         FROM customer_advance_entries
         WHERE entry_type = 'restore_credit' AND invoice_advance_allocation_id IN (${placeholders})
         GROUP BY invoice_advance_allocation_id`, allocations.map((allocation) => allocation.id)
      );
      const restoredByAllocation = new Map(restored.map((row) => [Number(row.invoice_advance_allocation_id), money(row.restored_amount)]));
      for (const allocation of allocations) allocation.restored_amount = restoredByAllocation.get(Number(allocation.id)) || 0;
    }
    let entryNo = Number(input.paymentNo) * 1000;
    for (const allocation of allocations) {
      if (remaining <= 0.005) break;
      const available = money(Number(allocation.amount) - Number(allocation.restored_amount || 0));
      if (available <= 0.005) continue;
      const restored = money(Math.min(remaining, available));
      entryNo += 1;
      await connection.execute(
        `INSERT INTO customer_advance_entries
           (advance_receipt_id, customer_account_id, business_day_id, loc_code, mac_code, txn_date,
            document_type, document_no, entry_no, invoice_id, refund_id, invoice_advance_allocation_id,
            entry_type, amount, reason, created_by, metadata)
         VALUES (?, ?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, 'restore_credit', ?,
                 'Sale refund restored to customer advance', ?, CAST(? AS JSON))`,
        [allocation.advance_receipt_id, input.customerAccountId, input.businessDayId, input.locCode, input.macCode,
          input.txnDate, input.documentNo, entryNo, input.sourceInvoiceId, input.refundId, allocation.id,
          restored, input.userId, JSON.stringify({ refundNumber: input.refundNumber, sourceInvoiceId: Number(input.sourceInvoiceId) })]
      );
      await connection.execute(`UPDATE customer_advance_receipts SET status = 'active' WHERE id = ?`, [allocation.advance_receipt_id]);
      remaining = money(remaining - restored);
    }
    if (remaining > 0.005) {
      throw new Error(`Only ${money(input.amount - remaining).toFixed(2)} from the original invoice can be restored to customer advance.`);
    }
  }

  async function refundUnused({ customerAccountId, locCode, macCode, txnDate, cashShiftId, userId, amount, method, fundAccountId, providerRef, reason }) {
    const origin = { locCode: String(locCode || '').trim(), macCode: String(macCode || '').trim(), txnDate: dateOnly(txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await activeAccount(connection, customerAccountId);
        const day = await businessDayRepository.assertOpenWithConnection(connection, { locationCode: origin.locCode, businessDate: origin.txnDate });
        const shift = await openShift(connection, cashShiftId, origin);
        const refundAmount = money(amount);
        if (refundAmount <= 0) throw new Error('Refund amount must be greater than zero.');
        const refundNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'customer_advance_refund', ...origin });
        const refundNumber = `AVR-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(refundNo).padStart(6, '0')}`;
        const [result] = await connection.execute(
          `INSERT INTO customer_advance_refunds
             (business_day_id, customer_account_id, cash_shift_id, loc_code, mac_code, txn_date,
              refund_no, refund_number, method, fund_account_id, amount, provider_ref, reason, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [day.id, customerAccountId, shift.id, origin.locCode, origin.macCode, origin.txnDate,
            refundNo, refundNumber, method, Number(fundAccountId) || null, refundAmount, providerRef || null, String(reason || '').trim(), userId]
        );
        await allocateDebit(connection, { customerAccountId, locCode: origin.locCode, amount: refundAmount,
          entry: { businessDayId: day.id, ...origin, documentType: 'customer_advance_refund', documentNo: refundNo,
            entryNo: 1, advanceRefundId: result.insertId, entryType: 'refund_debit', reason: String(reason || '').trim(),
            userId, metadata: { refundNumber, method, providerRef: providerRef || null } } });
        await insertCashMovement(connection, { shift, movementType: 'customer_advance_refund_cash', direction: 'out',
          amount: method === 'cash' ? refundAmount : 0, referenceType: 'customer_advance_refund', referenceId: result.insertId,
          reason: String(reason || '').trim(), userId, metadata: { refundNumber, customerAccountId: Number(customerAccountId) } });
        await connection.commit();
        return { id: Number(result.insertId), refundNumber, amount: refundAmount, availableBalance: await getBalance(customerAccountId, origin.locCode) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  return { getBalance, getSummary, receive, refundUnused, applyToInvoiceWithConnection, restoreFromRefundWithConnection };
}

module.exports = { createCustomerAdvanceRepository };
