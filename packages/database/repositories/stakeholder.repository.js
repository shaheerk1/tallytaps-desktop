/**
 * Stakeholders and the equity ledger.
 *
 * The ledger is append-only and signed from the stakeholder's point of view:
 * a positive amount raises what the business owes them, a negative amount
 * lowers it. Their claim is simply the sum of their entries, so there is no
 * separate balance to keep in step.
 *
 * Money always moves through the fund ledgers owned by the expense repository,
 * so a contribution or a drawing reconciles with the till, the safe, or the
 * bank in exactly the same way an expense does.
 */
const rules = require('../../core/accounting/posting-rules');

function createStakeholderRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, expenseRepository }) {
  if (!database) throw new Error('Stakeholder repository requires a database instance.');
  if (!documentSequenceRepository || !businessDayRepository) {
    throw new Error('Stakeholders require document numbering and business-day control.');
  }
  if (!journalRepository) throw new Error('Stakeholders require the journal for derived postings.');
  if (!expenseRepository) throw new Error('Stakeholders require the fund ledgers.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);
  const text = (value) => String(value || '').trim();

  function mapStakeholder(row) {
    return {
      id: Number(row.id),
      stakeholderCode: row.stakeholder_code,
      displayName: row.display_name,
      stakeholderType: row.stakeholder_type,
      fundAccountId: row.fund_account_id == null ? null : Number(row.fund_account_id),
      fundName: row.fund_name || null,
      borneCostTreatment: row.borne_cost_treatment,
      locationCode: row.loc_code,
      mobile: row.mobile || null,
      notes: row.notes || null,
      isActive: !!row.is_active,
      sortOrder: Number(row.sort_order || 0),
      contributed: money(row.contributed),
      borne: money(row.borne),
      profitShare: money(row.profit_share),
      drawn: money(row.drawn),
      settled: money(row.settled),
      // What the business owes this person right now.
      claim: money(row.claim),
      businessSharePercent: row.business_share_percent == null ? null : Number(row.business_share_percent)
    };
  }

  async function loadStakeholders(connection, { locCode, includeInactive = false, stakeholderId = null }) {
    const params = [text(locCode)];
    let where = 's.loc_code = ?';
    if (!includeInactive) where += ' AND s.is_active = 1';
    if (stakeholderId) { where += ' AND s.id = ?'; params.push(Number(stakeholderId)); }
    const [rows] = await connection.execute(
      `SELECT s.*, f.name AS fund_name,
              COALESCE(l.contributed, 0) AS contributed,
              COALESCE(l.borne, 0) AS borne,
              COALESCE(l.profit_share, 0) AS profit_share,
              COALESCE(l.drawn, 0) AS drawn,
              COALESCE(l.settled, 0) AS settled,
              COALESCE(l.claim, 0) AS claim,
              sh.share_percent AS business_share_percent
       FROM stakeholders s
       LEFT JOIN fund_accounts f ON f.id = s.fund_account_id
       LEFT JOIN (
         SELECT stakeholder_id,
                SUM(CASE WHEN entry_type = 'capital_contribution' THEN amount ELSE 0 END) AS contributed,
                SUM(CASE WHEN entry_type = 'expense_borne' THEN amount ELSE 0 END) AS borne,
                SUM(CASE WHEN entry_type = 'profit_share_allocation' THEN amount ELSE 0 END) AS profit_share,
                SUM(CASE WHEN entry_type = 'drawing' THEN -amount ELSE 0 END) AS drawn,
                SUM(CASE WHEN entry_type = 'settlement' THEN -amount ELSE 0 END) AS settled,
                SUM(amount) AS claim
         FROM stakeholder_ledger_entries GROUP BY stakeholder_id
       ) l ON l.stakeholder_id = s.id
       LEFT JOIN stakeholder_shares sh ON sh.stakeholder_id = s.id AND sh.scope = 'business' AND sh.is_active = 1
       WHERE ${where}
       ORDER BY s.sort_order, s.display_name, s.id`, params
    );
    return rows.map(mapStakeholder);
  }

  async function listStakeholders({ locCode, includeInactive = false }) {
    return database.withConnection((connection) => loadStakeholders(connection, { locCode, includeInactive }));
  }

  async function saveStakeholder(input) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const name = text(input.displayName);
        if (!name) throw new Error('Give the stakeholder a name.');
        const locCode = text(input.locCode);
        if (!locCode) throw new Error('A stakeholder belongs to a location.');
        const type = text(input.stakeholderType) || 'partner';
        if (!['owner', 'partner', 'investor'].includes(type)) throw new Error('Choose owner, partner, or investor.');
        const treatment = text(input.borneCostTreatment) || 'capital';
        if (!['capital', 'liability'].includes(treatment)) {
          throw new Error('Decide whether money they spend personally becomes their investment or a debt the business repays.');
        }
        let stakeholderId = Number(input.id || 0);
        let fundAccountId = input.fundAccountId == null ? null : Number(input.fundAccountId);

        if (stakeholderId) {
          const [existing] = await connection.execute('SELECT * FROM stakeholders WHERE id = ? FOR UPDATE', [stakeholderId]);
          if (!existing[0]) throw new Error('This stakeholder no longer exists.');
          fundAccountId = fundAccountId ?? (existing[0].fund_account_id == null ? null : Number(existing[0].fund_account_id));
          await connection.execute(
            `UPDATE stakeholders SET display_name = ?, stakeholder_type = ?, borne_cost_treatment = ?,
               mobile = ?, notes = ?, is_active = ?, sort_order = ?, fund_account_id = ? WHERE id = ?`,
            [name, type, treatment, text(input.mobile) || null, text(input.notes) || null,
              input.isActive === false ? 0 : 1, Number(input.sortOrder || 100), fundAccountId, stakeholderId]
          );
        } else {
          const code = (text(input.stakeholderCode) || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
            || `STK-${Date.now().toString().slice(-6)}`;
          // Every stakeholder gets their own pocket fund, so a cost they pay
          // personally has a real place to come from.
          if (!fundAccountId && input.createPocket !== false) {
            const [fund] = await connection.execute(
              `INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, is_active, sort_order, holder_name, notes)
               VALUES (?, ?, 'stakeholder', ?, 1, 60, ?, ?)`,
              [`POCKET-${locCode}-${code}`.slice(0, 60), `${name} (pocket)`, locCode, name,
                'Money this person spends for the business from their own hand.']
            );
            fundAccountId = Number(fund.insertId);
          }
          const [result] = await connection.execute(
            `INSERT INTO stakeholders
               (stakeholder_code, display_name, stakeholder_type, fund_account_id, borne_cost_treatment,
                loc_code, mobile, notes, is_active, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [code, name, type, fundAccountId, treatment, locCode, text(input.mobile) || null,
              text(input.notes) || null, input.isActive === false ? 0 : 1, Number(input.sortOrder || 100)]
          );
          stakeholderId = Number(result.insertId);
        }
        await connection.commit();
        const [saved] = await loadStakeholders(connection, { locCode, includeInactive: true, stakeholderId });
        return saved;
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  // ── Shares ──────────────────────────────────────────────────

  async function listShares({ stakeholderId = null, inventoryLotId = null }) {
    return database.withConnection(async (connection) => {
      const clauses = ['sh.is_active = 1'];
      const params = [];
      if (Number(stakeholderId)) { clauses.push('sh.stakeholder_id = ?'); params.push(Number(stakeholderId)); }
      if (Number(inventoryLotId)) { clauses.push('sh.inventory_lot_id = ?'); params.push(Number(inventoryLotId)); }
      const [rows] = await connection.execute(
        `SELECT sh.*, s.display_name, l.lot_code FROM stakeholder_shares sh
         JOIN stakeholders s ON s.id = sh.stakeholder_id
         LEFT JOIN inventory_lots l ON l.id = sh.inventory_lot_id
         WHERE ${clauses.join(' AND ')} ORDER BY sh.scope, sh.effective_from DESC, sh.id DESC`, params
      );
      return rows.map((row) => ({
        id: Number(row.id),
        stakeholderId: Number(row.stakeholder_id),
        stakeholderName: row.display_name,
        scope: row.scope,
        inventoryLotId: row.inventory_lot_id == null ? null : Number(row.inventory_lot_id),
        lotCode: row.lot_code || null,
        sharePercent: Number(row.share_percent),
        effectiveFrom: dateOnly(row.effective_from),
        notes: row.notes || null
      }));
    });
  }

  async function saveShare(input) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const scope = text(input.scope) || 'business';
        if (!['business', 'lot'].includes(scope)) throw new Error('A share covers the whole business or one lot.');
        const lotId = scope === 'lot' ? Number(input.inventoryLotId) : null;
        if (scope === 'lot' && !lotId) throw new Error('Choose the lot this share covers.');
        const percent = Number(input.sharePercent);
        if (!(percent > 0 && percent <= 100)) throw new Error('A share must be between 0 and 100 percent.');
        const effectiveFrom = dateOnly(input.effectiveFrom);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error('Give the share a start date.');

        // The shares in one scope may not add to more than the whole.
        const [others] = await connection.execute(
          `SELECT COALESCE(SUM(share_percent), 0) AS total FROM stakeholder_shares
           WHERE scope = ? AND is_active = 1 AND stakeholder_id <> ?
             AND (inventory_lot_id <=> ?)`,
          [scope, Number(input.stakeholderId), lotId]
        );
        const otherTotal = Number(others[0]?.total || 0);
        if (otherTotal + percent > 100.0001) {
          throw new Error(`Shares here already add up to ${otherTotal}%. This one would take the total past 100%.`);
        }

        await connection.execute(
          `INSERT INTO stakeholder_shares
             (stakeholder_id, scope, inventory_lot_id, share_percent, effective_from, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE share_percent = VALUES(share_percent), notes = VALUES(notes), is_active = 1`,
          [Number(input.stakeholderId), scope, lotId, percent, effectiveFrom, text(input.notes) || null, Number(input.userId)]
        );
        await connection.commit();
        return listShares({ stakeholderId: input.stakeholderId });
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  // ── Ledger entries ──────────────────────────────────────────

  async function lockStakeholder(connection, stakeholderId, locCode) {
    const [rows] = await connection.execute('SELECT * FROM stakeholders WHERE id = ? FOR UPDATE', [Number(stakeholderId)]);
    const row = rows[0];
    if (!row) throw new Error('Select a stakeholder.');
    if (!row.is_active) throw new Error(`${row.display_name} is not active.`);
    if (row.loc_code !== text(locCode)) throw new Error(`${row.display_name} belongs to another location.`);
    const [loaded] = await loadStakeholders(connection, { locCode: row.loc_code, includeInactive: true, stakeholderId: row.id });
    return { ...loaded, borneCostTreatment: row.borne_cost_treatment };
  }

  async function insertEntry(connection, { stakeholder, day, origin, entryType, amount, fund, ledger, reason, userId, documentType, documentNo, inventoryLotId, override }) {
    const entryNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'stakeholder_ledger', ...origin });
    const entryNumber = `SLE-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(entryNo).padStart(6, '0')}`;
    const [result] = await connection.execute(
      `INSERT INTO stakeholder_ledger_entries
         (stakeholder_id, business_day_id, loc_code, mac_code, txn_date,
          document_type, document_no, entry_no, entry_number, entry_type, amount,
          fund_account_id, inventory_lot_id, cash_movement_id, fund_movement_id, reason,
          override_approved_by, override_reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [stakeholder.id, day.id, origin.locCode, origin.macCode, origin.txnDate,
        documentType, documentNo, entryNumber, entryType, money(amount),
        fund ? fund.id : null, inventoryLotId || null,
        ledger ? ledger.cashMovementId : null, ledger ? ledger.fundMovementId : null,
        reason, override?.approvedBy || null, override?.reason || null, userId,
        JSON.stringify({ entryNumber, stakeholder: stakeholder.displayName })]
    );
    return { id: Number(result.insertId), entryNumber };
  }

  /**
   * Money in or out for a stakeholder. `direction` decides which way the fund
   * and the claim move, so contribution, drawing, and settlement all share one
   * carefully-checked path.
   */
  async function recordMovement(input, { entryType, direction, movementType, postingRule, requireAvailable }) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const amount = money(input.amount);
        if (amount <= 0) throw new Error('The amount must be greater than zero.');
        const reason = text(input.reason);
        if (!reason) throw new Error('Write why this money is moving.');

        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        const stakeholder = await lockStakeholder(connection, input.stakeholderId, origin.locCode);
        const fund = await expenseRepository.lockFundWithConnection(connection, input.fundAccountId, origin.locCode);
        if (fund.fundKind === 'stakeholder') {
          throw new Error('Choose the till, the safe, or a bank account. A stakeholder pocket is the person, not a business fund.');
        }

        let override = null;
        if (requireAvailable) {
          const available = money(stakeholder.claim);
          if (amount > available + 0.005) {
            if (!input.overrideApprovedBy || !text(input.overrideReason)) {
              throw new Error(`${stakeholder.displayName} has ${available.toFixed(2)} available. Taking more than that needs a manager to approve it with a reason.`);
            }
            override = { approvedBy: Number(input.overrideApprovedBy), reason: text(input.overrideReason) };
          }
        }

        const documentNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: entryType, ...origin });
        const shared = {
          businessDayId: day.id, origin, documentType: entryType, documentNo, entryNo: 1,
          movementType, sourceType: entryType, sourceId: `${stakeholder.id}-${documentNo}`,
          reason: `${stakeholder.displayName}: ${reason}`, userId: input.userId,
          metadata: { stakeholderId: stakeholder.id, stakeholder: stakeholder.displayName }
        };
        const ledger = direction === 'in'
          ? await expenseRepository.receiveIntoFundWithConnection(connection, { ...shared, fund, amount })
          : await expenseRepository.spendFromFundWithConnection(connection, { ...shared, fund, amount });

        const signedAmount = direction === 'in' ? amount : -amount;
        const entry = await insertEntry(connection, {
          stakeholder, day, origin, entryType, amount: signedAmount, fund, ledger, reason,
          userId: input.userId, documentType: entryType, documentNo, override
        });

        await journalRepository.postWithConnection(connection, {
          businessDayId: day.id, ...origin,
          documentType: entryType, documentNo,
          sourceType: entryType, sourceId: String(entry.id),
          posting: postingRule({ entry: { amount: signedAmount, reason }, stakeholder, fund }),
          userId: input.userId,
          metadata: { entryNumber: entry.entryNumber, stakeholder: stakeholder.displayName }
        });

        await connection.commit();
        const [updated] = await loadStakeholders(connection, { locCode: origin.locCode, includeInactive: true, stakeholderId: stakeholder.id });
        return {
          entryNumber: entry.entryNumber,
          amount,
          stakeholderName: stakeholder.displayName,
          fundName: fund.name,
          claim: updated.claim,
          overrideUsed: !!override
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  const recordContribution = (input) => recordMovement(input, {
    entryType: 'capital_contribution', direction: 'in', movementType: 'fund_transfer_in',
    postingRule: rules.contributionPosting, requireAvailable: false
  });

  const recordDrawing = (input) => recordMovement(input, {
    entryType: 'drawing', direction: 'out', movementType: 'fund_transfer_out',
    postingRule: rules.drawingPosting, requireAvailable: true
  });

  const recordSettlement = (input) => recordMovement(input, {
    entryType: 'settlement', direction: 'out', movementType: 'fund_transfer_out',
    postingRule: rules.settlementPosting, requireAvailable: true
  });

  /**
   * Approves part of the profit as belonging to a stakeholder. No cash moves;
   * this only changes what they may take out later.
   */
  async function allocateProfitShare(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const amount = money(input.amount);
        if (amount <= 0) throw new Error('A profit share must be greater than zero.');
        const reason = text(input.reason);
        if (!reason) throw new Error('Write what period or lot this share covers.');
        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        const stakeholder = await lockStakeholder(connection, input.stakeholderId, origin.locCode);
        const documentNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'profit_share_allocation', ...origin });
        const inventoryLotId = Number(input.inventoryLotId) || null;

        const entry = await insertEntry(connection, {
          stakeholder, day, origin, entryType: 'profit_share_allocation', amount,
          fund: null, ledger: null, reason, userId: input.userId,
          documentType: 'profit_share_allocation', documentNo, inventoryLotId
        });
        await journalRepository.postWithConnection(connection, {
          businessDayId: day.id, ...origin,
          documentType: 'profit_share_allocation', documentNo,
          sourceType: 'profit_share_allocation', sourceId: String(entry.id),
          posting: rules.profitSharePosting({ entry: { amount, reason, inventoryLotId }, stakeholder }),
          userId: input.userId,
          metadata: { entryNumber: entry.entryNumber }
        });
        await connection.commit();
        const [updated] = await loadStakeholders(connection, { locCode: origin.locCode, includeInactive: true, stakeholderId: stakeholder.id });
        return { entryNumber: entry.entryNumber, amount, stakeholderName: stakeholder.displayName, claim: updated.claim };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function getStatement({ stakeholderId, locCode, fromDate, toDate, limit = 200 }) {
    return database.withConnection(async (connection) => {
      const [stakeholder] = await loadStakeholders(connection, { locCode, includeInactive: true, stakeholderId });
      if (!stakeholder) throw new Error('This stakeholder no longer exists.');
      const clauses = ['e.stakeholder_id = ?'];
      const params = [Number(stakeholderId)];
      if (fromDate) { clauses.push('e.txn_date >= ?'); params.push(dateOnly(fromDate)); }
      if (toDate) { clauses.push('e.txn_date <= ?'); params.push(dateOnly(toDate)); }
      const safeLimit = Math.min(500, Math.max(1, Number(limit || 200)));
      const [rows] = await connection.query(
        `SELECT e.*, u.display_name AS user_name, f.name AS fund_name, l.lot_code,
                a.display_name AS override_approver
         FROM stakeholder_ledger_entries e
         JOIN users u ON u.id = e.created_by
         LEFT JOIN fund_accounts f ON f.id = e.fund_account_id
         LEFT JOIN inventory_lots l ON l.id = e.inventory_lot_id
         LEFT JOIN users a ON a.id = e.override_approved_by
         WHERE ${clauses.join(' AND ')}
         ORDER BY e.txn_date DESC, e.id DESC LIMIT ${safeLimit}`, params
      );
      return {
        stakeholder,
        entries: rows.map((row) => ({
          id: Number(row.id),
          entryNumber: row.entry_number,
          date: dateOnly(row.txn_date),
          entryType: row.entry_type,
          amount: money(row.amount),
          fundName: row.fund_name || null,
          lotCode: row.lot_code || null,
          reason: row.reason,
          overrideApprover: row.override_approver || null,
          overrideReason: row.override_reason || null,
          userName: row.user_name
        }))
      };
    });
  }

  /**
   * Does the sum of every stakeholder's claim agree with what the journal says
   * the business owes them? A drift here means a posting rule is wrong.
   */
  async function reconcileEquity({ locCode }) {
    return database.withConnection(async (connection) => {
      const [ledger] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM stakeholder_ledger_entries WHERE loc_code = ?`, [text(locCode)]
      );
      const [journal] = await connection.execute(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS total
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN ledger_accounts a ON a.id = l.ledger_account_id
         WHERE e.loc_code = ? AND l.stakeholder_id IS NOT NULL
           AND a.account_code IN ('2000','3000','3100','3200')`, [text(locCode)]
      );
      const ledgerTotal = money(ledger[0]?.total || 0);
      const journalTotal = money(journal[0]?.total || 0);
      return {
        ledgerTotal,
        journalTotal,
        difference: money(ledgerTotal - journalTotal),
        inBalance: money(ledgerTotal - journalTotal) === 0
      };
    });
  }

  return {
    listStakeholders,
    saveStakeholder,
    listShares,
    saveShare,
    recordContribution,
    recordDrawing,
    recordSettlement,
    allocateProfitShare,
    getStatement,
    reconcileEquity
  };
}

module.exports = { createStakeholderRepository };
