function createCashManagementRepository({ database, documentSequenceRepository, businessDayRepository }) {
  if (!database) throw new Error('Cash management repository requires a database instance.');
  if (!documentSequenceRepository) throw new Error('Cash management repository requires the document sequence repository.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const json = (value) => {
    if (!value || typeof value === 'object') return value || {};
    try { return JSON.parse(value); } catch (_error) { return {}; }
  };
  const toInt = (value) => Math.max(0, Math.floor(Number(value || 0)));

  async function ensureDrawer(connection, workstationId) {
    await connection.execute(
      `INSERT IGNORE INTO cash_drawers (workstation_id, name)
       SELECT id, CONCAT('Drawer - ', machine_code) FROM pos_workstations WHERE id = ?`,
      [workstationId]
    );
    const [rows] = await connection.execute(
      `SELECT * FROM cash_drawers WHERE workstation_id = ? AND status = 'active' LIMIT 1`,
      [workstationId]
    );
    if (rows.length === 0) throw new Error('No active cash drawer is configured for this workstation.');
    // Every till is also a fund, so an expense can be paid from it.
    await connection.execute(
      `INSERT IGNORE INTO fund_accounts (fund_code, name, fund_kind, cash_drawer_id, loc_code, currency_code, is_active, sort_order)
       SELECT CONCAT('DRAWER-', w.location_code, '-', w.machine_code), CONCAT(d.name, ' (', w.machine_code, ')'),
              'pos_drawer', d.id, w.location_code, d.currency_code, 1, 10
       FROM cash_drawers d JOIN pos_workstations w ON w.id = d.workstation_id
       WHERE d.id = ? AND NOT EXISTS (SELECT 1 FROM fund_accounts f WHERE f.cash_drawer_id = d.id)`,
      [rows[0].id]
    );
    return rows[0];
  }

  async function getShiftRow(connection, shiftId, lock = false) {
    const [rows] = await connection.execute(
      `SELECT s.*, d.name AS drawer_name, d.currency_code, d.drawer_mode,
              w.location_code, w.machine_code, w.name AS workstation_name,
              u.display_name AS cashier_name
       FROM cash_shifts s
       JOIN cash_drawers d ON d.id = s.drawer_id
       JOIN pos_workstations w ON w.id = s.workstation_id
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?${lock ? ' FOR UPDATE' : ''}`,
      [shiftId]
    );
    return rows[0] || null;
  }

  async function getActiveShiftForSession(sessionId, userId = null) {
    return database.withConnection(async (connection) => {
      const [recovered] = await connection.execute(
        `SELECT s.id
         FROM cash_shifts s
         JOIN workstation_sessions ws ON ws.id = ?
         WHERE s.workstation_id = ws.workstation_id
           AND s.user_id = COALESCE(?, ws.user_id)
           AND s.business_date = ws.billing_date
           AND s.status IN ('open', 'blind_closed')
         ORDER BY (s.workstation_session_id = ws.id) DESC, s.opened_at DESC LIMIT 1`,
        [sessionId, userId]
      );
      return recovered[0] ? getShift(recovered[0].id) : null;
    });
  }

  async function getRecoverableShiftForWorkstation({ workstationId, userId }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id FROM cash_shifts
         WHERE workstation_id = ? AND user_id = ? AND status IN ('open', 'blind_closed')
         ORDER BY opened_at DESC LIMIT 1`,
        [workstationId, userId]
      );
      return rows[0] ? getShift(rows[0].id) : null;
    });
  }

  async function createShift({ workstationSessionId, workstationId, userId, businessDate, openingLines = [] }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const drawer = await ensureDrawer(connection, workstationId);
        const [active] = await connection.execute(
          `SELECT id FROM cash_shifts WHERE drawer_id = ? AND status IN ('open', 'blind_closed') FOR UPDATE`,
          [drawer.id]
        );
        if (active.length > 0) throw new Error('This cash drawer already has an active shift. Resume or close it first.');
        const [workstations] = await connection.execute(
          'SELECT location_code, machine_code FROM pos_workstations WHERE id = ? FOR UPDATE', [workstationId]
        );
        if (!workstations.length) throw new Error('The POS workstation was not found.');
        const locCode = String(workstations[0].location_code || '').trim();
        const macCode = String(workstations[0].machine_code || '').trim();
        const [sessions] = await connection.execute(
          `SELECT id FROM workstation_sessions
           WHERE id = ? AND workstation_id = ? AND user_id = ? AND billing_date = ? AND status = 'open'
           LIMIT 1 FOR UPDATE`,
          [workstationSessionId, workstationId, userId, businessDate]
        );
        if (!sessions[0]) throw new Error('The cash shift date must match the active workstation session.');
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode,
          businessDate
        });
        const shiftNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'cash_shift', locCode, macCode, txnDate: businessDate
        });
        const openingTotal = money(openingLines.reduce((sum, line) => sum + money(line.denomination) * Number(line.quantity || 0), 0));
        const [result] = await connection.execute(
          `INSERT INTO cash_shifts
             (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id, loc_code, mac_code, shift_no, business_date, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [businessDay.id, drawer.id, workstationSessionId, workstationId, userId, locCode, macCode, shiftNo, businessDate, openingTotal]
        );
        const shiftId = result.insertId;
        const [count] = await connection.execute(
          `INSERT INTO cash_counts
             (cash_shift_id, loc_code, mac_code, business_date, shift_no, count_type, total, counted_by)
           VALUES (?, ?, ?, ?, ?, 'opening', ?, ?)`,
          [shiftId, locCode, macCode, businessDate, shiftNo, openingTotal, userId]
        );
        await writeCountLines(connection, count.insertId, openingLines);
        await insertMovement(connection, {
          shiftId, movementType: 'opening_float', direction: 'in', amount: openingTotal,
          reason: 'Opening float', userId, referenceType: 'cash_count', referenceId: String(count.insertId)
        });
        await connection.commit();
        return getShift(shiftId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function writeCountLines(connection, countId, lines) {
    const [counts] = await connection.execute(
      'SELECT loc_code, mac_code, business_date, shift_no, count_type FROM cash_counts WHERE id = ?', [countId]
    );
    if (!counts.length) throw new Error('Cash count was not found.');
    const count = counts[0];
    for (const line of lines || []) {
      const denomination = money(line.denomination);
      const quantity = Math.max(0, Math.floor(Number(line.quantity || 0)));
      if (denomination <= 0 || quantity === 0) continue;
      await connection.execute(
        `INSERT INTO cash_count_lines
           (cash_count_id, loc_code, mac_code, business_date, shift_no, count_type, denomination, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [countId, count.loc_code, count.mac_code, count.business_date, count.shift_no, count.count_type,
          denomination, quantity, money(denomination * quantity)]
      );
    }
  }

  async function insertMovement(connection, { shiftId, movementType, direction, amount, reason = null, userId, referenceType = null, referenceId = null, metadata = {} }) {
    if (money(amount) <= 0) return null;
    const shift = await getShiftRow(connection, shiftId, true);
    if (!shift) throw new Error('Cash shift was not found.');
    const [movementNumbers] = await connection.execute(
      'SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [shiftId]
    );
    const movementNo = Number(movementNumbers[0].max_no || 0) + 1;
    const [result] = await connection.execute(
      `INSERT INTO cash_movements
         (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
          movement_type, direction, amount, reference_type, reference_id, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [shiftId, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no, movementNo,
        movementType, direction, money(amount), referenceType, referenceId, reason, userId, JSON.stringify(metadata)]
    );
    return result.insertId;
  }

  async function addMovement({ shiftId, movementType, direction, amount, reason, userId }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const shift = await getShiftRow(connection, shiftId, true);
        if (!shift || shift.status !== 'open') throw new Error('Cash movements can only be made on an open shift.');
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: shift.loc_code,
          businessDate: shift.business_date
        });
        const id = await insertMovement(connection, { shiftId, movementType, direction, amount, reason, userId });
        await connection.commit();
        return { id, ...(await getShift(shiftId)) };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  const editableMovementTypes = new Set(['cash_in', 'cash_out', 'safe_drop', 'bank_drop', 'correction']);

  function movementSnapshot(row) {
    return {
      movementType: row.movement_type,
      direction: row.direction,
      amount: money(row.amount),
      reason: row.reason,
      status: row.status
    };
  }

  async function lockEditableMovement(connection, movementId) {
    const [rows] = await connection.execute(
      `SELECT m.*, s.status AS shift_status, s.business_date, s.loc_code
       FROM cash_movements m
       JOIN cash_shifts s ON s.id = m.cash_shift_id
       WHERE m.id = ? FOR UPDATE`,
      [Number(movementId)]
    );
    const row = rows[0];
    if (!row) throw new Error('This cash movement no longer exists.');
    if (row.shift_status !== 'open') throw new Error('Cash can only be corrected before its shift is closed.');
    if (row.status !== 'active') throw new Error('This cash movement has already been removed.');
    if (row.reference_type || !editableMovementTypes.has(row.movement_type)) {
      throw new Error('A sale, refund, advance, or other source-linked cash movement must be corrected from its original transaction.');
    }
    await businessDayRepository.assertOpenWithConnection(connection, {
      locationCode: row.loc_code,
      businessDate: row.business_date
    });
    return row;
  }

  async function appendMovementEvent(connection, { row, action, reason, afterState, userId }) {
    const [[sequence]] = await connection.execute(
      'SELECT COALESCE(MAX(event_no), 0) AS event_no FROM cash_movement_events WHERE cash_movement_id = ?',
      [Number(row.id)]
    );
    await connection.execute(
      `INSERT INTO cash_movement_events
         (cash_movement_id, event_no, action, reason, before_state, after_state, created_by)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?)`,
      [Number(row.id), Number(sequence.event_no || 0) + 1, action, reason,
        JSON.stringify(movementSnapshot(row)), afterState ? JSON.stringify(afterState) : null, Number(userId)]
    );
  }

  async function updateMovement({ movementId, direction, amount, reason, userId }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const row = await lockEditableMovement(connection, movementId);
        const nextDirection = direction === 'out' ? 'out' : 'in';
        const nextAmount = money(amount);
        const nextReason = String(reason || '').trim();
        if (nextAmount <= 0) throw new Error('Cash movement amount must be greater than zero.');
        if (!nextReason) throw new Error('A reason is required for a cash correction.');
        const nextType = row.movement_type === 'correction'
          ? 'correction'
          : (nextDirection === 'in' ? 'cash_in' : (row.movement_type === 'safe_drop' || row.movement_type === 'bank_drop' ? row.movement_type : 'cash_out'));
        const afterState = { movementType: nextType, direction: nextDirection, amount: nextAmount, reason: nextReason, status: 'active' };
        await appendMovementEvent(connection, {
          row,
          action: 'edited',
          reason: `Corrected before shift close: ${nextReason}`,
          afterState,
          userId
        });
        await connection.execute(
          `UPDATE cash_movements
           SET movement_type = ?, direction = ?, amount = ?, reason = ?,
               metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.lastCorrectionBy', ?, '$.lastCorrectionAt', NOW())
           WHERE id = ?`,
          [nextType, nextDirection, nextAmount, nextReason, Number(userId), Number(row.id)]
        );
        await connection.commit();
        return getShift(row.cash_shift_id);
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function voidMovement({ movementId, reason, userId }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const row = await lockEditableMovement(connection, movementId);
        const voidReason = String(reason || '').trim();
        if (!voidReason) throw new Error('A reason is required to remove a cash movement.');
        await appendMovementEvent(connection, { row, action: 'voided', reason: voidReason, afterState: null, userId });
        await connection.execute(
          `UPDATE cash_movements
           SET status = 'void', voided_at = NOW(), voided_by = ?, void_reason = ?
           WHERE id = ?`,
          [Number(userId), voidReason, Number(row.id)]
        );
        await connection.commit();
        return getShift(row.cash_shift_id);
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function listMovementHistory({ locCode, fromDate, toDate, direction, movementType, term, includeVoided = true, limit = 250 }) {
    return database.withConnection(async (connection) => {
      const clauses = ['s.loc_code = ?'];
      const params = [String(locCode || '').trim()];
      if (fromDate) { clauses.push('s.business_date >= ?'); params.push(String(fromDate).slice(0, 10)); }
      if (toDate) { clauses.push('s.business_date <= ?'); params.push(String(toDate).slice(0, 10)); }
      if (direction === 'in' || direction === 'out') { clauses.push('m.direction = ?'); params.push(direction); }
      if (movementType) { clauses.push('m.movement_type = ?'); params.push(String(movementType)); }
      if (!includeVoided) clauses.push("m.status = 'active'");
      if (String(term || '').trim()) {
        clauses.push('(m.reason LIKE ? OR m.reference_type LIKE ? OR m.reference_id LIKE ? OR u.display_name LIKE ?)');
        const pattern = `%${String(term).trim()}%`;
        params.push(pattern, pattern, pattern, pattern);
      }
      const safeLimit = Math.min(1000, Math.max(1, Number(limit || 250)));
      const [rows] = await connection.query(
        `SELECT m.id, m.movement_type, m.direction, m.amount, m.status, m.reference_type, m.reference_id,
                m.reason, m.voided_at, m.void_reason, m.created_at, m.updated_at,
                s.id AS cash_shift_id, s.business_date, s.shift_no, s.mac_code,
                u.display_name AS created_by_name, vu.display_name AS voided_by_name
         FROM cash_movements m
         JOIN cash_shifts s ON s.id = m.cash_shift_id
         JOIN users u ON u.id = m.created_by
         LEFT JOIN users vu ON vu.id = m.voided_by
         WHERE ${clauses.join(' AND ')}
         ORDER BY s.business_date DESC, m.id DESC LIMIT ${safeLimit}`,
        params
      );
      return rows.map((row) => ({
        id: Number(row.id), movementType: row.movement_type, direction: row.direction,
        amount: money(row.amount), status: row.status, referenceType: row.reference_type,
        referenceId: row.reference_id, reason: row.reason, voidReason: row.void_reason,
        voidedAt: row.voided_at, createdAt: row.created_at, updatedAt: row.updated_at,
        cashShiftId: Number(row.cash_shift_id), businessDate: row.business_date,
        shiftNo: Number(row.shift_no), machineCode: row.mac_code,
        createdByName: row.created_by_name, voidedByName: row.voided_by_name,
        editable: row.status === 'active' && !row.reference_type && editableMovementTypes.has(row.movement_type)
      }));
    });
  }

  async function getShift(shiftId) {
    return database.withConnection(async (connection) => {
      const shift = await getShiftRow(connection, shiftId);
      if (!shift) return null;
      const [movements] = await connection.execute(
        `SELECT id, movement_type, direction, amount, reference_type, reference_id, reason, created_at
         FROM cash_movements WHERE cash_shift_id = ? AND status = 'active' ORDER BY id ASC`, [shiftId]
      );
      const [counts] = await connection.execute(
        `SELECT c.id, c.count_type, c.total, c.counted_at, u.display_name AS counted_by_name
         FROM cash_counts c JOIN users u ON u.id = c.counted_by WHERE c.cash_shift_id = ? ORDER BY c.id ASC`, [shiftId]
      );
      for (const count of counts) {
        const [lines] = await connection.execute(
          `SELECT denomination, quantity, line_total FROM cash_count_lines WHERE cash_count_id = ? ORDER BY denomination DESC`, [count.id]
        );
        count.lines = lines.map((line) => ({ denomination: money(line.denomination), quantity: Number(line.quantity), lineTotal: money(line.line_total) }));
        count.total = money(count.total);
      }
      const expectedTotal = money(movements.reduce((sum, row) => sum + (row.direction === 'in' ? money(row.amount) : -money(row.amount)), 0));
      return {
        id: shift.id, drawerId: shift.drawer_id, drawerName: shift.drawer_name, drawerMode: shift.drawer_mode,
        workstationSessionId: shift.workstation_session_id, workstationId: shift.workstation_id,
        workstationName: shift.workstation_name, locationCode: shift.location_code, machineCode: shift.machine_code,
        userId: shift.user_id, cashierName: shift.cashier_name, businessDate: shift.business_date,
        status: shift.status, currencyCode: shift.currency_code, openingTotal: money(shift.opening_total),
        expectedTotal, declaredTotal: shift.declared_total == null ? null : money(shift.declared_total),
        varianceTotal: shift.variance_total == null ? null : money(shift.variance_total),
        varianceReason: shift.variance_reason, openedAt: shift.opened_at, blindClosedAt: shift.blind_closed_at,
        closedAt: shift.closed_at,
        movements: movements.map((row) => ({
          ...row,
          amount: money(row.amount),
          editable: shift.status === 'open' && !row.reference_type && editableMovementTypes.has(row.movement_type)
        })),
        counts
      };
    });
  }

  async function submitClosingCount({ shiftId, userId, lines }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const shift = await getShiftRow(connection, shiftId, true);
        if (!shift || shift.status !== 'open') throw new Error('Only an open shift can be counted.');
        const total = money((lines || []).reduce((sum, line) => sum + money(line.denomination) * Number(line.quantity || 0), 0));
        const [existing] = await connection.execute(`SELECT id FROM cash_counts WHERE cash_shift_id = ? AND count_type = 'closing' FOR UPDATE`, [shiftId]);
        let countId;
        if (existing[0]) {
          countId = existing[0].id;
          await connection.execute('DELETE FROM cash_count_lines WHERE cash_count_id = ?', [countId]);
          await connection.execute('UPDATE cash_counts SET total = ?, counted_by = ?, counted_at = NOW() WHERE id = ?', [total, userId, countId]);
        } else {
          const [result] = await connection.execute(
            `INSERT INTO cash_counts
               (cash_shift_id, loc_code, mac_code, business_date, shift_no, count_type, total, counted_by)
             VALUES (?, ?, ?, ?, ?, 'closing', ?, ?)`,
            [shiftId, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no, total, userId]
          );
          countId = result.insertId;
        }
        await writeCountLines(connection, countId, lines);
        await connection.execute(`UPDATE cash_shifts SET status = 'blind_closed', declared_total = ?, blind_closed_at = NOW() WHERE id = ?`, [total, shiftId]);
        await connection.commit();
        return getShift(shiftId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function closeShift({ shiftId, userId, varianceReason = '' }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const shift = await getShiftRow(connection, shiftId, true);
        if (!shift || shift.status !== 'blind_closed') throw new Error('A shift must be blind-closed before final reconciliation.');
        const [movementRows] = await connection.execute(`SELECT direction, amount FROM cash_movements WHERE cash_shift_id = ? AND status = 'active'`, [shiftId]);
        const expected = money(movementRows.reduce((sum, row) => sum + (row.direction === 'in' ? money(row.amount) : -money(row.amount)), 0));
        const declared = money(shift.declared_total);
        const variance = money(declared - expected);
        if (Math.abs(variance) > 0.005 && !String(varianceReason).trim()) throw new Error('A variance reason is required before closing the shift.');
        await connection.execute(
          `UPDATE cash_shifts SET status = 'closed', expected_total = ?, variance_total = ?, variance_reason = ?, closed_at = NOW(), closed_by = ? WHERE id = ?`,
          [expected, variance, varianceReason || null, userId, shiftId]
        );
        const snapshot = { expectedTotal: expected, declaredTotal: declared, varianceTotal: variance, closedAt: new Date().toISOString() };
        await connection.execute(
          `INSERT INTO cash_shift_reports
             (cash_shift_id, loc_code, mac_code, business_date, shift_no, report_type, report_no, snapshot, created_by)
           VALUES (?, ?, ?, ?, ?, 'Z', ?, CAST(? AS JSON), ?)`,
          [shiftId, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no, shift.shift_no, JSON.stringify(snapshot), userId]
        );
        await connection.commit();
        return getShift(shiftId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function listReportHistory(shiftId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT p.id, p.cash_shift_report_id AS cashShiftReportId, p.cash_shift_id AS cashShiftId,
                p.report_type AS reportType, p.report_no AS reportNo, p.snapshot,
                p.printed_at AS printedAt, p.created_at AS createdAt,
                p.printed_by AS printedBy, u.display_name AS printedByName
         FROM cash_shift_report_prints p
         JOIN users u ON u.id = p.printed_by
         WHERE p.cash_shift_id = ?
         ORDER BY p.printed_at DESC, p.id DESC`,
        [shiftId]
      );
      return rows.map((row) => ({
        id: row.id,
        cashShiftReportId: row.cashShiftReportId == null ? null : Number(row.cashShiftReportId),
        cashShiftId: Number(row.cashShiftId),
        reportType: row.reportType,
        reportNo: Number(row.reportNo),
        snapshot: json(row.snapshot),
        printedAt: row.printedAt,
        createdAt: row.createdAt,
        printedBy: Number(row.printedBy),
        printedByName: row.printedByName || ''
      }));
    });
  }

  async function archiveReportPrint({ shiftId, reportType, reportNo = null, snapshot = {}, printedBy }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const normalizedType = reportType === 'Z' ? 'Z' : 'X';
        const safeShiftId = toInt(shiftId);
        const safePrintedBy = toInt(printedBy);
        if (!safeShiftId) throw new Error('A cash shift is required to archive a report print.');
        if (!safePrintedBy) throw new Error('A user is required to archive a report print.');
        const shift = await getShiftRow(connection, safeShiftId, true);
        if (!shift) throw new Error('Cash shift was not found.');

        let resolvedReportNo = reportNo == null ? null : toInt(reportNo);
        let reportId = null;

        if (normalizedType === 'Z') {
          const [canonicalRows] = await connection.execute(
            `SELECT id, report_no, snapshot
             FROM cash_shift_reports
             WHERE cash_shift_id = ? AND report_type = 'Z'
             LIMIT 1 FOR UPDATE`,
            [safeShiftId]
          );
          if (canonicalRows.length > 0) {
            reportId = Number(canonicalRows[0].id);
            resolvedReportNo = Number(canonicalRows[0].report_no);
            if (!snapshot || Object.keys(snapshot).length === 0) {
              snapshot = json(canonicalRows[0].snapshot);
            }
            await connection.execute(
              `UPDATE cash_shift_reports
               SET printed_at = COALESCE(printed_at, NOW())
               WHERE id = ?`,
              [reportId]
            );
          } else {
            resolvedReportNo = resolvedReportNo || safeShiftId;
            const [inserted] = await connection.execute(
              `INSERT INTO cash_shift_reports
                 (cash_shift_id, loc_code, mac_code, business_date, shift_no, report_type, report_no, snapshot, printed_at, created_by)
               VALUES (?, ?, ?, ?, ?, 'Z', ?, CAST(? AS JSON), NOW(), ?)`,
              [safeShiftId, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no,
                resolvedReportNo, JSON.stringify(snapshot || {}), safePrintedBy]
            );
            reportId = inserted.insertId;
          }
        } else {
          resolvedReportNo = resolvedReportNo || await documentSequenceRepository.allocateWithConnection(connection, {
            documentType: 'cash_x_report', locCode: shift.loc_code, macCode: shift.mac_code, txnDate: shift.business_date
          });
          reportId = null;
        }

        if (!reportId) {
          const [rows] = await connection.execute(
            `SELECT id
             FROM cash_shift_reports
             WHERE cash_shift_id = ? AND report_type = ? AND report_no = ?
             LIMIT 1`,
            [safeShiftId, normalizedType, resolvedReportNo]
          );
          reportId = rows[0] ? Number(rows[0].id) : null;
        }

        const [printNumbers] = await connection.execute(
          'SELECT COALESCE(MAX(print_no), 0) AS max_no FROM cash_shift_report_prints WHERE cash_shift_id = ?', [safeShiftId]
        );
        const printNo = Number(printNumbers[0].max_no || 0) + 1;
        const [result] = await connection.execute(
          `INSERT INTO cash_shift_report_prints
             (cash_shift_report_id, cash_shift_id, loc_code, mac_code, business_date, shift_no,
              report_type, report_no, print_no, snapshot, printed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
          [reportId, safeShiftId, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no,
            normalizedType, resolvedReportNo, printNo, JSON.stringify(snapshot || {}), safePrintedBy]
        );
        await connection.commit();
        return {
          id: result.insertId,
          cashShiftReportId: reportId,
          cashShiftId: safeShiftId,
          reportType: normalizedType,
          reportNo: resolvedReportNo,
          snapshot: json(snapshot),
          printedAt: new Date().toISOString(),
          printedBy: safePrintedBy,
          printedByName: ''
        };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    getActiveShiftForSession,
    getRecoverableShiftForWorkstation,
    createShift,
    getShift,
    addMovement,
    updateMovement,
    voidMovement,
    listMovementHistory,
    submitClosingCount,
    closeShift,
    listReportHistory,
    archiveReportPrint
  };
}

module.exports = { createCashManagementRepository };
