function createAuthRepository({ database }) {
  if (!database) {
    throw new Error('Auth repository requires a database instance.');
  }

  async function findUserByUsername(username) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT u.id, u.username, u.password_hash, u.display_name, u.email, u.phone,
                u.status, u.last_login_at, u.password_updated_at
         FROM users u
         WHERE u.username = ? AND u.status = 'active'
         LIMIT 1`,
        [username]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  async function getUserPermissions(userId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT DISTINCT p.permission_key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = ?`,
        [userId]
      );
      return rows.map((r) => r.permission_key);
    });
  }

  async function getUserRoles(userId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT r.id AS role_id, r.role_key, r.name AS role_name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ?`,
        [userId]
      );
      return rows;
    });
  }

  async function createSession(userId, token, expiresAt) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
        [userId, token, expiresAt]
      );
    });
  }

  async function findSessionByToken(token) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT s.id, s.user_id, s.token, s.expires_at,
                u.username, u.display_name, u.email, u.phone,
                u.status, u.last_login_at, u.password_updated_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > NOW()
         LIMIT 1`,
        [token]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  /** Ties one sign-in to the workstation session it opened. */
  async function bindWorkstationSession(token, workstationSessionId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'UPDATE sessions SET workstation_session_id = ? WHERE token = ?',
        [workstationSessionId || null, token]
      );
    });
  }

  /**
   * Everything the main process needs to trust a request, in one read: the
   * signed-in user, and the open workstation session this sign-in is bound to
   * with its location, terminal, and business date. The workstation part is
   * null when the sign-in has no open workstation session.
   */
  async function findRequestContext(token) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT s.user_id, u.username, u.display_name, u.status AS user_status,
                ws.id AS workstation_session_id, ws.status AS workstation_session_status,
                ws.billing_date, pw.id AS workstation_id, pw.location_code, pw.machine_code,
                pw.name AS workstation_name, pw.status AS workstation_status,
                pl.business_code, pl.status AS location_status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN workstation_sessions ws ON ws.id = s.workstation_session_id AND ws.status = 'open'
         LEFT JOIN pos_workstations pw ON pw.id = ws.workstation_id
         LEFT JOIN pos_locations pl ON pl.loc_code = pw.location_code
         WHERE s.token = ? AND s.expires_at > NOW()
         LIMIT 1`,
        [token]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  async function deleteSession(token) {
    return database.withConnection(async (connection) => {
      await connection.execute('DELETE FROM sessions WHERE token = ?', [token]);
    });
  }

  async function deleteExpiredSessions() {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        'DELETE FROM sessions WHERE expires_at <= NOW()'
      );
      return { deleted: result.affectedRows };
    });
  }

  async function deleteUserSessions(userId) {
    return database.withConnection(async (connection) => {
      await connection.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    });
  }

  async function updateLastLogin(userId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'UPDATE users SET last_login_at = NOW() WHERE id = ?',
        [userId]
      );
    });
  }

  return {
    bindWorkstationSession,
    findRequestContext,
    findUserByUsername,
    getUserPermissions,
    getUserRoles,
    createSession,
    findSessionByToken,
    deleteSession,
    deleteExpiredSessions,
    deleteUserSessions,
    updateLastLogin
  };
}

module.exports = {
  createAuthRepository
};
