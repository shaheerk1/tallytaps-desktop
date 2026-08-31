function createSettingsService({ settingsRepository }) {
  if (!settingsRepository) {
    throw new Error('Settings service requires settingsRepository.');
  }

  /**
   * Get a single setting value.
   * Usage: getSetting('workstation', 'bill_header_1') → 'My Store'
   */
  async function getSetting(code, key) {
    return settingsRepository.getSetting(code, key);
  }

  /**
   * Get all settings for a code group as a flat object.
   * Usage: getSettingsByCode('workstation') → { bill_header_1: 'My Store', ... }
   */
  async function getSettingsByCode(code) {
    return settingsRepository.getSettingsByCode(code);
  }

  /**
   * Set (upsert) a single setting.
   * Usage: setSetting('workstation', 'bill_header_1', 'New Store Name')
   */
  async function setSetting(code, key, value) {
    return settingsRepository.setSetting(code, key, value);
  }

  /**
   * Bulk set all settings for a code group.
   * Usage: setSettings('workstation', { bill_header_1: 'Line 1', bill_header_2: 'Line 2' })
   */
  async function setSettings(code, settingsObj) {
    return settingsRepository.setSettings(code, settingsObj);
  }

  /**
   * Delete a single setting.
   */
  async function deleteSetting(code, key) {
    return settingsRepository.deleteSetting(code, key);
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
    listCodes
  };
}

module.exports = {
  createSettingsService
};
