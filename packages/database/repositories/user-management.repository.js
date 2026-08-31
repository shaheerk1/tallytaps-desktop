const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function createUserManagementRepository({ database }) {
  if (!database) {
    throw new Error('User management repository requires a database instance.');
  }

  // ── Users ─────────────────────────────────────────────────

  async function listUsers() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT u.id, u.username, u.display_name, u.email, u.phone,
                u.status, u.last_login_at, u.password_updated_at,
                u.created_at, u.updated_at
         FROM users u
         ORDER BY u.display_name ASC, u.username ASC`
      );

      // Attach roles to each user
      for (const user of rows) {
        const [roles] = await connection.execute(
          `SELECT r.id, r.role_key, r.name
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = ?`,
          [user.id]
        );
        user.roles = roles;
      }

      return rows;
    });
  }

  async function findUserById(id) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT u.id, u.username, u.display_name, u.email, u.phone,
                u.status, u.last_login_at, u.password_updated_at,
                u.created_at, u.updated_at
         FROM users u
         WHERE u.id = ?
         LIMIT 1`,
        [id]
      );

      if (rows.length === 0) return null;

      const user = rows[0];

      const [roles] = await connection.execute(
        `SELECT r.id, r.role_key, r.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ?`,
        [user.id]
      );
      user.roles = roles;

      const [permissions] = await connection.execute(
        `SELECT DISTINCT p.permission_key, p.name
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = ?`,
        [user.id]
      );
      user.permissions = permissions;

      return user;
    });
  }

  async function createUser({ username, password, displayName, email = null, phone = null, status = 'active', roleIds = [] }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existing] = await connection.execute(
          'SELECT id FROM users WHERE username = ? LIMIT 1',
          [username]
        );
        if (existing.length > 0) {
          throw new Error(`Username "${username}" already exists.`);
        }

        const passwordHash = hashPassword(password);
        const [result] = await connection.execute(
          `INSERT INTO users (username, password_hash, display_name, email, phone, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [username, passwordHash, displayName, email, phone, status]
        );
        const userId = result.insertId;

        for (const roleId of roleIds) {
          await connection.execute(
            'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
            [userId, roleId]
          );
        }

        await connection.commit();
        return findUserById(userId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function updateUser(id, { displayName, email, phone, status }) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute('SELECT id FROM users WHERE id = ? LIMIT 1', [id]);
      if (existing.length === 0) throw new Error(`User ${id} not found.`);

      await connection.execute(
        `UPDATE users
         SET display_name = COALESCE(?, display_name),
             email = ?,
             phone = ?,
             status = COALESCE(?, status),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [displayName, email, phone, status, id]
      );

      return findUserById(id);
    });
  }

  async function updatePassword(id, newPassword) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute('SELECT id FROM users WHERE id = ? LIMIT 1', [id]);
      if (existing.length === 0) throw new Error(`User ${id} not found.`);

      const passwordHash = hashPassword(newPassword);
      await connection.execute(
        `UPDATE users
         SET password_hash = ?, password_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [passwordHash, id]
      );

      return { updated: true };
    });
  }

  async function deleteUser(id) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute('SELECT id, username FROM users WHERE id = ? LIMIT 1', [id]);
      if (existing.length === 0) throw new Error(`User ${id} not found.`);

      if (existing[0].username === 'admin') {
        throw new Error('Cannot delete the admin user.');
      }

      await connection.execute('DELETE FROM users WHERE id = ?', [id]);
      return { deleted: true };
    });
  }

  async function setUserRoles(userId, roleIds) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existing] = await connection.execute('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
        if (existing.length === 0) throw new Error(`User ${userId} not found.`);

        await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [userId]);

        for (const roleId of roleIds) {
          await connection.execute(
            'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
            [userId, roleId]
          );
        }

        await connection.commit();
        return findUserById(userId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  // ── Roles ─────────────────────────────────────────────────

  async function listRoles() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT r.id, r.role_key, r.name, r.created_at
         FROM roles r
         ORDER BY r.name ASC`
      );

      for (const role of rows) {
        const [[{ count }]] = await connection.execute(
          'SELECT COUNT(*) AS count FROM role_permissions WHERE role_id = ?',
          [role.id]
        );
        role.permissionCount = count;

        const [[{ userCount }]] = await connection.execute(
          'SELECT COUNT(*) AS userCount FROM user_roles WHERE role_id = ?',
          [role.id]
        );
        role.userCount = userCount;
      }

      return rows;
    });
  }

  async function findRoleById(id) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id, role_key, name, created_at FROM roles WHERE id = ? LIMIT 1',
        [id]
      );

      if (rows.length === 0) return null;

      const role = rows[0];

      const [permissions] = await connection.execute(
        `SELECT p.id, p.permission_key, p.name
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.permission_key ASC`,
        [role.id]
      );
      role.permissions = permissions;

      const [users] = await connection.execute(
        `SELECT u.id, u.username, u.display_name
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.role_id = ?`,
        [role.id]
      );
      role.users = users;

      return role;
    });
  }

  async function createRole({ roleKey, name }) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute(
        'SELECT id FROM roles WHERE role_key = ? LIMIT 1',
        [roleKey]
      );
      if (existing.length > 0) {
        throw new Error(`Role key "${roleKey}" already exists.`);
      }

      const [result] = await connection.execute(
        'INSERT INTO roles (role_key, name) VALUES (?, ?)',
        [roleKey, name]
      );

      return findRoleById(result.insertId);
    });
  }

  async function updateRole(id, { name }) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute('SELECT id FROM roles WHERE id = ? LIMIT 1', [id]);
      if (existing.length === 0) throw new Error(`Role ${id} not found.`);

      await connection.execute(
        'UPDATE roles SET name = COALESCE(?, name) WHERE id = ?',
        [name, id]
      );

      return findRoleById(id);
    });
  }

  async function deleteRole(id) {
    return database.withConnection(async (connection) => {
      const [existing] = await connection.execute('SELECT id, role_key FROM roles WHERE id = ? LIMIT 1', [id]);
      if (existing.length === 0) throw new Error(`Role ${id} not found.`);

      if (existing[0].role_key === 'admin') {
        throw new Error('Cannot delete the admin role.');
      }

      await connection.execute('DELETE FROM roles WHERE id = ?', [id]);
      return { deleted: true };
    });
  }

  async function setRolePermissions(roleId, permissionIds) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existing] = await connection.execute('SELECT id FROM roles WHERE id = ? LIMIT 1', [roleId]);
        if (existing.length === 0) throw new Error(`Role ${roleId} not found.`);

        await connection.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);

        for (const permId of permissionIds) {
          await connection.execute(
            'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
            [roleId, permId]
          );
        }

        await connection.commit();
        return findRoleById(roleId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  // ── Permissions ───────────────────────────────────────────

  async function listPermissions() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id, permission_key, name FROM permissions ORDER BY permission_key ASC'
      );
      return rows;
    });
  }

  return {
    listUsers,
    findUserById,
    createUser,
    updateUser,
    updatePassword,
    deleteUser,
    setUserRoles,
    listRoles,
    findRoleById,
    createRole,
    updateRole,
    deleteRole,
    setRolePermissions,
    listPermissions
  };
}

module.exports = {
  createUserManagementRepository,
  hashPassword
};
