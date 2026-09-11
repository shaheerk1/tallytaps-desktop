/**
 * The journal: writer, period control, and the three statements.
 *
 * `postWithConnection` is the only way journal rows are created, and it is
 * always called inside the same transaction as the business event it describes.
 * If the event rolls back, so does its posting; a business event can never end
 * up recorded without its journal lines, or the other way round.
 */
const { assertBalanced } = require('../../core/accounting/posting-rules');

function createJournalRepository({ database, documentSequenceRepository }) {
  if (!database) throw new Error('Journal repository requires a database instance.');
  if (!documentSequenceRepository) throw new Error('The journal requires document numbering.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);
  const text = (value) => String(value || '').trim();

  async function accountsByCode(connection) {
    const [rows] = await connection.execute('SELECT id, account_code, name, account_type, normal_balance FROM ledger_accounts');
    return new Map(rows.map((row) => [row.account_code, row]));
  }

  /**
   * A closed period is read-only. Postings for a date inside one are refused
   * until somebody with authority reopens it and says why.
   */
  async function assertPeriodOpenWithConnection(connection, { locCode, txnDate }) {
    const [rows] = await connection.execute(
      `SELECT id, status, period_start, period_end FROM accounting_periods
       WHERE loc_code = ? AND ? BETWEEN period_start AND period_end LIMIT 1`,
      [text(locCode), dateOnly(txnDate)]
    );
    const period = rows[0];
    if (period && period.status === 'closed') {
      throw new Error(`The accounting period ${dateOnly(period.period_start)} to ${dateOnly(period.period_end)} is closed. Reopen it with a recorded reason to post to these dates.`);
    }
    return period || null;
  }

  /**
   * Writes one balanced entry. `sourceType`/`sourceId` are unique together, so a
   * replayed business event cannot post its journal twice.
   */
  async function postWithConnection(connection, {
    businessDayId, locCode, macCode, txnDate,
    documentType, documentNo, sourceType, sourceId, posting, userId, metadata
  }) {
    const origin = { locCode: text(locCode), macCode: text(macCode), txnDate: dateOnly(txnDate) };
    await assertPeriodOpenWithConnection(connection, { locCode: origin.locCode, txnDate: origin.txnDate });

    const balanced = assertBalanced(posting);
    const accounts = await accountsByCode(connection);

    const [existing] = await connection.execute(
      `SELECT COALESCE(MAX(entry_no), 0) AS max_no FROM journal_entries
       WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND document_type = ? AND document_no = ?`,
      [origin.locCode, origin.macCode, origin.txnDate, documentType, Number(documentNo)]
    );
    const entryNo = Number(existing[0]?.max_no || 0) + 1;
    const journalNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'journal', ...origin });
    const journalNumber = `JV-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(journalNo).padStart(6, '0')}`;

    const [result] = await connection.execute(
      `INSERT INTO journal_entries
         (business_day_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no,
          journal_number, source_type, source_id, narration, total_debit, total_credit, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [businessDayId, origin.locCode, origin.macCode, origin.txnDate, documentType, Number(documentNo), entryNo,
        journalNumber, sourceType, String(sourceId), balanced.narration,
        balanced.totalDebit, balanced.totalCredit, userId, JSON.stringify(metadata || {})]
    );

    let lineNo = 0;
    for (const line of balanced.lines) {
      lineNo += 1;
      const account = accounts.get(line.accountCode);
      if (!account) throw new Error(`Ledger account ${line.accountCode} is missing from the chart of accounts.`);
      await connection.execute(
        `INSERT INTO journal_lines
           (journal_entry_id, line_no, ledger_account_id, debit, credit,
            fund_account_id, stakeholder_id, inventory_lot_id, expense_category_id, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [result.insertId, lineNo, account.id, money(line.debit), money(line.credit),
          line.fundAccountId || null, line.stakeholderId || null,
          line.inventoryLotId || null, line.expenseCategoryId || null, line.memo || null]
      );
    }
    return { id: Number(result.insertId), journalNumber, totalDebit: balanced.totalDebit };
  }

  /**
   * Posts the exact mirror of an earlier entry: every debit becomes a credit on
   * the same account and dimensions, and the reverse. Mirroring the original's
   * own lines means the reversal is right whatever rule produced them. Returns
   * null when the source never posted (nothing to reverse).
   */
  async function reverseWithConnection(connection, {
    sourceType, sourceId, reversalSourceType, reversalSourceId,
    businessDayId, locCode, macCode, txnDate, documentType, documentNo, narration, userId, metadata
  }) {
    const [entries] = await connection.execute(
      'SELECT id, narration FROM journal_entries WHERE source_type = ? AND source_id = ? LIMIT 1',
      [sourceType, String(sourceId)]
    );
    if (!entries[0]) return null;
    const [lines] = await connection.execute(
      `SELECT l.*, a.account_code FROM journal_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
       WHERE l.journal_entry_id = ? ORDER BY l.line_no`, [entries[0].id]
    );
    return postWithConnection(connection, {
      businessDayId, locCode, macCode, txnDate, documentType, documentNo,
      sourceType: reversalSourceType, sourceId: reversalSourceId, userId,
      metadata: { ...(metadata || {}), reversesJournalEntryId: Number(entries[0].id) },
      posting: {
        narration: narration || `Reversal: ${entries[0].narration}`,
        lines: lines.map((line) => ({
          accountCode: line.account_code,
          debit: money(line.credit),
          credit: money(line.debit),
          fundAccountId: line.fund_account_id,
          stakeholderId: line.stakeholder_id,
          inventoryLotId: line.inventory_lot_id,
          expenseCategoryId: line.expense_category_id,
          memo: line.memo ? `Reversal: ${line.memo}`.slice(0, 255) : 'Reversal'
        }))
      }
    });
  }

  // ── Reading ─────────────────────────────────────────────────

  async function listAccounts() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT * FROM ledger_accounts WHERE is_active = 1 ORDER BY sort_order, account_code'
      );
      return rows.map((row) => ({
        id: Number(row.id), accountCode: row.account_code, name: row.name,
        accountType: row.account_type, normalBalance: row.normal_balance, description: row.description
      }));
    });
  }

  function periodClauses(filters, params) {
    const clauses = ['e.loc_code = ?'];
    params.push(text(filters.locCode));
    if (filters.fromDate) { clauses.push('e.txn_date >= ?'); params.push(dateOnly(filters.fromDate)); }
    if (filters.toDate) { clauses.push('e.txn_date <= ?'); params.push(dateOnly(filters.toDate)); }
    return clauses.join(' AND ');
  }

  async function listJournal(filters = {}) {
    return database.withConnection(async (connection) => {
      const params = [];
      const where = periodClauses(filters, params);
      const limit = Math.min(500, Math.max(1, Number(filters.limit || 100)));
      const [entries] = await connection.query(
        `SELECT e.*, u.display_name AS user_name FROM journal_entries e
         JOIN users u ON u.id = e.created_by
         WHERE ${where} ORDER BY e.txn_date DESC, e.id DESC LIMIT ${limit}`, params
      );
      if (!entries.length) return [];
      const ids = entries.map((row) => Number(row.id));
      const [lines] = await connection.query(
        `SELECT l.*, a.account_code, a.name AS account_name, a.account_type
         FROM journal_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
         WHERE l.journal_entry_id IN (?) ORDER BY l.journal_entry_id, l.line_no`, [ids]
      );
      const byEntry = new Map();
      for (const line of lines) {
        const key = Number(line.journal_entry_id);
        if (!byEntry.has(key)) byEntry.set(key, []);
        byEntry.get(key).push({
          lineNo: Number(line.line_no), accountCode: line.account_code, accountName: line.account_name,
          accountType: line.account_type, debit: money(line.debit), credit: money(line.credit), memo: line.memo
        });
      }
      return entries.map((row) => ({
        id: Number(row.id),
        journalNumber: row.journal_number,
        date: dateOnly(row.txn_date),
        narration: row.narration,
        sourceType: row.source_type,
        sourceId: row.source_id,
        totalDebit: money(row.total_debit),
        totalCredit: money(row.total_credit),
        userName: row.user_name,
        lines: byEntry.get(Number(row.id)) || []
      }));
    });
  }

  /**
   * The self-proving report. `inBalance` is the whole point: if it is ever
   * false, a posting rule is wrong and the difference says by how much.
   */
  async function getTrialBalance(filters = {}) {
    return database.withConnection(async (connection) => {
      const params = [];
      const where = periodClauses(filters, params);
      const [rows] = await connection.query(
        `SELECT a.account_code, a.name, a.account_type, a.normal_balance,
                COALESCE(SUM(l.debit), 0) AS debit_total,
                COALESCE(SUM(l.credit), 0) AS credit_total
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN ledger_accounts a ON a.id = l.ledger_account_id
         WHERE ${where}
         GROUP BY a.id, a.account_code, a.name, a.account_type, a.normal_balance, a.sort_order
         ORDER BY a.sort_order, a.account_code`, params
      );
      const accounts = rows.map((row) => {
        const debitTotal = money(row.debit_total);
        const creditTotal = money(row.credit_total);
        const balance = row.normal_balance === 'debit' ? money(debitTotal - creditTotal) : money(creditTotal - debitTotal);
        return {
          accountCode: row.account_code, name: row.name, accountType: row.account_type,
          normalBalance: row.normal_balance, debitTotal, creditTotal, balance
        };
      });
      const totalDebit = money(accounts.reduce((sum, row) => sum + row.debitTotal, 0));
      const totalCredit = money(accounts.reduce((sum, row) => sum + row.creditTotal, 0));
      return {
        accounts,
        totalDebit,
        totalCredit,
        difference: money(totalDebit - totalCredit),
        inBalance: money(totalDebit - totalCredit) === 0
      };
    });
  }

  async function getProfitAndLoss(filters = {}) {
    const trial = await getTrialBalance(filters);
    const expenses = trial.accounts.filter((row) => row.accountType === 'expense');
    const income = trial.accounts.filter((row) => row.accountType === 'income');
    const expenseTotal = money(expenses.reduce((sum, row) => sum + row.balance, 0));
    const incomeTotal = money(income.reduce((sum, row) => sum + row.balance, 0));
    return {
      income, expenses, incomeTotal, expenseTotal,
      netResult: money(incomeTotal - expenseTotal),
      // A zero-income result is surfaced as a warning because it normally means
      // older operational activity has not been reconciled into the journal yet.
      coversCostsOnly: incomeTotal === 0
    };
  }

  async function getBalanceSheet(filters = {}) {
    // A balance sheet is cumulative as at a date. `fromDate` belongs to the P&L
    // period and must not discard opening assets, debts, or owner balances.
    const cumulativeFilters = { locCode: filters.locCode, toDate: filters.toDate };
    const trial = await getTrialBalance(cumulativeFilters);
    const assets = trial.accounts.filter((row) => row.accountType === 'asset');
    const liabilities = trial.accounts.filter((row) => row.accountType === 'liability');
    const equity = trial.accounts.filter((row) => row.accountType === 'equity');
    // Each group is summed toward its own natural side. Drawings are an equity
    // account that is debit-normal, so its balance must REDUCE equity; adding
    // it would inflate what the owners are shown as holding.
    const towardCredit = (rows) => money(rows.reduce((sum, row) => sum + (row.normalBalance === 'credit' ? row.balance : -row.balance), 0));
    const towardDebit = (rows) => money(rows.reduce((sum, row) => sum + (row.normalBalance === 'debit' ? row.balance : -row.balance), 0));
    const assetTotal = towardDebit(assets);
    const liabilityTotal = towardCredit(liabilities);
    const equityTotal = towardCredit(equity);
    const profitAndLoss = await getProfitAndLoss(cumulativeFilters);
    return {
      assets, liabilities, equity, assetTotal, liabilityTotal, equityTotal,
      retainedResult: profitAndLoss.netResult,
      // Assets = liabilities + equity + this period's result.
      difference: money(assetTotal - (liabilityTotal + equityTotal + profitAndLoss.netResult)),
      inBalance: money(assetTotal - (liabilityTotal + equityTotal + profitAndLoss.netResult)) === 0
    };
  }

  // ── Period control ──────────────────────────────────────────

  async function listPeriods({ locCode, limit = 24 }) {
    return database.withConnection(async (connection) => {
      const safeLimit = Math.min(120, Math.max(1, Number(limit || 24)));
      const [rows] = await connection.query(
        `SELECT p.*, u.display_name AS closed_by_name FROM accounting_periods p
         LEFT JOIN users u ON u.id = p.closed_by
         WHERE p.loc_code = ? ORDER BY p.period_start DESC LIMIT ${safeLimit}`, [text(locCode)]
      );
      return rows.map((row) => ({
        id: Number(row.id), locationCode: row.loc_code,
        periodStart: dateOnly(row.period_start), periodEnd: dateOnly(row.period_end),
        status: row.status, closedByName: row.closed_by_name || null,
        closedAt: row.closed_at, reopenCount: Number(row.reopen_count), notes: row.notes
      }));
    });
  }

  async function closePeriod({ locCode, periodStart, periodEnd, userId, notes }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const start = dateOnly(periodStart);
        const end = dateOnly(periodEnd);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
          throw new Error('Give the period a start date and an end date that follows it.');
        }
        const [overlapping] = await connection.execute(
          `SELECT id, period_start, period_end FROM accounting_periods
           WHERE loc_code = ? AND period_start <= ? AND period_end >= ? AND period_start <> ? LIMIT 1`,
          [text(locCode), end, start, start]
        );
        if (overlapping[0]) {
          throw new Error(`These dates overlap the period ${dateOnly(overlapping[0].period_start)} to ${dateOnly(overlapping[0].period_end)}.`);
        }
        await connection.execute(
          `INSERT INTO accounting_periods (loc_code, period_start, period_end, status, closed_by, closed_at, notes)
           VALUES (?, ?, ?, 'closed', ?, NOW(), ?)
           ON DUPLICATE KEY UPDATE period_end = VALUES(period_end), status = 'closed',
             closed_by = VALUES(closed_by), closed_at = NOW(), notes = VALUES(notes)`,
          [text(locCode), start, end, userId, text(notes) || null]
        );
        const [[period]] = await connection.execute(
          'SELECT id FROM accounting_periods WHERE loc_code = ? AND period_start = ? FOR UPDATE', [text(locCode), start]
        );
        const [[eventNo]] = await connection.execute(
          'SELECT COALESCE(MAX(event_no), 0) AS n FROM accounting_period_events WHERE accounting_period_id = ?', [period.id]
        );
        await connection.execute(
          `INSERT INTO accounting_period_events (accounting_period_id, event_no, event_type, reason, created_by)
           VALUES (?, ?, 'closed', ?, ?)`,
          [period.id, Number(eventNo.n || 0) + 1, text(notes) || 'Period closed', userId]
        );
        await connection.commit();
        const [rows] = await connection.execute(
          'SELECT * FROM accounting_periods WHERE loc_code = ? AND period_start = ?', [text(locCode), start]
        );
        return {
          id: Number(rows[0].id), periodStart: dateOnly(rows[0].period_start),
          periodEnd: dateOnly(rows[0].period_end), status: rows[0].status
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function reopenPeriod({ periodId, userId, reason }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!text(reason)) throw new Error('Reopening a closed period needs a recorded reason.');
        const [rows] = await connection.execute('SELECT * FROM accounting_periods WHERE id = ? FOR UPDATE', [Number(periodId)]);
        if (!rows[0]) throw new Error('This accounting period no longer exists.');
        if (rows[0].status !== 'closed') throw new Error('This period is already open.');
        const [[eventNo]] = await connection.execute(
          'SELECT COALESCE(MAX(event_no), 0) AS n FROM accounting_period_events WHERE accounting_period_id = ?', [Number(periodId)]
        );
        await connection.execute(
          `UPDATE accounting_periods SET status = 'open', reopen_count = reopen_count + 1,
             reopen_reason = ? WHERE id = ?`,
          [text(reason), Number(periodId)]
        );
        await connection.execute(
          `INSERT INTO accounting_period_events (accounting_period_id, event_no, event_type, reason, created_by)
           VALUES (?, ?, 'reopened', ?, ?)`,
          [Number(periodId), Number(eventNo.n || 0) + 1, text(reason), userId]
        );
        await connection.commit();
        return { id: Number(periodId), status: 'open', reopenCount: Number(rows[0].reopen_count) + 1 };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  return {
    postWithConnection,
    reverseWithConnection,
    assertPeriodOpenWithConnection,
    listAccounts,
    listJournal,
    getTrialBalance,
    getProfitAndLoss,
    getBalanceSheet,
    listPeriods,
    closePeriod,
    reopenPeriod
  };
}

module.exports = { createJournalRepository };
