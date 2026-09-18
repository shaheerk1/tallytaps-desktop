function createIssuedChequeRepository({ database, documentSequenceRepository, businessDayRepository }) {
  if (!database || !documentSequenceRepository || !businessDayRepository) {
    throw new Error('Issued cheque repository requires database, document sequence, and business-day repositories.');
  }

  // Supplier accounts are built after this repository; the container hands in
  // the step that reverses a supplier payment whose cheque did not clear.
  let supplierAccounts = null;
  function setSupplierAccountHooks(hooks) { supplierAccounts = hooks || null; }

  function text(value, maxLength = 255) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  function money(value) {
    const normalized = Math.round(Number(value || 0) * 100) / 100;
    if (!Number.isFinite(normalized) || normalized <= 0) throw new Error('Enter a positive cheque amount.');
    return normalized;
  }

  function requireOrigin(originValue) {
    const locCode = text(originValue?.locCode || originValue?.locationCode, 50);
    const macCode = text(originValue?.macCode || originValue?.machineCode, 50);
    const txnDate = text(originValue?.txnDate || originValue?.billingDate || originValue?.businessDate, 10);
    if (!locCode || !macCode || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate || '')) {
      throw new Error('The current workstation origin and business date are required.');
    }
    return { locCode, macCode, txnDate };
  }

  function masterCode(origin, number) {
    const segment = (value) => String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || 'POS';
    return `BA-${segment(origin.locCode)}-${segment(origin.macCode)}-${String(number).padStart(4, '0')}`;
  }

  async function allocateBankAccountNumber(connection, origin) {
    await connection.execute(
      `INSERT IGNORE INTO master_record_sequences (record_type, loc_code, mac_code, next_number)
       VALUES ('business_bank_account', ?, ?, 1)`, [origin.locCode, origin.macCode]
    );
    const [rows] = await connection.execute(
      `SELECT next_number FROM master_record_sequences
       WHERE record_type = 'business_bank_account' AND loc_code = ? AND mac_code = ? FOR UPDATE`,
      [origin.locCode, origin.macCode]
    );
    const number = Number(rows[0]?.next_number || 1);
    await connection.execute(
      `UPDATE master_record_sequences SET next_number = next_number + 1
       WHERE record_type = 'business_bank_account' AND loc_code = ? AND mac_code = ?`,
      [origin.locCode, origin.macCode]
    );
    return number;
  }

  async function listBankAccounts(includeInactive = false) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT * FROM business_bank_accounts
         WHERE (? = 1 OR is_active = 1)
         ORDER BY is_active DESC, bank_name, account_name, id`, [includeInactive ? 1 : 0]
      );
      return rows.map((row) => ({ ...row, is_active: Boolean(row.is_active) }));
    });
  }

  async function saveBankAccount(payload = {}) {
    const bankName = text(payload.bankName, 160);
    const accountName = text(payload.accountName, 190);
    const accountNumber = text(payload.accountNumber, 100);
    if (!bankName || !accountName || !accountNumber) throw new Error('Bank, account name, and account number are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const id = Number(payload.id || 0);
        if (id) {
          const [[existing]] = await connection.execute('SELECT fund_account_id, loc_code FROM business_bank_accounts WHERE id = ? FOR UPDATE', [id]);
          if (!existing) throw new Error('Business bank account was not found.');
          const [result] = await connection.execute(
            `UPDATE business_bank_accounts
             SET bank_name = ?, branch_name = ?, account_name = ?, account_number = ?, is_active = ?, notes = ?
             WHERE id = ?`,
            [bankName, text(payload.branchName, 160), accountName, accountNumber,
              payload.isActive === false ? 0 : 1, text(payload.notes, 500), id]
          );
          if (!result.affectedRows) throw new Error('Business bank account was not found.');
          await connection.execute(
            `UPDATE fund_accounts SET name = ?, account_reference = ?, is_active = ?, notes = ?
             WHERE id = ?`,
            [`${bankName} · ${accountName}`, accountNumber, payload.isActive === false ? 0 : 1,
              text(payload.notes, 500), existing.fund_account_id]
          );
          await connection.commit();
          return (await listBankAccounts(true)).find((row) => Number(row.id) === id) || null;
        }
        const origin = requireOrigin(payload.origin);
        const accountNo = await allocateBankAccountNumber(connection, origin);
        const accountCode = masterCode(origin, accountNo);
        const [fund] = await connection.execute(
          `INSERT INTO fund_accounts
             (fund_code, name, fund_kind, loc_code, account_reference, opening_balance, is_active, sort_order, notes)
           VALUES (?, ?, 'bank', ?, ?, 0, ?, 40, ?)`,
          [`BANK-${accountCode}`, `${bankName} · ${accountName}`, origin.locCode, accountNumber,
            payload.isActive === false ? 0 : 1, text(payload.notes, 500)]
        );
        const [result] = await connection.execute(
          `INSERT INTO business_bank_accounts
             (loc_code, mac_code, account_no, fund_account_id, account_code, bank_name, branch_name, account_name,
              account_number, is_active, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [origin.locCode, origin.macCode, accountNo, fund.insertId, accountCode, bankName,
            text(payload.branchName, 160), accountName, accountNumber, payload.isActive === false ? 0 : 1,
            text(payload.notes, 500), payload.userId || null]
        );
        await connection.commit();
        return (await listBankAccounts(true)).find((row) => Number(row.id) === Number(result.insertId)) || null;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function insertEventWithConnection(connection, cheque, fromStatus, toStatus, reason, details, userId, origin) {
    const [numbers] = await connection.execute(
      `SELECT COALESCE(MAX(event_no), 0) AS max_no FROM issued_cheque_status_events
       WHERE issued_cheque_id = ? FOR UPDATE`, [cheque.id]
    );
    await connection.execute(
      `INSERT INTO issued_cheque_status_events
         (issued_cheque_id, event_no, loc_code, mac_code, txn_date, from_status, to_status, reason, details, changed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
      [cheque.id, Number(numbers[0]?.max_no || 0) + 1, origin.locCode, origin.macCode, origin.txnDate,
        fromStatus || null, toStatus, text(reason, 255), JSON.stringify(details || {}), userId || null]
    );
  }

  async function validateBankAccountWithConnection(connection, bankAccountId, locCode) {
    const [rows] = await connection.execute(
      `SELECT * FROM business_bank_accounts WHERE id = ? AND loc_code = ? AND is_active = 1 FOR UPDATE`, [bankAccountId, locCode]
    );
    if (!rows.length) throw new Error('Select an active business bank account.');
    return rows[0];
  }

  async function createWithConnection(connection, payload, context = {}) {
    const origin = requireOrigin(payload.origin);
    const amount = money(payload.amount);
    const chequeNumber = text(payload.chequeNumber, 80);
    const chequeDate = text(payload.chequeDate, 10);
    const payeeName = text(payload.payeeName, 190);
    if (!chequeNumber || !/^\d{4}-\d{2}-\d{2}$/.test(chequeDate || '') || !payeeName) {
      throw new Error('Cheque number, cheque date, and payee are required.');
    }
    await validateBankAccountWithConnection(connection, Number(payload.bankAccountId), origin.locCode);
    const businessDay = context.businessDay || await businessDayRepository.assertOpenWithConnection(connection, {
      locationCode: origin.locCode, businessDate: origin.txnDate
    });
    if (payload.payeePartyId) {
      const [parties] = await connection.execute(`SELECT id FROM parties WHERE id = ? AND status = 'active'`, [payload.payeePartyId]);
      if (!parties.length) throw new Error('The selected payee party is not active.');
    }
    const documentNo = await documentSequenceRepository.allocateWithConnection(connection, {
      documentType: 'issued_cheque', ...origin
    });
    const status = payload.status === 'prepared' ? 'prepared' : 'issued';
    const [result] = await connection.execute(
      `INSERT INTO issued_cheques
         (business_day_id, loc_code, mac_code, txn_date, document_no, bank_account_id,
          supplier_payment_id, supplier_settlement_id, supplier_id, payee_party_id, payee_name_snapshot,
          cheque_number, cheque_date, amount, purpose, status, reference, notes, issued_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'issued' THEN NOW() ELSE NULL END, ?)`,
      [businessDay.id, origin.locCode, origin.macCode, origin.txnDate, documentNo, Number(payload.bankAccountId),
        context.supplierPaymentId || null, context.supplierSettlementId || null, context.supplierId || null,
        payload.payeePartyId || null, payeeName, chequeNumber, chequeDate, amount,
        context.purpose || (context.supplierPaymentId ? 'supplier_settlement' : 'other'), status, text(payload.reference, 190),
        text(payload.notes, 500), status, payload.userId || null]
    );
    const cheque = { id: Number(result.insertId) };
    await insertEventWithConnection(connection, cheque, null, status,
      context.purpose === 'supplier_account' ? 'Issued as a supplier account payment'
        : context.supplierPaymentId ? 'Issued for supplier settlement payment' : 'Issued cheque recorded',
      { supplierPaymentId: context.supplierPaymentId || null }, payload.userId, origin);
    return { id: cheque.id, documentNo, status };
  }

  async function createIssuedCheque(payload = {}) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const result = await createWithConnection(connection, payload);
        await connection.commit();
        return getIssuedCheque(result.id);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function listIssuedCheques(filters = {}) {
    return database.withConnection(async (connection) => {
      const term = String(filters.term || '').trim();
      const like = `%${term}%`;
      const status = text(filters.status, 30);
      const fromDate = text(filters.fromDate, 10);
      const toDate = text(filters.toDate, 10);
      const [rows] = await connection.execute(
        `SELECT c.*, ba.account_code, ba.bank_name, ba.branch_name, ba.account_name, ba.account_number,
                s.supplier_code, s.name AS supplier_name, st.settlement_number, p.display_name AS payee_party_name
         FROM issued_cheques c
         JOIN business_bank_accounts ba ON ba.id = c.bank_account_id
         LEFT JOIN suppliers s ON s.id = c.supplier_id
         LEFT JOIN supplier_settlements st ON st.id = c.supplier_settlement_id
         LEFT JOIN parties p ON p.id = c.payee_party_id
         WHERE (? = '' OR c.cheque_number LIKE ? OR c.payee_name_snapshot LIKE ? OR ba.bank_name LIKE ?
                OR ba.account_number LIKE ? OR s.supplier_code LIKE ? OR s.name LIKE ? OR c.reference LIKE ?)
           AND (? IS NULL OR c.status = ?)
           AND (? IS NULL OR c.cheque_date >= ?)
           AND (? IS NULL OR c.cheque_date <= ?)
         ORDER BY CASE c.status WHEN 'prepared' THEN 1 WHEN 'issued' THEN 2 ELSE 3 END,
                  c.cheque_date, c.id DESC LIMIT 250`,
        [term, like, like, like, like, like, like, like, status, status, fromDate, fromDate, toDate, toDate]
      );
      return rows.map((row) => ({ ...row, amount: Number(row.amount || 0) }));
    });
  }

  async function getIssuedCheque(chequeId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT c.*, ba.account_code, ba.bank_name, ba.branch_name, ba.account_name, ba.account_number,
                s.supplier_code, s.name AS supplier_name, st.settlement_number, p.display_name AS payee_party_name
         FROM issued_cheques c
         JOIN business_bank_accounts ba ON ba.id = c.bank_account_id
         LEFT JOIN suppliers s ON s.id = c.supplier_id
         LEFT JOIN supplier_settlements st ON st.id = c.supplier_settlement_id
         LEFT JOIN parties p ON p.id = c.payee_party_id
         WHERE c.id = ? LIMIT 1`, [chequeId]
      );
      if (!rows.length) return null;
      const [events] = await connection.execute(
        `SELECT e.*, u.display_name AS user_name FROM issued_cheque_status_events e
         LEFT JOIN users u ON u.id = e.changed_by
         WHERE e.issued_cheque_id = ? ORDER BY e.event_no DESC`, [chequeId]
      );
      return { cheque: { ...rows[0], amount: Number(rows[0].amount || 0) }, events };
    });
  }

  async function reverseSupplierPaymentWithConnection(connection, cheque, reason, userId, origin) {
    if (!cheque.supplier_payment_id) return false;
    const [paymentRows] = await connection.execute(
      `SELECT p.*, st.supplier_id, st.total_due, st.paid_total
       FROM supplier_payments p JOIN supplier_settlements st ON st.id = p.supplier_settlement_id
       WHERE p.id = ? FOR UPDATE`, [cheque.supplier_payment_id]
    );
    if (!paymentRows.length || paymentRows[0].status === 'reversed') return false;
    const payment = paymentRows[0];
    await connection.execute(
      `UPDATE supplier_payments SET status = 'reversed', reversed_at = NOW(), reversal_reason = ? WHERE id = ?`,
      [text(reason, 255), payment.id]
    );
    const nextPaid = Math.max(0, Math.round((Number(payment.paid_total || 0) - Number(payment.amount || 0)) * 100) / 100);
    await connection.execute(
      `UPDATE supplier_settlements SET paid_total = ?, status = CASE WHEN ? > 0.005 THEN 'partially_paid' ELSE 'approved' END WHERE id = ?`,
      [nextPaid, nextPaid, payment.supplier_settlement_id]
    );
    await connection.execute(
      `INSERT INTO supplier_payable_entries
         (supplier_id, loc_code, mac_code, entry_type, amount, business_date, document_type,
          document_no, line_no, entry_no, reason, created_by, metadata)
       VALUES (?, ?, ?, 'adjustment', ?, ?, 'issued_cheque_return', ?, 1, 1, ?, ?, CAST(? AS JSON))`,
      [payment.supplier_id, origin.locCode, origin.macCode, Number(payment.amount), origin.txnDate,
        cheque.document_no, text(reason, 255) || 'Issued cheque did not clear', userId || null,
        JSON.stringify({ issuedChequeId: Number(cheque.id), supplierPaymentId: Number(payment.id), reversal: true })]
    );
    return true;
  }

  async function updateIssuedChequeStatus(payload = {}) {
    const origin = requireOrigin(payload.origin);
    const nextStatus = String(payload.status || '').trim().toLowerCase();
    const transitions = {
      prepared: new Set(['issued', 'cancelled']),
      issued: new Set(['cleared', 'cancelled', 'stopped', 'returned_unpaid']),
      cleared: new Set(), cancelled: new Set(), stopped: new Set(), returned_unpaid: new Set()
    };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute(`SELECT * FROM issued_cheques WHERE id = ? FOR UPDATE`, [payload.chequeId]);
        if (!rows.length) throw new Error('Issued cheque was not found.');
        const cheque = rows[0];
        if (!transitions[cheque.status]?.has(nextStatus)) throw new Error(`Issued cheque cannot move from ${cheque.status} to ${nextStatus}.`);
        const terminal = ['cancelled', 'stopped', 'returned_unpaid'].includes(nextStatus);
        if (terminal && !text(payload.reason, 255)) throw new Error('Enter a reason for this cheque outcome.');
        await businessDayRepository.assertOpenWithConnection(connection, { locationCode: origin.locCode, businessDate: origin.txnDate });
        let reversed = terminal
          ? await reverseSupplierPaymentWithConnection(connection, cheque, payload.reason, payload.userId, origin)
          : false;
        // A cheque paid on a supplier account that will not clear: the supplier is owed it again.
        if (terminal && cheque.supplier_account_entry_id) {
          if (!supplierAccounts) throw new Error('Supplier accounts are not available to reverse this payment.');
          const undone = await supplierAccounts.reverseForChequeOutcomeWithConnection(connection, {
            entryId: cheque.supplier_account_entry_id, outcome: nextStatus.replace(/_/g, ' '), origin, userId: payload.userId
          });
          reversed = reversed || Boolean(undone);
        }
        await connection.execute(
          `UPDATE issued_cheques SET status = ?,
             issued_at = CASE WHEN ? = 'issued' THEN COALESCE(issued_at, NOW()) ELSE issued_at END,
             cleared_at = CASE WHEN ? = 'cleared' THEN NOW() ELSE cleared_at END,
             closed_at = CASE WHEN ? IN ('cancelled','stopped','returned_unpaid') THEN NOW() ELSE closed_at END
           WHERE id = ?`, [nextStatus, nextStatus, nextStatus, nextStatus, cheque.id]
        );
        await insertEventWithConnection(connection, cheque, cheque.status, nextStatus, payload.reason,
          { supplierPaymentReversed: reversed }, payload.userId, origin);
        await connection.commit();
        return getIssuedCheque(cheque.id);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    listBankAccounts,
    saveBankAccount,
    setSupplierAccountHooks,
    createWithConnection,
    createIssuedCheque,
    listIssuedCheques,
    getIssuedCheque,
    updateIssuedChequeStatus
  };
}

module.exports = { createIssuedChequeRepository };
