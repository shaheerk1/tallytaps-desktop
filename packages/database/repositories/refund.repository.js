function createRefundRepository({ database, documentSequenceRepository, businessDayRepository }) {
  if (!database) {
    throw new Error('Refund repository requires a database instance.');
  }
  if (!documentSequenceRepository) {
    throw new Error('Refund repository requires the document sequence repository.');
  }

  const toNumber = (value) => Number(value || 0);
  const toMoney = (value) => Math.round(toNumber(value) * 100) / 100;

  function parseJson(value) {
    if (!value || typeof value === 'object') return value || {};
    try {
      return JSON.parse(value);
    } catch (_error) {
      return {};
    }
  }

  function readHeaderRows(rows) {
    const billHeader = {};
    for (const row of rows || []) {
      const pluginId = String(row.plugin_id || '').trim();
      const fieldKey = String(row.field_key || '').trim();
      if (!pluginId || !fieldKey) continue;
      if (!billHeader[pluginId]) {
        billHeader[pluginId] = {};
      }
      billHeader[pluginId][fieldKey] = row.field_value;
    }
    return billHeader;
  }

  function mapItem(row) {
    return {
      ...row,
      sourceQuantity: toNumber(row.source_quantity),
      sourceKilos: row.source_kilos == null ? null : toNumber(row.source_kilos),
      returnQuantity: row.return_quantity == null ? null : toNumber(row.return_quantity),
      returnKilos: row.return_kilos == null ? null : toNumber(row.return_kilos),
      unitPrice: toNumber(row.unit_price),
      discount: toMoney(row.discount),
      tax: toMoney(row.tax),
      sourceMerchandiseTotal: toMoney(row.source_merchandise_total),
      sourceBagChargeTotal: toMoney(row.source_bag_charge_total),
      sourceWageChargeTotal: toMoney(row.source_wage_charge_total),
      merchandiseTotal: toMoney(row.merchandise_total),
      bagChargeMode: row.bag_charge_mode || 'proportional',
      bagChargeTotal: toMoney(row.bag_charge_total),
      wageChargeMode: row.wage_charge_mode || 'proportional',
      wageChargeTotal: toMoney(row.wage_charge_total),
      total: toMoney(row.total),
      metadata: parseJson(row.metadata)
    };
  }

  async function searchSourceInvoices({ term = '', customerCode = '', locCode = '', macCode = '', txnDate = '', limit = 30 } = {}) {
    return database.withConnection(async (connection) => {
      const value = String(term).trim();
      const like = `%${value}%`;
      const location = String(locCode).trim();
      const machine = String(macCode).trim();
      const date = String(txnDate).slice(0, 10);
      const customer = String(customerCode).trim();
      // This MySQL server rejects a bound parameter in LIMIT. Keep the value
      // numeric and bounded before embedding it in the prepared statement.
      const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
      const [rows] = await connection.execute(
        `SELECT i.id, i.invoice_number, i.loc_code, i.mac_code, i.receipt_no, i.txn_date, i.customer_code,
                i.status, i.grand_total, i.paid_total, i.balance, i.created_at,
                COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.grand_total ELSE 0 END), 0) AS refunded_total
         FROM invoices i
         LEFT JOIN refunds r ON r.source_invoice_id = i.id
         WHERE i.inv_stat = 'active'
           AND i.status IN ('paid', 'partial')
           AND (? = '' OR i.loc_code = ?)
           AND (? = '' OR i.mac_code = ?)
           AND (? = '' OR (i.txn_date >= ? AND i.txn_date < DATE_ADD(?, INTERVAL 1 DAY)))
           AND (? = '' OR i.customer_code LIKE ?)
           AND (? = '' OR i.invoice_number LIKE ? OR CAST(i.receipt_no AS CHAR) LIKE ?)
         GROUP BY i.id
         ORDER BY i.created_at DESC
         LIMIT ${safeLimit}`,
        [location, location, machine, machine, date, date, date, customer, `%${customer}%`, value, like, like]
      );
      return rows.map((row) => ({
        ...row,
        grandTotal: toMoney(row.grand_total),
        paidTotal: toMoney(row.paid_total),
        balance: toMoney(row.balance),
        refundedTotal: toMoney(row.refunded_total),
        refundableTotal: toMoney(toNumber(row.grand_total) - toNumber(row.refunded_total))
      }));
    });
  }

  async function getSourceInvoice(invoiceId) {
    return database.withConnection(async (connection) => {
      const [invoices] = await connection.execute(
        `SELECT id, invoice_number, loc_code, mac_code, receipt_no, txn_date, status, customer_account_id, customer_code,
                subtotal, bag_charge_total, wage_charge_total, discount_total, tax_total, grand_total, paid_total, balance,
                metadata, created_at
         FROM invoices
         WHERE id = ? AND inv_stat = 'active' AND status IN ('paid', 'partial')
         LIMIT 1`,
        [invoiceId]
      );
      if (invoices.length === 0) return null;

      const [items] = await connection.execute(
        `SELECT ii.id, ii.seq_no, ii.product_id, ii.item_code, ii.supplier_code, ii.description,
                ii.quantity, ii.kilos, ii.unit_price, ii.discount, ii.tax,
                ii.merchandise_total, ii.bag_charge_total, ii.wage_charge_total, ii.total, ii.metadata,
                COALESCE(SUM(CASE WHEN r.status = 'completed' THEN ri.return_quantity ELSE 0 END), 0) AS refunded_quantity,
                COALESCE(SUM(CASE WHEN r.status = 'completed' THEN ri.return_kilos ELSE 0 END), 0) AS refunded_kilos,
                COALESCE(SUM(CASE WHEN r.status = 'completed' THEN ri.total ELSE 0 END), 0) AS refunded_total,
                COALESCE(SUM(CASE WHEN r.status = 'completed' THEN ri.bag_charge_total ELSE 0 END), 0) AS refunded_bag_charge_total,
                COALESCE(SUM(CASE WHEN r.status = 'completed' THEN ri.wage_charge_total ELSE 0 END), 0) AS refunded_wage_charge_total
         FROM invoice_items ii
         LEFT JOIN refund_items ri ON ri.source_invoice_item_id = ii.id
         LEFT JOIN refunds r ON r.id = ri.refund_id
         WHERE ii.invoice_id = ?
         GROUP BY ii.id
         ORDER BY ii.seq_no ASC`,
        [invoiceId]
      );
      const [payments] = await connection.execute(
        `SELECT method, amount, provider_ref AS providerRef, status
         FROM payments WHERE invoice_id = ? ORDER BY id ASC`,
        [invoiceId]
      );
      let customer = null;
      if (invoices[0].customer_account_id) {
        const [customers] = await connection.execute(
          `SELECT ca.id, ca.account_number, p.display_name,
                  COALESCE(SUM(CASE
                    WHEN e.entry_type IN ('sale_debit','refund_debit','cheque_dishonour_debit') THEN e.amount
                    WHEN e.entry_type IN ('collection_credit', 'return_credit','store_credit') THEN -e.amount
                    ELSE 0
                  END), 0) AS outstanding_balance
           FROM customer_accounts ca JOIN parties p ON p.id = ca.party_id
           LEFT JOIN customer_receivable_entries e ON e.customer_account_id = ca.id
           WHERE ca.id = ? GROUP BY ca.id, p.id`,
          [invoices[0].customer_account_id]
        );
        customer = customers[0] || null;
      }

      return {
        ...invoices[0],
        subtotal: toMoney(invoices[0].subtotal),
        bagChargeTotal: toMoney(invoices[0].bag_charge_total),
        wageChargeTotal: toMoney(invoices[0].wage_charge_total),
        discountTotal: toMoney(invoices[0].discount_total),
        taxTotal: toMoney(invoices[0].tax_total),
        grandTotal: toMoney(invoices[0].grand_total),
        paidTotal: toMoney(invoices[0].paid_total),
        balance: toMoney(invoices[0].balance),
        metadata: parseJson(invoices[0].metadata),
        billHeader: {},
        customer: customer ? {
          id: customer.id,
          accountNumber: customer.account_number,
          customerCode: invoices[0].customer_code,
          name: customer.display_name,
          outstandingBalance: toMoney(customer.outstanding_balance)
        } : null,
        payments: payments.map((payment) => ({ ...payment, amount: toMoney(payment.amount) })),
        items: items.map((item) => {
          const metadata = parseJson(item.metadata);
          const kilos = item.kilos == null
            ? (metadata.kilos == null || metadata.kilos === '' ? null : toNumber(metadata.kilos))
            : toNumber(item.kilos);
          const quantity = toNumber(item.quantity);
          const refundedQuantity = toNumber(item.refunded_quantity);
          const refundedKilos = toNumber(item.refunded_kilos);
          const refundedTotal = toMoney(item.refunded_total);
          return {
            id: item.id,
            seqNo: item.seq_no,
            productId: item.product_id,
            itemCode: item.item_code,
            description: item.description,
            qty: quantity,
            kilos,
          unitPrice: toMoney(item.unit_price),
          discount: toMoney(item.discount),
          tax: toMoney(item.tax),
          supplierCode: item.supplier_code || '',
          merchandiseTotal: toMoney(item.merchandise_total),
          bagChargeTotal: toMoney(item.bag_charge_total),
          wageChargeTotal: toMoney(item.wage_charge_total),
          total: toMoney(item.total),
            metadata,
            refundedQuantity,
            refundedKilos,
          refundedTotal,
          refundedBagChargeTotal: toMoney(item.refunded_bag_charge_total),
          refundedWageChargeTotal: toMoney(item.refunded_wage_charge_total),
            remainingQuantity: Math.max(0, quantity - refundedQuantity),
            remainingKilos: kilos == null ? null : Math.max(0, kilos - refundedKilos),
            remainingTotal: Math.max(0, toMoney(item.total) - refundedTotal),
            remainingBagChargeTotal: Math.max(0, toMoney(item.bag_charge_total) - toMoney(item.refunded_bag_charge_total)),
            remainingWageChargeTotal: Math.max(0, toMoney(item.wage_charge_total) - toMoney(item.refunded_wage_charge_total))
          };
        })
      };
    });
  }

  async function allocateRefundNo(connection, { locCode, macCode, txnDate }) {
    return documentSequenceRepository.allocateWithConnection(connection, {
      documentType: 'refund', locCode, macCode, txnDate
    });
  }

  async function createDraft({ sourceInvoiceId, sessionId, locCode, macCode, txnDate, userId, reason = '' }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode,
          businessDate: txnDate
        });
        const [source] = await connection.execute(
          `SELECT id FROM invoices
           WHERE id = ? AND inv_stat = 'active' AND status IN ('paid', 'partial') FOR UPDATE`,
          [sourceInvoiceId]
        );
        if (source.length === 0) throw new Error('The selected sale is not eligible for a refund.');
        const refundNo = await allocateRefundNo(connection, { locCode, macCode, txnDate });
        const [result] = await connection.execute(
          `INSERT INTO refund_drafts
             (business_day_id, source_invoice_id, session_id, loc_code, mac_code, refund_no, txn_date, status, reason, user_id, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, CAST(? AS JSON))`,
          [businessDay.id, sourceInvoiceId, sessionId || null, locCode, macCode, refundNo, txnDate, reason || null, userId || null, JSON.stringify({})]
        );
        await connection.execute(
          `INSERT INTO refund_audit_events
             (refund_draft_id, loc_code, mac_code, txn_date, refund_no, event_no, event_type, user_id, details)
           VALUES (?, ?, ?, ?, ?, 1, 'created', ?, CAST(? AS JSON))`,
          [result.insertId, locCode, macCode, txnDate, refundNo, userId || null, JSON.stringify({ sourceInvoiceId })]
        );
        await connection.commit();
        return { draftId: result.insertId, refundNo };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function getDraft(draftId) {
    return database.withConnection(async (connection) => {
      const [drafts] = await connection.execute(
        `SELECT d.*, i.invoice_number AS source_invoice_number, i.receipt_no AS source_receipt_no,
                i.txn_date AS source_txn_date, i.grand_total AS source_grand_total
         FROM refund_drafts d
         JOIN invoices i ON i.id = d.source_invoice_id
         WHERE d.id = ? LIMIT 1`,
        [draftId]
      );
      if (drafts.length === 0) return null;
      const [items] = await connection.execute(
        `SELECT * FROM refund_draft_items WHERE refund_draft_id = ? ORDER BY id ASC`,
        [draftId]
      );
      return {
        ...drafts[0],
        refundNo: Number(drafts[0].refund_no),
        sourceGrandTotal: toMoney(drafts[0].source_grand_total),
        metadata: parseJson(drafts[0].metadata),
        items: items.map(mapItem)
      };
    });
  }

  async function listActiveDrafts({ locCode, macCode, txnDate }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT d.id, d.refund_no AS refundNo, d.status, d.reason, d.user_id AS userId,
                d.created_at AS createdAt, d.updated_at AS updatedAt,
                i.invoice_number AS sourceInvoiceNumber,
                COUNT(di.id) AS itemCount,
                COALESCE(SUM(di.total), 0) AS grandTotal
         FROM refund_drafts d
         JOIN invoices i ON i.id = d.source_invoice_id
         LEFT JOIN refund_draft_items di ON di.refund_draft_id = d.id
         WHERE d.loc_code = ? AND d.mac_code = ? AND d.txn_date = ? AND d.status IN ('open', 'held')
         GROUP BY d.id
         ORDER BY CASE WHEN d.status = 'open' THEN 0 ELSE 1 END, d.updated_at DESC, d.id DESC`,
        [locCode, macCode, txnDate]
      );
      return rows.map((row) => ({ ...row, grandTotal: toMoney(row.grandTotal), itemCount: Number(row.itemCount) }));
    });
  }

  async function saveDraftItem(draftId, item) {
    return database.withConnection(async (connection) => {
      const [draft] = await connection.execute(
        `SELECT id, loc_code, mac_code, txn_date, refund_no
         FROM refund_drafts WHERE id = ? AND status IN ('open', 'held') LIMIT 1 FOR UPDATE`,
        [draftId]
      );
      if (draft.length === 0) throw new Error('Refund draft is not editable.');
      const [existingLine] = await connection.execute(
        `SELECT line_no FROM refund_draft_items
         WHERE refund_draft_id = ? AND source_invoice_item_id = ? LIMIT 1`,
        [draftId, item.sourceInvoiceItemId]
      );
      const [lineNumbers] = await connection.execute(
        'SELECT COALESCE(MAX(line_no), 0) AS max_no FROM refund_draft_items WHERE refund_draft_id = ?', [draftId]
      );
      const lineNo = Number(existingLine[0]?.line_no || 0) || Number(lineNumbers[0].max_no || 0) + 1;
      await connection.execute(
        `INSERT INTO refund_draft_items (
           refund_draft_id, loc_code, mac_code, txn_date, refund_no, line_no,
           source_invoice_item_id, product_id, supplier_code, item_code, description,
           source_quantity, source_kilos, return_quantity, return_kilos,
           unit_price, source_merchandise_total, source_bag_charge_total, source_wage_charge_total,
           discount, tax, merchandise_total, bag_charge_mode, bag_charge_total, wage_charge_mode, wage_charge_total,
           total, stock_disposition, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE
           return_quantity = VALUES(return_quantity), return_kilos = VALUES(return_kilos),
           discount = VALUES(discount), tax = VALUES(tax), merchandise_total = VALUES(merchandise_total),
           bag_charge_mode = VALUES(bag_charge_mode), bag_charge_total = VALUES(bag_charge_total),
           wage_charge_mode = VALUES(wage_charge_mode), wage_charge_total = VALUES(wage_charge_total), total = VALUES(total),
           stock_disposition = VALUES(stock_disposition), metadata = VALUES(metadata)`,
        [
          draftId, draft[0].loc_code, draft[0].mac_code, draft[0].txn_date, draft[0].refund_no, lineNo,
          item.sourceInvoiceItemId, item.productId || null, item.supplierCode || '', item.itemCode || '', item.description,
          item.sourceQuantity, item.sourceKilos, item.returnQuantity, item.returnKilos,
          item.unitPrice, item.sourceMerchandiseTotal, item.sourceBagChargeTotal, item.sourceWageChargeTotal,
          item.discount, item.tax, item.merchandiseTotal, item.bagChargeMode, item.bagChargeTotal, item.wageChargeMode, item.wageChargeTotal,
          item.total, item.stockDisposition || 'sellable',
          JSON.stringify(item.metadata || {})
        ]
      );
      return getDraft(draftId);
    });
  }

  async function removeDraftItem(draftId, sourceInvoiceItemId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        `DELETE di FROM refund_draft_items di
         JOIN refund_drafts d ON d.id = di.refund_draft_id
         WHERE di.refund_draft_id = ? AND di.source_invoice_item_id = ?
           AND d.status IN ('open', 'held')`,
        [draftId, sourceInvoiceItemId]
      );
      return getDraft(draftId);
    });
  }

  async function setDraftStatus(draftId, status, userId, eventType = status) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [drafts] = await connection.execute(
          `SELECT id, loc_code, mac_code, txn_date, refund_no
           FROM refund_drafts WHERE id = ? AND status IN ('open', 'held') FOR UPDATE`, [draftId]
        );
        if (!drafts.length) throw new Error('Refund draft is not editable.');
        await connection.execute(
          'UPDATE refund_drafts SET status = ?, user_id = COALESCE(?, user_id) WHERE id = ?',
          [status, userId || null, draftId]
        );
        const [eventNumbers] = await connection.execute(
          'SELECT COALESCE(MAX(event_no), 0) AS max_no FROM refund_audit_events WHERE refund_draft_id = ?', [draftId]
        );
        const draft = drafts[0];
        await connection.execute(
          `INSERT INTO refund_audit_events
             (refund_draft_id, loc_code, mac_code, txn_date, refund_no, event_no, event_type, user_id, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [draftId, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no, Number(eventNumbers[0].max_no || 0) + 1, eventType, userId || null, JSON.stringify({})]
        );
        await connection.commit();
        return getDraft(draftId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function getSettlementQuote(draftId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT d.id, i.customer_account_id, i.balance,
                COALESCE(SUM(di.total), 0) AS return_total
         FROM refund_drafts d
         JOIN invoices i ON i.id = d.source_invoice_id
         LEFT JOIN refund_draft_items di ON di.refund_draft_id = d.id
         WHERE d.id = ? AND d.status IN ('open', 'held')
         GROUP BY d.id, i.customer_account_id, i.balance`,
        [draftId]
      );
      if (!rows.length) throw new Error('Refund draft is not available for completion.');
      const row = rows[0];
      const returnTotal = toMoney(row.return_total);
      const outstandingBalance = toMoney(row.balance);
      if (outstandingBalance > 0.005 && !row.customer_account_id) {
        throw new Error('This historical credit sale has no customer account. Link or recreate it with a customer before processing a return.');
      }
      const debtReduction = row.customer_account_id ? toMoney(Math.min(returnTotal, outstandingBalance)) : 0;
      return {
        returnTotal,
        outstandingBalance,
        debtReduction,
        payoutDue: toMoney(returnTotal - debtReduction)
      };
    });
  }

  async function finalizeDraft({ draftId, payments, userId, reason, cashShiftId = null, cashMovements = [], expectedSettlement = null }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [drafts] = await connection.execute(
          `SELECT d.*, i.invoice_number AS source_invoice_number, i.status AS source_status,
                  i.paid_total AS source_paid_total, i.customer_account_id AS source_customer_account_id, i.balance AS source_balance
           FROM refund_drafts d JOIN invoices i ON i.id = d.source_invoice_id
           WHERE d.id = ? AND d.status IN ('open', 'held') FOR UPDATE`,
          [draftId]
        );
        if (drafts.length === 0) throw new Error('Refund draft is not available for completion.');
        const draft = drafts[0];
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: draft.loc_code,
          businessDate: draft.txn_date
        });
        const [items] = await connection.execute(
          `SELECT * FROM refund_draft_items WHERE refund_draft_id = ? FOR UPDATE`,
          [draftId]
        );
        if (items.length === 0) throw new Error('A refund requires at least one item.');

        let subtotal = 0;
        let merchandiseTotal = 0;
        let bagChargeTotal = 0;
        let wageChargeTotal = 0;
        let discountTotal = 0;
        let taxTotal = 0;
        let grandTotal = 0;
        for (const item of items) {
          const [sources] = await connection.execute(
            `SELECT id, invoice_id, quantity, kilos, merchandise_total, bag_charge_total, wage_charge_total, total, metadata FROM invoice_items WHERE id = ? FOR UPDATE`,
            [item.source_invoice_item_id]
          );
          if (sources.length === 0 || Number(sources[0].invoice_id) !== Number(draft.source_invoice_id)) {
            throw new Error('A refund item no longer belongs to the original sale.');
          }
          const [alreadyRows] = await connection.execute(
            `SELECT COALESCE(SUM(ri.return_quantity), 0) AS quantity,
                    COALESCE(SUM(ri.return_kilos), 0) AS kilos,
                    COALESCE(SUM(ri.total), 0) AS total,
                    COALESCE(SUM(ri.bag_charge_total), 0) AS bag_charge_total,
                    COALESCE(SUM(ri.wage_charge_total), 0) AS wage_charge_total
             FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
             WHERE ri.source_invoice_item_id = ? AND r.status = 'completed' FOR UPDATE`,
            [item.source_invoice_item_id]
          );
          const already = alreadyRows[0];
          const sourceQuantity = toNumber(sources[0].quantity);
          const sourceMeta = parseJson(sources[0].metadata);
          const sourceKilos = sources[0].kilos == null
            ? (sourceMeta.kilos == null || sourceMeta.kilos === '' ? null : toNumber(sourceMeta.kilos))
            : toNumber(sources[0].kilos);
          if (toNumber(item.return_quantity) > sourceQuantity - toNumber(already.quantity) + 0.0005) {
            throw new Error(`Return quantity exceeds the remaining amount for ${item.description}.`);
          }
          if (item.return_kilos != null && sourceKilos != null && toNumber(item.return_kilos) > sourceKilos - toNumber(already.kilos) + 0.0005) {
            throw new Error(`Return kilos exceed the remaining amount for ${item.description}.`);
          }
          if (toMoney(item.total) > toMoney(sources[0].total) - toMoney(already.total) + 0.005) {
            throw new Error(`Return value exceeds the remaining amount for ${item.description}.`);
          }
          if (toMoney(item.bag_charge_total) > toMoney(sources[0].bag_charge_total) - toMoney(already.bag_charge_total) + 0.005) {
            throw new Error(`Bag charge refund exceeds the remaining charge for ${item.description}.`);
          }
          if (toMoney(item.wage_charge_total) > toMoney(sources[0].wage_charge_total) - toMoney(already.wage_charge_total) + 0.005) {
            throw new Error(`Wage charge refund exceeds the remaining charge for ${item.description}.`);
          }
          subtotal += toMoney(item.merchandise_total);
          merchandiseTotal += toMoney(item.merchandise_total);
          bagChargeTotal += toMoney(item.bag_charge_total);
          wageChargeTotal += toMoney(item.wage_charge_total);
          discountTotal += toMoney(item.discount);
          taxTotal += toMoney(item.tax);
          grandTotal += toMoney(item.total);
        }
        subtotal = toMoney(subtotal);
        merchandiseTotal = toMoney(merchandiseTotal);
        bagChargeTotal = toMoney(bagChargeTotal);
        wageChargeTotal = toMoney(wageChargeTotal);
        discountTotal = toMoney(discountTotal);
        taxTotal = toMoney(taxTotal);
        grandTotal = toMoney(grandTotal);
        const outstandingBalance = toMoney(draft.source_balance);
        if (outstandingBalance > 0.005 && !draft.source_customer_account_id) {
          throw new Error('This historical credit sale has no customer account. Link or recreate it with a customer before processing a return.');
        }
        const debtReduction = draft.source_customer_account_id ? toMoney(Math.min(grandTotal, outstandingBalance)) : 0;
        const payoutDue = toMoney(grandTotal - debtReduction);
        const payoutTotal = toMoney((payments || []).reduce((sum, payment) => sum + toMoney(payment.amount), 0));
        if (Math.abs(payoutTotal - payoutDue) > 0.005) {
          throw new Error(`Refund payout must equal ${payoutDue.toFixed(2)} after outstanding debt is applied.`);
        }
        if (expectedSettlement && Math.abs(toMoney(expectedSettlement.payoutDue) - payoutDue) > 0.005) {
          throw new Error('The outstanding balance changed while this refund was open. Review the settlement and try again.');
        }

        const refundNumber = `REF-${draft.loc_code}-${draft.mac_code}-${String(draft.txn_date).replace(/-/g, '')}-${String(draft.refund_no).padStart(6, '0')}`;
        const [refundResult] = await connection.execute(
          `INSERT INTO refunds (
             business_day_id, refund_number, source_invoice_id, source_invoice_number, loc_code, mac_code, refund_no, txn_date, cash_shift_id,
             status, reason, subtotal, merchandise_total, bag_charge_total, wage_charge_total, discount_total, tax_total, grand_total, refunded_total, user_id, metadata
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [
            businessDay.id, refundNumber, draft.source_invoice_id, draft.source_invoice_number, draft.loc_code, draft.mac_code,
            draft.refund_no, draft.txn_date, cashShiftId, reason || draft.reason || 'Customer return',
            subtotal, merchandiseTotal, bagChargeTotal, wageChargeTotal, discountTotal, taxTotal, grandTotal, payoutTotal, userId || draft.user_id || null,
            JSON.stringify({ refundDraftId: draftId, outstandingBalance, debtReduction, payoutDue })
          ]
        );
        const refundId = refundResult.insertId;
        let receivableEntryNo = 0;
        if (debtReduction > 0) {
          receivableEntryNo += 1;
          await connection.execute(
            `INSERT INTO customer_receivable_entries
               (business_day_id, customer_account_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no,
                invoice_id, refund_id, entry_type, amount, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, 'return_credit', ?, 'Return applied to outstanding balance', ?, CAST(? AS JSON))`,
            [businessDay.id, draft.source_customer_account_id, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no, receivableEntryNo,
              draft.source_invoice_id, refundId, debtReduction, userId || draft.user_id || null, JSON.stringify({ refundNumber })]
          );
          const remainingBalance = toMoney(outstandingBalance - debtReduction);
          await connection.execute(
            `UPDATE invoices SET balance = ?, status = CASE WHEN ? <= 0.005 THEN 'paid' ELSE 'partial' END WHERE id = ?`,
            [remainingBalance, remainingBalance, draft.source_invoice_id]
          );
        }
        if (payoutTotal > 0 && draft.source_customer_account_id) {
          receivableEntryNo += 1;
          await connection.execute(
            `INSERT INTO customer_receivable_entries
               (business_day_id, customer_account_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no,
                invoice_id, refund_id, cash_shift_id, entry_type, amount, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, 'refund_debit', ?, 'Refund payout after debt settlement', ?, CAST(? AS JSON))`,
            [businessDay.id, draft.source_customer_account_id, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no, receivableEntryNo,
              draft.source_invoice_id, refundId, cashShiftId, payoutTotal, userId || draft.user_id || null, JSON.stringify({ refundNumber })]
          );
        }
        let refundLineNo = 0;
        for (const item of items) {
          refundLineNo += 1;
          const [refundItemResult] = await connection.execute(
            `INSERT INTO refund_items (
               refund_id, loc_code, mac_code, txn_date, refund_no, line_no,
               source_invoice_item_id, product_id, supplier_code, item_code, description,
               source_quantity, source_kilos, return_quantity, return_kilos,
               unit_price, discount, tax, merchandise_total, bag_charge_mode, bag_charge_total, wage_charge_mode, wage_charge_total,
               total, stock_disposition, metadata
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [
              refundId, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no, refundLineNo,
              item.source_invoice_item_id, item.product_id, item.supplier_code || '', item.item_code, item.description,
              item.source_quantity, item.source_kilos, item.return_quantity, item.return_kilos,
              item.unit_price, item.discount, item.tax, item.merchandise_total, item.bag_charge_mode, item.bag_charge_total,
              item.wage_charge_mode, item.wage_charge_total, item.total, item.stock_disposition, item.metadata
            ]
          );
          if (item.stock_disposition !== 'sellable' || !item.product_id) continue;

          // Restock only a source line that has an original sale deduction.
          // This keeps older pre-ledger invoices and non-stock returns from
          // creating inventory that was never deducted.
          const [sourceMovements] = await connection.execute(
            `SELECT id FROM stock_movements
             WHERE reference_type = 'invoice_item' AND reference_id = ? AND movement_type = 'sale'
             LIMIT 1 FOR UPDATE`,
            [String(item.source_invoice_item_id)]
          );
          if (sourceMovements.length === 0) continue;

          const movementQty = Number(item.return_kilos == null ? item.return_quantity : item.return_kilos);
          if (!Number.isFinite(movementQty) || movementQty <= 0) continue;
          await connection.execute(
            `INSERT INTO stock_movements
               (product_id, loc_code, mac_code, quantity, business_date, document_type, document_no, line_no, event_no,
                movement_type, reference_type, reference_id, note, created_by)
             VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, 1, 'return', 'refund_item', ?, 'Sellable customer return', ?)`,
            [item.product_id, draft.loc_code, draft.mac_code, movementQty, draft.txn_date,
              draft.refund_no, refundLineNo, String(refundItemResult.insertId), userId || draft.user_id || null]
          );
          await connection.execute(
            'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?',
            [movementQty, item.product_id]
          );

          // Restore the original FIFO lot allocation proportionally. This is
          // independent of generic stock so supplier settlement remains tied
          // to the actual consignment load that was returned.
          const byKilos = item.return_kilos != null;
          let remainingAllocation = movementQty;
          let returnAllocationNo = 0;
          const [allocations] = await connection.execute(
            `SELECT a.*, l.supplier_id, l.ownership_model, l.terms_snapshot
             FROM lot_sale_allocations a JOIN inventory_lots l ON l.id = a.inventory_lot_id
             WHERE a.invoice_item_id = ? ORDER BY a.id ASC FOR UPDATE`,
            [item.source_invoice_item_id]
          );
          for (const allocation of allocations) {
            if (remainingAllocation <= 0.0005) break;
            const measure = Number(byKilos ? allocation.kilos : allocation.quantity);
            if (!Number.isFinite(measure) || measure <= 0) continue;
            const [returnedRows] = await connection.execute(
              `SELECT COALESCE(SUM(${byKilos ? 'kilos' : 'quantity'}), 0) AS returned_measure
               FROM lot_sale_allocations WHERE source_allocation_id = ? FOR UPDATE`, [allocation.id]
            );
            const available = measure - Number(returnedRows[0].returned_measure || 0);
            const restored = Math.min(remainingAllocation, Math.max(0, available));
            if (restored <= 0.0005) continue;
            const returnValue = toMoney(Number(allocation.sale_value) * (restored / measure));
            returnAllocationNo += 1;
            await connection.execute(
              `INSERT INTO lot_sale_allocations
                 (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no,
                  refund_item_id, source_allocation_id, quantity, kilos, sale_value)
               VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?)`,
              [allocation.inventory_lot_id, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no,
                refundLineNo, returnAllocationNo, refundItemResult.insertId, allocation.id,
                byKilos ? 0 : restored, byKilos ? restored : null, -returnValue]
            );
            await connection.execute(
              `UPDATE inventory_lots SET ${byKilos ? 'remaining_kilos' : 'remaining_quantity'} = ${byKilos ? 'remaining_kilos' : 'remaining_quantity'} + ? WHERE id = ?`,
              [restored, allocation.inventory_lot_id]
            );
            if (allocation.ownership_model === 'consignment') {
              const terms = parseJson(allocation.terms_snapshot);
              const rate = Number(terms.commissionRate || 0);
              const supplierCredit = toMoney(returnValue * Math.max(0, 1 - rate / 100));
              await connection.execute(
                `INSERT INTO supplier_payable_entries
                   (supplier_id, loc_code, mac_code, inventory_lot_id, entry_type, amount, business_date,
                    document_type, document_no, line_no, entry_no, reason, created_by, metadata)
                 VALUES (?, ?, ?, ?, 'return_credit', ?, ?, 'refund', ?, ?, ?, 'Sellable customer return', ?, CAST(? AS JSON))`,
                [allocation.supplier_id, draft.loc_code, draft.mac_code, allocation.inventory_lot_id, -supplierCredit,
                  draft.txn_date, draft.refund_no, refundLineNo, returnAllocationNo, userId || draft.user_id || null,
                  JSON.stringify({ refundItemId: refundItemResult.insertId, sourceAllocationId: allocation.id })]
              );
            }
            remainingAllocation -= restored;
          }
        }
        let refundPaymentNo = 0;
        for (const payment of payments || []) {
          refundPaymentNo += 1;
          await connection.execute(
            `INSERT INTO refund_payments
               (refund_id, loc_code, mac_code, txn_date, refund_no, payment_no, method, amount, provider_ref, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
            [refundId, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no, refundPaymentNo, payment.method, payment.amount, payment.providerRef || null]
          );
        }
        if (cashShiftId) {
          const [shifts] = await connection.execute(
            `SELECT id, loc_code, mac_code, business_date, shift_no
             FROM cash_shifts
             WHERE id = ? AND loc_code = ? AND mac_code = ? AND business_date = ? AND status = 'open'
             FOR UPDATE`, [cashShiftId, draft.loc_code, draft.mac_code, draft.txn_date]
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
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'refund', ?, 'Refund payout', ?, CAST(? AS JSON))`,
              [cashShiftId, shifts[0].loc_code, shifts[0].mac_code, shifts[0].business_date, shifts[0].shift_no, movementNo,
                movement.movementType, movement.direction, movement.amount, String(refundId), userId, JSON.stringify({ refundNumber })]
            );
          }
        }
        await connection.execute(`UPDATE refund_drafts SET status = 'completed' WHERE id = ?`, [draftId]);
        const [eventNumbers] = await connection.execute(
          'SELECT COALESCE(MAX(event_no), 0) AS max_no FROM refund_audit_events WHERE refund_draft_id = ?', [draftId]
        );
        await connection.execute(
          `INSERT INTO refund_audit_events
             (refund_draft_id, refund_id, loc_code, mac_code, txn_date, refund_no, event_no, event_type, user_id, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, CAST(? AS JSON))`,
          [draftId, refundId, draft.loc_code, draft.mac_code, draft.txn_date, draft.refund_no,
            Number(eventNumbers[0].max_no || 0) + 1, userId || draft.user_id || null, JSON.stringify({ refundNumber, grandTotal })]
        );
        await connection.commit();
        return { refundId, refundNumber, refundNo: Number(draft.refund_no), grandTotal, paidTotal: payoutTotal, debtReduction, payoutDue };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    searchSourceInvoices,
    getSourceInvoice,
    createDraft,
    getDraft,
    listActiveDrafts,
    saveDraftItem,
    removeDraftItem,
    setDraftStatus,
    getSettlementQuote,
    finalizeDraft
  };
}

module.exports = { createRefundRepository };
