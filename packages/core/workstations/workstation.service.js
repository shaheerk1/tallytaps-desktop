function createWorkstationService({ workstationRepository, settingsRepository, businessDayService }) {
  if (!workstationRepository) {
    throw new Error('Workstation service requires workstationRepository.');
  }

  // Codes are printed inside every document number, so they are kept short
  // and plain: upper-case letters, digits, dash, and underscore.
  const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

  function normalizeCode(value, label) {
    const code = String(value || '').trim().toUpperCase();
    if (!code) throw new Error(`${label} is required.`);
    if (!CODE_PATTERN.test(code)) {
      throw new Error(`${label} must be 1 to 20 characters: letters, numbers, dash, or underscore. It is printed on every receipt, so keep it short.`);
    }
    return code;
  }

  async function listLocations() {
    return workstationRepository.listLocations();
  }

  /**
   * Issue a new location code. It can never be used again by another location,
   * even after this one is retired.
   */
  async function createLocation({ locCode, businessCode, name, notes }) {
    const code = normalizeCode(locCode, 'Location code');
    const business = normalizeCode(businessCode, 'Business code');
    const label = String(name || '').trim();
    if (!label) throw new Error('Give the location a name people will recognise.');
    return workstationRepository.createLocation({ locCode: code, businessCode: business, name: label, notes: String(notes || '').trim() || null });
  }

  /** The name, business label, and notes can change; the code never does. */
  async function updateLocation(locCode, { businessCode, name, notes } = {}) {
    const code = normalizeCode(locCode, 'Location code');
    return workstationRepository.updateLocation(code, {
      businessCode: businessCode ? normalizeCode(businessCode, 'Business code') : null,
      name: String(name || '').trim() || null,
      notes: String(notes || '').trim() || null
    });
  }

  async function retireLocation(locCode) {
    return workstationRepository.retireLocation(normalizeCode(locCode, 'Location code'));
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
      locationCode: normalizeCode(locationCode, 'Location code'),
      machineCode: normalizeCode(machineCode, 'Terminal code'),
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

    // The repository opens the session on exactly this workstation, or refuses
    // with a reason; it never hands back a session somewhere else.
    const session = await workstationRepository.openSession({
      workstationId,
      userId,
      billingDate,
      openingBalance
    });

    // Load workstation settings (bill headers, footers, address, printer)
    const wsSettings = await loadWorkstationSettings(workstation.location_code);

    return {
      sessionId: session.id,
      workstationId: session.workstationId,
      locationCode: workstation.location_code,
      machineCode: workstation.machine_code,
      workstationName: workstation.name,
      billingDate: normalizeDate(session.billingDate),
      openingBalance: session.openingBalance,
      currentReceiptNo: session.currentReceiptNo,
      workstationSettings: wsSettings,
      status: session.status,
      closedElsewhere: session.closedElsewhere || []
    };
  }

  /** The open session a sign-in is bound to, shaped for the renderer. */
  async function getSession(workstationSessionId) {
    if (!workstationSessionId) return null;
    const session = await workstationRepository.getSessionById(workstationSessionId);
    if (!session) return null;
    return {
      sessionId: session.id,
      workstationId: session.workstation_id,
      locationCode: session.location_code,
      machineCode: session.machine_code,
      workstationName: session.workstation_name,
      billingDate: normalizeDate(session.billing_date),
      openingBalance: Number(session.opening_balance),
      currentReceiptNo: session.current_receipt_no,
      workstationSettings: await loadWorkstationSettings(session.location_code),
      status: session.status,
      openedAt: session.opened_at
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
    const wsSettings = await loadWorkstationSettings(session.location_code);

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
    const wsSettings = await loadWorkstationSettings(session.location_code);
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
  async function loadWorkstationSettings(locCode) {
    if (!settingsRepository) return {};
    try {
      // Each location can print its own header, footer, and address; anything
      // it has not set falls back to the shared values.
      return await settingsRepository.getSettingsByCode('workstation', locCode);
    } catch {
      return {};
    }
  }

  return {
    listWorkstations,
    listAllWorkstations,
    listLocations,
    createLocation,
    updateLocation,
    retireLocation,
    createWorkstation,
    updateWorkstation,
    deleteWorkstation,
    openSession,
    getActiveSession,
    getSession,
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
