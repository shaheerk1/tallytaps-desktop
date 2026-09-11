const requestContext = require('../security/request-context');

/**
 * Settings are shared, but the ones a customer sees are per location.
 *
 * The receipt header and footer, the store name and address, billing rules, and
 * printer choices belong to a location: Khan Store and Khan Retail must not
 * print each other's name. Each of those codes reads the signed-in location's
 * own value and falls back to the shared one, and a change made while signed in
 * to a location is saved for that location only. Everything else (screen and
 * sidebar preferences) stays shared.
 *
 * Outside an IPC request -- seeders, migrations, background work -- there is no
 * signed-in location, so the shared values are read and written.
 *
 * A channel that needs no sign-in cannot touch these codes at all. It has no
 * location, so it would silently get the shared values: that is how bills once
 * printed the shared address while the settings screen had saved the
 * location's own one.
 */
const LOCATION_SCOPED_CODES = new Set(['general', 'workstation', 'billing', 'printing']);

function createSettingsService({ settingsRepository }) {
  if (!settingsRepository) {
    throw new Error('Settings service requires settingsRepository.');
  }

  function scopeFor(code) {
    if (!LOCATION_SCOPED_CODES.has(String(code || ''))) return null;
    if (requestContext.isAnonymousRequest()) {
      throw new Error(`The ${code} settings belong to a location. Sign in to read or change them.`);
    }
    const ws = requestContext.workstation();
    return ws ? ws.locCode : null;
  }

  /**
   * Get a single setting value.
   * Usage: getSetting('workstation', 'bill_header_1') → 'My Store'
   */
  async function getSetting(code, key) {
    return settingsRepository.getSetting(code, key, scopeFor(code));
  }

  /**
   * Get all settings for a code group as a flat object.
   * Usage: getSettingsByCode('workstation') → { bill_header_1: 'My Store', ... }
   */
  async function getSettingsByCode(code) {
    return settingsRepository.getSettingsByCode(code, scopeFor(code));
  }

  /**
   * Set (upsert) a single setting.
   * Usage: setSetting('workstation', 'bill_header_1', 'New Store Name')
   */
  async function setSetting(code, key, value) {
    return settingsRepository.setSetting(code, key, value, scopeFor(code));
  }

  /**
   * Bulk set all settings for a code group.
   * Usage: setSettings('workstation', { bill_header_1: 'Line 1', bill_header_2: 'Line 2' })
   */
  async function setSettings(code, settingsObj) {
    return settingsRepository.setSettings(code, settingsObj, scopeFor(code));
  }

  /**
   * Delete a single setting. At a location this removes only the location's
   * own value, so the shared value shows through again.
   */
  async function deleteSetting(code, key) {
    return settingsRepository.deleteSetting(code, key, scopeFor(code));
  }

  /**
   * List all distinct setting codes (for admin grouping UI).
   */
  async function listCodes() {
    return settingsRepository.listCodes();
  }

  return {
    getSetting,
    getSettingsByCode,
    setSetting,
    setSettings,
    deleteSetting,
    listCodes,
    isLocationScoped: (code) => LOCATION_SCOPED_CODES.has(String(code || ''))
  };
}

module.exports = {
  createSettingsService,
  LOCATION_SCOPED_CODES
};
