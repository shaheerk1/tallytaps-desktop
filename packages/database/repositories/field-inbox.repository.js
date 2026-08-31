function createFieldInboxRepository({ database }) {
  if (!database) throw new Error('Field inbox repository requires a database instance.');

  async function getConfiguration() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT host_id, api_key_ciphertext, created_at, updated_at
         FROM field_inbox_configuration
         WHERE id = 1
         LIMIT 1`
      );
      return rows[0] || null;
    });
  }

  async function saveConfiguration({ hostId, apiKeyCiphertext }) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO field_inbox_configuration (id, host_id, api_key_ciphertext)
         VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE
           host_id = VALUES(host_id),
           api_key_ciphertext = VALUES(api_key_ciphertext),
           updated_at = CURRENT_TIMESTAMP`,
        [hostId, apiKeyCiphertext]
      );
      const [rows] = await connection.execute(
        `SELECT host_id, api_key_ciphertext, created_at, updated_at
         FROM field_inbox_configuration
         WHERE id = 1
         LIMIT 1`
      );
      return rows[0] || null;
    });
  }

  async function clearConfiguration() {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        'DELETE FROM field_inbox_configuration WHERE id = 1'
      );
      return result.affectedRows > 0;
    });
  }

  async function listResolved(hostId, recordIds) {
    const ids = Array.from(new Set((recordIds || []).map(String).filter(Boolean)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT record_id, client_record_id, resolved_at, resolved_by
         FROM field_inbox_resolution
         WHERE host_id = ? AND record_id IN (${placeholders})`,
        [hostId, ...ids]
      );
      return rows;
    });
  }

  async function setResolved({ hostId, recordId, clientRecordId, userId, resolved }) {
    return database.withConnection(async (connection) => {
      if (!resolved) {
        await connection.execute(
          'DELETE FROM field_inbox_resolution WHERE host_id = ? AND record_id = ?',
          [hostId, recordId]
        );
        return { resolved: false, resolvedAt: null, resolvedBy: null };
      }

      await connection.execute(
        `INSERT INTO field_inbox_resolution
           (host_id, record_id, client_record_id, resolved_at, resolved_by)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
         ON DUPLICATE KEY UPDATE
           client_record_id = VALUES(client_record_id),
           resolved_at = CURRENT_TIMESTAMP,
           resolved_by = VALUES(resolved_by)`,
        [hostId, recordId, clientRecordId || null, userId || null]
      );
      const [rows] = await connection.execute(
        `SELECT resolved_at, resolved_by
         FROM field_inbox_resolution
         WHERE host_id = ? AND record_id = ?
         LIMIT 1`,
        [hostId, recordId]
      );
      return {
        resolved: true,
        resolvedAt: rows[0]?.resolved_at || null,
        resolvedBy: rows[0]?.resolved_by || null
      };
    });
  }

  return {
    getConfiguration,
    saveConfiguration,
    clearConfiguration,
    listResolved,
    setResolved
  };
}

module.exports = { createFieldInboxRepository };
