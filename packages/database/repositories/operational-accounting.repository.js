/**
 * Idempotent bridge from the mature POS subledgers into the general journal.
 *
 * Billing, refunds, receivables, advances, supplier settlement, and cheque
 * registers stay authoritative.  This bridge never changes them; it posts one
 * deterministic journal entry per source event and can therefore backfill old
 * installations safely or be rerun after an interrupted launch.
 */
const rules = require('../../core/accounting/posting-rules');

function createOperationalAccountingRepository({ database, journalRepository }) {
  if (!database || !journalRepository) throw new Error('Operational accounting requires the database and journal.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const text = (value) => String(value || '').trim();
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);
  const json = (value) => {
    if (!value || typeof value === 'object') return value || {};
    try { return JSON.parse(value); } catch { return {}; }
  };

  function fundAssetCode(kind) {
    if (kind === 'pos_drawer') return rules.ACCOUNTS.CASH_TILL;
    if (kind === 'cash_safe') return rules.ACCOUNTS.CASH_SAFE;
    return rules.ACCOUNTS.BANK;
  }

  async function ensureFundMovement(connection, row, { fundAccountId, direction, sourceType, sourceId, reason, userId }) {
    if (!Number(fundAccountId)) return null;
    const [existing] = await connection.execute(
      'SELECT id FROM fund_movements WHERE source_type = ? AND source_id = ? LIMIT 1',
      [sourceType, String(sourceId)]
    );
    if (existing[0]) return Number(existing[0].id);
    const [result] = await connection.execute(
      `INSERT INTO fund_movements
         (fund_account_id, business_day_id, loc_code, mac_code, txn_date,
          document_type, document_no, entry_no, direction, amount,
          source_type, source_id, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [Number(fundAccountId), Number(row.business_day_id), row.loc_code, row.mac_code, dateOnly(row.txn_date),
        sourceType.slice(0, 40), Number(row.id), direction, money(row.amount), sourceType, String(sourceId), reason,
        Number(row.source_user_id || userId), JSON.stringify({ derivedBy: 'operational-accounting' })]
    );
    return Number(result.insertId);
  }

  async function post(connection, row, { sourceType, sourceId, documentType, documentNo, posting, userId, metadata = {} }) {
    if (!posting || !posting.lines?.length) return false;
    await journalRepository.postWithConnection(connection, {
      businessDayId: Number(row.business_day_id),
      locCode: row.loc_code,
      macCode: row.mac_code,
      txnDate: row.txn_date,
      documentType,
      documentNo: Number(documentNo),
      sourceType,
      sourceId: String(sourceId),
      posting,
      userId: Number(row.source_user_id || userId),
      metadata
    });
    return true;
  }

  async function syncInvoices(connection, locCode, userId) {
    const [rows] = await connection.execute(
      `SELECT i.*, i.user_id AS source_user_id
       FROM invoices i
       LEFT JOIN journal_entries j ON j.source_type = 'invoice_sale' AND j.source_id = CAST(i.id AS CHAR)
       WHERE i.loc_code = ? AND i.status IN ('paid','partial') AND i.inv_stat = 'active' AND j.id IS NULL
       ORDER BY i.txn_date, i.id FOR UPDATE`, [locCode]
    );
    let posted = 0;
    for (const row of rows) {
      posted += await post(connection, row, {
        sourceType: 'invoice_sale', sourceId: row.id, documentType: 'sale', documentNo: row.receipt_no,
        posting: rules.invoiceSalePosting({ invoice: {
          invoiceNumber: row.invoice_number, grandTotal: row.grand_total,
          bagChargeTotal: row.bag_charge_total, wageChargeTotal: row.wage_charge_total
        } }), userId, metadata: { invoiceId: Number(row.id), customerAccountId: row.customer_account_id && Number(row.customer_account_id) }
      });
    }
    return posted;
  }

  async function syncManualCash(connection, locCode, userId) {
    const [movements] = await connection.execute(
      `SELECT m.*, s.business_day_id, m.created_by AS source_user_id,
              (SELECT e.before_state FROM cash_movement_events e WHERE e.cash_movement_id = m.id ORDER BY e.event_no LIMIT 1) AS original_state
       FROM cash_movements m
       JOIN cash_shifts s ON s.id = m.cash_shift_id
       LEFT JOIN journal_entries j ON j.source_type = 'manual_cash_movement' AND j.source_id = CAST(m.id AS CHAR)
       WHERE m.loc_code = ? AND m.reference_type IS NULL
         AND m.movement_type IN ('cash_in','cash_out','safe_drop','bank_drop') AND j.id IS NULL
       ORDER BY m.business_date, m.id FOR UPDATE`, [locCode]
    );
    let posted = 0;
    for (const row of movements) {
      const original = row.original_state ? json(row.original_state) : { direction: row.direction, amount: row.amount };
      posted += await post(connection, { ...row, txn_date: row.business_date }, {
        sourceType: 'manual_cash_movement', sourceId: row.id, documentType: 'cash_movement', documentNo: row.movement_no,
        posting: rules.manualCashMovementPosting({ movement: { ...original, reason: row.reason } }), userId,
        metadata: { cashMovementId: Number(row.id), movementType: row.movement_type }
      });
    }

    const [events] = await connection.execute(
      `SELECT e.*, m.business_date AS txn_date, m.loc_code, m.mac_code, m.movement_no, m.reason,
              s.business_day_id, e.created_by AS source_user_id
       FROM cash_movement_events e
       JOIN cash_movements m ON m.id = e.cash_movement_id
       JOIN cash_shifts s ON s.id = m.cash_shift_id
       LEFT JOIN journal_entries j ON j.source_type = 'manual_cash_movement_event' AND j.source_id = CAST(e.id AS CHAR)
       WHERE m.loc_code = ? AND m.reference_type IS NULL
         AND m.movement_type IN ('cash_in','cash_out','safe_drop','bank_drop') AND j.id IS NULL
       ORDER BY m.business_date, m.id, e.event_no FOR UPDATE`, [locCode]
    );
    for (const row of events) {
      const before = json(row.before_state);
      const after = json(row.after_state);
      posted += await post(connection, row, {
        sourceType: 'manual_cash_movement_event', sourceId: row.id,
        documentType: 'cash_movement_correction', documentNo: row.movement_no,
        posting: rules.manualCashMovementPosting({
          movement: { reason: row.reason }, before, after,
          voided: row.action === 'voided'
        }), userId,
        metadata: { cashMovementId: Number(row.cash_movement_id), eventNo: Number(row.event_no), action: row.action }
      });
    }
    return posted;
  }

  async function syncCustomerPayments(connection, locCode, userId) {
    const [rows] = await connection.execute(
      `SELECT p.*, i.invoice_number, i.change_amt, i.customer_account_id,
              COALESCE(p.business_day_id, i.business_day_id) AS business_day_id,
              COALESCE(i.user_id, ?) AS source_user_id, f.fund_kind
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN payment_modes pm ON pm.mode_key = p.method
       LEFT JOIN fund_accounts f ON f.id = p.fund_account_id
       LEFT JOIN journal_entries j ON j.source_type = 'customer_payment' AND j.source_id = CAST(p.id AS CHAR)
       WHERE p.loc_code = ? AND p.status = 'completed' AND COALESCE(pm.mode_type, 'tender') <> 'credit' AND j.id IS NULL
       ORDER BY p.invoice_id, p.document_type, p.payment_no, p.id FOR UPDATE`, [userId, locCode]
    );
    const saleChange = new Map();
    let posted = 0;
    for (const row of rows) {
      const invoiceId = Number(row.invoice_id);
      if (!saleChange.has(invoiceId)) saleChange.set(invoiceId, money(row.change_amt));
      let amount = money(row.amount);
      if (row.document_type === 'sale' && row.method === 'cash') {
        const change = saleChange.get(invoiceId) || 0;
        const deducted = Math.min(change, amount);
        amount = money(amount - deducted);
        saleChange.set(invoiceId, money(change - deducted));
      }
      if (amount <= 0) continue;
      const payment = {
        method: row.method, amount, fundAccountId: row.fund_account_id && Number(row.fund_account_id),
        assetAccountCode: row.fund_account_id ? fundAssetCode(row.fund_kind) : null,
        reference: row.invoice_number
      };
      if (payment.fundAccountId && row.method !== 'advance') {
        await ensureFundMovement(connection, { ...row, amount }, {
          fundAccountId: payment.fundAccountId, direction: 'in', sourceType: 'customer_payment', sourceId: row.id,
          reason: `Customer payment for ${row.invoice_number}`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'customer_payment', sourceId: row.id,
        documentType: row.document_type || 'sale', documentNo: row.document_no,
        posting: rules.customerPaymentPosting({ payment, amount }), userId,
        metadata: { paymentId: Number(row.id), invoiceId, method: row.method, grossTender: money(row.amount), netSettlement: amount }
      });
    }
    return posted;
  }

  async function syncRefunds(connection, locCode, userId) {
    const [rows] = await connection.execute(
      `SELECT r.*, r.user_id AS source_user_id
       FROM refunds r
       LEFT JOIN journal_entries j ON j.source_type = 'sale_refund' AND j.source_id = CAST(r.id AS CHAR)
       WHERE r.loc_code = ? AND r.status = 'completed' AND j.id IS NULL
       ORDER BY r.txn_date, r.id FOR UPDATE`, [locCode]
    );
    let posted = 0;
    for (const row of rows) {
      posted += await post(connection, row, {
        sourceType: 'sale_refund', sourceId: row.id, documentType: 'refund', documentNo: row.refund_no,
        posting: rules.refundPosting({ refund: { refundNumber: row.refund_number, grandTotal: row.grand_total } }),
        userId, metadata: { refundId: Number(row.id), sourceInvoiceId: Number(row.source_invoice_id) }
      });
    }

    const [payments] = await connection.execute(
      `SELECT p.*, r.business_day_id, r.user_id AS source_user_id, r.refund_number, r.source_invoice_id,
              f.fund_kind
       FROM refund_payments p
       JOIN refunds r ON r.id = p.refund_id
       LEFT JOIN fund_accounts f ON f.id = p.fund_account_id
       LEFT JOIN journal_entries j ON j.source_type = 'refund_payment' AND j.source_id = CAST(p.id AS CHAR)
       WHERE p.loc_code = ? AND p.status = 'completed' AND j.id IS NULL
       ORDER BY p.txn_date, p.id FOR UPDATE`, [locCode]
    );
    for (const row of payments) {
      const payment = {
        method: row.method, amount: row.amount, fundAccountId: row.fund_account_id && Number(row.fund_account_id),
        assetAccountCode: row.fund_account_id ? fundAssetCode(row.fund_kind) : (row.method === 'cheque' ? rules.ACCOUNTS.BANK : null),
        reference: row.refund_number
      };
      if (payment.fundAccountId && row.method !== 'advance') {
        await ensureFundMovement(connection, row, {
          fundAccountId: payment.fundAccountId, direction: 'out', sourceType: 'refund_payment', sourceId: row.id,
          reason: `Refund payment ${row.refund_number}`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'refund_payment', sourceId: row.id, documentType: 'refund', documentNo: row.refund_no,
        posting: rules.customerPaymentPosting({ payment, refund: true }), userId,
        metadata: { refundId: Number(row.refund_id), sourceInvoiceId: Number(row.source_invoice_id), method: row.method }
      });
    }
    return posted;
  }

  async function syncCustomerAdvances(connection, locCode, userId) {
    const [payments] = await connection.execute(
      `SELECT p.*, r.business_day_id, r.loc_code, r.mac_code, r.txn_date, r.advance_no,
              r.advance_number, r.created_by AS source_user_id, f.fund_kind
       FROM customer_advance_payments p
       JOIN customer_advance_receipts r ON r.id = p.advance_receipt_id
       LEFT JOIN fund_accounts f ON f.id = p.fund_account_id
       LEFT JOIN journal_entries j ON j.source_type = 'advance_receipt_payment' AND j.source_id = CAST(p.id AS CHAR)
       WHERE r.loc_code = ? AND p.status = 'completed' AND r.status <> 'void' AND j.id IS NULL
       ORDER BY r.txn_date, p.id FOR UPDATE`, [locCode]
    );
    let posted = 0;
    for (const row of payments) {
      const payment = {
        method: row.method, amount: row.amount, fundAccountId: row.fund_account_id && Number(row.fund_account_id),
        assetAccountCode: row.fund_account_id ? fundAssetCode(row.fund_kind) : null
      };
      if (payment.fundAccountId) {
        await ensureFundMovement(connection, row, {
          fundAccountId: payment.fundAccountId, direction: 'in', sourceType: 'advance_receipt_payment', sourceId: row.id,
          reason: `Customer advance ${row.advance_number}`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'advance_receipt_payment', sourceId: row.id, documentType: 'customer_advance', documentNo: row.advance_no,
        posting: rules.customerAdvanceReceiptPosting({ receipt: { advanceNumber: row.advance_number }, payment }),
        userId, metadata: { advanceReceiptId: Number(row.advance_receipt_id), method: row.method }
      });
    }

    const [refunds] = await connection.execute(
      `SELECT r.*, r.created_by AS source_user_id, f.fund_kind
       FROM customer_advance_refunds r
       LEFT JOIN fund_accounts f ON f.id = r.fund_account_id
       LEFT JOIN journal_entries j ON j.source_type = 'advance_refund' AND j.source_id = CAST(r.id AS CHAR)
       WHERE r.loc_code = ? AND j.id IS NULL ORDER BY r.txn_date, r.id FOR UPDATE`, [locCode]
    );
    for (const row of refunds) {
      const refund = {
        method: row.method, amount: row.amount, refundNumber: row.refund_number,
        fundAccountId: row.fund_account_id && Number(row.fund_account_id),
        assetAccountCode: row.fund_account_id ? fundAssetCode(row.fund_kind) : (row.method === 'cheque' ? rules.ACCOUNTS.BANK : null)
      };
      if (refund.fundAccountId) {
        await ensureFundMovement(connection, row, {
          fundAccountId: refund.fundAccountId, direction: 'out', sourceType: 'advance_refund', sourceId: row.id,
          reason: `Customer advance refund ${row.refund_number}`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'advance_refund', sourceId: row.id, documentType: 'customer_advance_refund', documentNo: row.refund_no,
        posting: rules.customerAdvanceRefundPosting({ refund }), userId,
        metadata: { customerAccountId: Number(row.customer_account_id), method: row.method }
      });
    }
    return posted;
  }

  async function syncSupplierLedger(connection, locCode, userId) {
    const [obligations] = await connection.execute(
      `SELECT e.*, COALESCE(g.business_day_id, b.id) AS business_day_id,
              e.business_date AS txn_date, e.created_by AS source_user_id, l.ownership_model
       FROM supplier_payable_entries e
       LEFT JOIN goods_receipts g ON g.id = e.goods_receipt_id
       LEFT JOIN business_days b ON b.loc_code = e.loc_code AND b.business_date = e.business_date
       LEFT JOIN inventory_lots l ON l.id = e.inventory_lot_id
       LEFT JOIN journal_entries j ON j.source_type IN ('supplier_obligation','supplier_payment_reversal') AND j.source_id = CAST(e.id AS CHAR)
       WHERE e.loc_code = ? AND e.entry_type <> 'payment_credit' AND j.id IS NULL
         AND COALESCE(g.business_day_id, b.id) IS NOT NULL
       ORDER BY e.business_date, e.id FOR UPDATE`, [locCode]
    );
    let posted = 0;
    for (const row of obligations) {
      const metadata = json(row.metadata);
      if (metadata.reversal && metadata.supplierPaymentId) {
        const [[paymentRow]] = await connection.execute(
          'SELECT method, amount, fund_account_id FROM supplier_payments WHERE id = ?',
          [Number(metadata.supplierPaymentId)]
        );
        if (paymentRow) {
          posted += await post(connection, row, {
            sourceType: 'supplier_payment_reversal', sourceId: row.id,
            documentType: row.document_type, documentNo: row.document_no,
            posting: rules.supplierPaymentPosting({ payment: paymentRow, reversal: true }), userId,
            metadata: { ...metadata, supplierPayableEntryId: Number(row.id) }
          });
        }
        continue;
      }
      const obligation = {
        entryType: row.ownership_model === 'consignment' ? 'consignment_accrual' : row.entry_type,
        amount: money(row.amount), inventoryLotId: row.inventory_lot_id && Number(row.inventory_lot_id), reason: row.reason
      };
      posted += await post(connection, row, {
        sourceType: 'supplier_obligation', sourceId: row.id,
        documentType: row.document_type, documentNo: row.document_no,
        posting: rules.supplierObligationPosting({ obligation }), userId,
        metadata: { supplierId: Number(row.supplier_id), entryType: row.entry_type, goodsReceiptId: row.goods_receipt_id && Number(row.goods_receipt_id) }
      });
    }

    const [payments] = await connection.execute(
      `SELECT p.*, p.paid_by AS source_user_id, f.fund_kind
       FROM supplier_payments p
       LEFT JOIN fund_accounts f ON f.id = p.fund_account_id
       LEFT JOIN journal_entries j ON j.source_type = 'supplier_payment' AND j.source_id = CAST(p.id AS CHAR)
       WHERE p.loc_code = ? AND j.id IS NULL ORDER BY p.txn_date, p.id FOR UPDATE`, [locCode]
    );
    for (const row of payments) {
      const payment = {
        method: row.method, amount: row.amount, fundAccountId: row.fund_account_id && Number(row.fund_account_id),
        assetAccountCode: row.fund_account_id ? fundAssetCode(row.fund_kind) : null
      };
      if (payment.fundAccountId) {
        await ensureFundMovement(connection, row, {
          fundAccountId: payment.fundAccountId, direction: 'out', sourceType: 'supplier_payment', sourceId: row.id,
          reason: `Supplier settlement payment #${row.payment_no}`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'supplier_payment', sourceId: row.id, documentType: 'supplier_payment', documentNo: row.payment_no,
        posting: rules.supplierPaymentPosting({ payment }), userId,
        metadata: { supplierSettlementId: Number(row.supplier_settlement_id), method: row.method, status: row.status }
      });
    }
    return posted;
  }

  async function syncChequeEvents(connection, locCode, userId) {
    const [incoming] = await connection.execute(
      `SELECT e.*, c.amount, c.cheque_number, c.deposited_fund_account_id AS fund_account_id,
              c.created_by AS source_user_id, b.id AS business_day_id
       FROM cheque_status_events e
       JOIN cheques c ON c.id = e.cheque_id
       JOIN business_days b ON b.loc_code = e.loc_code AND b.business_date = e.txn_date
       LEFT JOIN journal_entries j ON j.source_type = 'incoming_cheque_status' AND j.source_id = CAST(e.id AS CHAR)
       WHERE e.loc_code = ? AND e.to_status IN ('cleared','dishonoured','returned','cancelled') AND j.id IS NULL
       ORDER BY e.txn_date, e.id FOR UPDATE`, [locCode]
    );
    let posted = 0;
    for (const row of incoming) {
      if (row.to_status === 'cleared' && row.fund_account_id) {
        await ensureFundMovement(connection, row, {
          fundAccountId: row.fund_account_id, direction: 'in', sourceType: 'incoming_cheque_clearance', sourceId: row.id,
          reason: `Incoming cheque ${row.cheque_number} cleared`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'incoming_cheque_status', sourceId: row.id, documentType: 'incoming_cheque', documentNo: row.cheque_id,
        posting: rules.incomingChequeStatusPosting({
          cheque: { amount: row.amount, chequeNumber: row.cheque_number, fundAccountId: row.fund_account_id && Number(row.fund_account_id) },
          status: row.to_status
        }), userId, metadata: { chequeId: Number(row.cheque_id), status: row.to_status }
      });
    }

    const [issued] = await connection.execute(
      `SELECT e.*, c.amount, c.cheque_number, c.bank_account_id, c.created_by AS source_user_id,
              d.id AS business_day_id, c.purpose, c.payee_name_snapshot, b.fund_account_id
       FROM issued_cheque_status_events e
       JOIN issued_cheques c ON c.id = e.issued_cheque_id
       JOIN business_bank_accounts b ON b.id = c.bank_account_id
       JOIN business_days d ON d.loc_code = e.loc_code AND d.business_date = e.txn_date
       LEFT JOIN journal_entries j ON j.source_type = 'issued_cheque_status' AND j.source_id = CAST(e.id AS CHAR)
       WHERE e.loc_code = ? AND (
          e.to_status = 'cleared'
          OR (c.purpose = 'other' AND e.to_status IN ('issued','cancelled','stopped','returned_unpaid'))
       ) AND j.id IS NULL
       ORDER BY e.txn_date, e.id FOR UPDATE`, [locCode]
    );
    for (const row of issued) {
      const isClearance = row.to_status === 'cleared';
      const isReversal = ['cancelled', 'stopped', 'returned_unpaid'].includes(row.to_status);
      if (isClearance && row.fund_account_id) {
        await ensureFundMovement(connection, row, {
          fundAccountId: row.fund_account_id, direction: 'out', sourceType: 'issued_cheque_clearance', sourceId: row.id,
          reason: `Issued cheque ${row.cheque_number} cleared`, userId
        });
      }
      posted += await post(connection, row, {
        sourceType: 'issued_cheque_status', sourceId: row.id, documentType: 'issued_cheque', documentNo: row.issued_cheque_id,
        posting: isClearance
          ? rules.issuedChequeClearancePosting({ cheque: {
            amount: row.amount, chequeNumber: row.cheque_number, fundAccountId: Number(row.fund_account_id)
          } })
          : rules.otherIssuedChequePosting({ cheque: {
            amount: row.amount, chequeNumber: row.cheque_number, purpose: row.payee_name_snapshot
          }, reversal: isReversal }),
        userId, metadata: { issuedChequeId: Number(row.issued_cheque_id), bankAccountId: Number(row.bank_account_id), status: row.to_status }
      });
    }
    return posted;
  }

  async function syncAll({ locCode, userId }) {
    const location = text(locCode);
    if (!location) throw new Error('A location is required to refresh accounting.');
    if (!Number(userId)) throw new Error('A signed-in user is required to refresh accounting.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const counts = {
          manualCash: await syncManualCash(connection, location, userId),
          sales: await syncInvoices(connection, location, userId),
          customerPayments: await syncCustomerPayments(connection, location, userId),
          refunds: await syncRefunds(connection, location, userId),
          customerAdvances: await syncCustomerAdvances(connection, location, userId),
          supplierLedger: await syncSupplierLedger(connection, location, userId),
          chequeEvents: await syncChequeEvents(connection, location, userId)
        };
        await connection.commit();
        return { ...counts, posted: Object.values(counts).reduce((sum, value) => sum + value, 0) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  return { syncAll };
}

module.exports = { createOperationalAccountingRepository };
