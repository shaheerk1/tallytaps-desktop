function createPriorityListRepository({ database }) {
  if (!database) {
    throw new Error('Priority list repository requires a database instance.');
  }

  const LIST_COLUMNS = 'id, name, is_default, entries';

  async function findById(id) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${LIST_COLUMNS} FROM priority_lists WHERE id = ? LIMIT 1`,
        [id]
      );
      if (rows.length === 0) return null;
      return mapList(rows[0]);
    });
  }

  async function list() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${LIST_COLUMNS} FROM priority_lists ORDER BY is_default DESC, name ASC`
      );
      const lists = rows.map(mapList);
      for (const list of lists) {
        list.assignments = await getAssignments(connection, list.id);
      }
      return lists;
    });
  }

  async function getAssignments(connection, listId) {
    const [rows] = await connection.execute(
      'SELECT target_type, target_id FROM priority_list_assignments WHERE list_id = ?',
      [listId]
    );
    return rows.map((r) => ({
      targetType: r.target_type,
      targetId: Number(r.target_id)
    }));
  }

  async function clearDefaultFlag(connection) {
    await connection.execute('UPDATE priority_lists SET is_default = 0 WHERE is_default = 1');
  }

  async function create({ name, entries = [], isDefault = false }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (isDefault) {
          await clearDefaultFlag(connection);
        }
        const [result] = await connection.execute(
          'INSERT INTO priority_lists (name, is_default, entries) VALUES (?, ?, ?)',
          [name, isDefault ? 1 : 0, JSON.stringify(entries)]
        );
        await connection.commit();
        return findById(result.insertId);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function update(id, { name, entries, isDefault }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existing] = await connection.execute(
          'SELECT id FROM priority_lists WHERE id = ? LIMIT 1',
          [id]
        );
        if (existing.length === 0) throw new Error('Priority list not found.');

        if (isDefault) {
          await clearDefaultFlag(connection);
        }
        await connection.execute(
          `UPDATE priority_lists
           SET name = COALESCE(?, name),
               entries = COALESCE(?, entries),
               is_default = ?
           WHERE id = ?`,
          [
            name ?? null,
            entries !== undefined ? JSON.stringify(entries) : null,
            isDefault ? 1 : 0,
            id
          ]
        );
        await connection.commit();
        return findById(id);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async function setDefault(id) {
    return update(id, { isDefault: true });
  }

  async function deleteById(id) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute('DELETE FROM priority_lists WHERE id = ?', [id]);
      return { deleted: result.affectedRows > 0 };
    });
  }

  async function getDefault() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${LIST_COLUMNS} FROM priority_lists WHERE is_default = 1 ORDER BY id ASC LIMIT 1`
      );
      return rows.length > 0 ? mapList(rows[0]) : null;
    });
  }

  /**
   * Replace the full assignment set for a list. Each (target_type, target_id)
   * is unique across the table, so a role/user can belong to at most one list.
   */
  async function setAssignments(listId, assignments) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existing] = await connection.execute(
          'SELECT id FROM priority_lists WHERE id = ? LIMIT 1',
          [listId]
        );
        if (existing.length === 0) throw new Error('Priority list not found.');

        await connection.execute(
          'DELETE FROM priority_list_assignments WHERE list_id = ?',
          [listId]
        );

        const seen = new Set();
        for (const a of assignments) {
          if (!a || !a.targetType || a.targetId === undefined || a.targetId === null) continue;
          const key = `${a.targetType}:${a.targetId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await connection.execute(
            'INSERT INTO priority_list_assignments (list_id, target_type, target_id) VALUES (?, ?, ?)',
            [listId, a.targetType, Number(a.targetId)]
          );
        }

        await connection.commit();
        return { assigned: seen.size };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  /**
   * Resolve the effective priority list for a user:
   * exact user assignment > first matching role assignment > default list.
   */
  async function resolveForUser(userId) {
    return database.withConnection(async (connection) => {
      const [userRows] = await connection.execute(
        `SELECT pl.id, pl.name, pl.is_default, pl.entries
         FROM priority_list_assignments pla
         JOIN priority_lists pl ON pl.id = pla.list_id
         WHERE pla.target_type = 'user' AND pla.target_id = ?
         LIMIT 1`,
        [userId]
      );
      if (userRows.length > 0) return mapList(userRows[0]);

      const [roleRows] = await connection.execute(
        `SELECT pl.id, pl.name, pl.is_default, pl.entries
         FROM user_roles ur
         JOIN priority_list_assignments pla
           ON pla.target_type = 'role' AND pla.target_id = ur.role_id
         JOIN priority_lists pl ON pl.id = pla.list_id
         WHERE ur.user_id = ?
         ORDER BY ur.role_id ASC
         LIMIT 1`,
        [userId]
      );
      if (roleRows.length > 0) return mapList(roleRows[0]);

      const [defaultRows] = await connection.execute(
        `SELECT ${LIST_COLUMNS} FROM priority_lists WHERE is_default = 1 ORDER BY id ASC LIMIT 1`
      );
      if (defaultRows.length > 0) return mapList(defaultRows[0]);

      return { id: null, name: '', isDefault: false, entries: [] };
    });
  }

  return {
    findById,
    list,
    create,
    update,
    setDefault,
    deleteById,
    getDefault,
    setAssignments,
    resolveForUser
  };
}

function mapList(row) {
  let entries = row.entries;
  if (typeof entries === 'string') {
    try {
      entries = JSON.parse(entries);
    } catch {
      entries = [];
    }
  }
  return {
    id: Number(row.id),
    name: row.name,
    isDefault: !!row.is_default,
    entries: Array.isArray(entries) ? entries : []
  };
}

module.exports = {
  createPriorityListRepository
};
