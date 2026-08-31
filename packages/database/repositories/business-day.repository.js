function createBusinessDayRepository({ database }) {
  if (!database) throw new Error('Business day repository requires a database instance.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const dateOnly = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const parseJson = (value) => {
    if (!value || typeof value === 'object') return value || null;
    try { return JSON.parse(value); } catch (_error) { return null; }
  };

  function mapDay(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      locationCode: row.loc_code,
      businessDate: dateOnly(row.business_date),
      status: row.status,
      openedBy: row.opened_by == null ? null : Number(row.opened_by),
      openedByName: row.opened_by_name || null,
      openedAt: row.opened_at,
      closingStartedBy: row.closing_started_by == null ? null : Number(row.closing_started_by),
      closingStartedAt: row.closing_started_at,
      closedBy: row.closed_by == null ? null : Number(row.closed_by),
      closedByName: row.closed_by_name || null,
      closedAt: row.closed_at,
      closeReason: row.close_reason || '',
      reopenCount: Number(row.reopen_count || 0),
      summarySnapshot: parseJson(row.summary_snapshot)
    };
  }

  async function getDayRow(connection, dayId, lock = false) {
    const [rows] = await connection.execute(
      `SELECT d.*, opened.display_name AS opened_by_name, closed.display_name AS closed_by_name
       FROM business_days d
       LEFT JOIN users opened ON opened.id = d.opened_by
       LEFT JOIN users closed ON closed.id = d.closed_by
       WHERE d.id = ?${lock ? ' FOR UPDATE' : ''}`,
      [dayId]
    );
    return rows[0] || null;
  }

  async function getActiveDayRow(connection, locationCode, lock = false) {
    const [rows] = await connection.execute(
      `SELECT d.*, opened.display_name AS opened_by_name, closed.display_name AS closed_by_name
       FROM business_days d
       LEFT JOIN users opened ON opened.id = d.opened_by
       LEFT JOIN users closed ON closed.id = d.closed_by
       WHERE d.loc_code = ? AND d.status IN ('open', 'closing')
       LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [locationCode]
    );
    return rows[0] || null;
  }

  async function assertOpenWithConnection(connection, { locationCode, businessDate }) {
    const [rows] = await connection.execute(
      `SELECT id, loc_code, business_date, status
       FROM business_days
       WHERE loc_code = ? AND business_date = ?
       LIMIT 1`,
      [String(locationCode || '').trim(), dateOnly(businessDate)]
    );
    const day = rows[0];
    if (!day) throw new Error('No business day is open for this location and date. Use Business Day Control first.');
    if (day.status !== 'open') {
      throw new Error(day.status === 'closing'
        ? 'The business day is being closed and cannot accept new transactions.'
        : 'This business day is closed and is read-only. Reopen it with a recorded reason to post transactions.');
    }
    return { id: Number(day.id), locationCode: day.loc_code, businessDate: dateOnly(day.business_date), status: day.status };
  }

  async function assertOpen({ locationCode, businessDate }) {
    return database.withConnection((connection) => assertOpenWithConnection(connection, { locationCode, businessDate }));
  }

  async function getCurrent(locationCode) {
    return database.withConnection(async (connection) => mapDay(await getActiveDayRow(connection, locationCode)));
  }

  async function list({ locationCode, limit = 30 }) {
    return database.withConnection(async (connection) => {
      const safeLimit = Math.min(365, Math.max(1, Number(limit || 30)));
      const [rows] = await connection.query(
        `SELECT d.*, opened.display_name AS opened_by_name, closed.display_name AS closed_by_name
         FROM business_days d
         LEFT JOIN users opened ON opened.id = d.opened_by
         LEFT JOIN users closed ON closed.id = d.closed_by
         WHERE d.loc_code = ?
         ORDER BY d.business_date DESC
         LIMIT ${safeLimit}`,
        [locationCode]
      );
      return rows.map(mapDay);
    });
  }

  async function getBlockersWithConnection(connection, dayId) {
    const [rows] = await connection.execute(
      `SELECT
         (SELECT COUNT(*) FROM cash_shifts WHERE business_day_id = ? AND status = 'open') AS open_shifts,
         (SELECT COUNT(*) FROM cash_shifts WHERE business_day_id = ? AND status = 'blind_closed') AS unreconciled_shifts,
         (SELECT COUNT(DISTINCT CONCAT(loc_code, '|', mac_code, '|', txn_date, '|', receipt_no))
            FROM invoice_items WHERE business_day_id = ? AND invoice_id IS NULL) AS pending_bills,
         (SELECT COUNT(*) FROM invoice_items WHERE business_day_id = ? AND invoice_id IS NULL) AS pending_bill_lines,
         (SELECT COUNT(*) FROM refund_drafts WHERE business_day_id = ? AND status IN ('open', 'held')) AS refund_drafts,
         (SELECT COUNT(*) FROM goods_receipts WHERE business_day_id = ? AND status = 'draft') AS grn_drafts,
         (SELECT COUNT(*) FROM inventory_stock_counts WHERE business_day_id = ? AND status = 'draft') AS stock_count_drafts`,
      [dayId, dayId, dayId, dayId, dayId, dayId, dayId]
    );
    const row = rows[0] || {};
    const blockers = [
      { key: 'openShifts', label: 'Open cash shifts', count: Number(row.open_shifts || 0), action: 'Blind-close and reconcile every open shift.' },
      { key: 'unreconciledShifts', label: 'Unreconciled cash shifts', count: Number(row.unreconciled_shifts || 0), action: 'Complete the final reconciliation for every blind-closed shift.' },
      { key: 'pendingBills', label: 'Pending bills', count: Number(row.pending_bills || 0), detailCount: Number(row.pending_bill_lines || 0), action: 'Finalize or remove pending bill lines.' },
      { key: 'refundDrafts', label: 'Refund drafts', count: Number(row.refund_drafts || 0), action: 'Complete or abandon the refund drafts.' },
      { key: 'grnDrafts', label: 'GRN drafts', count: Number(row.grn_drafts || 0), action: 'Finalize or cancel the GRN drafts.' },
      { key: 'stockCountDrafts', label: 'Stock-count drafts', count: Number(row.stock_count_drafts || 0), action: 'Finalize or remove stock-count drafts.' }
    ];
    return blockers;
  }

  async function buildSummaryWithConnection(connection, dayId) {
    const [invoiceRows] = await connection.execute(
      `SELECT COUNT(*) AS invoice_count,
              COALESCE(SUM(merchandise_total), 0) AS merchandise_total,
              COALESCE(SUM(bag_charge_total), 0) AS bag_charge_total,
              COALESCE(SUM(wage_charge_total), 0) AS wage_charge_total,
              COALESCE(SUM(grand_total), 0) AS sales_total,
              COALESCE(SUM(paid_total), 0) AS paid_total,
              COALESCE(SUM(balance), 0) AS credit_total
       FROM invoices
       WHERE business_day_id = ? AND status IN ('paid', 'partial') AND inv_stat = 'active'`,
      [dayId]
    );
    const [refundRows] = await connection.execute(
      `SELECT COUNT(*) AS refund_count, COALESCE(SUM(grand_total), 0) AS refund_total,
              COALESCE(SUM(refunded_total), 0) AS payout_total
       FROM refunds WHERE business_day_id = ? AND status = 'completed'`,
      [dayId]
    );
    const [cashRows] = await connection.execute(
      `SELECT m.direction, m.movement_type, COALESCE(SUM(m.amount), 0) AS amount
       FROM cash_movements m
       JOIN cash_shifts s ON s.id = m.cash_shift_id
       WHERE s.business_day_id = ?
       GROUP BY m.direction, m.movement_type`,
      [dayId]
    );
    const [paymentRows] = await connection.execute(
      `SELECT method, document_type, COALESCE(SUM(amount), 0) AS amount
       FROM payments
       WHERE business_day_id = ? AND status = 'completed'
       GROUP BY method, document_type
       ORDER BY method, document_type`,
      [dayId]
    );
    const [shiftRows] = await connection.execute(
      `SELECT COUNT(*) AS shift_count,
              COALESCE(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) AS closed_shift_count,
              COALESCE(SUM(variance_total), 0) AS variance_total
       FROM cash_shifts WHERE business_day_id = ?`,
      [dayId]
    );
    const invoice = invoiceRows[0] || {};
    const refund = refundRows[0] || {};
    const shift = shiftRows[0] || {};
    const cashMovements = cashRows.map((row) => ({
      type: row.movement_type,
      direction: row.direction,
      amount: money(row.amount)
    }));
    const tenderBreakdown = paymentRows.map((row) => ({
      method: row.method,
      documentType: row.document_type,
      amount: money(row.amount)
    }));
    return {
      invoiceCount: Number(invoice.invoice_count || 0),
      merchandiseTotal: money(invoice.merchandise_total),
      bagChargeTotal: money(invoice.bag_charge_total),
      wageChargeTotal: money(invoice.wage_charge_total),
      salesTotal: money(invoice.sales_total),
      paidTotal: money(tenderBreakdown.reduce((sum, payment) => sum + payment.amount, 0)),
      collectionTotal: money(tenderBreakdown
        .filter((payment) => payment.documentType === 'collection')
        .reduce((sum, payment) => sum + payment.amount, 0)),
      creditTotal: money(invoice.credit_total),
      refundCount: Number(refund.refund_count || 0),
      refundTotal: money(refund.refund_total),
      refundPayoutTotal: money(refund.payout_total),
      shiftCount: Number(shift.shift_count || 0),
      closedShiftCount: Number(shift.closed_shift_count || 0),
      varianceTotal: money(shift.variance_total),
      cashMovements,
      tenderBreakdown,
      cashNet: money(cashMovements.reduce((sum, movement) => sum + (movement.direction === 'in' ? movement.amount : -movement.amount), 0))
    };
  }

  async function getEventsWithConnection(connection, dayId) {
    const [rows] = await connection.execute(
      `SELECT e.id, e.event_no, e.event_type, e.from_status, e.to_status, e.reason,
              e.details, e.created_at, e.user_id, u.display_name AS user_name
       FROM business_day_events e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.business_day_id = ? ORDER BY e.event_no DESC`,
      [dayId]
    );
    return rows.map((row) => ({
      id: Number(row.id), eventNo: Number(row.event_no), eventType: row.event_type,
      fromStatus: row.from_status, toStatus: row.to_status, reason: row.reason || '',
      details: parseJson(row.details), createdAt: row.created_at,
      userId: row.user_id == null ? null : Number(row.user_id), userName: row.user_name || 'System'
    }));
  }

  async function getOperationalState({ locationCode }) {
    return database.withConnection(async (connection) => {
      const day = await getActiveDayRow(connection, locationCode);
      if (!day) {
        const [latest] = await connection.execute(
          `SELECT d.*, opened.display_name AS opened_by_name, closed.display_name AS closed_by_name
           FROM business_days d
           LEFT JOIN users opened ON opened.id = d.opened_by
           LEFT JOIN users closed ON closed.id = d.closed_by
           WHERE d.loc_code = ? ORDER BY d.business_date DESC LIMIT 1`,
          [locationCode]
        );
        return { day: null, lastClosedDay: mapDay(latest[0]), blockers: [], summary: null, events: [] };
      }
      return {
        day: mapDay(day),
        lastClosedDay: null,
        blockers: await getBlockersWithConnection(connection, day.id),
        summary: await buildSummaryWithConnection(connection, day.id),
        events: await getEventsWithConnection(connection, day.id)
      };
    });
  }

  async function addEvent(connection, { dayId, eventType, fromStatus, toStatus, userId, reason = null, details = null }) {
    const [numbers] = await connection.execute(
      'SELECT COALESCE(MAX(event_no), 0) + 1 AS next_no FROM business_day_events WHERE business_day_id = ? FOR UPDATE',
      [dayId]
    );
    await connection.execute(
      `INSERT INTO business_day_events
         (business_day_id, event_no, event_type, from_status, to_status, user_id, reason, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [dayId, Number(numbers[0].next_no), eventType, fromStatus, toStatus, userId || null,
        reason || null, JSON.stringify(details || {})]
    );
  }

  async function startClosing({ dayId, userId }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const day = await getDayRow(connection, dayId, true);
        if (!day) throw new Error('Business day was not found.');
        if (day.status !== 'open') throw new Error('Only an open business day can enter closing.');
        const blockers = await getBlockersWithConnection(connection, day.id);
        const active = blockers.filter((blocker) => blocker.count > 0);
        if (active.length > 0) {
          throw new Error(`Business day cannot enter closing: ${active.map((item) => `${item.label} (${item.count})`).join(', ')}.`);
        }
        await connection.execute(
          `UPDATE business_days SET status = 'closing', closing_started_by = ?, closing_started_at = NOW() WHERE id = ?`,
          [userId, day.id]
        );
        await addEvent(connection, { dayId: day.id, eventType: 'closing_started', fromStatus: 'open', toStatus: 'closing', userId });
        await connection.commit();
        return getOperationalState({ locationCode: day.loc_code });
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function resumeTrading({ dayId, userId, reason }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const day = await getDayRow(connection, dayId, true);
        if (!day || day.status !== 'closing') throw new Error('Only a day in closing can resume trading.');
        const cleanReason = String(reason || '').trim();
        if (!cleanReason) throw new Error('A reason is required to resume trading.');
        await connection.execute(
          `UPDATE business_days SET status = 'open', closing_started_by = NULL, closing_started_at = NULL WHERE id = ?`,
          [day.id]
        );
        await addEvent(connection, { dayId: day.id, eventType: 'closing_cancelled', fromStatus: 'closing', toStatus: 'open', userId, reason: cleanReason });
        await connection.commit();
        return getOperationalState({ locationCode: day.loc_code });
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function closeDay({ dayId, userId, reason }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const day = await getDayRow(connection, dayId, true);
        if (!day || day.status !== 'closing') throw new Error('The business day must enter closing before it can be closed.');
        const active = (await getBlockersWithConnection(connection, day.id)).filter((blocker) => blocker.count > 0);
        if (active.length > 0) throw new Error('The business day changed after review. Resolve its closing blockers and try again.');
        const summary = await buildSummaryWithConnection(connection, day.id);
        await connection.execute(
          `UPDATE business_days
           SET status = 'closed', closed_by = ?, closed_at = NOW(), close_reason = ?, summary_snapshot = CAST(? AS JSON)
           WHERE id = ?`,
          [userId, String(reason || '').trim() || null, JSON.stringify(summary), day.id]
        );
        await addEvent(connection, { dayId: day.id, eventType: 'day_closed', fromStatus: 'closing', toStatus: 'closed', userId, reason: String(reason || '').trim() || null, details: summary });
        await connection.commit();
        return { day: mapDay(await getDayRow(connection, day.id)), summary };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function openDay({ locationCode, businessDate, userId }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const loc = String(locationCode || '').trim();
        const date = dateOnly(businessDate);
        if (!loc || !date) throw new Error('Location and business date are required.');
        const active = await getActiveDayRow(connection, loc, true);
        if (active) throw new Error(`Business day ${dateOnly(active.business_date)} is already active for this location.`);
        const [latestRows] = await connection.execute(
          'SELECT * FROM business_days WHERE loc_code = ? ORDER BY business_date DESC LIMIT 1 FOR UPDATE', [loc]
        );
        const latest = latestRows[0];
        if (latest && date <= dateOnly(latest.business_date)) {
          throw new Error('A new business day must be later than the most recent recorded day. Reopen a closed day when a historical correction is required.');
        }
        const [result] = await connection.execute(
          `INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)`,
          [loc, date, userId]
        );
        await addEvent(connection, { dayId: result.insertId, eventType: 'day_opened', fromStatus: null, toStatus: 'open', userId });
        await connection.execute(
          `UPDATE workstation_sessions ws
           JOIN pos_workstations w ON w.id = ws.workstation_id
           SET ws.billing_date = ?
           WHERE ws.status = 'open' AND w.location_code = ?`,
          [date, loc]
        );
        await connection.commit();
        return getOperationalState({ locationCode: loc });
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function reopenDay({ dayId, userId, reason }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const cleanReason = String(reason || '').trim();
        if (!cleanReason) throw new Error('A reason is required to reopen a closed business day.');
        const day = await getDayRow(connection, dayId, true);
        if (!day || day.status !== 'closed') throw new Error('Only a closed business day can be reopened.');
        const active = await getActiveDayRow(connection, day.loc_code, true);
        if (active) throw new Error(`Close the active business day ${dateOnly(active.business_date)} before reopening this day.`);
        await connection.execute(
          `UPDATE business_days
           SET status = 'open', opened_by = ?, opened_at = NOW(), closing_started_by = NULL,
               closing_started_at = NULL, closed_by = NULL, closed_at = NULL, close_reason = NULL,
               summary_snapshot = NULL, reopen_count = reopen_count + 1
           WHERE id = ?`,
          [userId, day.id]
        );
        await addEvent(connection, { dayId: day.id, eventType: 'day_reopened', fromStatus: 'closed', toStatus: 'open', userId, reason: cleanReason });
        await connection.execute(
          `UPDATE workstation_sessions ws
           JOIN pos_workstations w ON w.id = ws.workstation_id
           SET ws.billing_date = ?
           WHERE ws.status = 'open' AND w.location_code = ?`,
          [day.business_date, day.loc_code]
        );
        await connection.commit();
        return getOperationalState({ locationCode: day.loc_code });
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    assertOpen,
    assertOpenWithConnection,
    getCurrent,
    list,
    getOperationalState,
    startClosing,
    resumeTrading,
    closeDay,
    openDay,
    reopenDay
  };
}

module.exports = { createBusinessDayRepository };
