/**
 * Supplier accounts: what the business owes each supplier, line by line.
 *
 * Two sources make up an account:
 *   - finalized supplier statements (consignment sales or owned purchases),
 *     read from their own tables -- each one is what the business came to owe
 *     for that stock, after commission, credits and deductions;
 *   - `supplier_account_entries`: money paid to the supplier, a one-time
 *     opening balance, and adjustments with a reason.
 *
 * The balance is from the business's side: plus means the business owes the
 * supplier, minus means the supplier owes the business. Nothing here is edited
 * or deleted; a mistaken entry is cancelled by a reversal, and a voided
 * statement keeps its line and gains a reversing one.
 *
 * Only money that actually moved (payments and their reversals) posts to the
 * journal. Statements, opening balances and adjustments stay on the account,
 * as statements always have.
 */
const requestContext = require('../../core/security/request-context');
const rules = require('../../core/accounting/posting-rules');

function createSupplierAccountRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, expenseRepository }) {
  if (!database || !documentSequenceRepository || !businessDayRepository || !journalRepository || !expenseRepository) {
    throw new Error('Supplier accounts require the database, document numbering, business days, the journal, and funds.');
  }

  const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  const text = (value) => String(value ?? '').trim();
  const pad = (part) => String(part).padStart(2, '0');
  const dateOnly = (value) => {
    if (!value) return '';
    if (value instanceof Date) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    return String(value).slice(0, 10);
  };
  const timeOf = (value) => (value instanceof Date ? `${pad(value.getHours())}:${pad(value.getMinutes())}` : String(value || '').slice(11, 16));
  const signed = (row) => (row.effect === 'owe_more' ? money(row.amount) : -money(row.amount));

  // ── Supplier list ───────────────────────────────────────────

  async function listAccounts(filters = {}) {
    const loc = requestContext.scopedLocation(filters);
    if (!loc) throw new Error('A location is required to list supplier accounts.');
    return database.withConnection(async (connection) => {
      const [rows] = await connection.query(
        `SELECT s.id, s.supplier_code, s.name, s.is_active,
                COALESCE(st.net_total, 0) AS statement_total, COALESCE(st.finalized_count, 0) AS statement_count,
                st.last_statement_at,
                COALESCE(e.net_total, 0) AS entry_total, e.last_entry_at,
                (SELECT MAX(p.txn_date) FROM supplier_account_entries p
                  WHERE p.supplier_id = s.id AND p.entry_type = 'payment' AND p.reversed_by_entry_id IS NULL) AS last_payment_date,
                (SELECT p.amount FROM supplier_account_entries p
                  WHERE p.supplier_id = s.id AND p.entry_type = 'payment' AND p.reversed_by_entry_id IS NULL
                  ORDER BY p.txn_date DESC, p.id DESC LIMIT 1) AS last_payment_amount,
                EXISTS (SELECT 1 FROM supplier_account_entries o
                  WHERE o.supplier_id = s.id AND o.entry_type = 'opening_balance' AND o.reversed_by_entry_id IS NULL) AS has_opening_balance
         FROM suppliers s
         LEFT JOIN (
           SELECT supplier_id,
                  SUM(CASE WHEN status = 'finalized' THEN net_payable ELSE 0 END) AS net_total,
                  SUM(status = 'finalized') AS finalized_count,
                  MAX(GREATEST(finalized_at, COALESCE(voided_at, finalized_at))) AS last_statement_at
           FROM supplier_sale_statements
           WHERE loc_code = ? AND finalized_at IS NOT NULL
           GROUP BY supplier_id
         ) st ON st.supplier_id = s.id
         LEFT JOIN (
           SELECT supplier_id, SUM(CASE WHEN effect = 'owe_more' THEN amount ELSE -amount END) AS net_total, MAX(created_at) AS last_entry_at
           FROM supplier_account_entries WHERE loc_code = ? GROUP BY supplier_id
         ) e ON e.supplier_id = s.id
         WHERE s.loc_code = ?`,
        [loc, loc, loc]
      );
      const term = text(filters.term).toLowerCase();
      const accounts = rows.map((row) => {
        const lastStatement = row.last_statement_at ? new Date(row.last_statement_at) : null;
        const lastEntry = row.last_entry_at ? new Date(row.last_entry_at) : null;
        const last = [lastStatement, lastEntry].filter(Boolean).sort((a, b) => b - a)[0] || null;
        return {
          supplierId: Number(row.id),
          supplierCode: row.supplier_code || null,
          name: row.name,
          isActive: Boolean(row.is_active),
          balance: money(Number(row.statement_total) + Number(row.entry_total)),
          statementCount: Number(row.statement_count || 0),
          lastActivityAt: last ? last.toISOString() : null,
          lastActivityDate: last ? dateOnly(last) : null,
          lastPaymentDate: row.last_payment_date ? dateOnly(row.last_payment_date) : null,
          lastPaymentAmount: row.last_payment_amount == null ? null : money(row.last_payment_amount),
          hasOpeningBalance: Boolean(Number(row.has_opening_balance)),
          hasActivity: Boolean(last)
        };
      });
      return accounts
        .filter((row) => filters.includeAll || row.hasActivity)
        .filter((row) => !term || `${row.name} ${row.supplierCode || ''}`.toLowerCase().includes(term))
        .filter((row) => {
          if (filters.balance === 'owed') return row.balance > 0.005;
          if (filters.balance === 'owes_us') return row.balance < -0.005;
          if (filters.balance === 'settled') return Math.abs(row.balance) <= 0.005;
          return true;
        })
        .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')) || a.name.localeCompare(b.name));
    });
  }

  // ── The account sheet ───────────────────────────────────────

  function statementTypeLabel(type) {
    return type === 'owned_purchase' ? 'Purchase statement' : 'Sales statement';
  }

  /**
   * Every line of one supplier's account, oldest first, each with the balance
   * after it. `view` is `detailed` (a statement split into its parts) or
   * `compact` (one line per statement, at its net payable).
   */
  async function getSheet(filters = {}) {
    const supplierId = Number(filters.supplierId || 0);
    if (!supplierId) throw new Error('Choose a supplier.');
    const loc = requestContext.scopedLocation(filters);
    const detailed = filters.view !== 'compact';
    return database.withConnection(async (connection) => {
      const [suppliers] = await connection.execute(
        'SELECT id, loc_code, supplier_code, name, phone, mobile, address FROM suppliers WHERE id = ? AND (? IS NULL OR loc_code = ?)',
        [supplierId, loc, loc]
      );
      const supplier = suppliers[0];
      if (!supplier) throw new Error('This supplier does not belong to this location.');

      const [statements] = await connection.execute(
        `SELECT id, statement_number, statement_type, status, from_date, to_date, merchandise_subtotal, commission_rate,
                commission_amount, adjustment_total, net_payable, finalized_at, voided_at, void_reason
         FROM supplier_sale_statements
         WHERE supplier_id = ? AND loc_code = ? AND finalized_at IS NOT NULL
         ORDER BY finalized_at, id`,
        [supplierId, supplier.loc_code]
      );
      const statementIds = statements.map((row) => Number(row.id));
      const inList = statementIds.length ? statementIds.map(() => '?').join(',') : 'NULL';
      const [adjustments] = statementIds.length ? await connection.query(
        `SELECT statement_id, line_no, adjustment_type, label, amount, note FROM supplier_sale_statement_adjustments
         WHERE statement_id IN (${inList}) ORDER BY statement_id, line_no`, statementIds) : [[]];
      const [grns] = statementIds.length ? await connection.query(
        `SELECT DISTINCT link.statement_id, g.grn_number FROM supplier_sale_statement_grns link
         JOIN goods_receipts g ON g.id = link.goods_receipt_id WHERE link.statement_id IN (${inList}) ORDER BY g.grn_number`, statementIds) : [[]];
      const [lotTags] = statementIds.length ? await connection.query(
        `SELECT DISTINCT pl.statement_id, COALESCE(l.lot_tag, l.lot_code) AS lot_ref FROM supplier_sale_statement_purchase_lines pl
         JOIN inventory_lots l ON l.goods_receipt_line_id = pl.goods_receipt_line_id WHERE pl.statement_id IN (${inList})`, statementIds) : [[]];
      const group = (rows, key) => rows.reduce((map, row) => map.set(Number(row.statement_id), [...(map.get(Number(row.statement_id)) || []), row[key] ?? row]), new Map());
      const adjustmentsBy = group(adjustments, null);
      const grnsBy = group(grns, 'grn_number');
      const lotsBy = group(lotTags, 'lot_ref');

      const [entries] = await connection.execute(
        `SELECT e.*, f.name AS fund_name, f.fund_kind, u.display_name AS user_name, r.entry_number AS reverses_number
         FROM supplier_account_entries e
         LEFT JOIN fund_accounts f ON f.id = e.fund_account_id
         LEFT JOIN users u ON u.id = e.created_by
         LEFT JOIN supplier_account_entries r ON r.id = e.reverses_entry_id
         WHERE e.supplier_id = ? ORDER BY e.txn_date, e.created_at, e.id`,
        [supplierId]
      );

      // Each event is one statement, one statement void, or one entry; its lines
      // stay together in order.
      const events = [];
      for (const st of statements) {
        const net = money(st.net_payable);
        const refs = [st.statement_number, ...(grnsBy.get(Number(st.id)) || []), ...(lotsBy.get(Number(st.id)) || [])];
        const owned = st.statement_type === 'owned_purchase';
        const period = dateOnly(st.from_date) === dateOnly(st.to_date) ? dateOnly(st.from_date) : `${dateOnly(st.from_date)} to ${dateOnly(st.to_date)}`;
        const base = { kind: 'statement', statementId: Number(st.id), statementNumber: st.statement_number, refs };
        const lines = [];
        if (detailed) {
          lines.push({ ...base, description: owned ? 'Purchase subtotal' : 'Sales subtotal', detail: `${statementTypeLabel(st.statement_type)} ${st.statement_number} · ${period}`, owed: money(st.merchandise_subtotal), paid: 0 });
          if (!owned && money(st.commission_amount) > 0.005) {
            lines.push({ ...base, description: `Commission (${Number(st.commission_rate)}%)`, detail: st.statement_number, owed: 0, paid: money(st.commission_amount) });
          }
          for (const adj of adjustmentsBy.get(Number(st.id)) || []) {
            const credit = adj.adjustment_type === 'credit';
            lines.push({ ...base, description: `${credit ? 'Credit' : 'Deduction'}: ${adj.label}`, detail: adj.note || st.statement_number, owed: credit ? money(adj.amount) : 0, paid: credit ? 0 : money(adj.amount) });
          }
        } else {
          lines.push({ ...base, description: `${statementTypeLabel(st.statement_type)} ${st.statement_number}`, detail: `${period} · net payable`, owed: net > 0 ? net : 0, paid: net < 0 ? -net : 0 });
        }
        events.push({ at: st.finalized_at, date: dateOnly(st.finalized_at), time: timeOf(st.finalized_at), lines });
        if (st.voided_at) {
          events.push({
            at: st.voided_at, date: dateOnly(st.voided_at), time: timeOf(st.voided_at),
            lines: [{ ...base, kind: 'statement_void', description: `Statement ${st.statement_number} voided`, detail: st.void_reason || '', owed: net < 0 ? -net : 0, paid: net > 0 ? net : 0 }]
          });
        }
      }
      for (const entry of entries) {
        const amount = money(entry.amount);
        const owed = entry.effect === 'owe_more' ? amount : 0;
        const paid = entry.effect === 'owe_less' ? amount : 0;
        let description;
        if (entry.entry_type === 'payment') description = `Paid from ${entry.fund_name || 'a fund'}`;
        else if (entry.entry_type === 'opening_balance') description = 'Opening balance';
        else if (entry.entry_type === 'adjustment') description = `Adjustment: ${entry.reason}`;
        else description = `Reversal of ${entry.reverses_number || 'an entry'}`;
        const detail = [entry.entry_type === 'adjustment' ? '' : entry.reason, entry.reference ? `Ref ${entry.reference}` : '', entry.user_name ? `by ${entry.user_name}` : '']
          .filter(Boolean).join(' · ');
        events.push({
          at: entry.created_at, date: dateOnly(entry.txn_date), time: timeOf(entry.created_at),
          lines: [{
            kind: entry.entry_type, entryId: Number(entry.id), entryNumber: entry.entry_number, refs: [entry.entry_number],
            description, detail, owed, paid,
            reversed: Boolean(entry.reversed_by_entry_id),
            reversible: entry.entry_type !== 'reversal' && !entry.reversed_by_entry_id
          }]
        });
      }
      // Business date first; within a day, the moment it was recorded.
      events.sort((a, b) => a.date.localeCompare(b.date) || new Date(a.at) - new Date(b.at));

      const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(text(filters.fromDate)) ? text(filters.fromDate) : null;
      const toDate = /^\d{4}-\d{2}-\d{2}$/.test(text(filters.toDate)) ? text(filters.toDate) : null;
      let balance = 0;
      let broughtForward = 0;
      let totalOwed = 0;
      let totalPaid = 0;
      const lines = [];
      for (const event of events) {
        for (const line of event.lines) {
          balance = money(balance + line.owed - line.paid);
          if (fromDate && event.date < fromDate) { broughtForward = balance; continue; }
          if (toDate && event.date > toDate) continue;
          totalOwed = money(totalOwed + line.owed);
          totalPaid = money(totalPaid + line.paid);
          lines.push({ ...line, date: event.date, time: event.time, balance });
        }
      }
      const closing = money(broughtForward + totalOwed - totalPaid);
      return {
        supplier: {
          id: Number(supplier.id), supplierCode: supplier.supplier_code || null, name: supplier.name,
          phone: supplier.phone || supplier.mobile || null, address: supplier.address || null
        },
        view: detailed ? 'detailed' : 'compact',
        fromDate, toDate,
        broughtForward: fromDate ? broughtForward : null,
        totalOwed, totalPaid,
        closingBalance: closing,
        currentBalance: balance,
        hasOpeningBalance: entries.some((row) => row.entry_type === 'opening_balance' && !row.reversed_by_entry_id),
        lines
      };
    });
  }

  // ── Recording ───────────────────────────────────────────────

  async function lockSupplier(connection, supplierId, locCode) {
    const [rows] = await connection.execute('SELECT id, name, supplier_code, loc_code FROM suppliers WHERE id = ? FOR UPDATE', [Number(supplierId)]);
    if (!rows[0] || rows[0].loc_code !== locCode) throw new Error('This supplier does not belong to this location.');
    return rows[0];
  }

  async function nextEntryNumber(connection, origin) {
    const entryNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'supplier_account_entry', ...origin });
    return { entryNo, entryNumber: `SAE-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(entryNo).padStart(6, '0')}` };
  }

  async function replayOf(connection, origin, requestId) {
    if (!requestId) return null;
    const [rows] = await connection.execute(
      'SELECT id, entry_number FROM supplier_account_entries WHERE loc_code = ? AND mac_code = ? AND request_id = ? LIMIT 1',
      [origin.locCode, origin.macCode, requestId]
    );
    return rows[0] ? { id: Number(rows[0].id), entryNumber: rows[0].entry_number, replayed: true } : null;
  }

  async function insertEntry(connection, values) {
    const [result] = await connection.execute(
      `INSERT INTO supplier_account_entries
         (business_day_id, loc_code, mac_code, txn_date, entry_no, entry_number, request_id, supplier_id, entry_type, effect, amount,
          fund_account_id, cash_movement_id, fund_movement_id, reference, reason, reverses_entry_id, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [values.businessDayId, values.origin.locCode, values.origin.macCode, values.origin.txnDate, values.entryNo, values.entryNumber,
        values.requestId || null, values.supplierId, values.entryType, values.effect, money(values.amount),
        values.fundAccountId || null, values.cashMovementId || null, values.fundMovementId || null,
        text(values.reference) || null, text(values.reason).slice(0, 255), values.reversesEntryId || null, values.userId,
        JSON.stringify(values.metadata || {})]
    );
    return Number(result.insertId);
  }

  async function currentBalance(connection, supplierId) {
    const [[statements]] = await connection.execute(
      "SELECT COALESCE(SUM(net_payable), 0) AS total FROM supplier_sale_statements WHERE supplier_id = ? AND status = 'finalized'", [supplierId]
    );
    const [[entries]] = await connection.execute(
      "SELECT COALESCE(SUM(CASE WHEN effect = 'owe_more' THEN amount ELSE -amount END), 0) AS total FROM supplier_account_entries WHERE supplier_id = ?", [supplierId]
    );
    return money(Number(statements.total) + Number(entries.total));
  }

  /**
   * Pays a supplier from a fund. The money leaves that fund (a till payment
   * leaves the open shift), a partner who paid personally is now owed it, and
   * the journal records the supplier payable going down. All in one save.
   */
  async function recordPayment(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    const amount = money(input.amount);
    if (amount <= 0) throw new Error('A payment must be more than zero.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const replay = await replayOf(connection, origin, text(input.requestId));
        if (replay) { await connection.rollback(); return replay; }
        const day = await businessDayRepository.assertPostableWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate, allowClosed: Boolean(input.backdate)
        });
        const supplier = await lockSupplier(connection, input.supplierId, origin.locCode);
        const fund = await expenseRepository.lockFundWithConnection(connection, input.fundAccountId, origin.locCode);
        if (input.backdate && fund.fundKind === 'pos_drawer') {
          throw new Error(`${fund.name} is a till. Cash from a till is counted with its shift, so a payment from it can only be recorded today.`);
        }
        const stakeholder = fund.fundKind === 'stakeholder' ? await expenseRepository.stakeholderForFundWithConnection(connection, fund.id) : null;
        if (fund.fundKind === 'stakeholder' && !stakeholder) throw new Error(`${fund.name} is a partner pocket that is not linked to anyone yet.`);
        if (stakeholder && !stakeholder.isActive) throw new Error(`${stakeholder.displayName} is not active.`);

        const { entryNo, entryNumber } = await nextEntryNumber(connection, origin);
        const reason = text(input.note) || `Payment to ${supplier.name}`;
        const ledger = await expenseRepository.spendFromFundWithConnection(connection, {
          fund, amount, businessDayId: day.id, origin,
          documentType: 'supplier_account', documentNo: entryNo, entryNo: 1,
          movementType: 'supplier_settlement_cash', sourceType: 'supplier_account_entry', sourceId: entryNumber,
          reason: `Paid ${supplier.name}: ${reason}`.slice(0, 255), userId: input.userId,
          metadata: { entryNumber, supplierId: Number(supplier.id), reference: text(input.reference) || null }
        });
        const entryId = await insertEntry(connection, {
          businessDayId: day.id, origin, entryNo, entryNumber, requestId: text(input.requestId), supplierId: Number(supplier.id),
          entryType: 'payment', effect: 'owe_less', amount, fundAccountId: fund.id,
          cashMovementId: ledger.cashMovementId, fundMovementId: ledger.fundMovementId,
          reference: input.reference, reason, userId: input.userId,
          metadata: input.backdate ? { backdated: input.backdate } : {}
        });
        if (stakeholder) {
          const sle = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'stakeholder_ledger', ...origin });
          await connection.execute(
            `INSERT INTO stakeholder_ledger_entries
               (stakeholder_id, business_day_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no, entry_number,
                entry_type, balance_bucket, amount, fund_account_id, fund_movement_id, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, 'supplier_account', ?, 1, ?, 'expense_borne', ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [stakeholder.id, day.id, origin.locCode, origin.macCode, origin.txnDate, sle,
              `SLE-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(sle).padStart(6, '0')}`,
              stakeholder.borneCostTreatment === 'liability' ? 'repayable' : 'capital', amount, fund.id, ledger.fundMovementId,
              `Paid supplier ${supplier.name} for the business`.slice(0, 255), input.userId, JSON.stringify({ supplierAccountEntry: entryNumber })]
          );
        }
        await journalRepository.postWithConnection(connection, {
          businessDayId: day.id, ...origin, documentType: 'supplier_account', documentNo: entryNo,
          sourceType: 'supplier_account_entry', sourceId: String(entryId),
          posting: rules.supplierAccountPaymentPosting({ amount, fund, stakeholderTreatment: stakeholder?.borneCostTreatment, supplierName: supplier.name }),
          userId: input.userId, metadata: { entryNumber, supplierId: Number(supplier.id) }
        });
        const balance = await currentBalance(connection, Number(supplier.id));
        await connection.commit();
        return { id: entryId, entryNumber, amount, fundName: fund.name, stakeholderName: stakeholder?.displayName || null, balance };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /** What was owed before this system started: once per supplier, either way round. */
  async function recordOpeningBalance(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    const amount = money(input.amount);
    if (amount <= 0) throw new Error('An opening balance must be more than zero.');
    if (!['owe_more', 'owe_less'].includes(input.effect)) throw new Error('Say who owed whom.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const replay = await replayOf(connection, origin, text(input.requestId));
        if (replay) { await connection.rollback(); return replay; }
        const day = await businessDayRepository.assertPostableWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate, allowClosed: Boolean(input.backdate)
        });
        const supplier = await lockSupplier(connection, input.supplierId, origin.locCode);
        const [existing] = await connection.execute(
          "SELECT entry_number FROM supplier_account_entries WHERE supplier_id = ? AND entry_type = 'opening_balance' AND reversed_by_entry_id IS NULL LIMIT 1",
          [supplier.id]
        );
        if (existing.length) throw new Error(`${supplier.name} already has an opening balance (${existing[0].entry_number}). Reverse it first to enter a different one.`);
        const { entryNo, entryNumber } = await nextEntryNumber(connection, origin);
        const id = await insertEntry(connection, {
          businessDayId: day.id, origin, entryNo, entryNumber, requestId: text(input.requestId), supplierId: Number(supplier.id),
          entryType: 'opening_balance', effect: input.effect, amount, reason: text(input.note) || 'Balance carried over from before this system',
          userId: input.userId, metadata: input.backdate ? { backdated: input.backdate } : {}
        });
        const balance = await currentBalance(connection, Number(supplier.id));
        await connection.commit();
        return { id, entryNumber, balance };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /** A correction outside any statement, always with its reason. */
  async function recordAdjustment(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    const amount = money(input.amount);
    const reason = text(input.reason);
    if (amount <= 0) throw new Error('An adjustment must be more than zero.');
    if (!['owe_more', 'owe_less'].includes(input.effect)) throw new Error('Say whether this adds to or takes from what is owed.');
    if (!reason) throw new Error('Write why this adjustment is being made.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const replay = await replayOf(connection, origin, text(input.requestId));
        if (replay) { await connection.rollback(); return replay; }
        const day = await businessDayRepository.assertPostableWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate, allowClosed: Boolean(input.backdate)
        });
        const supplier = await lockSupplier(connection, input.supplierId, origin.locCode);
        const { entryNo, entryNumber } = await nextEntryNumber(connection, origin);
        const id = await insertEntry(connection, {
          businessDayId: day.id, origin, entryNo, entryNumber, requestId: text(input.requestId), supplierId: Number(supplier.id),
          entryType: 'adjustment', effect: input.effect, amount, reference: input.reference, reason,
          userId: input.userId, metadata: input.backdate ? { backdated: input.backdate } : {}
        });
        const balance = await currentBalance(connection, Number(supplier.id));
        await connection.commit();
        return { id, entryNumber, balance };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /**
   * Cancels a mistaken entry with an equal and opposite one. A payment's money
   * goes back where it came from -- a till payment only while its shift is still
   * open, because a counted shift must not change.
   */
  async function reverseEntry(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    const reason = text(input.reason);
    if (!reason) throw new Error('Write why this entry is being reversed.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute('SELECT * FROM supplier_account_entries WHERE id = ? FOR UPDATE', [Number(input.entryId)]);
        const entry = rows[0];
        if (!entry || entry.loc_code !== origin.locCode) throw new Error('This entry does not belong to this location.');
        if (entry.entry_type === 'reversal') throw new Error('A reversal cannot itself be reversed. Record a new entry instead.');
        if (entry.reversed_by_entry_id) throw new Error(`${entry.entry_number} has already been reversed.`);
        const day = await businessDayRepository.assertOpenWithConnection(connection, { locationCode: origin.locCode, businessDate: origin.txnDate });
        const { entryNo, entryNumber } = await nextEntryNumber(connection, origin);
        const note = `Reversed ${entry.entry_number}: ${reason}`.slice(0, 255);

        let fundMovementId = null;
        if (entry.entry_type === 'payment') {
          if (entry.cash_movement_id) {
            const [movements] = await connection.execute(
              'SELECT m.*, s.status AS shift_status FROM cash_movements m JOIN cash_shifts s ON s.id = m.cash_shift_id WHERE m.id = ? FOR UPDATE',
              [entry.cash_movement_id]
            );
            const movement = movements[0];
            if (!movement || movement.shift_status !== 'open') {
              throw new Error('This payment was made from the till in a shift that has since been counted. Putting the cash back now would make that count wrong, so ask a manager to record a cash correction instead.');
            }
            if (movement.status === 'active') {
              const [[sequence]] = await connection.execute('SELECT COALESCE(MAX(event_no), 0) AS event_no FROM cash_movement_events WHERE cash_movement_id = ?', [movement.id]);
              await connection.execute(
                `INSERT INTO cash_movement_events (cash_movement_id, event_no, action, reason, before_state, after_state, created_by)
                 VALUES (?, ?, 'voided', ?, CAST(? AS JSON), NULL, ?)`,
                [movement.id, Number(sequence.event_no || 0) + 1, note,
                  JSON.stringify({ movementType: movement.movement_type, direction: movement.direction, amount: money(movement.amount), reason: movement.reason, status: movement.status }),
                  input.userId]
              );
              await connection.execute("UPDATE cash_movements SET status = 'void', voided_at = NOW(), voided_by = ?, void_reason = ? WHERE id = ?", [input.userId, note, movement.id]);
            }
          } else if (entry.fund_movement_id) {
            const fund = await expenseRepository.lockFundWithConnection(connection, entry.fund_account_id, origin.locCode);
            const received = await expenseRepository.receiveIntoFundWithConnection(connection, {
              fund, amount: money(entry.amount), businessDayId: day.id, origin,
              documentType: 'supplier_account', documentNo: entryNo, entryNo: 1,
              movementType: 'fund_transfer_in', sourceType: 'supplier_account_entry', sourceId: entryNumber,
              reason: note, userId: input.userId, metadata: { entryNumber, reverses: entry.entry_number }
            });
            fundMovementId = received.fundMovementId;
          }
          const [borne] = await connection.execute(
            `SELECT * FROM stakeholder_ledger_entries WHERE document_type = 'supplier_account' AND fund_account_id = ?
               AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.supplierAccountEntry')) = ? AND amount > 0 LIMIT 1`,
            [entry.fund_account_id, entry.entry_number]
          );
          if (borne[0]) {
            const sle = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'stakeholder_ledger', ...origin });
            await connection.execute(
              `INSERT INTO stakeholder_ledger_entries
                 (stakeholder_id, business_day_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no, entry_number,
                  entry_type, balance_bucket, amount, fund_account_id, fund_movement_id, reason, created_by, metadata)
               VALUES (?, ?, ?, ?, ?, 'supplier_account', ?, 1, ?, 'expense_borne', ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
              [borne[0].stakeholder_id, day.id, origin.locCode, origin.macCode, origin.txnDate, sle,
                `SLE-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(sle).padStart(6, '0')}`,
                borne[0].balance_bucket, -money(borne[0].amount), entry.fund_account_id, fundMovementId, note, input.userId,
                JSON.stringify({ reversesSupplierAccountEntry: entry.entry_number })]
            );
          }
          await journalRepository.reverseWithConnection(connection, {
            sourceType: 'supplier_account_entry', sourceId: String(entry.id),
            reversalSourceType: 'supplier_account_reversal', reversalSourceId: String(entry.id),
            businessDayId: day.id, ...origin, documentType: 'supplier_account', documentNo: entryNo,
            narration: note, userId: input.userId, metadata: { entryNumber, reverses: entry.entry_number }
          });
        }

        const reversalId = await insertEntry(connection, {
          businessDayId: day.id, origin, entryNo, entryNumber, supplierId: Number(entry.supplier_id),
          entryType: 'reversal', effect: entry.effect === 'owe_more' ? 'owe_less' : 'owe_more', amount: money(entry.amount),
          fundAccountId: entry.fund_account_id, fundMovementId, reason: note, reversesEntryId: Number(entry.id),
          userId: input.userId, metadata: { reverses: entry.entry_number, type: entry.entry_type }
        });
        await connection.execute('UPDATE supplier_account_entries SET reversed_by_entry_id = ? WHERE id = ?', [reversalId, entry.id]);
        const balance = await currentBalance(connection, Number(entry.supplier_id));
        await connection.commit();
        return { id: reversalId, entryNumber, reverses: entry.entry_number, balance };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  return { listAccounts, getSheet, recordPayment, recordOpeningBalance, recordAdjustment, reverseEntry };
}

module.exports = { createSupplierAccountRepository };
