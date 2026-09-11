function createSettingsRepository({ database }) {
  if (!database) {
    throw new Error('Settings repository requires a database instance.');
  }

  /**
   * Get a single setting value by code + key.
   * Returns the parsed value (auto-deserializes JSON when serialized=1).
   * Returns undefined if not found.
   */
  // `locCode` null reads and writes the shared value. With a location, a read
  // prefers that location's own value and falls back to the shared one.
  async function getSetting(code, key, locCode = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT value, serialized FROM system_settings
         WHERE code = ? AND \`key\` = ? AND (loc_code IS NULL OR loc_code = ?)
         ORDER BY loc_code IS NULL LIMIT 1`,
        [code, key, locCode || null]
      );
      if (rows.length === 0) return undefined;
      return deserialize(rows[0].value, rows[0].serialized);
    });
  }

  /**
   * Get all settings for a given code group as a flat object { key: value }.
   */
  async function getSettingsByCode(code, locCode = null) {
    return database.withConnection(async (connection) => {
      // Shared rows first, then the location's own, so its values win.
      const [rows] = await connection.execute(
        `SELECT \`key\`, value, serialized FROM system_settings
         WHERE code = ? AND (loc_code IS NULL OR loc_code = ?)
         ORDER BY loc_code IS NOT NULL, id`,
        [code, locCode || null]
      );
      const result = {};
      for (const row of rows) {
        result[row.key] = deserialize(row.value, row.serialized);
      }
      return result;
    });
  }

  /**
   * Upsert a single setting.
   */
  async function setSetting(code, key, value, locCode = null) {
    const { serializedValue, serialized } = serialize(value);
    return database.withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO system_settings (loc_code, code, \`key\`, value, serialized)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           value = VALUES(value),
           serialized = VALUES(serialized),
           updated_at = CURRENT_TIMESTAMP`,
        [locCode || null, code, key, serializedValue, serialized]
      );
      return deserialize(serializedValue, serialized);
    });
  }

  /**
   * Bulk upsert all settings for a code group.
   * Existing keys not in the payload are left untouched.
   */
  async function setSettings(code, settingsObj, locCode = null) {
    const entries = Object.entries(settingsObj);
    if (entries.length === 0) return;

    return database.withConnection(async (connection) => {
      for (const [key, value] of entries) {
        const { serializedValue, serialized } = serialize(value);
        await connection.execute(
          `INSERT INTO system_settings (loc_code, code, \`key\`, value, serialized)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             value = VALUES(value),
             serialized = VALUES(serialized),
             updated_at = CURRENT_TIMESTAMP`,
          [locCode || null, code, key, serializedValue, serialized]
        );
      }
    });
  }

  /**
   * Delete a single setting.
   */
  async function deleteSetting(code, key, locCode = null) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `DELETE FROM system_settings WHERE code = ? AND \`key\` = ? AND scope_key = ?`,
        [code, key, locCode || '']
      );
      return result.affectedRows > 0;
    });
  }

  /**
   * Get all distinct codes (for admin UI grouping).
   */
  async function listCodes() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT DISTINCT code FROM system_settings ORDER BY code`
      );
      return rows.map((r) => r.code);
    });
  }

  return {
    getSetting,
    getSettingsByCode,
    setSetting,
    setSettings,
    deleteSetting,
    listCodes
  };
}

// ── Serialization helpers ──

function serialize(value) {
  if (value === null || value === undefined) {
    return { serializedValue: null, serialized: 0 };
  }
  if (typeof value === 'object' || Array.isArray(value)) {
    return { serializedValue: JSON.stringify(value), serialized: 1 };
  }
  return { serializedValue: String(value), serialized: 0 };
}

function deserialize(raw, serialized) {
  if (raw === null || raw === undefined) return null;
  if (serialized) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

module.exports = {
  createSettingsRepository
};
