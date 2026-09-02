const { createInventoryLedgerRepository } = require('./inventory-ledger.repository');

function createBillingRepository({ database, businessDayRepository, documentSequenceRepository, inventoryLedgerRepository, customerAdvanceRepository = null }) {
  if (!database) {
    throw new Error('Billing repository requires a database instance.');
  }

  function toMoney(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function toKilos(value) {
    const kilos = Number(value);
    return Number.isFinite(kilos) && kilos > 0 ? Math.round(kilos * 1000) / 1000 : null;
  }

  function toStockQuantity(value) {
    const number = Number(value || 0);
    return Math.round((Number.isFinite(number) ? number : 0) * 1000) / 1000;
  }

  async function validateAllocationPriority(connection, { lotId, productId, locCode, txnDate }) {
    const normalizedLotId = Number(lotId);
    if (!Number.isInteger(normalizedLotId) || normalizedLotId < 1) return null;
    const [rows] = await connection.execute(
      `SELECT l.id
       FROM inventory_lots l
       JOIN products p ON p.id = l.product_id
       JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
       JOIN goods_receipts g ON g.id = gl.goods_receipt_id
       WHERE l.id = ? AND l.product_id = ? AND l.loc_code = ? AND l.txn_date <= ?
         AND g.status = 'finalized'
         AND (CASE WHEN p.pricing_basis = 'kilos' OR p.requires_kilos = 1
                   THEN COALESCE(l.remaining_base_quantity, 0) > 0
                   ELSE l.remaining_handling_quantity > 0 END)
       LIMIT 1`,
      [normalizedLotId, Number(productId), String(locCode || '').trim(), txnDate]
    );
    return rows.length ? normalizedLotId : null;
  }

  async function listAllocationLotCandidates({ productId, locCode, txnDate, userId = null, limit = 12 } = {}) {
    const normalizedProductId = Number(productId);
    const normalizedLocation = String(locCode || '').trim();
    if (!Number.isInteger(normalizedProductId) || normalizedProductId < 1 || !normalizedLocation || !txnDate) return [];
    const rowLimit = Math.max(1, Math.min(30, Number(limit) || 12));
    return database.withConnection(async (connection) => {
      const [preferenceRows] = Number(userId) > 0
        ? await connection.execute(
          `SELECT inventory_lot_id FROM inventory_lot_preferences
           WHERE loc_code = ? AND product_id = ? AND user_id = ? LIMIT 1`,
          [normalizedLocation, normalizedProductId, Number(userId)]
        )
        : [[]];
      const rememberedLotId = Number(preferenceRows[0]?.inventory_lot_id || 0) || null;
      const [rows] = await connection.execute(
        `SELECT l.id, l.lot_code, l.loc_code, l.mac_code, l.txn_date, l.grn_no, l.line_no,
                l.received_handling_quantity, l.remaining_handling_quantity,
                l.received_base_quantity, l.remaining_base_quantity,
                l.handling_uom_snapshot, l.base_uom_snapshot, l.conversion_mode,
                l.expected_base_per_handling, l.actual_base_per_handling, l.ownership_model,
                s.id AS supplier_id, s.supplier_code, s.name AS supplier_name,
                g.id AS goods_receipt_id, g.grn_number, g.external_reference, g.vehicle_no
         FROM inventory_lots l
         JOIN products p ON p.id = l.product_id
         JOIN suppliers s ON s.id = l.supplier_id
         JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
         JOIN goods_receipts g ON g.id = gl.goods_receipt_id
         WHERE l.product_id = ? AND l.loc_code = ? AND l.txn_date <= ? AND g.status = 'finalized'
           AND (CASE WHEN p.pricing_basis = 'kilos' OR p.requires_kilos = 1
                     THEN COALESCE(l.remaining_base_quantity, 0) > 0
                     ELSE l.remaining_handling_quantity > 0 END)
         ORDER BY CASE WHEN l.id = ? THEN 0 ELSE 1 END,
                  l.txn_date ASC, l.grn_no ASC, l.line_no ASC, l.id ASC
         LIMIT ${rowLimit}`,
        [normalizedProductId, normalizedLocation, txnDate, rememberedLotId || 0]
      );
      if (rememberedLotId && !rows.some((row) => Number(row.id) === rememberedLotId)) {
        await connection.execute(
          `DELETE FROM inventory_lot_preferences
           WHERE loc_code = ? AND product_id = ? AND user_id = ? AND inventory_lot_id = ?`,
          [normalizedLocation, normalizedProductId, Number(userId), rememberedLotId]
        );
      }
      return rows.map((row, index) => ({
        ...row,
        id: Number(row.id),
        supplier_id: Number(row.supplier_id),
        received_handling_quantity: toStockQuantity(row.received_handling_quantity),
        remaining_handling_quantity: toStockQuantity(row.remaining_handling_quantity),
        received_base_quantity: row.received_base_quantity == null ? null : toStockQuantity(row.received_base_quantity),
        remaining_base_quantity: row.remaining_base_quantity == null ? null : toStockQuantity(row.remaining_base_quantity),
        remembered: Number(row.id) === rememberedLotId,
        priority: index + 1,
        priority_reason: Number(row.id) === rememberedLotId ? 'remembered' : 'fifo'
      }));
    });
  }

  async function rememberAllocationLot({ productId, locCode, txnDate, userId, lotId }) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 1) throw new Error('A signed-in cashier is required to remember a stock lot.');
    return database.withConnection(async (connection) => {
      const validLotId = await validateAllocationPriority(connection, { lotId, productId, locCode, txnDate });
      if (!validLotId) throw new Error('That stock lot is no longer available for this product and date.');
      await connection.execute(
        `INSERT INTO inventory_lot_preferences (loc_code, product_id, user_id, inventory_lot_id)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE inventory_lot_id = VALUES(inventory_lot_id), updated_at = CURRENT_TIMESTAMP`,
        [String(locCode).trim(), Number(productId), normalizedUserId, validLotId]
      );
      return { lotId: validLotId };
    });
  }

  async function clearRememberedAllocationLot({ productId, locCode, userId }) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'DELETE FROM inventory_lot_preferences WHERE loc_code = ? AND product_id = ? AND user_id = ?',
        [String(locCode || '').trim(), Number(productId), Number(userId)]
      );
      return { cleared: true };
    });
  }

  async function setLiveItemAllocationPriority({ itemId, lotId = null, source = null, userId = null }) {
    return database.withConnection(async (connection) => {
      const [items] = await connection.execute(
        `SELECT id, product_id, loc_code, txn_date FROM invoice_items
         WHERE id = ? AND invoice_id IS NULL LIMIT 1`, [Number(itemId)]
      );
      if (!items.length) throw new Error('The editable bill line was not found.');
      const item = items[0];
      const validLotId = lotId == null ? null : await validateAllocationPriority(connection, {
        lotId, productId: item.product_id, locCode: item.loc_code, txnDate: item.txn_date
      });
      if (lotId != null && !validLotId) throw new Error('That stock lot is no longer available for this bill line.');
      const normalizedSource = validLotId && ['automatic', 'remembered', 'manual'].includes(source) ? source : null;
      const normalizedUserId = validLotId && Number.isInteger(Number(userId)) && Number(userId) > 0 ? Number(userId) : null;
      await connection.execute(
        `UPDATE invoice_items
         SET allocation_priority_lot_id = ?, allocation_priority_source = ?,
             allocation_priority_set_by = ?, allocation_priority_set_at = ?, upd_stat = 1
         WHERE id = ? AND invoice_id IS NULL`,
        [validLotId, normalizedSource, normalizedUserId, validLotId ? new Date() : null, Number(itemId)]
      );
      return { itemId: Number(itemId), lotId: validLotId, source: normalizedSource };
    });
  }
  inventoryLedgerRepository = inventoryLedgerRepository || createInventoryLedgerRepository({ database });

  function chequePaymentValues(payment = {}) {
    const details = payment.chequeDetails && typeof payment.chequeDetails === 'object'
      ? payment.chequeDetails
      : {};
    return [
      details.number || null,
      details.date || null,
      details.bankName || null,
      details.branchName || null,
      details.drawerName || null,
      details.accountReference || null,
      details.notes || null
    ];
  }

  async function insertChequeWithConnection(connection, {
    paymentId, invoiceId, locCode, macCode, txnDate, documentType, documentNo, paymentNo,
    customerAccountId, payment, userId
  }) {
    if (payment.method !== 'cheque') return;
    const details = payment.chequeDetails && typeof payment.chequeDetails === 'object' ? payment.chequeDetails : {};
    const [result] = await connection.execute(
      `INSERT INTO cheques
         (payment_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no, payment_no,
          received_from_customer_account_id, drawer_party_id, drawer_name_snapshot, cheque_number, cheque_date,
          bank_name, branch_name, account_reference, amount, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
      [paymentId, invoiceId, locCode, macCode, txnDate, documentType, documentNo, paymentNo,
        customerAccountId || null, details.drawerPartyId || null, details.drawerName || null, details.number || null,
        details.date || null, details.bankName || null, details.branchName || null, details.accountReference || null,
        toMoney(payment.amount), details.notes || null, userId || null]
    );
    await connection.execute(
      `INSERT INTO cheque_status_events
         (cheque_id, event_no, loc_code, mac_code, txn_date, from_status, to_status, reason, details, changed_by)
       VALUES (?, 1, ?, ?, ?, NULL, 'received', 'Cheque accepted as invoice tender.', CAST(? AS JSON), ?)`,
      [result.insertId, locCode, macCode, txnDate,
        JSON.stringify({ paymentId: Number(paymentId), invoiceId: Number(invoiceId), documentType, documentNo, paymentNo }), userId || null]
    );
  }

  async function allocateFinalizedSaleToLots(connection, item, txnDate, userId) {
    if (!item.product_id) return;
    const baseQuantity = item.base_quantity == null && item.kilos == null ? null : Number(item.base_quantity ?? item.kilos);
    const byBase = baseQuantity != null;
    let remainingBase = byBase ? toStockQuantity(baseQuantity) : null;
    let remainingHandling = toStockQuantity(item.handling_quantity ?? item.qty ?? item.quantity);
    const originalBase = remainingBase;
    const originalHandling = remainingHandling;
    const controllingOriginal = byBase ? originalBase : originalHandling;
    if (!Number.isFinite(controllingOriginal) || controllingOriginal <= 0) return;
    const [lots] = await connection.execute(
      `SELECT l.* FROM inventory_lots l
       JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
       JOIN goods_receipts g ON g.id = gl.goods_receipt_id
       WHERE l.product_id = ? AND l.loc_code = ? AND l.txn_date <= ? AND g.status = 'finalized'
         AND l.${byBase ? 'remaining_base_quantity' : 'remaining_handling_quantity'} > 0
       ORDER BY CASE WHEN l.id = ? THEN 0 ELSE 1 END,
                l.txn_date ASC, l.grn_no ASC, l.line_no ASC, l.id ASC FOR UPDATE`,
      [item.product_id, item.loc_code, item.txn_date, Number(item.allocation_priority_lot_id || 0)]
    );
    let allocationNo = 0;
    for (const lot of lots) {
      if ((byBase ? remainingBase : remainingHandling) <= 0.0005) break;
      const availableHandling = Math.max(0, Number(lot.remaining_handling_quantity || 0));
      const availableBase = Math.max(0, Number(lot.remaining_base_quantity || 0));
      let quantity = 0;
      let base = null;
      if (byBase) {
        const baseFraction = remainingBase > 0 ? availableBase / remainingBase : 0;
        const handlingFraction = remainingHandling > 0 ? availableHandling / remainingHandling : 1;
        const fraction = Math.max(0, Math.min(1, baseFraction, handlingFraction));
        if (fraction <= 0.0000005) continue;
        base = toStockQuantity(remainingBase * fraction);
        quantity = remainingHandling > 0 ? toStockQuantity(remainingHandling * fraction) : 0;
      } else {
        quantity = toStockQuantity(Math.min(remainingHandling, availableHandling));
      }
      const selectedLotExhausted = byBase
        ? availableBase - Number(base || 0) <= 0.0005
        : availableHandling - quantity <= 0.0005;
      if (Number(lot.id) === Number(item.allocation_priority_lot_id)
          && ['manual', 'remembered'].includes(item.allocation_priority_source)
          && selectedLotExhausted && Number(item.allocation_priority_set_by) > 0) {
        await connection.execute(
          `DELETE FROM inventory_lot_preferences
           WHERE loc_code = ? AND product_id = ? AND user_id = ? AND inventory_lot_id = ?`,
          [item.loc_code, item.product_id, Number(item.allocation_priority_set_by), lot.id]
        );
      }
      const controllingTaken = byBase ? base : quantity;
      if (!(controllingTaken > 0)) continue;
      const saleValue = toMoney(Number(item.total) * (controllingTaken / controllingOriginal));
      allocationNo += 1;
      await connection.execute(
        `INSERT INTO lot_sale_allocations
           (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no,
            invoice_item_id, quantity, handling_quantity, kilos, base_quantity, sale_value)
         VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [lot.id, item.loc_code, item.mac_code, item.txn_date, item.receipt_no, item.seq_no, allocationNo,
          item.id, quantity, quantity, base, base, saleValue]
      );
      if (byBase) {
        await connection.execute(
          `UPDATE inventory_lots
           SET remaining_kilos = remaining_kilos - ?,
               remaining_base_quantity = remaining_base_quantity - ?,
               remaining_quantity = GREATEST(0, remaining_quantity - ?),
               remaining_handling_quantity = GREATEST(0, remaining_handling_quantity - ?)
           WHERE id = ?`,
          [base, base, quantity, quantity, lot.id]
        );
      } else {
        await connection.execute(
          `UPDATE inventory_lots
           SET remaining_quantity = remaining_quantity - ?,
               remaining_handling_quantity = remaining_handling_quantity - ?
           WHERE id = ?`, [quantity, quantity, lot.id]
        );
      }
      const terms = typeof lot.terms_snapshot === 'string' ? JSON.parse(lot.terms_snapshot || '{}') : (lot.terms_snapshot || {});
      if (lot.ownership_model === 'consignment') {
        const commissionRate = Number(terms.commissionRate || 0);
        const supplierDue = toMoney(saleValue * Math.max(0, 1 - commissionRate / 100));
        await connection.execute(
          `INSERT INTO supplier_payable_entries
             (supplier_id, loc_code, mac_code, inventory_lot_id, entry_type, amount, business_date,
              document_type, document_no, line_no, entry_no, reason, created_by, metadata)
           VALUES (?, ?, ?, ?, 'consignment_accrual', ?, ?, 'sale', ?, ?, ?, 'Finalized consignment sale', ?, CAST(? AS JSON))`,
          [lot.supplier_id, item.loc_code, item.mac_code, lot.id, supplierDue, txnDate,
            item.receipt_no, item.seq_no, allocationNo, userId || null,
            JSON.stringify({ invoiceItemId: item.id, saleValue, commissionRate })]
        );
      }
      remainingHandling = toStockQuantity(Math.max(0, remainingHandling - quantity));
      if (byBase) remainingBase = toStockQuantity(Math.max(0, remainingBase - base));
    }
    const unallocatedControlling = byBase ? remainingBase : remainingHandling;
    if (unallocatedControlling > 0.0005 || remainingHandling > 0.0005) {
      await connection.execute(
        `INSERT INTO inventory_allocation_exceptions
           (invoice_item_id, loc_code, mac_code, txn_date, document_no, line_no, product_id,
            unallocated_handling_quantity, unallocated_base_quantity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
         ON DUPLICATE KEY UPDATE
           unallocated_handling_quantity = VALUES(unallocated_handling_quantity),
           unallocated_base_quantity = VALUES(unallocated_base_quantity), status = 'open',
           resolution_note = NULL, resolved_by = NULL, resolved_at = NULL`,
        [item.id, item.loc_code, item.mac_code, item.txn_date, item.receipt_no, item.seq_no, item.product_id,
          remainingHandling, byBase ? remainingBase : null]
      );
    }
  }

  function normalizeLineMetadata(metadata, kilos) {
    const normalized = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
    const promotedKilos = kilos !== undefined ? toKilos(kilos) : toKilos(normalized.kilos);
    if (normalized.kilos !== undefined) {
      delete normalized.kilos;
    }
    return {
      kilos: promotedKilos,
      metadata: Object.keys(normalized).length > 0 ? normalized : null
    };
  }

  function hydrateLineMetadata(metadata, kilos) {
    const hydrated = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
    if (hydrated.kilos === undefined && kilos != null) {
      hydrated.kilos = toKilos(kilos);
    }
    return hydrated;
  }

  /**
   * Settle an already-finalized credit sale. This deliberately stays separate
   * from addPayment: it must update the receivable ledger and cash shift with
   * the invoice payment in one atomic transaction.
   */
  async function collectInvoiceBalance({ invoiceId, userId, payments, cashShiftId = null, cashMovements = [], origin }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [invoices] = await connection.execute(
          `SELECT id, invoice_number, loc_code, mac_code, txn_date, receipt_no, customer_account_id, status, balance
           FROM invoices WHERE id = ? FOR UPDATE`,
          [invoiceId]
        );
        const invoice = invoices[0];
        if (!invoice) throw new Error('Invoice was not found.');
        if (!invoice.customer_account_id) throw new Error('This invoice has no customer account to settle.');
        const openBalance = toMoney(invoice.balance);
        if (openBalance <= 0) throw new Error('This invoice has no outstanding balance.');

        const total = toMoney((payments || []).reduce((sum, payment) => sum + toMoney(payment.amount), 0));
        if (total <= 0) throw new Error('Collection amount must be greater than zero.');
        if (total - openBalance > 0.005) {
          throw new Error(`Collection exceeds the outstanding balance (${openBalance.toFixed(2)}).`);
        }

        const locationCode = String(origin?.locCode || '').trim();
        const machineCode = String(origin?.macCode || '').trim();
        const businessDate = origin?.businessDate;
        if (!locationCode || !machineCode || !businessDate) throw new Error('The current workstation origin is required for a collection.');
        if (!businessDayRepository || !documentSequenceRepository) throw new Error('Business-day collection control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode, businessDate
        });
        const collectionNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'customer_collection', locCode: locationCode, macCode: machineCode, txnDate: businessDate
        });
        let paymentNo = 0;
        for (const payment of payments) {
          paymentNo += 1;
          const [paymentResult] = await connection.execute(
            `INSERT INTO payments
               (business_day_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no,
                receipt_no, payment_no, method, amount, provider_ref, cheque_number, cheque_date, cheque_bank,
                cheque_branch, cheque_drawer_name, cheque_account_reference, cheque_notes, status)
             VALUES (?, ?, ?, ?, ?, 'collection', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
            [businessDay.id, invoiceId, locationCode, machineCode, businessDate, collectionNo,
              invoice.receipt_no, paymentNo, payment.method, toMoney(payment.amount), payment.providerRef || null,
              ...chequePaymentValues(payment)]
          );
          await insertChequeWithConnection(connection, {
            paymentId: paymentResult.insertId, invoiceId, locCode: locationCode, macCode: machineCode,
            txnDate: businessDate, documentType: 'collection', documentNo: collectionNo, paymentNo,
            customerAccountId: invoice.customer_account_id, payment, userId
          });
          if (payment.method === 'advance') {
            if (!customerAdvanceRepository) throw new Error('Customer advance settlement is not available.');
            await customerAdvanceRepository.applyToInvoiceWithConnection(connection, {
              customerAccountId: invoice.customer_account_id, businessDayId: businessDay.id,
              locCode: locationCode, macCode: machineCode, txnDate: businessDate,
              invoiceId, invoiceNumber: invoice.invoice_number, paymentId: paymentResult.insertId, paymentNo,
              documentType: 'collection', documentNo: collectionNo, amount: toMoney(payment.amount), userId
            });
          }
        }
        const remainingBalance = toMoney(openBalance - total);
        await connection.execute(
          `UPDATE invoices
           SET paid_total = paid_total + ?, balance = ?, status = CASE WHEN ? <= 0.005 THEN 'paid' ELSE 'partial' END
           WHERE id = ?`,
          [total, remainingBalance, remainingBalance, invoiceId]
        );
        await connection.execute(
          `INSERT INTO customer_receivable_entries
             (business_day_id, customer_account_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no,
              invoice_id, entry_type, amount, reason, created_by, metadata)
           VALUES (?, ?, ?, ?, ?, 'collection', ?, 1, ?, 'collection_credit', ?, 'Outstanding balance collected', ?, CAST(? AS JSON))`,
          [businessDay.id, invoice.customer_account_id, locationCode, machineCode, businessDate, collectionNo,
            invoiceId, total, userId, JSON.stringify({ invoiceNumber: invoice.invoice_number, sourceReceiptNo: invoice.receipt_no })]
        );

        if (cashShiftId) {
          const [shifts] = await connection.execute(
            `SELECT id, loc_code, mac_code, business_date, shift_no
             FROM cash_shifts
             WHERE id = ? AND loc_code = ? AND mac_code = ? AND business_date = ? AND status = 'open'
             FOR UPDATE`,
            [cashShiftId, locationCode, machineCode, businessDate]
          );
          if (shifts.length === 0) throw new Error('The cash shift is no longer open.');
          const [movementNumbers] = await connection.execute(
            'SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [cashShiftId]
          );
          let movementNo = Number(movementNumbers[0].max_no || 0);
          for (const movement of cashMovements) {
            movementNo += 1;
            await connection.execute(
              `INSERT INTO cash_movements
                 (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
                  movement_type, direction, amount, reference_type, reference_id, reason, created_by, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'invoice_collection', ?, 'Outstanding balance collected', ?, CAST(? AS JSON))`,
              [cashShiftId, shifts[0].loc_code, shifts[0].mac_code, shifts[0].business_date, shifts[0].shift_no, movementNo,
                movement.movementType, movement.direction, movement.amount, `${invoiceId}:${collectionNo}`, userId,
                JSON.stringify({ invoiceId, invoiceNumber: invoice.invoice_number, collectionNo })]
            );
          }
        }
        await connection.commit();
        return { invoiceId, invoiceNumber: invoice.invoice_number, collectionNo, collected: total, balance: remainingBalance, status: remainingBalance <= 0.005 ? 'paid' : 'partial' };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function getInvoice(invoiceId) {
    return database.withConnection(async (connection) => {
      const [invoices] = await connection.execute('SELECT * FROM invoices WHERE id = ? LIMIT 1', [invoiceId]);
      if (invoices.length === 0) {
        return null;
      }
      const [items] = await connection.execute('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
      const [payments] = await connection.execute('SELECT * FROM payments WHERE invoice_id = ?', [invoiceId]);
      return {
        ...invoices[0],
        items,
        payments,
        billHeader: {}
      };
    });
  }

  async function searchInvoices({ term = '', customerCode = '', locCode = '', macCode = '', txnDate = '', limit = 50 } = {}) {
    return database.withConnection(async (connection) => {
      const text = String(term || '').trim();
      const clauses = [];
      const params = [];
      if (locCode) { clauses.push('loc_code = ?'); params.push(locCode); }
      if (macCode) { clauses.push('mac_code = ?'); params.push(macCode); }
      if (txnDate) { clauses.push('txn_date = ?'); params.push(txnDate); }
      if (customerCode) { clauses.push('customer_code LIKE ?'); params.push(`%${String(customerCode).trim()}%`); }
      if (text) {
        clauses.push('(invoice_number LIKE ? OR CAST(receipt_no AS CHAR) LIKE ?)');
        params.push(`%${text}%`, `%${text}%`);
      }
      const maxRows = Math.max(1, Math.min(Number(limit) || 50, 200));
      const [rows] = await connection.execute(
        `SELECT id, invoice_number, loc_code, mac_code, receipt_no, txn_date, status, customer_code,
                (SELECT p.display_name FROM customer_accounts ca JOIN parties p ON p.id = ca.party_id
                 WHERE ca.id = invoices.customer_account_id LIMIT 1) AS customer_name,
                subtotal, bag_charge_total, wage_charge_total, discount_total, grand_total, paid_total, balance, end_time
         FROM invoices
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY txn_date DESC, receipt_no DESC LIMIT ${maxRows}`,
        params
      );
      return rows.map((row) => ({
        ...row,
        subtotal: toMoney(row.subtotal), bagChargeTotal: toMoney(row.bag_charge_total), wageChargeTotal: toMoney(row.wage_charge_total), discountTotal: toMoney(row.discount_total), grandTotal: toMoney(row.grand_total),
        paidTotal: toMoney(row.paid_total), balance: toMoney(row.balance)
      }));
    });
  }

  async function getInvoiceArchive(invoiceId) {
    const invoice = await getInvoice(invoiceId);
    if (!invoice) return null;
    const customer = invoice.customer_account_id
      ? await database.withConnection(async (connection) => {
          const [rows] = await connection.execute(
            `SELECT ca.id, ca.account_number, p.display_name,
                    COALESCE(SUM(CASE
                      WHEN e.entry_type IN ('sale_debit','refund_debit','cheque_dishonour_debit') THEN e.amount
                      WHEN e.entry_type IN ('collection_credit', 'return_credit','store_credit') THEN -e.amount
                      ELSE 0
                    END), 0) AS outstanding_balance
             FROM customer_accounts ca JOIN parties p ON p.id = ca.party_id
             LEFT JOIN customer_receivable_entries e ON e.customer_account_id = ca.id
             WHERE ca.id = ? GROUP BY ca.id, p.id`,
            [invoice.customer_account_id]
          );
          return rows[0] || null;
        })
      : null;
    const parse = (value) => {
      if (value && typeof value === 'object') return value;
      try { return value ? JSON.parse(value) : {}; } catch { return {}; }
    };
    return {
      ...invoice,
      subtotal: toMoney(invoice.subtotal), discountTotal: toMoney(invoice.discount_total), taxTotal: toMoney(invoice.tax_total),
      grandTotal: toMoney(invoice.grand_total), paidTotal: toMoney(invoice.paid_total), balance: toMoney(invoice.balance),
      metadata: parse(invoice.metadata),
      billHeader: {},
      customer: customer ? {
        id: customer.id,
        accountNumber: customer.account_number,
        customerCode: invoice.customer_code || null,
        name: customer.display_name,
        outstandingBalance: toMoney(customer.outstanding_balance)
      } : null,
      items: invoice.items.map((item) => {
        const metadata = hydrateLineMetadata(parse(item.metadata), item.kilos);
        return {
          ...item,
          qty: toMoney(item.quantity),
          kilos: item.kilos == null ? null : toKilos(item.kilos),
          pricingBasis: item.pricing_basis === 'kilos' ? 'kilos' : 'qty',
          unitPrice: toMoney(item.unit_price),
          discount: toMoney(item.discount),
          tax: toMoney(item.tax),
          merchandiseTotal: toMoney(item.merchandise_total),
          bagChargeTotal: toMoney(item.bag_charge_total),
          wageChargeTotal: toMoney(item.wage_charge_total),
          total: toMoney(item.total),
          metadata
        };
      }),
      payments: invoice.payments.map((payment) => ({
        ...payment,
        amount: toMoney(payment.amount),
        providerRef: payment.provider_ref || null,
        chequeDetails: payment.method === 'cheque' ? {
          number: payment.cheque_number || null,
          date: payment.cheque_date || null,
          bankName: payment.cheque_bank || null,
          branchName: payment.cheque_branch || null,
          drawerName: payment.cheque_drawer_name || null,
          accountReference: payment.cheque_account_reference || null,
          notes: payment.cheque_notes || null
        } : null
      }))
    };
  }

  /**
   * Create the invoices master from a held (live) bill and backfill its items.
   *
   * POS flow: invoice_items rows already exist with invoice_id = NULL for this
   * (loc, mac, txn_date, receipt_no). Finalize creates the master row, writes
   * the payment records, then links the live items to the master — all in one
   * transaction.
   */
  async function finalizeInvoice({
    locCode, macCode, txnDate, receiptNo, sessionId, userId, payments,
    invoiceMetadata = {}, grandTotalOverride, subtotalOverride, bagChargeTotalOverride = 0, wageChargeTotalOverride = 0,
    cashShiftId = null, cashMovements = [], customerAccountId = null, customerCode = '', receivableSaleDebt = 0
  }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode,
          businessDate: txnDate
        });
        // Load the held items for this receipt
        const [items] = await connection.execute(
          `SELECT id, loc_code, mac_code, txn_date, receipt_no, seq_no, product_id, item_code, description,
                  quantity AS qty, handling_quantity, kilos, base_quantity, handling_uom_snapshot, base_uom_snapshot,
                  allocation_priority_lot_id, allocation_priority_source, allocation_priority_set_by,
                  unit_price, discount, tax, merchandise_total, bag_charge_total, wage_charge_total, total
           FROM invoice_items
           WHERE invoice_id IS NULL AND loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?
           ORDER BY seq_no ASC`,
          [locCode, macCode, txnDate, receiptNo]
        );
        if (items.length === 0) {
          throw new Error('Cannot finalize a bill with no items.');
        }

        // Compute totals from DB using DECIMAL aggregates (avoids JS float errors)
        const [totals] = await connection.execute(
          `SELECT
             COALESCE(SUM(merchandise_total), 0) AS gross_amt,
             COALESCE(SUM(bag_charge_total), 0) AS bag_charge_total,
             COALESCE(SUM(wage_charge_total), 0) AS wage_charge_total,
             COALESCE(SUM(discount), 0) AS discount_total,
             COALESCE(SUM(total), 0) AS grand_total,
             MIN(created_at) AS start_time
           FROM invoice_items
           WHERE invoice_id IS NULL AND loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?`,
          [locCode, macCode, txnDate, receiptNo]
        );
        const grossAmt = Number.isFinite(Number(subtotalOverride))
          ? toMoney(Number(subtotalOverride))
          : Number(totals[0].gross_amt);
        const discountTotal = Number(totals[0].discount_total);
        // Prefer the authoritative (plugin-adjusted) grand total from the
        // billing engine; fall back to the DB SUM(total) when no override was
        // provided (no registered totals hooks or nothing adjusted).
        const dbGrandTotal = Number(totals[0].grand_total);
        const grandTotal = Number.isFinite(Number(grandTotalOverride))
          ? toMoney(Number(grandTotalOverride))
          : dbGrandTotal;

        // Split payments into tender (reduces balance) and credit (leaves an
        // outstanding balance, e.g. the Pending paymode). paid_total only
        // counts tender; balance reflects what the customer still owes.
        const tenderPayments = payments.filter((p) => (p.type || 'tender') === 'tender');
        const creditPayments = payments.filter((p) => (p.type || 'tender') === 'credit');
        const tenderTotal = toMoney(tenderPayments.reduce((s, p) => s + toMoney(p.amount), 0));
        const creditTotal = toMoney(creditPayments.reduce((s, p) => s + toMoney(p.amount), 0));
        const balance = toMoney(Math.max(grandTotal - tenderTotal, 0));
        const cashAmt = toMoney(
          tenderPayments.filter((p) => p.method === 'cash').reduce((s, p) => s + toMoney(p.amount), 0)
        );
        const changeAmt = toMoney(Math.max(tenderTotal - grandTotal, 0));
        const status = tenderTotal >= grandTotal ? 'paid' : 'partial';

        const invoiceNumber = `${locCode}-${macCode}-${String(txnDate).replace(/-/g, '')}-${String(receiptNo).padStart(6, '0')}`;

        let paymentTermsDays = 0;
        if (customerAccountId) {
          const [accountRows] = await connection.execute(
            `SELECT payment_terms_days FROM customer_accounts WHERE id = ? AND status = 'active' LIMIT 1`,
            [customerAccountId]
          );
          if (!accountRows.length) throw new Error('The selected customer account is not active.');
          paymentTermsDays = Number(accountRows[0].payment_terms_days || 0);
        }
        const dueDate = receivableSaleDebt > 0 && customerAccountId
          ? new Date(new Date(`${txnDate}T00:00:00Z`).getTime() + paymentTermsDays * 86400000).toISOString().slice(0, 10)
          : null;

        const [invResult] = await connection.execute(
          `INSERT INTO invoices (
            business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, due_date, cash_shift_id,
            customer_account_id, customer_code, user_id, sale_type, status,
            subtotal, merchandise_total, bag_charge_total, wage_charge_total, discount_total, tax_total, grand_total, paid_total, balance,
            cash_amt, change_amt,
            start_time, end_time, inv_stat, cre_by, upd_stat, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NOW(), 'active', ?, 1, CAST(? AS JSON))`,
          [
            businessDay.id, invoiceNumber, locCode, macCode, receiptNo, txnDate, dueDate, cashShiftId,
            customerAccountId, customerCode, userId, 'cash',
            status,
            grossAmt, grossAmt, Number(bagChargeTotalOverride || totals[0].bag_charge_total), Number(wageChargeTotalOverride || totals[0].wage_charge_total), discountTotal, grandTotal, tenderTotal, balance,
            cashAmt, changeAmt,
            totals[0].start_time, userId,
            JSON.stringify({ sessionId, ...invoiceMetadata })
          ]
        );

        const invoiceId = invResult.insertId;
        if (customerAccountId && toMoney(receivableSaleDebt) > 0) {
          await connection.execute(
            `INSERT INTO customer_receivable_entries
               (business_day_id, customer_account_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no, invoice_id, entry_type, amount, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, 'sale', ?, 1, ?, 'sale_debit', ?, 'Pending balance from sale', ?, CAST(? AS JSON))`,
            [businessDay.id, customerAccountId, locCode, macCode, txnDate, receiptNo, invoiceId, toMoney(receivableSaleDebt), userId, JSON.stringify({ invoiceNumber })]
          );
        }
        if (customerAccountId) {
          await connection.execute(
            `INSERT INTO invoice_customer_assignment_events
               (invoice_id, loc_code, mac_code, txn_date, receipt_no, assignment_no, customer_account_id,
                market_code_snapshot, event_type, action_loc_code, action_mac_code, action_date, changed_by)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'finalized_link', ?, ?, ?, ?)`,
            [invoiceId, locCode, macCode, txnDate, receiptNo, customerAccountId, customerCode,
              locCode, macCode, txnDate, userId || null]
          );
        }
        // Backfill invoice_id onto the live items
        await connection.execute(
          `UPDATE invoice_items
           SET invoice_id = ?, customer_account_id = ?, upd_stat = 1
           WHERE invoice_id IS NULL AND loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?`,
          [invoiceId, customerAccountId, locCode, macCode, txnDate, receiptNo]
        );

        // Stock follows the finalized database rows, never the editable live
        // billing state. Weight-based lines move their final kilos; all other
        // lines move their final quantity.
        for (const item of items) {
          if (!item.product_id) continue;
          const handlingQuantity = Number(item.handling_quantity ?? item.qty ?? item.quantity ?? 0);
          const baseQuantity = item.base_quantity == null && item.kilos == null ? null : Number(item.base_quantity ?? item.kilos);
          if (!(handlingQuantity > 0) && !(baseQuantity > 0)) continue;
          await inventoryLedgerRepository.postWithConnection(connection, {
            productId: item.product_id,
            locCode,
            macCode,
            businessDate: txnDate,
            documentType: 'sale',
            documentNo: receiptNo,
            lineNo: item.seq_no,
            eventNo: 1,
            movementType: 'sale',
            referenceType: 'invoice_item',
            referenceId: item.id,
            note: 'Stock deduction from finalized sale',
            createdBy: userId,
            handlingDelta: handlingQuantity > 0 ? -handlingQuantity : null,
            baseDelta: baseQuantity != null && baseQuantity > 0 ? -baseQuantity : null,
            handlingUom: item.handling_uom_snapshot,
            baseUom: item.base_uom_snapshot
          });
          await allocateFinalizedSaleToLots(connection, item, txnDate, userId);
        }

        // Insert payment records
        let paymentNo = 0;
        for (const p of payments) {
          paymentNo += 1;
          const [paymentResult] = await connection.execute(
            `INSERT INTO payments
               (business_day_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no,
                receipt_no, payment_no, method, amount, provider_ref, cheque_number, cheque_date, cheque_bank,
                cheque_branch, cheque_drawer_name, cheque_account_reference, cheque_notes, status)
             VALUES (?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
            [businessDay.id, invoiceId, locCode, macCode, txnDate, receiptNo, receiptNo,
              paymentNo, p.method || 'cash', p.amount, p.providerRef || null, ...chequePaymentValues(p)]
          );
          await insertChequeWithConnection(connection, {
            paymentId: paymentResult.insertId, invoiceId, locCode, macCode, txnDate,
            documentType: 'sale', documentNo: receiptNo, paymentNo,
            customerAccountId, payment: p, userId
          });
          if (p.method === 'advance') {
            if (!customerAdvanceRepository || !customerAccountId) throw new Error('A customer account is required to use advance money.');
            await customerAdvanceRepository.applyToInvoiceWithConnection(connection, {
              customerAccountId, businessDayId: businessDay.id, locCode, macCode, txnDate,
              invoiceId, invoiceNumber, paymentId: paymentResult.insertId, paymentNo,
              documentNo: receiptNo, amount: p.amount, userId
            });
          }
        }

        if (cashShiftId) {
          const [shifts] = await connection.execute(
            `SELECT id, loc_code, mac_code, business_date, shift_no
             FROM cash_shifts
             WHERE id = ? AND loc_code = ? AND mac_code = ? AND business_date = ? AND status = 'open'
             FOR UPDATE`,
            [cashShiftId, locCode, macCode, txnDate]
          );
          if (shifts.length === 0) throw new Error('The cash shift is no longer open.');
          const [movementNumbers] = await connection.execute(
            'SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [cashShiftId]
          );
          let movementNo = Number(movementNumbers[0].max_no || 0);
          for (const movement of cashMovements) {
            movementNo += 1;
            await connection.execute(
              `INSERT INTO cash_movements
                 (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
                  movement_type, direction, amount, reference_type, reference_id, reason, created_by, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'invoice', ?, 'Sale settlement', ?, CAST(? AS JSON))`,
              [cashShiftId, shifts[0].loc_code, shifts[0].mac_code, shifts[0].business_date, shifts[0].shift_no, movementNo,
                movement.movementType, movement.direction, movement.amount, String(invoiceId), userId, JSON.stringify({ invoiceNumber })]
            );
          }
        }

        await connection.commit();
        return {
          invoiceId, invoiceNumber, receiptNo, status,
          grandTotal, paidTotal: tenderTotal, creditTotal, balance, cashAmt, changeAmt
        };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    listAllocationLotCandidates,
    rememberAllocationLot,
    clearRememberedAllocationLot,
    setLiveItemAllocationPriority,
    collectInvoiceBalance,
    getInvoice,
    searchInvoices,
    getInvoiceArchive,
    finalizeInvoice
  };
}

module.exports = {
  createBillingRepository
};
