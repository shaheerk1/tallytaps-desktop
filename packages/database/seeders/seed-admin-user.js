const crypto = require('crypto');
const { corePermissions } = require('../../core/security/permission-catalog');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function seedAdminUser(database) {
  return database.withConnection(async (connection) => {
    // ── 1. Core Permissions ────────────────────────────────────
    const permissionKeys = corePermissions.map((permission) => permission.key);

    for (const permission of corePermissions) {
      const [permCheck] = await connection.execute(
        'SELECT id FROM permissions WHERE permission_key = ? LIMIT 1',
        [permission.key]
      );
      if (permCheck.length === 0) {
        await connection.execute(
          'INSERT INTO permissions (permission_key, name) VALUES (?, ?)',
          [permission.key, permission.name]
        );
      }
    }

    // ── 2. Admin Role ──────────────────────────────────────────
    const [adminRoleCheck] = await connection.execute(
      'SELECT id FROM roles WHERE role_key = ? LIMIT 1',
      ['admin']
    );

    let adminRoleId;
    if (adminRoleCheck.length === 0) {
      const [result] = await connection.execute(
        'INSERT INTO roles (role_key, name) VALUES (?, ?)',
        ['admin', 'Administrator']
      );
      adminRoleId = result.insertId;
    } else {
      adminRoleId = adminRoleCheck[0].id;
    }

    // Grant all permissions to admin
    const placeholders = permissionKeys.map(() => '?').join(', ');
    const [allPerms] = await connection.execute(
      `SELECT id FROM permissions WHERE permission_key IN (${placeholders})`,
      permissionKeys
    );

    for (const permRow of allPerms) {
      await connection.execute(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [adminRoleId, permRow.id]
      );
    }

    // ── 3. Cashier Role ────────────────────────────────────────
    const [cashierRoleCheck] = await connection.execute(
      'SELECT id FROM roles WHERE role_key = ? LIMIT 1',
      ['cashier']
    );

    let cashierRoleId;
    if (cashierRoleCheck.length === 0) {
      const [result] = await connection.execute(
        'INSERT INTO roles (role_key, name) VALUES (?, ?)',
        ['cashier', 'Cashier']
      );
      cashierRoleId = result.insertId;
    } else {
      cashierRoleId = cashierRoleCheck[0].id;
    }

    // Cashiers can sell, manage their drawer, look up customers, and collect balances.
    const cashierPermissions = [
      'billing.view', 'billing.create',
      'refund.view', 'refund.create',
      'cash.shift.view', 'cash.shift.open', 'cash.movement.create', 'cash.count.create', 'cash.shift.blindClose', 'cash.shift.close',
      'business-day.view', 'business-day.open', 'business-day.close', 'business-day.reopen',
      'customers.view', 'receivables.view', 'receivables.collect',
      'customer-advances.view', 'customer-advances.create'
    ];

    const cashierPlaceholders = cashierPermissions.map(() => '?').join(', ');
    const [cashierPerms] = await connection.execute(
      `SELECT id FROM permissions WHERE permission_key IN (${cashierPlaceholders})`,
      cashierPermissions
    );

    for (const permRow of cashierPerms) {
      await connection.execute(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [cashierRoleId, permRow.id]
      );
    }

    // ── 4. Admin User ──────────────────────────────────────────
    const [adminExisting] = await connection.execute(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      ['admin']
    );

    if (adminExisting.length === 0) {
      const passwordHash = hashPassword('admin');
      await connection.execute(
        `INSERT INTO users (username, password_hash, display_name, email, status)
         VALUES (?, ?, ?, ?, 'active')`,
        ['admin', passwordHash, 'System Admin', 'admin@pos.local']
      );
      console.log('[seed] Admin user created (admin / admin)');
    }

    const [adminUser] = await connection.execute(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      ['admin']
    );

    await connection.execute(
      'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
      [adminUser[0].id, adminRoleId]
    );

    // ── 5. Cashier User ────────────────────────────────────────
    const [cashierExisting] = await connection.execute(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      ['cashier']
    );

    if (cashierExisting.length === 0) {
      const passwordHash = hashPassword('cashier');
      await connection.execute(
        `INSERT INTO users (username, password_hash, display_name, email, status)
         VALUES (?, ?, ?, ?, 'active')`,
        ['cashier', passwordHash, 'Default Cashier', 'cashier@pos.local']
      );
      console.log('[seed] Cashier user created (cashier / cashier)');
    }

    const [cashierUser] = await connection.execute(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      ['cashier']
    );

    await connection.execute(
      'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
      [cashierUser[0].id, cashierRoleId]
    );

    // ── 6. Default Workstation ─────────────────────────────────
    const [wsExisting] = await connection.execute(
      'SELECT id FROM pos_workstations WHERE location_code = ? AND machine_code = ? LIMIT 1',
      ['MAIN', 'WS01']
    );

    if (wsExisting.length === 0) {
      await connection.execute(
        `INSERT INTO pos_workstations (location_code, machine_code, name, status)
         VALUES (?, ?, ?, 'active')`,
        ['MAIN', 'WS01', 'Main Counter']
      );
      console.log('[seed] Default workstation created (MAIN/WS01)');
    }

    return {
      seeded: true,
      users: [
        { username: 'admin', password: 'admin', role: 'Administrator' },
        { username: 'cashier', password: 'cashier', role: 'Cashier' }
      ],
      workstation: { location: 'MAIN', machine: 'WS01', name: 'Main Counter' }
    };
  });
}

module.exports = { seedAdminUser, hashPassword };
