const requestContext = require('../../core/security/request-context');
/**
 * Funds and expenses.
 *
 * A fund account is a named place money sits. Balance ownership is split so no
 * amount is ever counted twice:
 *
 *   * a `pos_drawer` fund is a view over the existing cash_movements ledger, so
 *     its balance is what the currently open shift holds. Closed shifts were
 *     counted and emptied, so they are deliberately not carried forward.
 *   * every other fund kind keeps its own append-only fund_movements ledger and
 *     starts from its recorded opening balance.
 *
 * An expense therefore writes EITHER a cash movement (drawer) OR a fund
 * movement (safe, bank, stakeholder pocket), never both.
 *
 * The connection-level fund helpers are exported so the stakeholder repository
 * can move money through the same ledgers without duplicating the rules. The
 * dependency runs one way: stakeholders depend on funds, never the reverse.
 */
const rules = require('../../core/accounting/posting-rules');

function createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, lotCostingRepository = null }) {
  if (!database) throw new Error('Expense repository requires a database instance.');
  if (!documentSequenceRepository || !businessDayRepository) {
    throw new Error('Expenses require document numbering and business-day control.');
  }
  if (!journalRepository) throw new Error('Expenses require the journal for derived postings.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);
  const text = (value) => String(value || '').trim();
  const json = (value) => {
    if (!value || typeof value === 'object') return value || {};
    try { return JSON.parse(value); } catch { return {}; }
  };

  // ── Fund accounts ───────────────────────────────────────────

  function mapFund(row) {
    return {
      id: Number(row.id),
      fundCode: row.fund_code,
      name: row.name,
      fundKind: row.fund_kind,
      cashDrawerId: row.cash_drawer_id == null ? null : Number(row.cash_drawer_id),
      locationCode: row.loc_code,
      currencyCode: row.currency_code,
      openingBalance: money(row.opening_balance),
      holderName: row.holder_name || null,
      accountReference: row.account_reference || null,
      notes: row.notes || null,
      isActive: !!row.is_active,
      sortOrder: Number(row.sort_order || 0),
      balance: money(row.balance),
      lastMovementAt: row.last_movement_at || null,
      metadata: json(row.metadata)
    };
  }

  /**
   * Balances for every fund at a location in two queries rather than one per
   * fund: drawers read the open shift, everything else reads its own ledger.
   */
  async function loadFunds(connection, { locCode, includeInactive = false, fundId = null }) {
    const params = [text(locCode)];
    let where = 'f.loc_code = ?';
    if (!includeInactive) where += ' AND f.is_active = 1';
    if (fundId) { where += ' AND f.id = ?'; params.push(Number(fundId)); }
    const [rows] = await connection.execute(
      `SELECT f.* FROM fund_accounts f WHERE ${where} ORDER BY f.sort_order, f.name, f.id`, params
    );
    if (!rows.length) return [];

    const drawerIds = rows.filter((row) => row.cash_drawer_id != null).map((row) => Number(row.cash_drawer_id));
    const ledgerIds = rows.filter((row) => row.cash_drawer_id == null).map((row) => Number(row.id));
    const drawerTotals = new Map();
    const ledgerTotals = new Map();

    if (drawerIds.length) {
      // Only an open shift still holds cash in the till.
      const [totals] = await connection.query(
        `SELECT s.drawer_id,
                COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END), 0) AS balance,
                MAX(m.created_at) AS last_movement_at
         FROM cash_shifts s
         LEFT JOIN cash_movements m ON m.cash_shift_id = s.id AND m.status = 'active'
         WHERE s.drawer_id IN (?) AND s.status = 'open'
         GROUP BY s.drawer_id`, [drawerIds]
      );
      for (const row of totals) {
        drawerTotals.set(Number(row.drawer_id), { balance: money(row.balance), lastMovementAt: row.last_movement_at });
      }
      // Between shifts, the cash counted at the last close stays in the drawer.
      const idle = drawerIds.filter((id) => !drawerTotals.has(Number(id)));
      if (idle.length) {
        const [left] = await connection.query(
          `SELECT s.drawer_id, s.declared_total, s.closed_at FROM cash_shifts s
           JOIN (SELECT drawer_id, MAX(closed_at) AS closed_at FROM cash_shifts WHERE drawer_id IN (?) AND status = 'closed' AND declared_total IS NOT NULL GROUP BY drawer_id) last
             ON last.drawer_id = s.drawer_id AND last.closed_at = s.closed_at
           WHERE s.status = 'closed'`, [idle]
        );
        for (const row of left) {
          drawerTotals.set(Number(row.drawer_id), { balance: money(row.declared_total), lastMovementAt: row.closed_at });
        }
      }
    }
    if (ledgerIds.length) {
      const [totals] = await connection.query(
        `SELECT fund_account_id,
                COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS balance,
                MAX(created_at) AS last_movement_at
         FROM fund_movements WHERE fund_account_id IN (?) GROUP BY fund_account_id`, [ledgerIds]
      );
      for (const row of totals) {
        ledgerTotals.set(Number(row.fund_account_id), { balance: money(row.balance), lastMovementAt: row.last_movement_at });
      }
    }

    return rows.map((row) => {
      const isDrawer = row.cash_drawer_id != null;
      const totals = isDrawer
        ? drawerTotals.get(Number(row.cash_drawer_id))
        : ledgerTotals.get(Number(row.id));
      const ledgerBalance = money(totals?.balance || 0);
      return mapFund({
        ...row,
        balance: isDrawer ? ledgerBalance : money(money(row.opening_balance) + ledgerBalance),
        last_movement_at: totals?.lastMovementAt || null
      });
    });
  }

  async function listFundAccounts({ locCode, includeInactive = false }) {
    return database.withConnection((connection) => loadFunds(connection, { locCode, includeInactive }));
  }

  /** Locks one fund and returns it with a current balance, for spend checks. */
  async function lockFund(connection, fundAccountId, locCode) {
    const [rows] = await connection.execute(
      'SELECT * FROM fund_accounts WHERE id = ? FOR UPDATE', [Number(fundAccountId)]
    );
    const row = rows[0];
    if (!row) throw new Error('Select a fund account.');
    if (!row.is_active) throw new Error(`${row.name} is not active. Choose another fund or reactivate it in Fund Accounts.`);
    if (row.loc_code !== text(locCode)) throw new Error(`${row.name} belongs to another location.`);
    const [loaded] = await loadFunds(connection, { locCode: row.loc_code, includeInactive: true, fundId: row.id });
    return loaded;
  }

  /** The stakeholder whose pocket this fund is, if it is one. */
  async function stakeholderForFund(connection, fundAccountId) {
    const [rows] = await connection.execute(
      `SELECT id, stakeholder_code, display_name, borne_cost_treatment, is_active
       FROM stakeholders WHERE fund_account_id = ? LIMIT 1`, [Number(fundAccountId)]
    );
    if (!rows[0]) return null;
    return {
      id: Number(rows[0].id),
      stakeholderCode: rows[0].stakeholder_code,
      displayName: rows[0].display_name,
      borneCostTreatment: rows[0].borne_cost_treatment,
      isActive: !!rows[0].is_active
    };
  }

  async function saveFundAccount(input) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const kind = text(input.fundKind);
        // A partner's pocket is created with the partner, so it always has an
        // owner. Existing pockets can still be renamed here.
        if (kind === 'stakeholder' && !Number(input.id || 0)) {
          throw new Error('A partner pocket is added from Partners, so it belongs to that person. Open Money, then Partners, then Add partner.');
        }
        if (!['cash_safe', 'bank', 'stakeholder'].includes(kind)) {
          throw new Error('A fund can be a cash safe, a bank account, or a stakeholder pocket. Drawer funds are created with their workstation.');
        }
        const name = text(input.name);
        if (!name) throw new Error('Give the fund a name a person will recognise.');
        const locCode = text(input.locCode);
        if (!locCode) throw new Error('A fund belongs to a location.');
        const payload = [
          name, kind, locCode, text(input.currencyCode) || 'LKR', money(input.openingBalance),
          text(input.holderName) || null, text(input.accountReference) || null, text(input.notes) || null,
          input.isActive === false ? 0 : 1, Number(input.sortOrder || 100)
        ];
        let fundId = Number(input.id || 0);
        if (fundId) {
          const [existing] = await connection.execute('SELECT fund_kind, cash_drawer_id, loc_code, opening_balance FROM fund_accounts WHERE id = ? FOR UPDATE', [fundId]);
          if (!existing[0]) throw new Error('This fund account no longer exists.');
          if (existing[0].cash_drawer_id != null) throw new Error('A drawer fund mirrors its workstation and cannot be edited here.');
          const [activity] = await connection.execute('SELECT id FROM fund_movements WHERE fund_account_id = ? LIMIT 1', [fundId]);
          if (activity[0] && (existing[0].fund_kind !== kind || existing[0].loc_code !== locCode
            || money(existing[0].opening_balance) !== money(input.openingBalance))) {
            throw new Error('After a fund has movements, its type, location, and opening balance are locked. Record a transfer or adjustment instead.');
          }
          await connection.execute(
            `UPDATE fund_accounts SET name = ?, fund_kind = ?, loc_code = ?, currency_code = ?, opening_balance = ?,
               holder_name = ?, account_reference = ?, notes = ?, is_active = ?, sort_order = ? WHERE id = ?`,
            [...payload, fundId]
          );
          // The matching cheque bank account follows the fund's name and on/off switch.
          await connection.execute(
            'UPDATE business_bank_accounts SET bank_name = ?, is_active = ? WHERE fund_account_id = ? AND mac_code = \'FUND\'',
            [name, input.isActive === false ? 0 : 1, fundId]
          );
        } else {
          const fundCode = text(input.fundCode).toUpperCase()
            || `${kind === 'bank' ? 'BANK' : kind === 'stakeholder' ? 'POCKET' : 'SAFE'}-${locCode}-${Date.now().toString().slice(-6)}`;
          const [result] = await connection.execute(
            `INSERT INTO fund_accounts
               (fund_code, name, fund_kind, loc_code, currency_code, opening_balance,
                holder_name, account_reference, notes, is_active, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [fundCode, ...payload]
          );
          fundId = Number(result.insertId);
          if (kind === 'bank') {
            // One list of bank accounts: a bank fund can issue cheques and receive deposits.
            await connection.execute(
              `INSERT INTO business_bank_accounts
                 (loc_code, mac_code, account_no, fund_account_id, account_code, bank_name, account_name, account_number, is_active, notes)
               VALUES (?, 'FUND', ?, ?, ?, ?, ?, ?, ?, 'Created from the bank fund of the same name')`,
              [locCode, fundId, fundId, `BA-FUND-${fundId}`, name, text(input.holderName) || name,
                text(input.accountReference) || fundCode, input.isActive === false ? 0 : 1]
            );
          }
        }
        await connection.commit();
        const [saved] = await loadFunds(connection, { locCode, includeInactive: true, fundId });
        return saved;
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  // ── Categories ──────────────────────────────────────────────

  function mapCategory(row) {
    return {
      id: Number(row.id),
      categoryCode: row.category_code,
      name: row.name,
      defaultTreatment: row.default_treatment,
      helpText: row.help_text || null,
      locationCode: row.loc_code || null,
      isShared: row.loc_code == null,
      isActive: !!row.is_active,
      sortOrder: Number(row.sort_order || 0)
    };
  }

  /** The reason every location can always fall back on, so an expense is never blocked for want of one. */
  const DEFAULT_CATEGORY_CODE = 'other';

  // A location sees the shared reasons plus the ones it added itself. When a
  // location changes a shared reason it gets its own row with the same code,
  // and that row stands in for the shared one there -- other locations and
  // every past expense are untouched.
  async function listCategories({ includeInactive = false, locCode = null } = {}) {
    const scope = requestContext.scopedLocation({ locCode });
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT * FROM expense_categories
         WHERE (loc_code IS NULL OR ? IS NULL OR loc_code = ?)
         ORDER BY sort_order, name, id`,
        [scope, scope]
      );
      const byCode = new Map();
      for (const row of rows) {
        const current = byCode.get(row.category_code);
        if (!current || (current.loc_code == null && row.loc_code != null)) byCode.set(row.category_code, row);
      }
      return rows
        .filter((row) => byCode.get(row.category_code) === row)
        .filter((row) => includeInactive || row.is_active)
        .map((row) => ({ ...mapCategory(row), isDefault: row.category_code === DEFAULT_CATEGORY_CODE }));
    });
  }

  async function saveCategory(input) {
    return database.withConnection(async (connection) => {
      const name = text(input.name);
      if (!name) throw new Error('Give the category a name.');
      const treatment = text(input.defaultTreatment) || 'overhead';
      if (!['lot_cost', 'overhead', 'supplier_deduction'].includes(treatment)) {
        throw new Error('Choose whether this reason is a lot expense or a shop expense.');
      }
      const helpText = text(input.helpText) || null;
      const isActive = input.isActive === false ? 0 : 1;
      const sortOrder = Number(input.sortOrder || 100);
      const id = Number(input.id || 0);
      const scope = requestContext.scopedLocation(input);
      if (id) {
        const [found] = await connection.execute('SELECT * FROM expense_categories WHERE id = ?', [id]);
        const current = found[0];
        if (!current) throw new Error('This expense reason no longer exists.');
        if (current.category_code === DEFAULT_CATEGORY_CODE && !isActive) {
          throw new Error(`${current.name} is the reason every expense can fall back on, so it always stays available.`);
        }
        if (current.loc_code == null && scope) {
          // A shared reason is changed for this location only: its own row with
          // the same code takes the shared one's place here.
          const [existing] = await connection.execute(
            'SELECT id FROM expense_categories WHERE loc_code = ? AND category_code = ?', [scope, current.category_code]
          );
          if (existing.length) {
            await connection.execute(
              'UPDATE expense_categories SET name = ?, default_treatment = ?, help_text = ?, is_active = ?, sort_order = ? WHERE id = ?',
              [name, treatment, helpText, isActive, sortOrder, existing[0].id]
            );
            const [rows] = await connection.execute('SELECT * FROM expense_categories WHERE id = ?', [existing[0].id]);
            return mapCategory(rows[0]);
          }
          const [result] = await connection.execute(
            `INSERT INTO expense_categories (loc_code, category_code, name, default_treatment, help_text, is_active, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [scope, current.category_code, name, treatment, helpText, isActive, sortOrder]
          );
          const [rows] = await connection.execute('SELECT * FROM expense_categories WHERE id = ?', [result.insertId]);
          return mapCategory(rows[0]);
        }
        if (scope && current.loc_code !== scope) throw new Error('This expense reason belongs to another location.');
        await connection.execute(
          'UPDATE expense_categories SET name = ?, default_treatment = ?, help_text = ?, is_active = ?, sort_order = ? WHERE id = ?',
          [name, treatment, helpText, isActive, sortOrder, id]
        );
        const [rows] = await connection.execute('SELECT * FROM expense_categories WHERE id = ?', [id]);
        return mapCategory(rows[0]);
      }
      const code = (text(input.categoryCode) || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
      if (!code) throw new Error('Give the reason a name using letters or numbers.');
      const [taken] = await connection.execute(
        `SELECT name FROM expense_categories WHERE category_code = ? AND (loc_code IS NULL OR loc_code <=> ?) LIMIT 1`, [code, scope]
      );
      if (taken.length) throw new Error(`There is already a reason called ${taken[0].name}. Edit that one instead.`);
      const [result] = await connection.execute(
        `INSERT INTO expense_categories (loc_code, category_code, name, default_treatment, help_text, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [scope, code, name, treatment, helpText, isActive, sortOrder]
      );
      const [rows] = await connection.execute('SELECT * FROM expense_categories WHERE id = ?', [result.insertId]);
      return mapCategory(rows[0]);
    });
  }

  // ── Ledger writers ──────────────────────────────────────────

  async function openShiftForDrawer(connection, { drawerId, origin, userId }) {
    const [rows] = await connection.execute(
      `SELECT id, shift_no, loc_code, mac_code, business_date, status, user_id
       FROM cash_shifts WHERE drawer_id = ? AND status = 'open' FOR UPDATE`, [Number(drawerId)]
    );
    const shift = rows[0];
    if (!shift) throw new Error('Open a cash shift before paying from the till.');
    if (shift.loc_code !== origin.locCode || shift.mac_code !== origin.macCode || dateOnly(shift.business_date) !== origin.txnDate) {
      throw new Error('The till payment must use the active shift location, terminal, and business date.');
    }
    if (userId && Number(shift.user_id) !== Number(userId)) {
      throw new Error('The open cash shift belongs to another cashier.');
    }
    return shift;
  }

  async function insertCashMovement(connection, { shift, movementType, direction, amount, referenceType, referenceId, reason, userId, metadata }) {
    const [numbers] = await connection.execute(
      'SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [shift.id]
    );
    const [result] = await connection.execute(
      `INSERT INTO cash_movements
         (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
          movement_type, direction, amount, reference_type, reference_id, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [shift.id, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no, Number(numbers[0].max_no || 0) + 1,
        movementType, direction, money(amount), referenceType, String(referenceId), reason, userId, JSON.stringify(metadata || {})]
    );
    return Number(result.insertId);
  }

  async function insertFundMovement(connection, { fundAccountId, businessDayId, origin, documentType, documentNo, entryNo, direction, amount, sourceType, sourceId, reason, userId, metadata }) {
    const [result] = await connection.execute(
      `INSERT INTO fund_movements
         (fund_account_id, business_day_id, loc_code, mac_code, txn_date,
          document_type, document_no, entry_no, direction, amount,
          source_type, source_id, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [Number(fundAccountId), businessDayId, origin.locCode, origin.macCode, origin.txnDate,
        documentType, documentNo, entryNo, direction, money(amount),
        sourceType || null, sourceId == null ? null : String(sourceId), reason, userId, JSON.stringify(metadata || {})]
    );
    return Number(result.insertId);
  }

  /**
   * Takes money out of a fund by the ledger that fund owns.
   *
   * A stakeholder pocket is exempt from the overdraw guard on purpose: the
   * business has no way to know what is in a partner's personal wallet, and a
   * negative pocket balance is meaningful -- it is what the business owes them.
   */
  async function spendFromFund(connection, { fund, amount, businessDayId, origin, documentType, documentNo, entryNo, movementType, sourceType, sourceId, reason, userId, metadata }) {
    if (fund.fundKind !== 'stakeholder' && money(amount) > money(fund.balance) + 0.005) {
      throw new Error(`${fund.name} holds only ${money(fund.balance).toFixed(2)}. Record money coming in first, or choose another fund.`);
    }
    if (fund.fundKind === 'pos_drawer') {
      const shift = await openShiftForDrawer(connection, { drawerId: fund.cashDrawerId, origin, userId });
      const cashMovementId = await insertCashMovement(connection, {
        shift, movementType, direction: 'out', amount, referenceType: sourceType, referenceId: sourceId, reason, userId, metadata
      });
      return { cashMovementId, fundMovementId: null, cashShiftId: Number(shift.id) };
    }
    const fundMovementId = await insertFundMovement(connection, {
      fundAccountId: fund.id, businessDayId, origin, documentType, documentNo, entryNo,
      direction: 'out', amount, sourceType, sourceId, reason, userId, metadata
    });
    return { cashMovementId: null, fundMovementId, cashShiftId: null };
  }

  async function receiveIntoFund(connection, { fund, amount, businessDayId, origin, documentType, documentNo, entryNo, movementType, sourceType, sourceId, reason, userId, metadata }) {
    if (fund.fundKind === 'pos_drawer') {
      const shift = await openShiftForDrawer(connection, { drawerId: fund.cashDrawerId, origin, userId: null });
      const cashMovementId = await insertCashMovement(connection, {
        shift, movementType, direction: 'in', amount, referenceType: sourceType, referenceId: sourceId, reason, userId, metadata
      });
      return { cashMovementId, fundMovementId: null, cashShiftId: Number(shift.id) };
    }
    const fundMovementId = await insertFundMovement(connection, {
      fundAccountId: fund.id, businessDayId, origin, documentType, documentNo, entryNo,
      direction: 'in', amount, sourceType, sourceId, reason, userId, metadata
    });
    return { cashMovementId: null, fundMovementId, cashShiftId: null };
  }

  /**
   * Writes the equity side of a cost a partner paid personally.
   *
   * This INSERT lives here rather than in the stakeholder repository so the
   * dependency stays one-way. The cost belonging to the business and the
   * partner's claim rising are one event, so they share this transaction.
   */
  async function insertBorneEntry(connection, { stakeholder, expense, fund, day, origin, ledger, userId }) {
    const entryNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'stakeholder_ledger', ...origin });
    const entryNumber = `SLE-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(entryNo).padStart(6, '0')}`;
    await connection.execute(
      `INSERT INTO stakeholder_ledger_entries
         (stakeholder_id, business_day_id, loc_code, mac_code, txn_date,
           document_type, document_no, entry_no, entry_number, entry_type, balance_bucket, amount,
          fund_account_id, expense_entry_id, fund_movement_id, reason, created_by, metadata)
        VALUES (?, ?, ?, ?, ?, 'expense', ?, 1, ?, 'expense_borne', ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [stakeholder.id, day.id, origin.locCode, origin.macCode, origin.txnDate,
        expense.expenseNo, entryNumber, stakeholder.borneCostTreatment === 'liability' ? 'repayable' : 'capital',
        money(expense.amount), fund.id, expense.id,
        ledger.fundMovementId, `Paid for the business: ${expense.reason}`, userId,
        JSON.stringify({ expenseNumber: expense.expenseNumber, treatment: stakeholder.borneCostTreatment })]
    );
    return entryNumber;
  }

  // ── Expenses ────────────────────────────────────────────────

  function mapExpense(row) {
    return {
      id: Number(row.id),
      expenseNumber: row.expense_number,
      date: dateOnly(row.txn_date),
      amount: money(row.amount),
      payee: row.payee || null,
      reference: row.reference || null,
      reason: row.reason,
      status: row.status,
      voidReason: row.void_reason || null,
      voidedAt: row.voided_at || null,
      backdated: json(row.metadata)?.backdated || null,
      allocationTarget: row.allocation_target,
      allocatedTotal: money(row.allocated_total),
      unallocatedTotal: money(money(row.amount) - money(row.allocated_total)),
      goodsReceiptId: row.goods_receipt_id == null ? null : Number(row.goods_receipt_id),
      grnNumber: row.grn_number || null,
      categoryId: Number(row.expense_category_id),
      categoryName: row.category_name,
      categoryTreatment: row.treatment_snapshot,
      fundAccountId: Number(row.fund_account_id),
      fundName: row.fund_name,
      fundKind: row.fund_kind,
      stakeholderName: row.stakeholder_name || null,
      locationCode: row.loc_code,
      machineCode: row.mac_code,
      userName: row.user_name,
      createdAt: row.created_at,
      metadata: json(row.metadata)
    };
  }

  /**
   * Which goods a lot expense belongs to. The GRN is required (unless a schedule
   * is recording it, which is attached later as before); a lot narrows it to one
   * lot of that GRN. A whole GRN is split by weight when every lot was weighed,
   * otherwise by package count.
   */
  async function resolveExpenseGoods(connection, { input, locCode, categoryName }) {
    const goodsReceiptId = Number(input.goodsReceiptId || 0) || null;
    const inventoryLotId = Number(input.inventoryLotId || 0) || null;
    if (!goodsReceiptId) {
      if (input.requireGoodsLink) throw new Error(`${categoryName} is a lot expense. Choose the GRN it belongs to.`);
      return null;
    }
    const [grns] = await connection.execute(
      `SELECT id, grn_number, status FROM goods_receipts WHERE id = ? AND loc_code = ?`, [goodsReceiptId, locCode]
    );
    if (!grns.length) throw new Error('That GRN does not belong to this location.');
    if (!['finalized', 'corrected'].includes(grns[0].status)) throw new Error(`${grns[0].grn_number} is not a posted GRN.`);
    const [lots] = await connection.execute(
      `SELECT l.id, l.lot_code, l.received_base_quantity FROM inventory_lots l
       JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
       WHERE gl.goods_receipt_id = ?`, [goodsReceiptId]
    );
    if (!lots.length) throw new Error(`${grns[0].grn_number} has no lots to carry this cost.`);
    let lotCode = null;
    if (inventoryLotId) {
      const lot = lots.find((row) => Number(row.id) === inventoryLotId);
      if (!lot) throw new Error(`That lot is not part of ${grns[0].grn_number}.`);
      lotCode = lot.lot_code;
    }
    const allWeighed = lots.every((row) => row.received_base_quantity != null && Number(row.received_base_quantity) > 0);
    return {
      goodsReceiptId, inventoryLotId, grnNumber: grns[0].grn_number, lotCode,
      basis: inventoryLotId ? 'direct' : (allWeighed ? 'base_quantity' : 'handling_quantity')
    };
  }

  async function recordExpense(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const amount = money(input.amount);
        if (amount <= 0) throw new Error('An expense amount must be greater than zero.');
        const reason = text(input.reason);
        if (!reason) throw new Error('Write what this money was for.');

        // Remembered late: the entry is dated the day it happened, which may be
        // a day already closed. See packages/core/security/entry-date.js.
        const backdate = input.backdate || null;
        const day = await businessDayRepository.assertPostableWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate, allowClosed: Boolean(backdate)
        });
        const [categories] = await connection.execute(
          'SELECT * FROM expense_categories WHERE id = ? LIMIT 1', [Number(input.expenseCategoryId)]
        );
        const category = categories[0];
        if (!category || !category.is_active) throw new Error('Choose an active expense category.');

        // A lot expense belongs to received goods, so it says which delivery.
        const goods = category.default_treatment === 'lot_cost'
          ? await resolveExpenseGoods(connection, { input, locCode: origin.locCode, categoryName: category.name })
          : null;

        const fund = await lockFund(connection, input.fundAccountId, origin.locCode);
        // A till payment belongs to the shift that counted it, so it can only be
        // recorded on the day it was paid.
        if (backdate && fund.fundKind === 'pos_drawer') {
          throw new Error(`${fund.name} is a till. Cash from a till is counted with its shift, so it cannot be recorded on an earlier date. Record it as today's payment, or ask a manager to correct that day's cash.`);
        }
        const stakeholder = fund.fundKind === 'stakeholder' ? await stakeholderForFund(connection, fund.id) : null;
        if (fund.fundKind === 'stakeholder' && !stakeholder) {
          throw new Error(`${fund.name} is a partner pocket that is not linked to anyone yet. Open Money, then Partners, then Add partner, and choose ${fund.name} under Their pocket.`);
        }
        if (stakeholder && !stakeholder.isActive) throw new Error(`${stakeholder.displayName} is not active.`);

        const requestId = text(input.requestId) || null;
        if (requestId) {
          const [replays] = await connection.execute(
            `SELECT e.id, e.expense_number, e.amount, e.fund_account_id, e.treatment_snapshot,
                    c.name AS category_name, f.name AS fund_name, s.display_name AS stakeholder_name
             FROM expense_entries e
             JOIN expense_categories c ON c.id = e.expense_category_id
             JOIN fund_accounts f ON f.id = e.fund_account_id
             LEFT JOIN stakeholders s ON s.fund_account_id = f.id
             WHERE e.loc_code = ? AND e.mac_code = ? AND e.request_id = ? LIMIT 1`,
            [origin.locCode, origin.macCode, requestId]
          );
          if (replays[0]) {
            await connection.rollback();
            const replay = replays[0];
            const [replayFund] = await loadFunds(connection, { locCode: origin.locCode, includeInactive: true, fundId: replay.fund_account_id });
            return {
              id: Number(replay.id), expenseNumber: replay.expense_number, amount: money(replay.amount),
              categoryName: replay.category_name, categoryTreatment: replay.treatment_snapshot,
              fundName: replay.fund_name, fundBalance: replayFund?.balance || 0,
              stakeholderName: replay.stakeholder_name || null, stakeholderEntryNumber: null, replayed: true
            };
          }
        }
        const expenseNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'expense', ...origin });
        const expenseNumber = `EXP-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(expenseNo).padStart(6, '0')}`;

        const ledger = await spendFromFund(connection, {
          fund, amount, businessDayId: day.id, origin,
          documentType: 'expense', documentNo: expenseNo, entryNo: 1,
          movementType: 'expense_cash', sourceType: 'expense', sourceId: expenseNumber,
          reason: `${category.name}: ${reason}`, userId: input.userId,
          metadata: { expenseNumber, categoryCode: category.category_code, payee: text(input.payee) || null }
        });

        const [result] = await connection.execute(
          `INSERT INTO expense_entries
              (business_day_id, expense_category_id, treatment_snapshot, fund_account_id, cash_shift_id,
               loc_code, mac_code, txn_date, expense_no, expense_number, request_id, amount,
              payee, reference, reason, cash_movement_id, fund_movement_id, created_by, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [day.id, category.id, category.default_treatment, fund.id, ledger.cashShiftId,
            origin.locCode, origin.macCode, origin.txnDate, expenseNo, expenseNumber, requestId, amount,
            text(input.payee) || null, text(input.reference) || null, reason,
            ledger.cashMovementId, ledger.fundMovementId, input.userId,
            JSON.stringify({ categoryCode: category.category_code, treatment: category.default_treatment, fundCode: fund.fundCode, ...(backdate ? { backdated: backdate } : {}) })]
        );

        let borneEntryNumber = null;
        if (stakeholder) {
          borneEntryNumber = await insertBorneEntry(connection, {
            stakeholder, fund, day, origin, ledger, userId: input.userId,
            expense: { id: Number(result.insertId), expenseNo, expenseNumber, amount, reason }
          });
        }

        await journalRepository.postWithConnection(connection, {
          businessDayId: day.id, ...origin,
          documentType: 'expense', documentNo: expenseNo,
          sourceType: 'expense', sourceId: String(result.insertId),
          posting: rules.expensePosting({
            expense: { amount, reason },
            fund,
            category: { id: Number(category.id), name: category.name, categoryCode: category.category_code, defaultTreatment: category.default_treatment },
            stakeholder
          }),
          userId: input.userId,
          metadata: { expenseNumber, fundCode: fund.fundCode }
        });

        let attached = null;
        if (goods) {
          if (!lotCostingRepository) throw new Error('This build cannot attach a cost to goods.');
          const allocation = await lotCostingRepository.allocateExpenseWithConnection(connection, {
            ...origin, userId: input.userId, expenseEntryId: Number(result.insertId),
            inventoryLotId: goods.inventoryLotId, goodsReceiptId: goods.inventoryLotId ? null : goods.goodsReceiptId,
            basis: goods.basis, reason
          }, { day });
          attached = { goodsReceiptId: goods.goodsReceiptId, grnNumber: goods.grnNumber, lotCode: goods.lotCode, allocatedTotal: allocation.allocated };
        }

        await connection.commit();
        const [saved] = await loadFunds(connection, { locCode: origin.locCode, includeInactive: true, fundId: fund.id });
        return {
          id: Number(result.insertId),
          expenseNumber,
          amount,
          categoryName: category.name,
          categoryTreatment: category.default_treatment,
          fundName: fund.name,
          fundBalance: saved ? saved.balance : 0,
          stakeholderName: stakeholder ? stakeholder.displayName : null,
          stakeholderEntryNumber: borneEntryNumber,
          attached
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /**
   * Reverses a mistaken expense. Nothing is deleted: every record the expense
   * created gets its opposite, in one transaction --
   *
   *   * any cost it put on goods is taken back off (and any part already
   *     recognised as sold is reversed with it);
   *   * the money goes back: a till payment is voided inside its still-open
   *     shift, and any other fund receives a matching "in" movement;
   *   * a partner who paid it personally has their claim reduced again;
   *   * the journal gets the exact mirror of the original posting;
   *   * a recurring cost it settled becomes due again.
   *
   * The expense is then marked void with who, when, and why. A till payment
   * whose shift was already closed and counted is refused: putting cash back
   * would make that count wrong.
   */
  async function reverseExpense(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const reason = text(input.reason);
        if (!reason) throw new Error('Write why this expense is being reversed.');
        const [rows] = await connection.execute(
          `SELECT e.*, c.name AS category_name, e.treatment_snapshot AS default_treatment, c.id AS category_id
           FROM expense_entries e JOIN expense_categories c ON c.id = e.expense_category_id
           WHERE e.id = ? FOR UPDATE`, [Number(input.expenseEntryId)]
        );
        const expense = rows[0];
        if (!expense) throw new Error('This expense no longer exists.');
        if (expense.loc_code !== origin.locCode) throw new Error('This expense belongs to another location.');
        if (expense.status !== 'recorded') throw new Error(`${expense.expense_number} has already been reversed.`);
        const amount = money(expense.amount);

        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        const reversalNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'expense_reversal', ...origin });
        const reversalNumber = `EXR-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(reversalNo).padStart(6, '0')}`;
        const note = `Reversed ${expense.expense_number}: ${reason}`;

        // 1. Off the goods first, so the cost leaves inventory before the expense goes.
        let detached = [];
        if (money(expense.allocated_total) > 0.005) {
          if (!lotCostingRepository) throw new Error('This build cannot take a cost off goods, so the expense cannot be reversed here.');
          detached = await lotCostingRepository.detachExpenseWithConnection(connection, {
            expense, reason: note, day, origin, userId: input.userId
          });
        }

        // 2. The money goes back where it came from.
        let fundMovementId = null;
        let fundName = null;
        if (expense.cash_movement_id) {
          const [movements] = await connection.execute(
            `SELECT m.*, s.status AS shift_status FROM cash_movements m
             JOIN cash_shifts s ON s.id = m.cash_shift_id WHERE m.id = ? FOR UPDATE`, [expense.cash_movement_id]
          );
          const movement = movements[0];
          if (!movement || movement.shift_status !== 'open') {
            throw new Error('This expense was paid from the till in a shift that has since been closed and counted. Putting the cash back now would make that count wrong, so ask a manager to record a cash correction instead.');
          }
          if (movement.status === 'active') {
            const [[sequence]] = await connection.execute(
              'SELECT COALESCE(MAX(event_no), 0) AS event_no FROM cash_movement_events WHERE cash_movement_id = ?', [movement.id]
            );
            await connection.execute(
              `INSERT INTO cash_movement_events
                 (cash_movement_id, event_no, action, reason, before_state, after_state, created_by)
               VALUES (?, ?, 'voided', ?, CAST(? AS JSON), NULL, ?)`,
              [movement.id, Number(sequence.event_no || 0) + 1, note.slice(0, 255),
                JSON.stringify({ movementType: movement.movement_type, direction: movement.direction, amount: money(movement.amount), reason: movement.reason, status: movement.status }),
                input.userId]
            );
            await connection.execute(
              "UPDATE cash_movements SET status = 'void', voided_at = NOW(), voided_by = ?, void_reason = ? WHERE id = ?",
              [input.userId, note.slice(0, 255), movement.id]
            );
          }
          fundName = 'the till';
        } else if (expense.fund_movement_id) {
          const [funds] = await connection.execute('SELECT id, name FROM fund_accounts WHERE id = ? FOR UPDATE', [expense.fund_account_id]);
          fundName = funds[0] ? funds[0].name : 'its fund';
          fundMovementId = await insertFundMovement(connection, {
            fundAccountId: expense.fund_account_id, businessDayId: day.id, origin,
            documentType: 'expense_reversal', documentNo: reversalNo, entryNo: 1,
            direction: 'in', amount, sourceType: 'expense_reversal', sourceId: reversalNumber,
            reason: note.slice(0, 255), userId: input.userId,
            metadata: { reversalNumber, expenseNumber: expense.expense_number }
          });
        }

        // 3. A partner who paid it personally is no longer owed it.
        const [borne] = await connection.execute(
          `SELECT * FROM stakeholder_ledger_entries
           WHERE expense_entry_id = ? AND entry_type = 'expense_borne' AND amount > 0 ORDER BY id LIMIT 1`, [expense.id]
        );
        let stakeholderName = null;
        if (borne[0]) {
          const entryNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'stakeholder_ledger', ...origin });
          const entryNumber = `SLE-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(entryNo).padStart(6, '0')}`;
          await connection.execute(
            `INSERT INTO stakeholder_ledger_entries
               (stakeholder_id, business_day_id, loc_code, mac_code, txn_date,
                document_type, document_no, entry_no, entry_number, entry_type, balance_bucket, amount,
                fund_account_id, expense_entry_id, fund_movement_id, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, 'expense_reversal', ?, 1, ?, 'expense_borne', ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [borne[0].stakeholder_id, day.id, origin.locCode, origin.macCode, origin.txnDate,
              reversalNo, entryNumber, borne[0].balance_bucket, money(-money(borne[0].amount)),
              expense.fund_account_id, expense.id, fundMovementId, note.slice(0, 255), input.userId,
              JSON.stringify({ reversalNumber, reverses: borne[0].entry_number })]
          );
          const [[person]] = await connection.execute('SELECT display_name FROM stakeholders WHERE id = ?', [borne[0].stakeholder_id]);
          stakeholderName = person ? person.display_name : null;
        }

        // 4. The journal gets the mirror of the original posting.
        await journalRepository.reverseWithConnection(connection, {
          sourceType: 'expense', sourceId: String(expense.id),
          reversalSourceType: 'expense_reversal', reversalSourceId: String(expense.id),
          businessDayId: day.id, ...origin, documentType: 'expense_reversal', documentNo: reversalNo,
          narration: note.slice(0, 255), userId: input.userId,
          metadata: { reversalNumber, expenseNumber: expense.expense_number }
        });

        // 5. A recurring cost this settled becomes due again. The run is only a
        //    reminder link; the voided expense keeps the full history.
        const [runs] = await connection.execute(
          `SELECT r.id, r.due_date, t.id AS template_id, t.next_due_date, t.cadence, t.interval_count
           FROM recurring_expense_runs r JOIN recurring_expense_templates t ON t.id = r.recurring_expense_template_id
           WHERE r.expense_entry_id = ? FOR UPDATE`, [expense.id]
        );
        for (const run of runs) {
          const due = dateOnly(run.due_date);
          if (dateOnly(run.next_due_date) === nextRecurringDate(due, run.cadence, Number(run.interval_count))) {
            await connection.execute(
              'UPDATE recurring_expense_templates SET next_due_date = ?, is_active = 1, updated_by = ? WHERE id = ?',
              [due, input.userId, run.template_id]
            );
          }
          await connection.execute('DELETE FROM recurring_expense_runs WHERE id = ?', [run.id]);
        }

        // 6. The expense itself is kept, marked void.
        await connection.execute(
          `UPDATE expense_entries SET status = 'void', voided_at = NOW(), voided_by = ?, void_reason = ?,
             metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.reversalNumber', ?)
           WHERE id = ?`,
          [input.userId, reason.slice(0, 255), reversalNumber, expense.id]
        );
        await connection.commit();
        return {
          expenseNumber: expense.expense_number,
          reversalNumber,
          amount,
          returnedTo: fundName,
          stakeholderName,
          detachedFromLots: detached.map((row) => row.lotCode),
          recurringDueAgain: runs.length > 0
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function listExpenses(filters = {}) {
    return database.withConnection(async (connection) => {
      const clauses = ['e.loc_code = ?'];
      const params = [text(filters.locCode)];
      if (filters.fromDate) { clauses.push('e.txn_date >= ?'); params.push(dateOnly(filters.fromDate)); }
      if (filters.toDate) { clauses.push('e.txn_date <= ?'); params.push(dateOnly(filters.toDate)); }
      if (Number(filters.categoryId)) { clauses.push('e.expense_category_id = ?'); params.push(Number(filters.categoryId)); }
      if (Number(filters.fundAccountId)) { clauses.push('e.fund_account_id = ?'); params.push(Number(filters.fundAccountId)); }
      if (filters.unallocatedOnly) clauses.push('e.allocated_total < e.amount');
      if (text(filters.term)) {
        clauses.push('(e.reason LIKE ? OR e.payee LIKE ? OR e.expense_number LIKE ? OR e.reference LIKE ?)');
        const like = `%${text(filters.term)}%`;
        params.push(like, like, like, like);
      }
      const where = clauses.join(' AND ');
      const limit = Math.min(500, Math.max(1, Number(filters.limit || 200)));
      const [rows] = await connection.query(
         `SELECT e.*, c.name AS category_name, e.treatment_snapshot, f.name AS fund_name, f.fund_kind,
                u.display_name AS user_name, g.grn_number, sh.display_name AS stakeholder_name
         FROM expense_entries e
         JOIN expense_categories c ON c.id = e.expense_category_id
         JOIN fund_accounts f ON f.id = e.fund_account_id
         JOIN users u ON u.id = e.created_by
         LEFT JOIN goods_receipts g ON g.id = e.goods_receipt_id
         LEFT JOIN stakeholders sh ON sh.fund_account_id = f.id
         WHERE ${where} AND (e.status = 'recorded' OR ? = 1)
         ORDER BY e.txn_date DESC, e.expense_no DESC, e.id DESC
         LIMIT ${limit}`, [...params, filters.includeReversed ? 1 : 0]
      );
      const [byCategory] = await connection.query(
         `SELECT c.id, c.name, e.treatment_snapshot, COUNT(*) AS entry_count, COALESCE(SUM(e.amount), 0) AS total
         FROM expense_entries e JOIN expense_categories c ON c.id = e.expense_category_id
         WHERE ${where} AND e.status = 'recorded'
         GROUP BY c.id, c.name, e.treatment_snapshot ORDER BY total DESC`, params
      );
      const [byFund] = await connection.query(
        `SELECT f.id, f.name, f.fund_kind, COUNT(*) AS entry_count, COALESCE(SUM(e.amount), 0) AS total
         FROM expense_entries e JOIN fund_accounts f ON f.id = e.fund_account_id
         WHERE ${where} AND e.status = 'recorded'
         GROUP BY f.id, f.name, f.fund_kind ORDER BY total DESC`, params
      );
      const rowsOut = rows.map(mapExpense);
      // Reversed expenses may be shown, struck through, but never counted.
      const counted = rowsOut.filter((row) => row.status === 'recorded');
      return {
        rows: rowsOut,
        total: money(counted.reduce((sum, row) => sum + row.amount, 0)),
        goodsTotal: money(counted.filter((row) => row.categoryTreatment === 'lot_cost').reduce((sum, row) => sum + row.amount, 0)),
        overheadTotal: money(counted.filter((row) => row.categoryTreatment !== 'lot_cost').reduce((sum, row) => sum + row.amount, 0)),
        attachedTotal: money(counted.reduce((sum, row) => sum + row.allocatedTotal, 0)),
        unattachedTotal: money(counted.reduce((sum, row) => sum + row.unallocatedTotal, 0)),
        byCategory: byCategory.map((row) => ({
          id: Number(row.id), name: row.name, treatment: row.treatment_snapshot,
          entryCount: Number(row.entry_count), total: money(row.total)
        })),
        byFund: byFund.map((row) => ({
          id: Number(row.id), name: row.name, fundKind: row.fund_kind,
          entryCount: Number(row.entry_count), total: money(row.total)
        }))
      };
    });
  }

  // ── Recurring expense reminders ───────────────────────────

  function mapRecurring(row) {
    return {
      id: Number(row.id), locationCode: row.loc_code, name: row.name,
      expenseCategoryId: Number(row.expense_category_id), categoryName: row.category_name,
      fundAccountId: Number(row.fund_account_id), fundName: row.fund_name,
      amount: money(row.amount), payee: row.payee || '', reference: row.reference || '', reason: row.reason,
      cadence: row.cadence, intervalCount: Number(row.interval_count),
      nextDueDate: dateOnly(row.next_due_date), endDate: row.end_date ? dateOnly(row.end_date) : null,
      isActive: !!row.is_active, lastExpenseNumber: row.last_expense_number || null,
      lastRecordedAt: row.last_recorded_at || null
    };
  }

  async function listRecurringExpenses({ locCode, includeInactive = false }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT t.*, c.name AS category_name, f.name AS fund_name,
                last_run.expense_number AS last_expense_number, last_run.recorded_at AS last_recorded_at
         FROM recurring_expense_templates t
         JOIN expense_categories c ON c.id = t.expense_category_id
         JOIN fund_accounts f ON f.id = t.fund_account_id
         LEFT JOIN (
           SELECT r.recurring_expense_template_id, e.expense_number, r.recorded_at,
                  ROW_NUMBER() OVER (PARTITION BY r.recurring_expense_template_id ORDER BY r.due_date DESC, r.id DESC) AS row_no
           FROM recurring_expense_runs r JOIN expense_entries e ON e.id = r.expense_entry_id
         ) last_run ON last_run.recurring_expense_template_id = t.id AND last_run.row_no = 1
         WHERE t.loc_code = ? AND (? = 1 OR t.is_active = 1)
         ORDER BY t.is_active DESC, t.next_due_date, t.name, t.id`,
        [text(locCode), includeInactive ? 1 : 0]
      );
      return rows.map(mapRecurring);
    });
  }

  async function saveRecurringExpense(input) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const locCode = text(input.locCode);
        const name = text(input.name);
        const reason = text(input.reason);
        const amount = money(input.amount);
        const cadence = text(input.cadence);
        const intervalCount = Math.max(1, Number(input.intervalCount || 1));
        const nextDueDate = dateOnly(input.nextDueDate);
        const endDate = input.endDate ? dateOnly(input.endDate) : null;
        if (!locCode || !name || !reason || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) {
          throw new Error('Name, amount, reason, and next due date are required.');
        }
        if (!['weekly', 'monthly', 'yearly', 'custom_days'].includes(cadence)) throw new Error('Choose a valid repeat schedule.');
        if (endDate && endDate < nextDueDate) throw new Error('The ending date cannot be before the next due date.');
        const [categories] = await connection.execute('SELECT id FROM expense_categories WHERE id = ? AND is_active = 1', [Number(input.expenseCategoryId)]);
        if (!categories.length) throw new Error('Choose an active expense category.');
        const [funds] = await connection.execute('SELECT id FROM fund_accounts WHERE id = ? AND loc_code = ? AND is_active = 1', [Number(input.fundAccountId), locCode]);
        if (!funds.length) throw new Error('Choose an active fund for this location.');
        const values = [locCode, name, Number(input.expenseCategoryId), Number(input.fundAccountId), amount,
          text(input.payee) || null, text(input.reference) || null, reason, cadence, intervalCount,
          nextDueDate, endDate, input.isActive === false ? 0 : 1, Number(input.userId)];
        const id = Number(input.id || 0);
        let savedId = id;
        if (id) {
          const [result] = await connection.execute(
            `UPDATE recurring_expense_templates SET loc_code = ?, name = ?, expense_category_id = ?, fund_account_id = ?,
               amount = ?, payee = ?, reference = ?, reason = ?, cadence = ?, interval_count = ?, next_due_date = ?,
               end_date = ?, is_active = ?, updated_by = ? WHERE id = ?`, [...values, id]
          );
          if (!result.affectedRows) throw new Error('This recurring expense no longer exists.');
        } else {
          const [result] = await connection.execute(
            `INSERT INTO recurring_expense_templates
               (loc_code, name, expense_category_id, fund_account_id, amount, payee, reference, reason,
                cadence, interval_count, next_due_date, end_date, is_active, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values, Number(input.userId)]
          );
          savedId = Number(result.insertId);
        }
        await connection.commit();
        return (await listRecurringExpenses({ locCode, includeInactive: true })).find((row) => row.id === savedId) || null;
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  function nextRecurringDate(value, cadence, intervalCount) {
    const [year, month, day] = dateOnly(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (cadence === 'monthly') {
      const targetMonth = month - 1 + intervalCount;
      const targetYear = year + Math.floor(targetMonth / 12);
      const normalizedMonth = ((targetMonth % 12) + 12) % 12;
      const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
      date.setUTCFullYear(targetYear, normalizedMonth, Math.min(day, lastDay));
    } else if (cadence === 'yearly') {
      const targetYear = year + intervalCount;
      const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
      date.setUTCFullYear(targetYear, month - 1, Math.min(day, lastDay));
    } else date.setUTCDate(date.getUTCDate() + intervalCount * (cadence === 'weekly' ? 7 : 1));
    return date.toISOString().slice(0, 10);
  }

  async function completeRecurringExpense({ templateId, dueDate, expenseEntryId, userId }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute('SELECT * FROM recurring_expense_templates WHERE id = ? FOR UPDATE', [Number(templateId)]);
        const template = rows[0];
        if (!template) throw new Error('This recurring expense no longer exists.');
        const normalizedDue = dateOnly(dueDate);
        await connection.execute(
          `INSERT IGNORE INTO recurring_expense_runs
             (recurring_expense_template_id, due_date, expense_entry_id, recorded_by)
           VALUES (?, ?, ?, ?)`, [template.id, normalizedDue, Number(expenseEntryId), Number(userId)]
        );
        if (dateOnly(template.next_due_date) === normalizedDue) {
          const nextDate = nextRecurringDate(normalizedDue, template.cadence, Number(template.interval_count));
          const remainsActive = !template.end_date || nextDate <= dateOnly(template.end_date);
          await connection.execute(
            'UPDATE recurring_expense_templates SET next_due_date = ?, is_active = ?, updated_by = ? WHERE id = ?',
            [nextDate, remainsActive ? 1 : 0, Number(userId), template.id]
          );
        }
        await connection.commit();
        return { templateId: Number(template.id), nextDueDate: nextRecurringDate(normalizedDue, template.cadence, Number(template.interval_count)) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  // ── Transfers ───────────────────────────────────────────────

  async function transferFunds(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const amount = money(input.amount);
        if (amount <= 0) throw new Error('A transfer amount must be greater than zero.');
        const reason = text(input.reason);
        if (!reason) throw new Error('Write why this money is moving.');
        const fromId = Number(input.fromFundAccountId);
        const toId = Number(input.toFundAccountId);
        if (!fromId || !toId) throw new Error('Choose where the money leaves from and where it goes.');
        if (fromId === toId) throw new Error('Choose two different funds.');

        const backdate = input.backdate || null;
        const day = await businessDayRepository.assertPostableWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate, allowClosed: Boolean(backdate)
        });
        // Locked in id order so two simultaneous transfers cannot deadlock.
        const [firstId, secondId] = fromId < toId ? [fromId, toId] : [toId, fromId];
        const first = await lockFund(connection, firstId, origin.locCode);
        const second = await lockFund(connection, secondId, origin.locCode);
        const fromFund = first.id === fromId ? first : second;
        const toFund = first.id === toId ? first : second;
        // A till payment belongs to the shift that counted it, so it can only be
        // recorded on the day it was paid.
        if (backdate && fromFund.fundKind === 'pos_drawer') {
          throw new Error(`${fromFund.name} is a till. Cash from a till is counted with its shift, so it cannot be recorded on an earlier date. Record it as today's payment, or ask a manager to correct that day's cash.`);
        }
        // A till payment belongs to the shift that counted it, so it can only be
        // recorded on the day it was paid.
        if (backdate && toFund.fundKind === 'pos_drawer') {
          throw new Error(`${toFund.name} is a till. Cash from a till is counted with its shift, so it cannot be recorded on an earlier date. Record it as today's payment, or ask a manager to correct that day's cash.`);
        }
        const fromStakeholder = fromFund.fundKind === 'stakeholder' ? await stakeholderForFund(connection, fromFund.id) : null;
        const toStakeholder = toFund.fundKind === 'stakeholder' ? await stakeholderForFund(connection, toFund.id) : null;

        const transferNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'fund_transfer', ...origin });
        const transferNumber = `FT-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(transferNo).padStart(6, '0')}`;
        const shared = {
          businessDayId: day.id, origin, documentType: 'fund_transfer', documentNo: transferNo,
          sourceType: 'fund_transfer', sourceId: transferNumber, userId: input.userId,
          metadata: { transferNumber, fromFund: fromFund.name, toFund: toFund.name }
        };
        const out = await spendFromFund(connection, {
          ...shared, fund: fromFund, amount, entryNo: 1,
          movementType: 'fund_transfer_out', reason: `Moved to ${toFund.name}: ${reason}`
        });
        const into = await receiveIntoFund(connection, {
          ...shared, fund: toFund, amount, entryNo: 2,
          movementType: 'fund_transfer_in', reason: `Moved from ${fromFund.name}: ${reason}`
        });

        const [transferRow] = await connection.execute(
          `INSERT INTO fund_transfers
             (business_day_id, from_fund_account_id, to_fund_account_id, cash_shift_id,
              loc_code, mac_code, txn_date, transfer_no, transfer_number, amount, reason,
              from_cash_movement_id, from_fund_movement_id, to_cash_movement_id, to_fund_movement_id,
              created_by, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [day.id, fromFund.id, toFund.id, out.cashShiftId || into.cashShiftId,
            origin.locCode, origin.macCode, origin.txnDate, transferNo, transferNumber, amount, reason,
            out.cashMovementId, out.fundMovementId, into.cashMovementId, into.fundMovementId,
            input.userId, JSON.stringify({ transferNumber, ...(backdate ? { backdated: backdate } : {}) })]
        );

        await journalRepository.postWithConnection(connection, {
          businessDayId: day.id, ...origin,
          documentType: 'fund_transfer', documentNo: transferNo,
          sourceType: 'fund_transfer', sourceId: String(transferRow.insertId),
          posting: rules.transferPosting({
            transfer: { amount, reason }, fromFund, toFund, fromStakeholder, toStakeholder
          }),
          userId: input.userId,
          metadata: { transferNumber }
        });

        await connection.commit();
        const funds = await loadFunds(connection, { locCode: origin.locCode, includeInactive: true });
        return {
          transferNumber,
          amount,
          fromFund: fromFund.name,
          toFund: toFund.name,
          fromBalance: funds.find((row) => row.id === fromFund.id)?.balance ?? 0,
          toBalance: funds.find((row) => row.id === toFund.id)?.balance ?? 0
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /** Every in and out for one fund, newest first, for the fund drawer view. */
  async function getFundLedger({ fundAccountId, locCode, fromDate, toDate, limit = 150 }) {
    return database.withConnection(async (connection) => {
      const [fund] = await loadFunds(connection, { locCode, includeInactive: true, fundId: fundAccountId });
      if (!fund) throw new Error('This fund account no longer exists.');
      const safeLimit = Math.min(500, Math.max(1, Number(limit || 150)));
      const params = [];
      const dateClause = (column) => {
        let clause = '';
        if (fromDate) { clause += ` AND ${column} >= ?`; params.push(dateOnly(fromDate)); }
        if (toDate) { clause += ` AND ${column} <= ?`; params.push(dateOnly(toDate)); }
        return clause;
      };
      let rows;
      if (fund.fundKind === 'pos_drawer') {
        params.push(Number(fund.cashDrawerId));
        const clause = dateClause('s.business_date');
        [rows] = await connection.query(
          `SELECT m.id, m.direction, m.amount, m.reason, m.movement_type AS kind,
                  s.business_date AS txn_date, m.created_at, u.display_name AS user_name
           FROM cash_movements m
           JOIN cash_shifts s ON s.id = m.cash_shift_id
           JOIN users u ON u.id = m.created_by
           WHERE s.drawer_id = ? AND m.status = 'active'${clause}
           ORDER BY m.created_at DESC, m.id DESC LIMIT ${safeLimit}`, params
        );
      } else {
        params.push(Number(fund.id));
        const clause = dateClause('m.txn_date');
        [rows] = await connection.query(
          `SELECT m.id, m.direction, m.amount, m.reason, m.document_type AS kind,
                  m.txn_date, m.created_at, u.display_name AS user_name
           FROM fund_movements m
           JOIN users u ON u.id = m.created_by
           WHERE m.fund_account_id = ?${clause}
           ORDER BY m.txn_date DESC, m.id DESC LIMIT ${safeLimit}`, params
        );
      }
      return {
        fund,
        movements: rows.map((row) => ({
          id: Number(row.id),
          direction: row.direction,
          amount: money(row.amount),
          reason: row.reason,
          kind: row.kind,
          date: dateOnly(row.txn_date),
          userName: row.user_name,
          createdAt: row.created_at
        }))
      };
    });
  }

  return {
    listFundAccounts,
    saveFundAccount,
    getFundLedger,
    listCategories,
    saveCategory,
    recordExpense,
    reverseExpense,
    listExpenses,
    listRecurringExpenses,
    saveRecurringExpense,
    completeRecurringExpense,
    transferFunds,
    // Connection-level helpers shared with the stakeholder repository.
    loadFundsWithConnection: loadFunds,
    lockFundWithConnection: lockFund,
    spendFromFundWithConnection: spendFromFund,
    receiveIntoFundWithConnection: receiveIntoFund,
    stakeholderForFundWithConnection: stakeholderForFund
  };
}

module.exports = { createExpenseRepository };
