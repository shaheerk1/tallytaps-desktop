const requestContext = require('../../core/security/request-context');
function createPartyRepository({ database, businessDayRepository }) {
  if (!database) throw new Error('Party repository requires a database instance.');

  const RESERVED_MARKET_CODES = new Set(['X', 'UNKNOWN', 'WALKIN', 'WALK-IN', 'N/A', 'NA']);

  function text(value, maxLength = 255) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  function normalizeMarketCode(value) {
    return String(value ?? '').trim().toUpperCase();
  }

  function requireOrigin(originValue) {
    // Inside an IPC request, where a customer is created is always the
    // signed-in workstation; the value sent is ignored.
    const origin = requestContext.current() ? requestContext.resolveOrigin(originValue || {}) : originValue;
    const locCode = text(origin?.locCode || origin?.locationCode, 50);
    const macCode = text(origin?.macCode || origin?.machineCode, 50);
    const txnDate = text(origin?.txnDate || origin?.billingDate || origin?.businessDate, 10);
    if (!locCode || !macCode) throw new Error('The current workstation origin is required.');
    return { locCode, macCode, txnDate };
  }

  async function allocateMasterNumber(connection, recordType, origin) {
    await connection.execute(
      `INSERT IGNORE INTO master_record_sequences (record_type, loc_code, mac_code, next_number)
       VALUES (?, ?, ?, 1)`,
      [recordType, origin.locCode, origin.macCode]
    );
    const [rows] = await connection.execute(
      `SELECT next_number FROM master_record_sequences
       WHERE record_type = ? AND loc_code = ? AND mac_code = ? FOR UPDATE`,
      [recordType, origin.locCode, origin.macCode]
    );
    const number = Number(rows[0]?.next_number || 1);
    await connection.execute(
      `UPDATE master_record_sequences SET next_number = ?
       WHERE record_type = ? AND loc_code = ? AND mac_code = ?`,
      [number + 1, recordType, origin.locCode, origin.macCode]
    );
    return number;
  }

  function accountNumber(origin, number) {
    const segment = (value) => String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || 'POS';
    return `C-${segment(origin.locCode)}-${segment(origin.macCode)}-${String(number).padStart(6, '0')}`;
  }

  function partyNumber(origin, number) {
    const segment = (value) => String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || 'POS';
    return `P-${segment(origin.locCode)}-${segment(origin.macCode)}-${String(number).padStart(6, '0')}`;
  }

  function receivableBalanceSql(alias = 'e') {
    return `CASE
      WHEN ${alias}.entry_type IN ('sale_debit','refund_debit','cheque_dishonour_debit','payment_reversal_debit') THEN ${alias}.amount
      WHEN ${alias}.entry_type IN ('collection_credit','return_credit','store_credit') THEN -${alias}.amount
      WHEN ${alias}.entry_type = 'manager_adjustment' THEN ${alias}.amount
      ELSE 0 END`;
  }

  async function searchCustomerAccounts(term = '', options = {}) {
    // Each location keeps its own customers.
    const scope = requestContext.scopedLocation(options);
    return database.withConnection(async (connection) => {
      const value = String(term || '').trim();
      const like = `%${value}%`;
      const outstandingOnly = Boolean(options.outstandingOnly);
      const balanceDirection = String(options.balanceOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const activityDirection = String(options.activityOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const orderClause = String(options.sortBy).toLowerCase() === 'activity'
        ? `rb.last_activity_at ${activityDirection}, outstanding_balance ${balanceDirection}, p.display_name ASC`
        : `outstanding_balance ${balanceDirection}, rb.last_activity_at ${activityDirection}, p.display_name ASC`;
      const [rows] = await connection.execute(
        `SELECT ca.id, ca.account_number, ca.credit_enabled, ca.credit_limit, ca.payment_terms_days, ca.status,
                p.id AS party_id, p.party_number, p.display_name, p.legal_name, p.party_type, p.shop_name,
                p.mobile, p.phone, p.email, p.address, p.locality, p.secondary_tag, p.notes,
                GROUP_CONCAT(DISTINCT CASE WHEN pi.identifier_type = 'market_code' AND pi.status = 'active'
                  THEN pi.identifier_value END ORDER BY pi.is_primary DESC, pi.id SEPARATOR ', ') AS market_codes,
                COALESCE(rb.outstanding_balance, 0) AS outstanding_balance,
                rb.last_activity_at
         FROM customer_accounts ca
         JOIN parties p ON p.id = ca.party_id
         LEFT JOIN party_identifiers pi ON pi.party_id = p.id
         LEFT JOIN (
           SELECT customer_account_id, SUM(${receivableBalanceSql('e')}) AS outstanding_balance,
                  MAX(created_at) AS last_activity_at
           FROM customer_receivable_entries e GROUP BY customer_account_id
         ) rb ON rb.customer_account_id = ca.id
         WHERE ca.status <> 'closed' AND p.status <> 'merged'
           AND (? IS NULL OR ca.loc_code = ?)
           AND (? = '' OR ca.account_number LIKE ? OR p.display_name LIKE ? OR p.shop_name LIKE ?
                OR p.mobile LIKE ? OR p.phone LIKE ? OR p.locality LIKE ? OR p.secondary_tag LIKE ?
                OR EXISTS (SELECT 1 FROM party_identifiers sx WHERE sx.party_id = p.id AND sx.status = 'active'
                           AND (sx.identifier_value LIKE ? OR sx.normalized_value LIKE UPPER(?))))
         GROUP BY ca.id, p.id, rb.outstanding_balance, rb.last_activity_at
         ${outstandingOnly ? 'HAVING outstanding_balance > 0.005' : ''}
         ORDER BY ${orderClause}
         LIMIT 100`,
        [scope, scope, value, like, like, like, like, like, like, like, like, like]
      );
      return rows.map((row) => ({
        ...row,
        name: row.display_name,
        customer_code: row.market_codes ? String(row.market_codes).split(', ')[0] : null,
        marketCodes: row.market_codes ? String(row.market_codes).split(', ') : [],
        outstandingBalance: Number(row.outstanding_balance || 0),
        lastActivityAt: row.last_activity_at || null,
        creditEnabled: Boolean(row.credit_enabled)
      }));
    });
  }

  async function getCustomerAccount(customerAccountId) {
    return database.withConnection(async (connection) => {
      await assertCustomerInScope(connection, customerAccountId);
      return getCustomerAccountWithConnection(connection, customerAccountId);
    });
  }

  /** A customer can only be read or changed from the location that owns it. */
  async function assertCustomerInScope(connection, customerAccountId) {
    const scope = requestContext.scopedLocation();
    if (!scope) return;
    const [rows] = await connection.execute(
      'SELECT id FROM customer_accounts WHERE id = ? AND loc_code = ? LIMIT 1', [Number(customerAccountId), scope]
    );
    if (!rows.length) throw new Error('This customer belongs to another location.');
  }

  async function getCustomerAccountWithConnection(connection, customerAccountId) {
    const [accounts] = await connection.execute(
      `SELECT ca.*, p.id AS party_id, p.party_number, p.display_name, p.legal_name, p.party_type,
              p.shop_name, p.mobile, p.phone, p.email, p.address, p.locality, p.secondary_tag,
              p.notes AS party_notes, p.status AS party_status,
              COALESCE(rb.outstanding_balance, 0) AS outstanding_balance,
              COALESCE(cx.cheque_exposure, 0) AS cheque_exposure
       FROM customer_accounts ca
       JOIN parties p ON p.id = ca.party_id
       LEFT JOIN (SELECT customer_account_id, SUM(${receivableBalanceSql('e')}) AS outstanding_balance
                  FROM customer_receivable_entries e GROUP BY customer_account_id) rb ON rb.customer_account_id = ca.id
       LEFT JOIN (SELECT received_from_customer_account_id,
                         SUM(CASE WHEN status IN ('received','deposited') THEN amount ELSE 0 END) AS cheque_exposure
                  FROM cheques GROUP BY received_from_customer_account_id) cx ON cx.received_from_customer_account_id = ca.id
       WHERE ca.id = ? LIMIT 1`,
      [customerAccountId]
    );
    if (!accounts.length) return null;
    const row = accounts[0];
    const [identifiers] = await connection.execute(
      `SELECT id, identifier_type, identifier_value, valid_from, valid_until, is_primary, status
       FROM party_identifiers WHERE party_id = ? ORDER BY status, is_primary DESC, id`,
      [row.party_id]
    );
    const [invoices] = await connection.execute(
      `SELECT id, invoice_number, loc_code, mac_code, receipt_no, customer_code, txn_date, due_date, status, grand_total, paid_total, balance
       FROM invoices WHERE customer_account_id = ? AND balance > 0.005 ORDER BY due_date, txn_date, id`,
      [customerAccountId]
    );
    const [entries] = await connection.execute(
      `SELECT e.*, i.invoice_number, r.refund_number,
              CASE WHEN e.invoice_id IS NOT NULL THEN i.txn_date
                   WHEN e.refund_id IS NOT NULL THEN r.txn_date ELSE e.txn_date END AS transaction_date
       FROM customer_receivable_entries e
       LEFT JOIN invoices i ON i.id = e.invoice_id
       LEFT JOIN refunds r ON r.id = e.refund_id
       WHERE e.customer_account_id = ? ORDER BY e.txn_date DESC, e.id DESC`,
      [customerAccountId]
    );
    const customer = {
      id: Number(row.id),
      accountNumber: row.account_number,
      partyId: Number(row.party_id),
      partyNumber: row.party_number,
      name: row.display_name,
      displayName: row.display_name,
      legalName: row.legal_name,
      partyType: row.party_type,
      shopName: row.shop_name,
      mobile: row.mobile,
      phone: row.phone,
      email: row.email,
      address: row.address,
      locality: row.locality,
      secondaryTag: row.secondary_tag,
      notes: row.party_notes || row.notes,
      is_active: row.status === 'active' && row.party_status === 'active' ? 1 : 0,
      status: row.status,
      creditEnabled: Boolean(row.credit_enabled),
      creditLimit: row.credit_limit == null ? null : Number(row.credit_limit),
      paymentTermsDays: Number(row.payment_terms_days || 0),
      outstandingBalance: Number(row.outstanding_balance || 0),
      chequeExposure: Number(row.cheque_exposure || 0),
      totalExposure: Number(row.outstanding_balance || 0) + Number(row.cheque_exposure || 0),
      customer_code: identifiers.find((identifier) => identifier.identifier_type === 'market_code' && identifier.status === 'active')?.identifier_value || null,
      marketCodes: identifiers.filter((identifier) => identifier.identifier_type === 'market_code' && identifier.status === 'active').map((identifier) => identifier.identifier_value)
    };
    return {
      customer,
      account: customer,
      party: customer,
      identifiers,
      openInvoices: invoices.map((invoice) => ({
        ...invoice,
        grandTotal: Number(invoice.grand_total || 0),
        paidTotal: Number(invoice.paid_total || 0),
        balance: Number(invoice.balance || 0)
      })),
      entries: entries.map((entry) => ({ ...entry, amount: Number(entry.amount || 0) }))
    };
  }

  async function createCustomer(payload, originValue, userId = null) {
    const origin = requireOrigin(originValue);
    const displayName = text(payload?.displayName || payload?.name || payload?.shopName, 190);
    if (!displayName) throw new Error('Customer display name or shop name is required.');
    const marketCodes = Array.from(new Set((Array.isArray(payload?.marketCodes) ? payload.marketCodes : [payload?.customerCode])
      .map(normalizeMarketCode).filter(Boolean)));
    if (marketCodes.some((code) => RESERVED_MARKET_CODES.has(code))) {
      throw new Error('Walk-in codes such as X cannot be assigned to a permanent customer account.');
    }
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const partyNo = await allocateMasterNumber(connection, 'party', origin);
        const [partyResult] = await connection.execute(
          `INSERT INTO parties
             (loc_code, mac_code, party_no, party_number, display_name, legal_name, party_type, shop_name,
              mobile, phone, email, address, locality, secondary_tag, notes, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [origin.locCode, origin.macCode, partyNo, partyNumber(origin, partyNo), displayName,
            text(payload?.legalName, 190), ['person', 'business', 'other'].includes(payload?.partyType) ? payload.partyType : 'other',
            text(payload?.shopName, 190), text(payload?.mobile, 60), text(payload?.phone, 60), text(payload?.email, 190),
            text(payload?.address, 4000), text(payload?.locality, 160), text(payload?.secondaryTag, 120), text(payload?.notes, 4000),
            payload?.isActive === false ? 'inactive' : 'active', userId]
        );
        const partyId = Number(partyResult.insertId);
        await connection.execute(`INSERT INTO party_roles (party_id, role_key) VALUES (?, 'customer')`, [partyId]);
        const accountNo = await allocateMasterNumber(connection, 'customer_account', origin);
        const [accountResult] = await connection.execute(
          `INSERT INTO customer_accounts
             (loc_code, mac_code, account_no, account_number, party_id, credit_enabled, credit_limit,
              payment_terms_days, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [origin.locCode, origin.macCode, accountNo, accountNumber(origin, accountNo), partyId,
            payload?.creditEnabled ? 1 : 0, payload?.creditLimit === '' || payload?.creditLimit == null ? null : Number(payload.creditLimit),
            Math.max(0, Number(payload?.paymentTermsDays || 0)), payload?.isActive === false ? 'inactive' : 'active',
            text(payload?.accountNotes, 4000), userId]
        );
        for (let index = 0; index < marketCodes.length; index += 1) {
          const identifierNo = await allocateMasterNumber(connection, 'party_identifier', origin);
          await connection.execute(
            `INSERT INTO party_identifiers
               (loc_code, mac_code, identifier_no, party_id, identifier_type, identifier_value,
                normalized_value, is_primary, created_by)
             VALUES (?, ?, ?, ?, 'market_code', ?, ?, ?, ?)`,
            [origin.locCode, origin.macCode, identifierNo, partyId, marketCodes[index], marketCodes[index], index === 0 ? 1 : 0, userId]
          );
        }
        await connection.commit();
        return getCustomerAccount(Number(accountResult.insertId));
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function updateCustomer(customerAccountId, payload, originValue, userId = null) {
    const origin = requireOrigin(originValue);
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await assertCustomerInScope(connection, customerAccountId);
        const [rows] = await connection.execute(
          `SELECT ca.id, ca.party_id FROM customer_accounts ca WHERE ca.id = ? FOR UPDATE`,
          [customerAccountId]
        );
        if (!rows.length) throw new Error('Customer account not found.');
        const partyId = Number(rows[0].party_id);
        const displayName = text(payload?.displayName || payload?.name || payload?.shopName, 190);
        if (!displayName) throw new Error('Customer display name or shop name is required.');
        await connection.execute(
          `UPDATE parties SET display_name = ?, legal_name = ?, party_type = ?, shop_name = ?, mobile = ?, phone = ?,
             email = ?, address = ?, locality = ?, secondary_tag = ?, notes = ?, status = ? WHERE id = ?`,
          [displayName, text(payload?.legalName, 190), ['person', 'business', 'other'].includes(payload?.partyType) ? payload.partyType : 'other',
            text(payload?.shopName, 190), text(payload?.mobile, 60), text(payload?.phone, 60), text(payload?.email, 190),
            text(payload?.address, 4000), text(payload?.locality, 160), text(payload?.secondaryTag, 120), text(payload?.notes, 4000),
            payload?.isActive === false ? 'inactive' : 'active', partyId]
        );
        await connection.execute(
          `UPDATE customer_accounts SET credit_enabled = ?, credit_limit = ?, payment_terms_days = ?, status = ?, notes = ? WHERE id = ?`,
          [payload?.creditEnabled ? 1 : 0, payload?.creditLimit === '' || payload?.creditLimit == null ? null : Number(payload.creditLimit),
            Math.max(0, Number(payload?.paymentTermsDays || 0)), payload?.isActive === false ? 'inactive' : 'active',
            text(payload?.accountNotes, 4000), customerAccountId]
        );
        if (payload?.marketCodes !== undefined || payload?.customerCode !== undefined) {
          const marketCodes = Array.from(new Set((Array.isArray(payload?.marketCodes) ? payload.marketCodes : [payload?.customerCode])
            .map(normalizeMarketCode).filter(Boolean)));
          if (marketCodes.some((code) => RESERVED_MARKET_CODES.has(code))) {
            throw new Error('Walk-in codes such as X cannot be assigned to a permanent customer account.');
          }
          await connection.execute(
            `UPDATE party_identifiers SET status = 'inactive', is_primary = 0
             WHERE party_id = ? AND identifier_type = 'market_code'`,
            [partyId]
          );
          for (let index = 0; index < marketCodes.length; index += 1) {
            const [existing] = await connection.execute(
              `SELECT id FROM party_identifiers WHERE party_id = ? AND identifier_type = 'market_code' AND normalized_value = ? LIMIT 1`,
              [partyId, marketCodes[index]]
            );
            if (existing.length) {
              await connection.execute(`UPDATE party_identifiers SET identifier_value = ?, status = 'active', is_primary = ? WHERE id = ?`,
                [marketCodes[index], index === 0 ? 1 : 0, existing[0].id]);
            } else {
              const identifierNo = await allocateMasterNumber(connection, 'party_identifier', origin);
              await connection.execute(
                `INSERT INTO party_identifiers
                   (loc_code, mac_code, identifier_no, party_id, identifier_type, identifier_value, normalized_value, is_primary, created_by)
                 VALUES (?, ?, ?, ?, 'market_code', ?, ?, ?, ?)`,
                [origin.locCode, origin.macCode, identifierNo, partyId, marketCodes[index], marketCodes[index], index === 0 ? 1 : 0, userId]
              );
            }
          }
        }
        await connection.commit();
        return getCustomerAccount(customerAccountId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function assignInvoiceCustomer({ invoiceId, customerAccountId = null, reason = '', userId = null, origin: originValue }) {
    const origin = requireOrigin(originValue);
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [invoices] = await connection.execute(
          `SELECT id, loc_code, mac_code, txn_date, receipt_no, customer_code, customer_account_id, balance
           FROM invoices WHERE id = ? FOR UPDATE`,
          [invoiceId]
        );
        if (!invoices.length) throw new Error('Invoice not found.');
        const invoice = invoices[0];
        const nextAccountId = customerAccountId == null ? null : Number(customerAccountId);
        if (Number(invoice.customer_account_id || 0) === Number(nextAccountId || 0)) {
          await connection.rollback();
          return { invoiceId: Number(invoice.id), customerAccountId: nextAccountId, unchanged: true };
        }
        if (!nextAccountId && Number(invoice.balance || 0) > 0.005) {
          throw new Error('An invoice with an outstanding balance cannot be unlinked from its customer account.');
        }
        const previousId = invoice.customer_account_id == null ? null : Number(invoice.customer_account_id);
        const [advanceAllocations] = await connection.execute(
          'SELECT id FROM invoice_advance_allocations WHERE invoice_id = ? LIMIT 1', [invoiceId]
        );
        if (advanceAllocations.length && previousId !== nextAccountId) {
          throw new Error('This invoice used customer advance money and cannot be reassigned to another customer. Refund or correct the advance transaction first.');
        }
        if (previousId && previousId !== nextAccountId && !text(reason, 255)) {
          throw new Error('A reason is required when changing or removing an invoice customer account.');
        }
        if (!nextAccountId) {
          const [linkedCheques] = await connection.execute(
            `SELECT id FROM cheques WHERE invoice_id = ? AND status IN ('received','deposited') LIMIT 1`,
            [invoiceId]
          );
          if (linkedCheques.length) {
            throw new Error('An invoice with an uncleared cheque cannot be unlinked from its liable customer account.');
          }
        }
        let termsDays = 0;
        if (nextAccountId) {
          const [accounts] = await connection.execute(
            `SELECT id, payment_terms_days, credit_enabled FROM customer_accounts WHERE id = ? AND status = 'active' LIMIT 1`,
            [nextAccountId]
          );
          if (!accounts.length) throw new Error('Select an active customer account.');
          if (Number(invoice.balance || 0) > 0.005 && !accounts[0].credit_enabled) {
            throw new Error('Credit is not enabled for the selected customer account.');
          }
          termsDays = Number(accounts[0].payment_terms_days || 0);
        }
        await connection.execute(
          `UPDATE invoices SET customer_account_id = ?,
             due_date = CASE WHEN balance > 0.005 AND ? IS NOT NULL THEN DATE_ADD(txn_date, INTERVAL ? DAY) ELSE NULL END
           WHERE id = ?`,
          [nextAccountId, nextAccountId, termsDays, invoiceId]
        );
        await connection.execute(`UPDATE invoice_items SET customer_account_id = ? WHERE invoice_id = ?`, [nextAccountId, invoiceId]);
        if (nextAccountId) {
          await connection.execute(`UPDATE customer_receivable_entries SET customer_account_id = ? WHERE invoice_id = ?`, [nextAccountId, invoiceId]);
          await connection.execute(`UPDATE cheques SET received_from_customer_account_id = ? WHERE invoice_id = ?`, [nextAccountId, invoiceId]);
        }
        const [numbers] = await connection.execute(
          `SELECT COALESCE(MAX(assignment_no), 0) AS max_no FROM invoice_customer_assignment_events
           WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ? FOR UPDATE`,
          [invoice.loc_code, invoice.mac_code, invoice.txn_date, invoice.receipt_no]
        );
        const assignmentNo = Number(numbers[0]?.max_no || 0) + 1;
        const eventType = nextAccountId ? (previousId ? 'changed' : 'linked') : 'unlinked';
        await connection.execute(
          `INSERT INTO invoice_customer_assignment_events
             (invoice_id, loc_code, mac_code, txn_date, receipt_no, assignment_no,
              previous_customer_account_id, customer_account_id, market_code_snapshot, event_type,
              reason, action_loc_code, action_mac_code, action_date, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [invoiceId, invoice.loc_code, invoice.mac_code, invoice.txn_date, invoice.receipt_no, assignmentNo,
            previousId, nextAccountId, invoice.customer_code || '', eventType, text(reason, 255),
            origin.locCode, origin.macCode, origin.txnDate || invoice.txn_date, userId]
        );
        await connection.commit();
        return { invoiceId: Number(invoice.id), customerAccountId: nextAccountId, eventType };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function listCheques(filters = {}) {
    return database.withConnection(async (connection) => {
      const term = String(filters.term || '').trim();
      const like = `%${term}%`;
      const status = String(filters.status || '').trim();
      const fromDate = text(filters.fromDate, 10);
      const toDate = text(filters.toDate, 10);
      const [rows] = await connection.execute(
        `SELECT c.*, i.invoice_number, i.customer_code,
                ca.account_number AS customer_account_number, cp.display_name AS customer_name,
                dp.display_name AS drawer_party_name
         FROM cheques c
         JOIN invoices i ON i.id = c.invoice_id
         LEFT JOIN customer_accounts ca ON ca.id = c.received_from_customer_account_id
         LEFT JOIN parties cp ON cp.id = ca.party_id
         LEFT JOIN parties dp ON dp.id = c.drawer_party_id
         WHERE (? = '' OR c.cheque_number LIKE ? OR c.bank_name LIKE ? OR c.drawer_name_snapshot LIKE ?
                OR cp.display_name LIKE ? OR dp.display_name LIKE ? OR i.invoice_number LIKE ? OR i.customer_code LIKE ?)
           AND (? = '' OR c.status = ?)
           AND (? IS NULL OR c.cheque_date >= ?)
           AND (? IS NULL OR c.cheque_date <= ?)
         ORDER BY CASE c.status WHEN 'received' THEN 1 WHEN 'deposited' THEN 2 ELSE 3 END,
                  COALESCE(c.cheque_date, c.txn_date), c.id DESC LIMIT 250`,
        [term, like, like, like, like, like, like, like, status, status, fromDate, fromDate, toDate, toDate]
      );
      return rows.map((row) => ({ ...row, amount: Number(row.amount || 0) }));
    });
  }

  async function getCheque(chequeId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT c.*, i.invoice_number, i.customer_code,
                ca.account_number AS customer_account_number, cp.display_name AS customer_name,
                dp.display_name AS drawer_party_name
         FROM cheques c JOIN invoices i ON i.id = c.invoice_id
         LEFT JOIN customer_accounts ca ON ca.id = c.received_from_customer_account_id
         LEFT JOIN parties cp ON cp.id = ca.party_id LEFT JOIN parties dp ON dp.id = c.drawer_party_id
         WHERE c.id = ? LIMIT 1`, [chequeId]
      );
      if (!rows.length) return null;
      const [events] = await connection.execute(
        `SELECT e.*, u.display_name AS user_name FROM cheque_status_events e
         LEFT JOIN users u ON u.id = e.changed_by WHERE e.cheque_id = ? ORDER BY e.event_no DESC`, [chequeId]
      );
      return { cheque: { ...rows[0], amount: Number(rows[0].amount || 0) }, events };
    });
  }

  function chequeDetailSnapshot(row = {}) {
    const dateValue = row.cheque_date;
    const chequeDate = dateValue instanceof Date
      ? `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}-${String(dateValue.getDate()).padStart(2, '0')}`
      : (String(dateValue || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null);
    return {
      number: text(row.cheque_number, 80),
      date: chequeDate,
      bankName: text(row.bank_name, 160),
      branchName: text(row.branch_name, 160),
      drawerName: text(row.drawer_name_snapshot, 160),
      accountReference: text(row.account_reference, 100),
      notes: text(row.notes, 255)
    };
  }

  async function updateChequeDetails({ chequeId, details = {}, reason = '', userId = null, origin: originValue }) {
    const origin = requireOrigin(originValue);
    if (!origin.txnDate) throw new Error('The current business date is required.');
    const normalized = {
      number: text(details.number, 80),
      date: text(details.date, 10),
      bankName: text(details.bankName, 160),
      branchName: text(details.branchName, 160),
      drawerName: text(details.drawerName, 160),
      accountReference: text(details.accountReference, 100),
      notes: text(details.notes, 255)
    };
    if (normalized.date && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.date)) {
      throw new Error('Cheque date must be a valid date.');
    }

    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute(
          `SELECT c.*, p.method AS payment_method
           FROM cheques c JOIN payments p ON p.id = c.payment_id
           WHERE c.id = ? FOR UPDATE`,
          [chequeId]
        );
        if (!rows.length) throw new Error('Cheque not found.');
        const cheque = rows[0];
        if (cheque.payment_method !== 'cheque') throw new Error('The linked payment is not a cheque payment.');
        const previous = chequeDetailSnapshot(cheque);

        await connection.execute(
          `UPDATE cheques
           SET cheque_number = ?, cheque_date = ?, bank_name = ?, branch_name = ?,
               drawer_name_snapshot = ?, account_reference = ?, notes = ?
           WHERE id = ?`,
          [normalized.number, normalized.date, normalized.bankName, normalized.branchName,
            normalized.drawerName, normalized.accountReference, normalized.notes, chequeId]
        );
        await connection.execute(
          `UPDATE payments
           SET provider_ref = ?, cheque_number = ?, cheque_date = ?, cheque_bank = ?, cheque_branch = ?,
               cheque_drawer_name = ?, cheque_account_reference = ?, cheque_notes = ?
           WHERE id = ? AND method = 'cheque'`,
          [normalized.number, normalized.number, normalized.date, normalized.bankName, normalized.branchName,
            normalized.drawerName, normalized.accountReference, normalized.notes, cheque.payment_id]
        );

        const changed = JSON.stringify(previous) !== JSON.stringify(normalized);
        if (changed) {
          const [eventNos] = await connection.execute(
            `SELECT COALESCE(MAX(event_no), 0) AS max_no FROM cheque_status_events WHERE cheque_id = ? FOR UPDATE`,
            [chequeId]
          );
          await connection.execute(
            `INSERT INTO cheque_status_events
               (cheque_id, event_no, loc_code, mac_code, txn_date, from_status, to_status, reason, details, changed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
            [chequeId, Number(eventNos[0]?.max_no || 0) + 1, origin.locCode, origin.macCode, origin.txnDate,
              cheque.status, cheque.status, text(reason, 255) || 'Cheque details updated',
              JSON.stringify({ eventType: 'details_updated', previous, current: normalized }), userId]
          );
        }
        await connection.commit();
        return getCheque(chequeId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function updateChequeStatus({ chequeId, status, reason = '', depositedTo = '', depositedFundAccountId = null, userId = null, origin: originValue }) {
    const origin = requireOrigin(originValue);
    if (!origin.txnDate) throw new Error('The current business date is required.');
    const transitions = {
      received: new Set(['deposited', 'dishonoured', 'returned', 'cancelled']),
      deposited: new Set(['cleared', 'dishonoured', 'returned']),
      cleared: new Set(), dishonoured: new Set(['replaced']), returned: new Set(['replaced']), cancelled: new Set(), replaced: new Set()
    };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute(
          `SELECT c.*, i.business_day_id AS invoice_business_day_id, i.customer_account_id, i.balance,
                  i.grand_total, i.paid_total
           FROM cheques c JOIN invoices i ON i.id = c.invoice_id WHERE c.id = ? FOR UPDATE`,
          [chequeId]
        );
        if (!rows.length) throw new Error('Cheque not found.');
        const cheque = rows[0];
        const nextStatus = String(status || '').toLowerCase();
        if (!transitions[cheque.status]?.has(nextStatus)) {
          throw new Error(`Cheque cannot move from ${cheque.status} to ${nextStatus}.`);
        }
        let depositFund = null;
        const requestedFundId = Number(depositedFundAccountId || cheque.deposited_fund_account_id || 0);
        if (['deposited', 'cleared'].includes(nextStatus)) {
          if (!requestedFundId) throw new Error('Choose the business bank account receiving this cheque.');
          const [fundRows] = await connection.execute(
            `SELECT id, name FROM fund_accounts
             WHERE id = ? AND loc_code = ? AND fund_kind = 'bank' AND is_active = 1 FOR UPDATE`,
            [requestedFundId, origin.locCode]
          );
          if (!fundRows.length) throw new Error('Choose an active business bank account for this location.');
          depositFund = fundRows[0];
        }
        const businessDay = businessDayRepository
          ? await businessDayRepository.assertOpenWithConnection(connection, { locationCode: origin.locCode, businessDate: origin.txnDate })
          : null;
        if (['dishonoured', 'returned', 'cancelled'].includes(nextStatus)) {
          const accountId = cheque.received_from_customer_account_id || cheque.customer_account_id;
          if (!accountId) throw new Error('Link the cheque to the liable customer before recording a dishonour or return.');
          const restored = Math.min(Number(cheque.amount || 0), Math.max(Number(cheque.grand_total || 0) - Number(cheque.balance || 0), 0));
          if (restored > 0.005) {
            const newBalance = Number(cheque.balance || 0) + restored;
            await connection.execute(
              `UPDATE invoices SET customer_account_id = ?, balance = ?, paid_total = GREATEST(0, grand_total - ?),
                 status = CASE WHEN ? > 0.005 THEN 'partial' ELSE status END,
                 due_date = COALESCE(due_date, txn_date)
               WHERE id = ?`,
              [accountId, newBalance, newBalance, newBalance, cheque.invoice_id]
            );
            const [entryNos] = await connection.execute(
              `SELECT COALESCE(MAX(entry_no), 0) AS max_no FROM customer_receivable_entries
               WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND document_type = 'cheque_dishonour' AND document_no = ? FOR UPDATE`,
              [origin.locCode, origin.macCode, origin.txnDate, cheque.id]
            );
            await connection.execute(
              `INSERT INTO customer_receivable_entries
                 (business_day_id, customer_account_id, loc_code, mac_code, txn_date, document_type, document_no,
                  entry_no, invoice_id, entry_type, amount, reason, created_by, metadata)
               VALUES (?, ?, ?, ?, ?, 'cheque_dishonour', ?, ?, ?, 'cheque_dishonour_debit', ?, ?, ?, CAST(? AS JSON))`,
              [businessDay?.id || cheque.invoice_business_day_id, accountId, origin.locCode, origin.macCode, origin.txnDate,
                cheque.id, Number(entryNos[0]?.max_no || 0) + 1, cheque.invoice_id, restored,
                text(reason, 255) || `Cheque ${nextStatus}`, userId,
                JSON.stringify({ chequeId: Number(cheque.id), paymentId: Number(cheque.payment_id), previousStatus: cheque.status })]
            );
          }
        }
        await connection.execute(
          `UPDATE cheques SET status = ?, deposited_to = CASE WHEN ? IN ('deposited','cleared') THEN ? ELSE deposited_to END,
             deposited_fund_account_id = CASE WHEN ? IN ('deposited','cleared') THEN ? ELSE deposited_fund_account_id END,
             deposited_at = CASE WHEN ? = 'deposited' THEN NOW() ELSE deposited_at END,
             cleared_at = CASE WHEN ? = 'cleared' THEN NOW() ELSE cleared_at END,
             closed_at = CASE WHEN ? IN ('dishonoured','returned','cancelled','replaced') THEN NOW() ELSE closed_at END,
             dishonour_reason = CASE WHEN ? = 'dishonoured' THEN ? ELSE dishonour_reason END
           WHERE id = ?`,
          [nextStatus, nextStatus, depositFund?.name || text(depositedTo, 160), nextStatus, depositFund?.id || null,
            nextStatus, nextStatus, nextStatus, nextStatus, text(reason, 255), chequeId]
        );
        const [eventNos] = await connection.execute(`SELECT COALESCE(MAX(event_no), 0) AS max_no FROM cheque_status_events WHERE cheque_id = ? FOR UPDATE`, [chequeId]);
        await connection.execute(
          `INSERT INTO cheque_status_events
             (cheque_id, event_no, loc_code, mac_code, txn_date, from_status, to_status, reason, details, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
          [chequeId, Number(eventNos[0]?.max_no || 0) + 1, origin.locCode, origin.macCode, origin.txnDate,
            cheque.status, nextStatus, text(reason, 255), JSON.stringify({
              depositedTo: depositFund?.name || text(depositedTo, 160),
              depositedFundAccountId: depositFund?.id || null
            }), userId]
        );
        await connection.commit();
        return getCheque(chequeId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function linkCheque({ chequeId, drawerPartyId = null, receivedFromCustomerAccountId = null, reason = '', userId = null, origin: originValue }) {
    const origin = requireOrigin(originValue);
    if (!origin.txnDate) throw new Error('The current business date is required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute(`SELECT id, status FROM cheques WHERE id = ? FOR UPDATE`, [chequeId]);
        if (!rows.length) throw new Error('Cheque not found.');
        if (drawerPartyId) {
          const [parties] = await connection.execute(`SELECT id FROM parties WHERE id = ? AND status = 'active'`, [drawerPartyId]);
          if (!parties.length) throw new Error('Drawer party not found.');
          await connection.execute(`INSERT IGNORE INTO party_roles (party_id, role_key) VALUES (?, 'cheque_drawer')`, [drawerPartyId]);
        }
        await connection.execute(
          `UPDATE cheques SET drawer_party_id = ?, received_from_customer_account_id = COALESCE(?, received_from_customer_account_id) WHERE id = ?`,
          [drawerPartyId || null, receivedFromCustomerAccountId || null, chequeId]
        );
        const [eventNos] = await connection.execute(`SELECT COALESCE(MAX(event_no), 0) AS max_no FROM cheque_status_events WHERE cheque_id = ? FOR UPDATE`, [chequeId]);
        await connection.execute(
          `INSERT INTO cheque_status_events
             (cheque_id, event_no, loc_code, mac_code, txn_date, from_status, to_status, reason, details, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
          [chequeId, Number(eventNos[0]?.max_no || 0) + 1, origin.locCode, origin.macCode, origin.txnDate,
            rows[0].status, rows[0].status, text(reason, 255) || 'Cheque parties updated',
            JSON.stringify({ drawerPartyId: drawerPartyId || null, receivedFromCustomerAccountId: receivedFromCustomerAccountId || null }), userId]
        );
        await connection.commit();
        return getCheque(chequeId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    searchCustomerAccounts,
    getCustomerAccount,
    getCustomerAccountWithConnection,
    createCustomer,
    updateCustomer,
    assignInvoiceCustomer,
    listCheques,
    getCheque,
    updateChequeDetails,
    updateChequeStatus,
    linkCheque
  };
}

module.exports = { createPartyRepository };
