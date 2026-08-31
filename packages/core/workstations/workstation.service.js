function createWorkstationService({ workstationRepository, settingsRepository, businessDayService }) {
  if (!workstationRepository) {
    throw new Error('Workstation service requires workstationRepository.');
  }

  /**
   * List all active workstations (configured by admin).
   */
  async function listWorkstations() {
    return workstationRepository.listActive();
  }

  /**
   * List all workstations (admin management view).
   */
  async function listAllWorkstations() {
    return workstationRepository.listAll();
  }

  /**
   * Create a workstation. locationCode + machineCode form the receipt-key
   * identity and are immutable afterwards.
   */
  async function createWorkstation({ locationCode, machineCode, name, status = 'active' }) {
    if (!locationCode || !machineCode || !name) {
      throw new Error('Location code, machine code and name are required.');
    }
    return workstationRepository.create({
      locationCode: String(locationCode).trim().toUpperCase(),
      machineCode: String(machineCode).trim().toUpperCase(),
      name: String(name).trim(),
      status
    });
  }

  /**
   * Update mutable workstation fields (name/status). Codes are immutable.
   */
  async function updateWorkstation(id, { name, status } = {}) {
    if (!id) {
      throw new Error('Workstation id is required.');
    }
    const existing = await workstationRepository.getById(id);
    if (!existing) {
      throw new Error(`Workstation with id ${id} not found.`);
    }
    return workstationRepository.update(id, { name, status });
  }

  /**
   * Delete a workstation only if it has never had a billing session.
   */
  async function deleteWorkstation(id) {
    if (!id) {
      throw new Error('Workstation id is required.');
    }
    return workstationRepository.deleteById(id);
  }

  /**
   * Open a billing session for a user on a workstation.
   * If no workstationId is given, uses the first active workstation.
   * billingDate defaults to today (YYYY-MM-DD).
   */
  async function openSession({ userId, workstationId, billingDate, openingBalance = 0 }) {
    if (!userId) {
      throw new Error('userId is required to open a workstation session.');
    }

    // Default to first active workstation if not specified
    if (!workstationId) {
      const workstation = await workstationRepository.getFirstActive();
      if (!workstation) {
        throw new Error('No active workstation configured. Please contact admin.');
      }
      workstationId = workstation.id;
    }

    // Validate workstation exists
    const workstation = await workstationRepository.getById(workstationId);
    if (!workstation) {
      throw new Error(`Workstation with id ${workstationId} not found.`);
    }

    // Normalize billing date to YYYY-MM-DD (handles Date objects, strings, empty)
    billingDate = normalizeDate(billingDate);

    const session = await workstationRepository.openSession({
      workstationId,
      userId,
      billingDate,
      openingBalance
    });
    const sessionWorkstation = session.workstationId === workstation.id
      ? workstation
      : await workstationRepository.getById(session.workstationId);

    // Load workstation settings (bill headers, footers, address, printer)
    const wsSettings = await loadWorkstationSettings();

    return {
      sessionId: session.id,
      workstationId: session.workstationId,
      locationCode: sessionWorkstation.location_code,
      machineCode: sessionWorkstation.machine_code,
      workstationName: sessionWorkstation.name,
      billingDate: normalizeDate(session.billingDate),
      openingBalance: session.openingBalance,
      currentReceiptNo: session.currentReceiptNo,
      workstationSettings: wsSettings,
      status: session.status
    };
  }

  /**
   * Get the currently active workstation session for a user.
   */
  async function getActiveSession(userId) {
    if (!userId) return null;
    const session = await workstationRepository.getActiveSession(userId);
    if (!session) return null;

    // Load workstation settings
    const wsSettings = await loadWorkstationSettings();

    return {
      sessionId: session.id,
      workstationId: session.workstation_id,
      locationCode: session.location_code,
      machineCode: session.machine_code,
      workstationName: session.workstation_name,
      billingDate: normalizeDate(session.billing_date),
      openingBalance: Number(session.opening_balance),
      currentReceiptNo: session.current_receipt_no,
      workstationSettings: wsSettings,
      status: session.status,
      openedAt: session.opened_at
    };
  }

  /**
   * Close the active workstation session for a user (on logout).
   */
  async function closeSession(userId) {
    return workstationRepository.closeSession(userId);
  }

  /**
   * Change the billing date of a user's open workstation session.
   * Returns the updated session (with fresh settings) or null if none is open.
   */
  async function updateSessionDate(userId, billingDate) {
    if (!userId) {
      throw new Error('userId is required to change the billing date.');
    }
    const current = await workstationRepository.getActiveSession(userId);
    if (!current) return null;
    if (businessDayService) {
      await businessDayService.assertOpen({
        locationCode: current.location_code,
        businessDate: normalizeDate(billingDate)
      });
    }
    const updated = await workstationRepository.updateSessionDate(userId, normalizeDate(billingDate));
    if (!updated) {
      return null;
    }
    const session = await workstationRepository.getActiveSession(userId);
    if (!session) {
      return null;
    }
    const wsSettings = await loadWorkstationSettings();
    return {
      sessionId: session.id,
      workstationId: session.workstation_id,
      locationCode: session.location_code,
      machineCode: session.machine_code,
      workstationName: session.workstation_name,
      billingDate: normalizeDate(session.billing_date),
      openingBalance: Number(session.opening_balance),
      currentReceiptNo: session.current_receipt_no,
      workstationSettings: wsSettings,
      status: session.status,
      openedAt: session.opened_at
    };
  }

  /**
   * Load workstation settings from system_settings (code='workstation').
   * Returns a flat object like { bill_header_1: '...', bill_footer_1: '...', ... }
   */
  async function loadWorkstationSettings() {
    if (!settingsRepository) return {};
    try {
      return await settingsRepository.getSettingsByCode('workstation');
    } catch {
      return {};
    }
  }

  return {
    listWorkstations,
    listAllWorkstations,
    createWorkstation,
    updateWorkstation,
    deleteWorkstation,
    openSession,
    getActiveSession,
    closeSession,
    updateSessionDate
  };
}

module.exports = {
  createWorkstationService
};

/**
 * Normalize any date input (Date object, string, null, undefined)
 * into a MySQL-compatible YYYY-MM-DD string.
 */
function normalizeDate(input) {
  let d;
  if (!input) {
    d = new Date();
  } else if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string') {
    // Already YYYY-MM-DD?
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      return input;
    }
    d = new Date(input);
  } else {
    d = new Date();
  }

  if (isNaN(d.getTime())) {
    d = new Date();
  }

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
