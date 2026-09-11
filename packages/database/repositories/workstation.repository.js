function createWorkstationRepository({ database, businessDayRepository }) {
  if (!database) {
    throw new Error('Workstation repository requires a database instance.');
  }

  const COLUMNS = 'id, location_code, machine_code, name, status, created_at';

  // Workstations are listed with their location and business so the login
  // screen can show which business each one belongs to.
  const LISTED = `w.id, w.location_code, w.machine_code, w.name, w.status, w.created_at,
                  l.business_code, l.name AS location_name, l.status AS location_status`;

  async function listActive() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${LISTED}
         FROM pos_workstations w JOIN pos_locations l ON l.loc_code = w.location_code
         WHERE w.status = 'active' AND l.status = 'active'
         ORDER BY l.business_code, w.location_code, w.machine_code`
      );
      return rows;
    });
  }

  async function listAll() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${LISTED}
         FROM pos_workstations w JOIN pos_locations l ON l.loc_code = w.location_code
         ORDER BY w.status ASC, l.business_code ASC, w.location_code ASC, w.machine_code ASC`
      );
      return rows;
    });
  }

  // --- Locations ---
  // A location code is issued once. Rows are never deleted (a database trigger
  // refuses it) and the code never changes (another trigger), so a retired code
  // stays taken for good.

  function mapLocation(row) {
    return {
      locCode: row.loc_code,
      businessCode: row.business_code,
      name: row.name,
      status: row.status,
      notes: row.notes || null,
      createdAt: row.created_at,
      retiredAt: row.retired_at || null,
      workstationCount: Number(row.workstation_count || 0),
      activeWorkstationCount: Number(row.active_workstation_count || 0)
    };
  }

  async function listLocations() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT l.*, COUNT(w.id) AS workstation_count,
                COALESCE(SUM(w.status = 'active'), 0) AS active_workstation_count
         FROM pos_locations l LEFT JOIN pos_workstations w ON w.location_code = l.loc_code
         GROUP BY l.loc_code
         ORDER BY l.status, l.business_code, l.loc_code`
      );
      return rows.map(mapLocation);
    });
  }

  async function getLocation(locCode) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT l.*, COUNT(w.id) AS workstation_count,
                COALESCE(SUM(w.status = 'active'), 0) AS active_workstation_count
         FROM pos_locations l LEFT JOIN pos_workstations w ON w.location_code = l.loc_code
         WHERE l.loc_code = ? GROUP BY l.loc_code`,
        [locCode]
      );
      return rows[0] ? mapLocation(rows[0]) : null;
    });
  }

  async function createLocation({ locCode, businessCode, name, notes = null }) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute('SELECT status FROM pos_locations WHERE loc_code = ?', [locCode]);
      if (existing.length) {
        throw new Error(existing[0].status === 'retired'
          ? `${locCode} was used before and has been retired. A location code is never reused; choose a new one.`
          : `${locCode} is already in use. Choose a different code.`);
      }
      await connection.execute(
        'INSERT INTO pos_locations (loc_code, business_code, name, notes) VALUES (?, ?, ?, ?)',
        [locCode, businessCode, name, notes]
      );
      return getLocation(locCode);
    });
  }

  async function updateLocation(locCode, { businessCode, name, notes }) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `UPDATE pos_locations SET business_code = COALESCE(?, business_code), name = COALESCE(?, name),
           notes = ? WHERE loc_code = ?`,
        [businessCode || null, name || null, notes || null, locCode]
      );
      if (!result.affectedRows) throw new Error(`${locCode} is not a registered location.`);
      return getLocation(locCode);
    });
  }

  async function retireLocation(locCode) {
    return database.withConnection(async (connection) => {
      const [active] = await connection.execute(
        "SELECT name FROM pos_workstations WHERE location_code = ? AND status = 'active'", [locCode]
      );
      if (active.length) {
        throw new Error(`Deactivate its workstations first: ${active.map((row) => row.name).join(', ')}.`);
      }
      const [result] = await connection.execute(
        "UPDATE pos_locations SET status = 'retired', retired_at = CURRENT_TIMESTAMP WHERE loc_code = ? AND status = 'active'",
        [locCode]
      );
      if (!result.affectedRows) throw new Error(`${locCode} is not an active location.`);
      return getLocation(locCode);
    });
  }

  /**
   * Create a workstation. location_code + machine_code are the receipt-key
   * identity and therefore immutable after creation.
   */
  async function create({ locationCode, machineCode, name, status = 'active' }) {
    return database.withConnection(async (connection) => {
      const [locations] = await connection.execute('SELECT status FROM pos_locations WHERE loc_code = ?', [locationCode]);
      if (!locations.length) throw new Error(`${locationCode} is not a registered location. Add the location first.`);
      if (locations[0].status !== 'active') throw new Error(`${locationCode} is retired and cannot receive new workstations.`);
      const [taken] = await connection.execute(
        'SELECT id FROM pos_workstations WHERE location_code = ? AND machine_code = ?', [locationCode, machineCode]
      );
      if (taken.length) throw new Error(`${locationCode}/${machineCode} already exists. A terminal code is used once per location.`);
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

  /**
   * Opens -- or resumes -- the user's session on the workstation they chose.
   *
   * The chosen workstation always wins. An open session there is resumed; an
   * open session on any other workstation is closed first, because one user
   * works in one place at a time. The one case that is refused rather than
   * switched is a cash shift still open on another workstation: that drawer has
   * to be counted and closed where it is, so login says exactly where.
   */
  async function openSession({ workstationId, userId, billingDate, openingBalance = 0 }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [targets] = await connection.execute(
          `SELECT w.id, w.name, w.status, w.location_code, w.machine_code, l.status AS location_status
           FROM pos_workstations w
           LEFT JOIN pos_locations l ON l.loc_code = w.location_code
           WHERE w.id = ? FOR UPDATE`,
          [workstationId]
        );
        const target = targets[0];
        if (!target) throw new Error('The chosen workstation no longer exists.');
        if (target.status !== 'active') throw new Error(`${target.name} is inactive. Choose another workstation.`);
        if (target.location_status && target.location_status !== 'active') {
          throw new Error(`${target.name} belongs to a retired location (${target.location_code}) and cannot be used.`);
        }

        const [openRows] = await connection.execute(
          `SELECT s.id, s.workstation_id, s.billing_date, s.opening_balance, s.status,
                  w.name AS workstation_name, w.location_code, w.machine_code
           FROM workstation_sessions s
           JOIN pos_workstations w ON w.id = s.workstation_id
           WHERE s.user_id = ? AND s.status = 'open'
           ORDER BY s.opened_at DESC FOR UPDATE`,
          [userId]
        );
        const elsewhere = openRows.filter((row) => Number(row.workstation_id) !== Number(workstationId));
        if (elsewhere.length) {
          const [shifts] = await connection.query(
            `SELECT cs.workstation_session_id FROM cash_shifts cs
             WHERE cs.workstation_session_id IN (?) AND cs.status = 'open' LIMIT 1`,
            [elsewhere.map((row) => row.id)]
          );
          if (shifts.length) {
            const holder = elsewhere.find((row) => Number(row.id) === Number(shifts[0].workstation_session_id));
            const error = new Error(
              `You still have an open cash shift on ${holder.workstation_name} (${holder.location_code}/${holder.machine_code}). `
              + `Sign in there and close the shift before signing in to ${target.name}.`
            );
            error.code = 'SHIFT_OPEN_ON_ANOTHER_WORKSTATION';
            throw error;
          }
          await connection.query(
            `UPDATE workstation_sessions SET status = 'closed', closed_at = NOW() WHERE id IN (?)`,
            [elsewhere.map((row) => row.id)]
          );
        }

        const [activeDays] = await connection.execute(
          `SELECT d.business_date FROM business_days d
           WHERE d.loc_code = ? AND d.status IN ('open', 'closing') LIMIT 1`,
          [target.location_code]
        );
        const here = openRows.find((row) => Number(row.workstation_id) === Number(workstationId));
        const resolvedDate = activeDays[0]?.business_date || (here ? here.billing_date : billingDate);

        const [sequenceRows] = await connection.execute(
          `SELECT COALESCE(MAX(next_number), 1) AS next_no FROM document_sequences
           WHERE document_type = 'sale_receipt' AND loc_code = ? AND mac_code = ? AND txn_date = ?`,
          [target.location_code, target.machine_code, resolvedDate]
        );
        const nextReceiptNo = Number(sequenceRows[0]?.next_no || 1);

        let session;
        if (here) {
          if (String(resolvedDate) !== String(here.billing_date)) {
            await connection.execute('UPDATE workstation_sessions SET billing_date = ? WHERE id = ?', [resolvedDate, here.id]);
          }
          session = {
            id: here.id, workstationId: Number(workstationId), userId, billingDate: resolvedDate,
            openingBalance: Number(here.opening_balance), currentReceiptNo: nextReceiptNo, status: 'open'
          };
        } else {
          const [result] = await connection.execute(
            `INSERT INTO workstation_sessions (workstation_id, user_id, billing_date, opening_balance, current_receipt_no)
             VALUES (?, ?, ?, ?, ?)`,
            [workstationId, userId, resolvedDate, openingBalance, nextReceiptNo]
          );
          session = {
            id: result.insertId, workstationId: Number(workstationId), userId, billingDate: resolvedDate,
            openingBalance, currentReceiptNo: nextReceiptNo, status: 'open'
          };
        }
        await connection.commit();
        return { ...session, closedElsewhere: elsewhere.map((row) => row.workstation_name) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /** The open workstation session a sign-in is bound to, with its workstation. */
  async function getSessionById(workstationSessionId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ws.id, ws.workstation_id, ws.user_id, ws.billing_date,
                ws.opening_balance, ws.current_receipt_no, ws.status, ws.opened_at,
                pw.location_code, pw.machine_code, pw.name AS workstation_name
         FROM workstation_sessions ws
         JOIN pos_workstations pw ON pw.id = ws.workstation_id
         WHERE ws.id = ? AND ws.status = 'open' LIMIT 1`,
        [workstationSessionId]
      );
      return rows.length > 0 ? rows[0] : null;
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
    getSessionById,
    listLocations,
    getLocation,
    createLocation,
    updateLocation,
    retireLocation,
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
