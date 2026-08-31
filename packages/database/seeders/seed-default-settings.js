/**
 * Default system settings seeder.
 *
 * Seeds the system_settings table with baseline key-value pairs
 * grouped by code (workstation, general, billing, etc.).
 *
 * Each setting is only inserted if it doesn't already exist,
 * so re-running this seeder is safe — it never overwrites
 * values you've changed through the admin UI.
 */

const DEFAULT_SETTINGS = [
  // ── Workstation / receipt ─────────────────────────────
  { code: 'workstation', key: 'bill_header_1',   value: '' },
  { code: 'workstation', key: 'bill_header_2',   value: '' },
  { code: 'workstation', key: 'bill_header_3',   value: '' },
  { code: 'workstation', key: 'bill_footer_1',   value: 'Thank you for your business!' },
  { code: 'workstation', key: 'bill_footer_2',   value: '' },
  { code: 'workstation', key: 'store_address_1', value: '123 Main Street' },
  { code: 'workstation', key: 'store_address_2', value: '' },
  { code: 'workstation', key: 'store_phone',     value: '' },
  { code: 'workstation', key: 'default_printer', value: '' },

  // ── General ───────────────────────────────────────────
  { code: 'general', key: 'currency_symbol', value: 'Rs.' },
  { code: 'general', key: 'date_format',     value: 'Y-m-d' },
  { code: 'general', key: 'store_name',      value: 'POS Platform' },
  { code: 'general', key: 'store_tagline',   value: 'Main Store' },
  { code: 'general', key: 'store_address_1', value: '123 Main Street' },
  { code: 'general', key: 'store_address_2', value: '' },
  { code: 'general', key: 'store_phone',     value: '' },

  // ── Billing ───────────────────────────────────────────
  { code: 'billing', key: 'default_tax_rate', value: '0' },
  { code: 'billing', key: 'receipt_prefix',   value: '' },

  // ── UI / sidebar ──────────────────────────────────────
  { code: 'ui', key: 'sidebar_auto_hide',          value: '0' },
  { code: 'ui', key: 'sidebar_auto_close_seconds', value: '5' },
  { code: 'ui', key: 'sidebar_position',           value: 'left' },
  { code: 'ui', key: 'window_startup_mode',        value: 'normal' }
];

async function seedDefaultSettings(database) {
  return database.withConnection(async (connection) => {
    let inserted = 0;
    let skipped = 0;

    for (const s of DEFAULT_SETTINGS) {
      const [existing] = await connection.execute(
        'SELECT id FROM system_settings WHERE code = ? AND `key` = ? LIMIT 1',
        [s.code, s.key]
      );
      if (existing.length === 0) {
        await connection.execute(
          'INSERT INTO system_settings (code, `key`, value) VALUES (?, ?, ?)',
          [s.code, s.key, s.value]
        );
        inserted++;
      } else {
        skipped++;
      }
    }

    const codes = [...new Set(DEFAULT_SETTINGS.map((s) => s.code))];
    console.log(`[seed] Default settings: ${inserted} inserted, ${skipped} skipped (already exist)`);

    return {
      seeded: true,
      total: DEFAULT_SETTINGS.length,
      inserted,
      skipped,
      codes
    };
  });
}

module.exports = { seedDefaultSettings, DEFAULT_SETTINGS };
