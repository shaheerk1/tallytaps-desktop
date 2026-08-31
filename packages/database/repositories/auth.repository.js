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
