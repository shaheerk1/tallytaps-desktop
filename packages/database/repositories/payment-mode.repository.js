function createPaymentModeRepository({ database }) {
  if (!database) throw new Error('Payment mode repository requires a database instance.');

  async function listModes({ enabledOnly = false } = {}) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT mode_key AS id, display_name AS name, icon, mode_type AS type,
                sort_order AS priority, is_enabled, is_system, configuration
         FROM payment_modes
         ${enabledOnly ? 'WHERE is_enabled = 1' : ''}
         ORDER BY sort_order ASC, mode_key ASC`
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        icon: row.icon || String(row.name || '').slice(0, 1).toUpperCase(),
        type: row.type,
        priority: Number(row.priority || 0),
        enabled: Boolean(row.is_enabled),
        core: Boolean(row.is_system),
        configuration: row.configuration || null
      }));
    });
  }

  return { listModes };
}

module.exports = { createPaymentModeRepository };
