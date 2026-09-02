/**
 * Payment mode registry.
 *
 * A payment mode describes how a receipt can be settled. Each mode is one of:
 *   - tender  : reduces the outstanding balance (cash, card, QR, voucher, ...)
 *   - credit  : settles the receipt while leaving an outstanding balance
 *              (e.g. "pending" — the market's borrowed-amount settlement)
 *
 * Core modes are seeded in the database. The in-memory registry is refreshed
 * from that table so validation stays fast while status/order remain market
 * configuration rather than application code.
 */

const CORE_MODES = [
  { id: 'cash', name: 'Cash', icon: '$', type: 'tender', priority: 1 },
  { id: 'card', name: 'Card', icon: '💳', type: 'tender', priority: 2 },
  { id: 'cheque', name: 'Cheque', icon: 'CHQ', type: 'tender', priority: 3 },
  { id: 'pending', name: 'Pending', icon: '💱', type: 'credit', priority: 1000 }
];

function createPaymentModeRegistry() {
  const modes = new Map();

  for (const mode of CORE_MODES) {
    modes.set(mode.id, { ...mode, enabled: true, core: true });
  }

  function validateMode(mode) {
    if (!mode || typeof mode.id !== 'string' || !mode.id.trim()) {
      throw new Error('Payment mode requires a non-empty id.');
    }
    if (typeof mode.name !== 'string' || !mode.name.trim()) {
      throw new Error(`Payment mode "${mode.id}" requires a name.`);
    }
    if (mode.type !== 'tender' && mode.type !== 'credit') {
      throw new Error(`Payment mode "${mode.id}" must have type "tender" or "credit".`);
    }
  }

  function register(mode) {
    validateMode(mode);
    const priority = Number.isFinite(mode.priority) ? mode.priority : 100 + modes.size;
    modes.set(mode.id, {
      id: mode.id,
      name: mode.name,
      icon: mode.icon || mode.name.charAt(0).toUpperCase(),
      type: mode.type,
      priority,
      enabled: mode.enabled !== false,
      pluginId: mode.pluginId || null,
      configuration: mode.configuration || null,
      core: false
    });
    return { registered: mode.id };
  }

  function unregister(modeId) {
    const existing = modes.get(modeId);
    if (existing && existing.core) {
      throw new Error(`Core payment mode "${modeId}" cannot be removed.`);
    }
    return modes.delete(modeId);
  }

  function getMode(modeId) {
    const mode = modes.get(modeId) || null;
    return mode?.enabled === false ? null : mode;
  }

  function listModes({ includeDisabled = false } = {}) {
    return Array.from(modes.values())
      .filter((mode) => includeDisabled || mode.enabled !== false)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  function replaceConfigured(configuredModes = []) {
    modes.clear();
    for (const mode of configuredModes) {
      validateMode(mode);
      modes.set(mode.id, {
        id: mode.id,
        name: mode.name,
        icon: mode.icon || mode.name.charAt(0).toUpperCase(),
        type: mode.type,
        priority: Number.isFinite(Number(mode.priority)) ? Number(mode.priority) : 100,
        enabled: mode.enabled !== false,
        pluginId: null,
        configuration: mode.configuration || null,
        core: mode.core !== false
      });
    }
    return listModes();
  }

  function isTender(modeId) {
    return getMode(modeId)?.type === 'tender';
  }

  function isCredit(modeId) {
    return getMode(modeId)?.type === 'credit';
  }

  return {
    register,
    unregister,
    getMode,
    listModes,
    replaceConfigured,
    isTender,
    isCredit
  };
}

module.exports = {
  createPaymentModeRegistry
};
