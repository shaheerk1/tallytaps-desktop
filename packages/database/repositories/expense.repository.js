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

function createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository }) {
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
         LEFT JOIN cash_movements m ON m.cash_shift_id = s.id
         WHERE s.drawer_id IN (?) AND s.status = 'open'
         GROUP BY s.drawer_id`, [drawerIds]
      );
      for (const row of totals) {
        drawerTotals.set(Number(row.drawer_id), { balance: money(row.balance), lastMovementAt: row.last_movement_at });
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
          const [existing] = await connection.execute('SELECT fund_kind, cash_drawer_id FROM fund_accounts WHERE id = ? FOR UPDATE', [fundId]);
          if (!existing[0]) throw new Error('This fund account no longer exists.');
          if (existing[0].cash_drawer_id != null) throw new Error('A drawer fund mirrors its workstation and cannot be edited here.');
          await connection.execute(
            `UPDATE fund_accounts SET name = ?, fund_kind = ?, loc_code = ?, currency_code = ?, opening_balance = ?,
               holder_name = ?, account_reference = ?, notes = ?, is_active = ?, sort_order = ? WHERE id = ?`,
            [...payload, fundId]
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
      isActive: !!row.is_active,
      sortOrder: Number(row.sort_order || 0)
    };
  }

  async function listCategories({ includeInactive = false } = {}) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT * FROM expense_categories ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, name, id`
      );
      return rows.map(mapCategory);
    });
  }

  async function saveCategory(input) {
    return database.withConnection(async (connection) => {
      const name = text(input.name);
      if (!name) throw new Error('Give the category a name.');
      const treatment = text(input.defaultTreatment) || 'overhead';
      if (!['lot_cost', 'overhead', 'supplier_deduction'].includes(treatment)) {
        throw new Error('Choose whether this category belongs to received goods, to the period, or to a supplier.');
      }
      const helpText = text(input.helpText) || null;
      const isActive = input.isActive === false ? 0 : 1;
      const sortOrder = Number(input.sortOrder || 100);
      const id = Number(input.id || 0);
      if (id) {
        await connection.execute(
          'UPDATE expense_categories SET name = ?, default_treatment = ?, help_text = ?, is_active = ?, sort_order = ? WHERE id = ?',
          [name, treatment, helpText, isActive, sortOrder, id]
        );
        const [rows] = await connection.execute('SELECT * FROM expense_categories WHERE id = ?', [id]);
        return mapCategory(rows[0]);
      }
      const code = (text(input.categoryCode) || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
      if (!code) throw new Error('Give the category a name using letters or numbers.');
      const [result] = await connection.execute(
        `INSERT INTO expense_categories (category_code, name, default_treatment, help_text, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [code, name, treatment, helpText, isActive, sortOrder]
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
          document_type, document_no, entry_no, entry_number, entry_type, amount,
          fund_account_id, expense_entry_id, fund_movement_id, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, 'expense', ?, 1, ?, 'expense_borne', ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [stakeholder.id, day.id, origin.locCode, origin.macCode, origin.txnDate,
        expense.expenseNo, entryNumber, money(expense.amount), fund.id, expense.id,
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
      allocationTarget: row.allocation_target,
      allocatedTotal: money(row.allocated_total),
      unallocatedTotal: money(money(row.amount) - money(row.allocated_total)),
      goodsReceiptId: row.goods_receipt_id == null ? null : Number(row.goods_receipt_id),
      grnNumber: row.grn_number || null,
      categoryId: Number(row.expense_category_id),
      categoryName: row.category_name,
      categoryTreatment: row.default_treatment,
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

  async function recordExpense(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const amount = money(input.amount);
        if (amount <= 0) throw new Error('An expense amount must be greater than zero.');
        const reason = text(input.reason);
        if (!reason) throw new Error('Write what this money was for.');

        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        const [categories] = await connection.execute(
          'SELECT * FROM expense_categories WHERE id = ? LIMIT 1', [Number(input.expenseCategoryId)]
        );
        const category = categories[0];
        if (!category || !category.is_active) throw new Error('Choose an active expense category.');

        const fund = await lockFund(connection, input.fundAccountId, origin.locCode);
        const stakeholder = fund.fundKind === 'stakeholder' ? await stakeholderForFund(connection, fund.id) : null;
        if (fund.fundKind === 'stakeholder' && !stakeholder) {
          throw new Error(`${fund.name} is a stakeholder pocket that is not linked to anyone. Link it in Stakeholders first.`);
        }
        if (stakeholder && !stakeholder.isActive) throw new Error(`${stakeholder.displayName} is not active.`);

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
             (business_day_id, expense_category_id, fund_account_id, cash_shift_id,
              loc_code, mac_code, txn_date, expense_no, expense_number, amount,
              payee, reference, reason, cash_movement_id, fund_movement_id, created_by, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [day.id, category.id, fund.id, ledger.cashShiftId,
            origin.locCode, origin.macCode, origin.txnDate, expenseNo, expenseNumber, amount,
            text(input.payee) || null, text(input.reference) || null, reason,
            ledger.cashMovementId, ledger.fundMovementId, input.userId,
            JSON.stringify({ categoryCode: category.category_code, treatment: category.default_treatment, fundCode: fund.fundCode })]
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
            category: { id: Number(category.id), name: category.name, defaultTreatment: category.default_treatment },
            stakeholder
          }),
          userId: input.userId,
          metadata: { expenseNumber, fundCode: fund.fundCode }
        });

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
          stakeholderEntryNumber: borneEntryNumber
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
        `SELECT e.*, c.name AS category_name, c.default_treatment, f.name AS fund_name, f.fund_kind,
                u.display_name AS user_name, g.grn_number, sh.display_name AS stakeholder_name
         FROM expense_entries e
         JOIN expense_categories c ON c.id = e.expense_category_id
         JOIN fund_accounts f ON f.id = e.fund_account_id
         JOIN users u ON u.id = e.created_by
         LEFT JOIN goods_receipts g ON g.id = e.goods_receipt_id
         LEFT JOIN stakeholders sh ON sh.fund_account_id = f.id
         WHERE ${where} AND e.status = 'recorded'
         ORDER BY e.txn_date DESC, e.expense_no DESC, e.id DESC
         LIMIT ${limit}`, params
      );
      const [byCategory] = await connection.query(
        `SELECT c.id, c.name, c.default_treatment, COUNT(*) AS entry_count, COALESCE(SUM(e.amount), 0) AS total
         FROM expense_entries e JOIN expense_categories c ON c.id = e.expense_category_id
         WHERE ${where} AND e.status = 'recorded'
         GROUP BY c.id, c.name, c.default_treatment ORDER BY total DESC`, params
      );
      const [byFund] = await connection.query(
        `SELECT f.id, f.name, f.fund_kind, COUNT(*) AS entry_count, COALESCE(SUM(e.amount), 0) AS total
         FROM expense_entries e JOIN fund_accounts f ON f.id = e.fund_account_id
         WHERE ${where} AND e.status = 'recorded'
         GROUP BY f.id, f.name, f.fund_kind ORDER BY total DESC`, params
      );
      const rowsOut = rows.map(mapExpense);
      return {
        rows: rowsOut,
        total: money(rowsOut.reduce((sum, row) => sum + row.amount, 0)),
        goodsTotal: money(rowsOut.filter((row) => row.categoryTreatment === 'lot_cost').reduce((sum, row) => sum + row.amount, 0)),
        overheadTotal: money(rowsOut.filter((row) => row.categoryTreatment !== 'lot_cost').reduce((sum, row) => sum + row.amount, 0)),
        attachedTotal: money(rowsOut.reduce((sum, row) => sum + row.allocatedTotal, 0)),
        unattachedTotal: money(rowsOut.reduce((sum, row) => sum + row.unallocatedTotal, 0)),
        byCategory: byCategory.map((row) => ({
          id: Number(row.id), name: row.name, treatment: row.default_treatment,
          entryCount: Number(row.entry_count), total: money(row.total)
        })),
        byFund: byFund.map((row) => ({
          id: Number(row.id), name: row.name, fundKind: row.fund_kind,
          entryCount: Number(row.entry_count), total: money(row.total)
        }))
      };
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

        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        // Locked in id order so two simultaneous transfers cannot deadlock.
        const [firstId, secondId] = fromId < toId ? [fromId, toId] : [toId, fromId];
        const first = await lockFund(connection, firstId, origin.locCode);
        const second = await lockFund(connection, secondId, origin.locCode);
        const fromFund = first.id === fromId ? first : second;
        const toFund = first.id === toId ? first : second;
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
            input.userId, JSON.stringify({ transferNumber })]
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
           WHERE s.drawer_id = ?${clause}
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
    listExpenses,
    transferFunds,
    // Connection-level helpers shared with the stakeholder repository.
    loadFundsWithConnection: loadFunds,
    lockFundWithConnection: lockFund,
    spendFromFundWithConnection: spendFromFund,
    receiveIntoFundWithConnection: receiveIntoFund
  };
}

module.exports = { createExpenseRepository };
