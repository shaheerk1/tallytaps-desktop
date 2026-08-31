function createWorkstationRepository({ database, businessDayRepository }) {
  if (!database) {
    throw new Error('Workstation repository requires a database instance.');
  }

  const COLUMNS = 'id, location_code, machine_code, name, status, created_at';

  async function listActive() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${COLUMNS}
         FROM pos_workstations
         WHERE status = 'active'
         ORDER BY location_code, machine_code`
      );
      return rows;
    });
  }

  async function listAll() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${COLUMNS}
         FROM pos_workstations
         ORDER BY status ASC, location_code ASC, machine_code ASC`
      );
      return rows;
    });
  }

  /**
   * Create a workstation. location_code + machine_code are the receipt-key
   * identity and therefore immutable after creation.
   */
  async function create({ locationCode, machineCode, name, status = 'active' }) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO pos_workstations (location_code, machine_code, name, status)
         VALUES (?, ?, ?, ?)`,
        [locationCode, machineCode, name, status]
      );
      return getById(result.insertId);
    });
  }

  /**
   * Update only mutable fields (name/status). Codes stay immutable to protect
   * receipt identity — changing them would invalidate existing receipt keys.
   */
  async function update(id, { name, status }) {
    return database.withConnection(async (connection) => {
      const updates = [];
      const params = [];
      if (name !== undefined) {
        updates.push('name = ?');
        params.push(name);
      }
      if (status !== undefined) {
        updates.push('status = ?');
        params.push(status);
      }
      if (updates.length === 0) {
        return getById(id);
      }
      await connection.execute(
        `UPDATE pos_workstations SET ${updates.join(', ')} WHERE id = ?`,
        [...params, id]
      );
      return getById(id);
    });
  }

  async function deleteById(id) {
    return database.withConnection(async (connection) => {
      const [sessions] = await connection.execute(
        'SELECT id FROM workstation_sessions WHERE workstation_id = ? LIMIT 1',
        [id]
      );
      if (sessions.length > 0) {
        throw new Error(
          'Cannot delete a workstation that has billing sessions. Set its status to inactive instead.'
        );
      }
      const [result] = await connection.execute(
        'DELETE FROM pos_workstations WHERE id = ?',
        [id]
      );
      return { deleted: result.affectedRows > 0 };
    });
  }

  async function getById(id) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${COLUMNS}
         FROM pos_workstations
         WHERE id = ?
         LIMIT 1`,
        [id]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  async function getFirstActive() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${COLUMNS}
         FROM pos_workstations
         WHERE status = 'active'
         ORDER BY id
         LIMIT 1`
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  // --- Workstation Sessions ---

  async function openSession({ workstationId, userId, billingDate, openingBalance = 0 }) {
    return database.withConnection(async (connection) => {
      // A later sign-in resumes the open context. Historical sessions must not
      // be removed because cash-shift reconciliation depends on them.
      const [existingRows] = await connection.execute(
        `SELECT id, workstation_id, user_id, billing_date, opening_balance, current_receipt_no, status
         FROM workstation_sessions
         WHERE user_id = ? AND status = 'open'
         ORDER BY opened_at DESC LIMIT 1`,
        [userId]
      );
      if (existingRows.length > 0) {
        const existing = existingRows[0];
        const [activeDays] = await connection.execute(
          `SELECT d.business_date
           FROM pos_workstations w
           JOIN business_days d ON d.loc_code = w.location_code AND d.status IN ('open', 'closing')
           WHERE w.id = ? LIMIT 1`,
          [existing.workstation_id]
        );
        const resolvedDate = activeDays[0]?.business_date || existing.billing_date;
        if (String(resolvedDate) !== String(existing.billing_date)) {
          await connection.execute(
            'UPDATE workstation_sessions SET billing_date = ? WHERE id = ?',
            [resolvedDate, existing.id]
          );
        }
        const [sequenceRows] = await connection.execute(
          `SELECT COALESCE(ds.next_number, 1) AS next_no
           FROM pos_workstations w
           LEFT JOIN document_sequences ds
             ON ds.document_type = 'sale_receipt'
            AND ds.loc_code = w.location_code AND ds.mac_code = w.machine_code AND ds.txn_date = ?
           WHERE w.id = ?`,
          [resolvedDate, existing.workstation_id]
        );
        return {
          id: existing.id,
          workstationId: existing.workstation_id,
          userId: existing.user_id,
          billingDate: resolvedDate,
          openingBalance: Number(existing.opening_balance),
          currentReceiptNo: sequenceRows[0]?.next_no || 1,
          status: existing.status
        };
      }

      const [activeDays] = await connection.execute(
        `SELECT d.business_date
         FROM pos_workstations w
         JOIN business_days d ON d.loc_code = w.location_code AND d.status IN ('open', 'closing')
         WHERE w.id = ? LIMIT 1`,
        [workstationId]
      );
      billingDate = activeDays[0]?.business_date || billingDate;

      const [lastSession] = await connection.execute(
        `SELECT COALESCE(ds.next_number, 1) AS maxNo
         FROM pos_workstations w
         LEFT JOIN document_sequences ds
           ON ds.document_type = 'sale_receipt'
          AND ds.loc_code = w.location_code AND ds.mac_code = w.machine_code AND ds.txn_date = ?
         WHERE w.id = ?`,
        [billingDate, workstationId]
      );
      const nextReceiptNo = lastSession[0]?.maxNo || 1;

      // Remove all existing sessions for this workstation + date + user
      // (both open and closed — a fresh login always starts a new session)
      const [result] = await connection.execute(
        `INSERT INTO workstation_sessions (workstation_id, user_id, billing_date, opening_balance, current_receipt_no)
         VALUES (?, ?, ?, ?, ?)`,
        [workstationId, userId, billingDate, openingBalance, nextReceiptNo]
      );

      return {
        id: result.insertId,
        workstationId,
        userId,
        billingDate,
        openingBalance,
        currentReceiptNo: nextReceiptNo,
        status: 'open'
      };
    });
  }

  async function getActiveSession(userId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ws.id, ws.workstation_id, ws.user_id, ws.billing_date,
                ws.opening_balance, ws.current_receipt_no, ws.status, ws.opened_at,
                pw.location_code, pw.machine_code, pw.name AS workstation_name
         FROM workstation_sessions ws
         JOIN pos_workstations pw ON pw.id = ws.workstation_id
         WHERE ws.user_id = ? AND ws.status = 'open'
         ORDER BY ws.opened_at DESC
         LIMIT 1`,
        [userId]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  async function closeSession(userId) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `UPDATE workstation_sessions
         SET status = 'closed', closed_at = NOW()
         WHERE user_id = ? AND status = 'open'`,
        [userId]
      );
      return { closed: result.affectedRows > 0 };
    });
  }

  /**
   * Update the billing date of a user's open workstation session.
   * Mirrors the reference POS "Change Date" behaviour: the new date is
   * applied to the active session so all subsequent transactions use it.
   *
   * Sessions are unique per (workstation, billing_date, user), so any prior
   * session on the target date is superseded (same rule openSession uses on
   * login) and the receipt counter is carried forward to avoid collisions.
   */
  async function updateSessionDate(userId, billingDate) {
    if (!userId || !billingDate) {
      throw new Error('userId and billingDate are required.');
    }
    return database.withConnection(async (connection) => {
      const [openRows] = await connection.execute(
        `SELECT id, workstation_id, current_receipt_no
         FROM workstation_sessions
         WHERE user_id = ? AND status = 'open'
         ORDER BY opened_at DESC
         LIMIT 1`,
        [userId]
      );
      if (openRows.length === 0) {
        return null;
      }
      const open = openRows[0];
      const [workstationRows] = await connection.execute(
        'SELECT location_code FROM pos_workstations WHERE id = ? LIMIT 1', [open.workstation_id]
      );
      if (!workstationRows[0]) throw new Error('The workstation for this session was not found.');
      if (businessDayRepository) {
        await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: workstationRows[0].location_code,
          businessDate: billingDate
        });
      }
      const [activeShifts] = await connection.execute(
        `SELECT business_date FROM cash_shifts
         WHERE workstation_id = ? AND status IN ('open', 'blind_closed')
         ORDER BY opened_at DESC LIMIT 1`,
        [open.workstation_id]
      );
      if (activeShifts[0] && dateKey(activeShifts[0].business_date) !== dateKey(billingDate)) {
        throw new Error(`Close the active cash shift for ${dateKey(activeShifts[0].business_date)} before changing the session date.`);
      }

      const [maxRows] = await connection.execute(
        `SELECT COALESCE(ds.next_number, 1) AS maxNo
         FROM pos_workstations w
         LEFT JOIN document_sequences ds
           ON ds.document_type = 'sale_receipt'
          AND ds.loc_code = w.location_code AND ds.mac_code = w.machine_code AND ds.txn_date = ?
         WHERE w.id = ?`,
        [billingDate, open.workstation_id]
      );
      const nextNo = maxRows[0]?.maxNo || 1;

      // Replace any superseded session on the target date for this workstation+user.
      await connection.execute(
        `DELETE FROM workstation_sessions
         WHERE workstation_id = ? AND billing_date = ? AND user_id = ? AND id <> ?`,
        [open.workstation_id, billingDate, userId, open.id]
      );

      await connection.execute(
        `UPDATE workstation_sessions
         SET billing_date = ?, current_receipt_no = ?
         WHERE id = ?`,
        [billingDate, nextNo, open.id]
      );

      return { id: open.id, billingDate, currentReceiptNo: nextNo };
    });
  }

  return {
    listActive,
    listAll,
    create,
    update,
    deleteById,
    getById,
    getFirstActive,
    openSession,
    getActiveSession,
    closeSession,
    updateSessionDate
  };
}

module.exports = {
  createWorkstationRepository
};

function dateKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
