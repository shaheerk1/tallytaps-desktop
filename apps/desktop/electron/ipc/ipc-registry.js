const { wrapIpcHandler } = require('./ipc-response');
const { dialog } = require('electron');
const { normalizeReceiptLanguage, getReceiptLabels } = require('../../../../packages/core/printing/receipt-localization.service');

function registerIpcHandlers(services) {
  const requireSettingsManage = services.ipcAuthorizationService.requirePermission('settings.manage');
  const requireBillingCreate = services.ipcAuthorizationService.requirePermission('billing.create');
  const requireBillingView = services.ipcAuthorizationService.requirePermission('billing.view');
  const requireRefundView = services.ipcAuthorizationService.requirePermission('refund.view');
  const requireRefundCreate = services.ipcAuthorizationService.requirePermission('refund.create');
  const requireCashView = services.ipcAuthorizationService.requirePermission('cash.shift.view');
  const requireCashOpen = services.ipcAuthorizationService.requirePermission('cash.shift.open');
  const requireCashMovement = services.ipcAuthorizationService.requirePermission('cash.movement.create');
  const requireCashCorrection = services.ipcAuthorizationService.requirePermission('cash.movement.correct');
  const requireCashCount = services.ipcAuthorizationService.requirePermission('cash.count.create');
  const requireCashBlindClose = services.ipcAuthorizationService.requirePermission('cash.shift.blindClose');
  const requireCashClose = services.ipcAuthorizationService.requirePermission('cash.shift.close');
  const requireBusinessDayView = services.ipcAuthorizationService.requirePermission('business-day.view');
  const requireBusinessDayOpen = services.ipcAuthorizationService.requirePermission('business-day.open');
  const requireBusinessDayClose = services.ipcAuthorizationService.requirePermission('business-day.close');
  const requireBusinessDayReopen = services.ipcAuthorizationService.requirePermission('business-day.reopen');
  const requireProductsManage = services.ipcAuthorizationService.requirePermission('products.manage');
  const requireCustomersView = services.ipcAuthorizationService.requirePermission('customers.view');
  const requireCustomersManage = services.ipcAuthorizationService.requirePermission('customers.manage');
  const requireReceivablesView = services.ipcAuthorizationService.requirePermission('receivables.view');
  const requireReceivablesCollect = services.ipcAuthorizationService.requirePermission('receivables.collect');
  const requireCustomerAdvancesView = services.ipcAuthorizationService.requirePermission('customer-advances.view');
  const requireCustomerAdvancesCreate = services.ipcAuthorizationService.requirePermission('customer-advances.create');
  const requireCustomerAdvancesRefund = services.ipcAuthorizationService.requirePermission('customer-advances.refund');
  const requireChequesView = services.ipcAuthorizationService.requirePermission('cheques.view');
  const requireChequesManage = services.ipcAuthorizationService.requirePermission('cheques.manage');
  const requireReportsView = services.ipcAuthorizationService.requirePermission('reports.view');
  const requireReportsExport = services.ipcAuthorizationService.requirePermission('reports.export');
  const requireSuppliersView = services.ipcAuthorizationService.requirePermission('suppliers.view');
  const requireSuppliersManage = services.ipcAuthorizationService.requirePermission('suppliers.manage');
  const requireReceivingView = services.ipcAuthorizationService.requirePermission('receiving.view');
  const requireReceivingManage = services.ipcAuthorizationService.requirePermission('receiving.manage');
  const requireInventoryAdjust = services.ipcAuthorizationService.requirePermission('inventory.adjust');
  const requireInventoryIssue = services.ipcAuthorizationService.requirePermission('inventory.issue');
  const requireSettlementsView = services.ipcAuthorizationService.requirePermission('supplier-settlements.view');
  const requireSettlementsManage = services.ipcAuthorizationService.requirePermission('supplier-settlements.manage');
  const requireFundsView = services.ipcAuthorizationService.requirePermission('funds.view');
  const requireFundsManage = services.ipcAuthorizationService.requirePermission('funds.manage');
  const requireFundsTransfer = services.ipcAuthorizationService.requirePermission('funds.transfer');
  const requireExpensesView = services.ipcAuthorizationService.requirePermission('expenses.view');
  const requireExpensesCreate = services.ipcAuthorizationService.requirePermission('expenses.create');
  const requireExpensesAllocate = services.ipcAuthorizationService.requirePermission('expenses.allocate');
  const requireRecurringExpenses = services.ipcAuthorizationService.requirePermission('expenses.recurring.manage');
  const requireLotCostingView = services.ipcAuthorizationService.requirePermission('lot-costing.view');
  const requireStakeholdersView = services.ipcAuthorizationService.requirePermission('stakeholders.view');
  const requireStakeholdersManage = services.ipcAuthorizationService.requirePermission('stakeholders.manage');
  const requireStakeholdersContribute = services.ipcAuthorizationService.requirePermission('stakeholders.contribute');
  const requireStakeholdersDrawing = services.ipcAuthorizationService.requirePermission('stakeholders.drawing');
  const requireStakeholdersOverrideDrawing = services.ipcAuthorizationService.requirePermission('stakeholders.override-drawing');
  const requireStakeholdersProfitShare = services.ipcAuthorizationService.requirePermission('stakeholders.profit-share');
  const requireJournalView = services.ipcAuthorizationService.requirePermission('accounting.journal.view');
  const requireAccountingReconcile = services.ipcAuthorizationService.requirePermission('accounting.reconcile');
  const requirePeriodClose = services.ipcAuthorizationService.requirePermission('accounting.period.close');
  const actorId = (payload) => Number(payload?.context?.actor?.id || payload?.actor?.id || 0) || null;
  const requireDrawingAuthority = async (payload) => {
    await requireStakeholdersDrawing(payload);
    if (payload?.entry?.overrideApprovedBy) await requireStakeholdersOverrideDrawing(payload);
  };
  const requireFieldInboxView = services.ipcAuthorizationService.requirePermission('field-inbox.view');
  const requireFieldInboxResolve = services.ipcAuthorizationService.requirePermission('field-inbox.resolve');

  // Billing auto-prints receipts (billing.create) and admins test printers
  // (settings.manage) — either permission is enough to send a document.
  const requirePrintOrBilling = async (payload) => {
    const actor = payload?.context?.actor || payload?.actor || null;
    if (!actor) throw new Error('Missing actor context for printing.');
    const permissions = actor.permissions || [];
    if (!permissions.includes('billing.create') && !permissions.includes('settings.manage')
      && !permissions.includes('supplier-settlements.view') && !permissions.includes('supplier-settlements.manage')) {
      throw new Error('Permission denied: billing.create, settings.manage, or supplier-settlements.view');
    }
  };

  const requirePdfOrSettlements = async (payload) => {
    const actor = payload?.context?.actor || payload?.actor || null;
    if (!actor) throw new Error('Missing actor context for PDF output.');
    const permissions = actor.permissions || [];
    if (!permissions.includes('billing.view') && !permissions.includes('supplier-settlements.view')
      && !permissions.includes('supplier-settlements.manage')) {
      throw new Error('Permission denied: billing.view or supplier-settlements.view');
    }
  };

  // Changing the billing date affects transactions (billing.create) and is also
  // part of admin settings (settings.manage) — either permission is enough.
  const requireBillingOrSettings = async (payload) => {
    const actor = payload?.context?.actor || payload?.actor || null;
    if (!actor) throw new Error('Missing actor context.');
    const permissions = actor.permissions || [];
    if (!permissions.includes('billing.create') && !permissions.includes('settings.manage')) {
      throw new Error('Permission denied: billing.create or settings.manage');
    }
  };

  // ── Health ──────────────────────────────────────────────────
  wrapIpcHandler('core.health.check', async () => {
    return services.coreHealthService.check();
  });

  wrapIpcHandler('database.health.check', async () => {
    return services.databaseHealthService.check();
  });

  // ── Database ────────────────────────────────────────────────
  wrapIpcHandler('database.migrations.status', async () => {
    return services.migrationRunner.status();
  });

  wrapIpcHandler('database.migrations.runPending', async () => {
    return services.migrationRunner.runPending();
  });

  // ── Auth ────────────────────────────────────────────────────
  wrapIpcHandler('auth.login', async (payload) => {
    const loginResult = await services.authService.login(payload || {});

    // Open a workstation session for the billing context
    try {
      const wsSession = await services.workstationService.openSession({
        userId: loginResult.user.id,
        workstationId: payload?.workstationId || null,
        billingDate: payload?.billingDate || null,
        openingBalance: payload?.openingBalance || 0
      });
      loginResult.workstationSession = wsSession;
    } catch (wsError) {
      console.warn('[auth.login] Could not open workstation session:', wsError.message);
      loginResult.workstationSession = null;
      loginResult.workstationWarning = wsError.message;
    }

    return loginResult;
  });

  wrapIpcHandler('auth.session.validate', async (payload) => {
    const sessionResult = await services.authService.validateSession(payload?.token);

    // Also fetch active workstation session
    try {
      const wsSession = await services.workstationService.getActiveSession(sessionResult.user.id);
      sessionResult.workstationSession = wsSession;
    } catch (_err) {
      sessionResult.workstationSession = null;
    }

    return sessionResult;
  });

  wrapIpcHandler('auth.logout', async (payload) => {
    // Close workstation session before logging out
    try {
      const session = await services.authService.validateSession(payload?.token);
      if (session?.user?.id) {
        await services.workstationService.closeSession(session.user.id);
      }
    } catch (_err) {
      // Non-fatal: session might already be expired
    }
    return services.authService.logout(payload?.token);
  });

  wrapIpcHandler('auth.cleanup', async () => {
    return services.authService.cleanupExpiredSessions();
  });

  // ── Workstations ─────────────────────────────────────────────
  wrapIpcHandler('workstations.list', async () => {
    return services.workstationService.listWorkstations();
  });

  wrapIpcHandler(
    'workstations.listAll',
    async () => {
      return services.workstationService.listAllWorkstations();
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'workstations.create',
    async (payload) => {
      return services.workstationService.createWorkstation(payload);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'workstations.update',
    async (payload) => {
      return services.workstationService.updateWorkstation(payload?.id, payload);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'workstations.delete',
    async (payload) => {
      return services.workstationService.deleteWorkstation(payload?.id);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler('workstations.activeSession', async (payload) => {
    return services.workstationService.getActiveSession(payload?.userId);
  });

  wrapIpcHandler('workstations.openSession', async (payload) => {
    return services.workstationService.openSession(payload);
  });

  wrapIpcHandler('workstations.closeSession', async (payload) => {
    return services.workstationService.closeSession(payload?.userId);
  });

  wrapIpcHandler(
    'workstations.updateSessionDate',
    async (payload) => {
      return services.workstationService.updateSessionDate(payload?.userId, payload?.billingDate);
    },
    { authorize: requireBillingOrSettings }
  );

  // ── Plugins ─────────────────────────────────────────────────
  // Plugin settings are namespaced, plugin-owned configuration values (labels,
  // field priority, visibility, …) that plugins already read at runtime. They
  // grant no system privileges, so both get() and set() are ungated — matching
  // `plugins.settings.get` — instead of requiring the plugins.manage actor that
  // gates enable/disable/uninstall. This keeps the plugin view's settings form
  // usable without coupling saves to session actor state.
  // ── Plugin Migrations ───────────────────────────────────────
  // ── Extensions ──────────────────────────────────────────────
  // ── Settings ────────────────────────────────────────────────
  wrapIpcHandler(
    'settings.get',
    async (payload) => {
      return services.settingsService.getSetting(payload.code, payload.key);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'settings.getByCode',
    async (payload) => {
      return services.settingsService.getSettingsByCode(payload.code);
    },
    { authorize: requireSettingsManage }
  );

  // Cashiers need receipt branding to print a bill, but should not gain access
  // to the complete settings groups. This intentionally exposes only public,
  // customer-facing display values and never requires settings.manage.
  wrapIpcHandler('settings.receipt.get', async () => {
    const [general, workstation] = await Promise.all([
      services.settingsService.getSettingsByCode('general'),
      services.settingsService.getSettingsByCode('workstation')
    ]);
    const asText = (value) => String(value ?? '').trim();
    const nonEmpty = (values) => values.map(asText).filter(Boolean);
    const logo = workstation.receipt_logo && typeof workstation.receipt_logo === 'object'
      ? workstation.receipt_logo
      : {};

    const storeName = asText(general.store_name) || asText(workstation.bill_header_1);
    const tagline = asText(general.store_tagline) || asText(workstation.bill_header_2);
    const addressLines = nonEmpty([
      general.store_address_1 || workstation.store_address_1,
      general.store_address_2 || workstation.store_address_2
    ]);
    const phone = asText(general.store_phone) || asText(workstation.store_phone);
    const language = normalizeReceiptLanguage(asText(workstation.receipt_language));
    const brandLines = new Set([storeName, tagline, ...addressLines, phone].filter(Boolean).map((line) => line.toLocaleLowerCase()));

    return {
      storeName,
      tagline,
      addressLines,
      phone,
      headers: nonEmpty([
        workstation.bill_header_1,
        workstation.bill_header_2,
        workstation.bill_header_3
      ]).filter((line) => !brandLines.has(line.toLocaleLowerCase())),
      footers: nonEmpty([workstation.bill_footer_1, workstation.bill_footer_2]),
      currencySymbol: asText(general.currency_symbol) || 'Rs.',
      dateFormat: asText(general.date_format) || 'Y-m-d',
      logoDataUrl: logo.enabled && typeof logo.dataUrl === 'string' ? logo.dataUrl : '',
      language,
      labels: getReceiptLabels(language)
    };
  });

  // Cashiers need only the configured automatic invoice-output destination.
  // Keep the rest of the billing settings group behind settings.manage.
  wrapIpcHandler(
    'settings.billingOutput.get',
    async () => {
      const billing = await services.settingsService.getSettingsByCode('billing');
      return {
        autoSavePdf: billing.auto_save_pdf === true || billing.auto_save_pdf === 'true',
        pdfFolder: String(billing.pdf_folder || '').trim()
      };
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'settings.set',
    async (payload) => {
      return services.settingsService.setSetting(payload.code, payload.key, payload.value);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'settings.setBulk',
    async (payload) => {
      return services.settingsService.setSettings(payload.code, payload.settings);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'settings.delete',
    async (payload) => {
      return services.settingsService.deleteSetting(payload.code, payload.key);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'settings.listCodes',
    async () => {
      return services.settingsService.listCodes();
    },
    { authorize: requireSettingsManage }
  );

  // ── UI Preferences ──────────────────────────────────────
  // The app shell needs the sidebar config for every user, but settings.* is
  // settings.manage-gated. get() is therefore read-only and unauthenticated
  // (like extensions.snapshot); set() stays admin-gated.
  wrapIpcHandler('uiPreferences.get', async () => {
    const ui = await services.settingsService.getSettingsByCode('ui');
    const raw = ui.sidebar_auto_hide;
    return {
      autoHide: raw === true || raw === 1 || raw === '1' || raw === 'true',
      autoCloseSeconds: Math.max(1, Number(ui.sidebar_auto_close_seconds) || 5),
      position: ui.sidebar_position === 'right' ? 'right' : 'left',
      startupWindowMode: ['normal', 'maximized', 'fullscreen'].includes(ui.window_startup_mode)
        ? ui.window_startup_mode
        : 'normal'
    };
  });

  wrapIpcHandler(
    'uiPreferences.set',
    async (payload) => {
      const prefs = payload?.settings || {};
      const update = {};
      if ('autoHide' in prefs) update.sidebar_auto_hide = prefs.autoHide ? '1' : '0';
      if ('autoCloseSeconds' in prefs) {
        update.sidebar_auto_close_seconds = String(
          Math.max(1, Number(prefs.autoCloseSeconds) || 5)
        );
      }
      if ('position' in prefs) {
        update.sidebar_position = prefs.position === 'right' ? 'right' : 'left';
      }
      if ('startupWindowMode' in prefs) {
        update.window_startup_mode = ['normal', 'maximized', 'fullscreen'].includes(prefs.startupWindowMode)
          ? prefs.startupWindowMode
          : 'normal';
      }
      if (Object.keys(update).length > 0) {
        await services.settingsService.setSettings('ui', update);
      }
      return update;
    },
    { authorize: requireSettingsManage }
  );

  // ── Priority Lists ────────────────────────────────────────
  // resolveForUser is read-only: any authenticated user may query their own
  // effective list to order the shell sidebar and pick a landing page.
  wrapIpcHandler('priorityLists.resolveForUser', async (payload) => {
    return services.priorityListService.resolveForUser(payload?.userId);
  });

  wrapIpcHandler(
    'priorityLists.list',
    async () => {
      return services.priorityListService.listLists();
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.get',
    async (payload) => {
      return services.priorityListService.getList(payload?.id);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.create',
    async (payload) => {
      return services.priorityListService.createList(payload);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.update',
    async (payload) => {
      return services.priorityListService.updateList(payload?.id, payload);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.delete',
    async (payload) => {
      return services.priorityListService.deleteList(payload?.id);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.setDefault',
    async (payload) => {
      return services.priorityListService.setDefaultList(payload?.id);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.setAssignments',
    async (payload) => {
      return services.priorityListService.setAssignments(payload?.listId, payload?.assignments);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'priorityLists.assignmentTargets',
    async () => {
      return services.priorityListService.listAssignmentTargets();
    },
    { authorize: requireSettingsManage }
  );

  // ── Catalog ─────────────────────────────────────────────────
  wrapIpcHandler('catalog.products.list', async (payload) => {
    return services.catalogService.listProducts(payload?.options || {});
  });

  wrapIpcHandler('catalog.products.get', async (payload) => {
    return services.catalogService.getProduct(payload?.id);
  });

  wrapIpcHandler(
    'catalog.products.create',
    async (payload) => {
      return services.catalogService.createProduct(payload);
    },
    { authorize: requireProductsManage }
  );

  wrapIpcHandler(
    'catalog.products.update',
    async (payload) => {
      return services.catalogService.updateProduct(payload?.id, payload?.updates || {});
    },
    { authorize: requireProductsManage }
  );

  wrapIpcHandler(
    'catalog.products.delete',
    async (payload) => {
      const deleted = await services.catalogService.deleteProduct(payload?.id);
      return { deleted };
    },
    { authorize: requireProductsManage }
  );

  wrapIpcHandler('catalog.products.categories', async () => {
    return services.catalogService.listProductCategories();
  });

  wrapIpcHandler('catalog.customers.list', async () => services.catalogService.listCustomers(), { authorize: requireCustomersView });
  wrapIpcHandler('catalog.customers.search', async (payload) => services.catalogService.searchCustomers(payload?.term || '', payload?.options || {}), { authorize: requireCustomersView });
  wrapIpcHandler('catalog.customers.account', async (payload) => services.catalogService.getCustomerAccount(payload?.customerId), { authorize: requireReceivablesView });
  wrapIpcHandler('catalog.customers.create', async (payload) => services.catalogService.createCustomer(payload?.customer || {}), { authorize: requireCustomersManage });
  wrapIpcHandler('catalog.customers.update', async (payload) => services.catalogService.updateCustomer(payload?.customerId, payload?.customer || {}), { authorize: requireCustomersManage });
  wrapIpcHandler('catalog.customers.assignInvoice', async (payload) => services.catalogService.assignInvoiceCustomer(payload || {}), { authorize: requireCustomersManage });
  wrapIpcHandler('customerAdvances.balance', async (payload) => services.customerAdvanceService.getBalance(payload || {}), { authorize: requireCustomerAdvancesView });
  wrapIpcHandler('customerAdvances.summary', async (payload) => services.customerAdvanceService.getSummary(payload || {}), { authorize: requireCustomerAdvancesView });
  wrapIpcHandler('customerAdvances.receive', async (payload) => services.customerAdvanceService.receive(payload || {}), { authorize: requireCustomerAdvancesCreate });
  wrapIpcHandler('customerAdvances.refund', async (payload) => services.customerAdvanceService.refundUnused(payload || {}), { authorize: requireCustomerAdvancesRefund });
  // ── Funds and expenses ──────────────────────────────────────
  // A fund is where money sits: the till, the safe, a bank account, or a
  // stakeholder's pocket. Cashiers may record a till payout; setting up funds
  // and moving money between them is management work.
  wrapIpcHandler('funds.list', async (payload) => services.expenseService.listFundAccounts(payload || {}), { authorize: requireFundsView });
  wrapIpcHandler('funds.save', async (payload) => services.expenseService.saveFundAccount(payload?.fund || {}), { authorize: requireFundsManage });
  wrapIpcHandler('funds.ledger', async (payload) => services.expenseService.getFundLedger(payload || {}), { authorize: requireFundsView });
  wrapIpcHandler('funds.transfer', async (payload) => services.expenseService.transferFunds(payload?.transfer || {}), { authorize: requireFundsTransfer });
  wrapIpcHandler('expenses.categories.list', async (payload) => services.expenseService.listCategories(payload || {}), { authorize: requireExpensesView });
  wrapIpcHandler('expenses.categories.save', async (payload) => services.expenseService.saveCategory(payload?.category || {}), { authorize: requireFundsManage });
  wrapIpcHandler('expenses.list', async (payload) => services.expenseService.listExpenses(payload?.filters || {}), { authorize: requireExpensesView });
  wrapIpcHandler('expenses.create', async (payload) => services.expenseService.recordExpense({ ...(payload?.expense || {}), userId: actorId(payload) }), { authorize: requireExpensesCreate });
  wrapIpcHandler('expenses.recurring.list', async (payload) => services.expenseService.listRecurringExpenses(payload || {}), { authorize: requireExpensesView });
  wrapIpcHandler('expenses.recurring.save', async (payload) => services.expenseService.saveRecurringExpense({ ...(payload?.template || {}), userId: actorId(payload) }), { authorize: requireRecurringExpenses });
  wrapIpcHandler('expenses.recurring.record', async (payload) => services.expenseService.recordRecurringExpense({ ...(payload || {}), userId: actorId(payload) }), { authorize: requireRecurringExpenses });

  // ── Lot costing ─────────────────────────────────────────────
  // Attaching a cost to the goods it belongs to is receiving work, so it
  // follows the receiving permissions rather than the cashier's.
  wrapIpcHandler('lotCosting.lots.list', async (payload) => services.lotCostingService.listLots(payload?.filters || {}), { authorize: requireLotCostingView });
  wrapIpcHandler('lotCosting.profitability', async (payload) => services.lotCostingService.getProfitability(payload?.filters || {}), { authorize: requireLotCostingView });
  wrapIpcHandler('lotCosting.lot.detail', async (payload) => services.lotCostingService.getLotCostDetail(payload || {}), { authorize: requireLotCostingView });
  wrapIpcHandler('lotCosting.reconcile', async (payload) => services.lotCostingService.reconcile(payload || {}), { authorize: requireLotCostingView });
  wrapIpcHandler('lotCosting.allocate', async (payload) => services.lotCostingService.allocateExpense(payload?.allocation || {}), { authorize: requireExpensesAllocate });
  wrapIpcHandler('lotCosting.reallocate', async (payload) => services.lotCostingService.reallocate(payload?.reallocation || {}), { authorize: requireExpensesAllocate });

  // ── Stakeholders and equity ─────────────────────────────────
  // Owner-level information. A cashier never receives any of these.
  wrapIpcHandler('stakeholders.list', async (payload) => services.stakeholderService.list(payload || {}), { authorize: requireStakeholdersView });
  wrapIpcHandler('stakeholders.statement', async (payload) => services.stakeholderService.statement(payload || {}), { authorize: requireStakeholdersView });
  wrapIpcHandler('stakeholders.shares.list', async (payload) => services.stakeholderService.listShares(payload || {}), { authorize: requireStakeholdersView });
  wrapIpcHandler('stakeholders.reconcile', async (payload) => services.stakeholderService.reconcile(payload || {}), { authorize: requireStakeholdersView });
  wrapIpcHandler('stakeholders.save', async (payload) => services.stakeholderService.save(payload?.stakeholder || {}), { authorize: requireStakeholdersManage });
  wrapIpcHandler('stakeholders.shares.save', async (payload) => services.stakeholderService.saveShare({ ...(payload?.share || {}), userId: actorId(payload) }), { authorize: requireStakeholdersManage });
  wrapIpcHandler('stakeholders.contribute', async (payload) => services.stakeholderService.contribute({ ...(payload?.entry || {}), userId: actorId(payload) }), { authorize: requireStakeholdersContribute });
  wrapIpcHandler('stakeholders.draw', async (payload) => services.stakeholderService.draw({ ...(payload?.entry || {}), userId: actorId(payload), overrideApprovedBy: payload?.entry?.overrideApprovedBy ? actorId(payload) : null }), { authorize: requireDrawingAuthority });
  wrapIpcHandler('stakeholders.settle', async (payload) => services.stakeholderService.settle({ ...(payload?.entry || {}), userId: actorId(payload) }), { authorize: requireStakeholdersDrawing });
  wrapIpcHandler('stakeholders.profitShare', async (payload) => services.stakeholderService.allocateProfitShare({ ...(payload?.entry || {}), userId: actorId(payload) }), { authorize: requireStakeholdersProfitShare });

  // ── Accountant mode ─────────────────────────────────────────
  // Read-only over derived postings; there is no manual journal entry.
  wrapIpcHandler('accounting.accounts.list', async () => services.accountingService.listAccounts(), { authorize: requireJournalView });
  wrapIpcHandler('accounting.reconcile', async (payload) => services.accountingService.reconcile({ ...(payload?.options || {}), userId: actorId(payload) }), { authorize: requireAccountingReconcile });
  wrapIpcHandler('accounting.journal.list', async (payload) => services.accountingService.listJournal(payload?.filters || {}), { authorize: requireJournalView });
  wrapIpcHandler('accounting.trialBalance', async (payload) => services.accountingService.trialBalance(payload?.filters || {}), { authorize: requireJournalView });
  wrapIpcHandler('accounting.profitAndLoss', async (payload) => services.accountingService.profitAndLoss(payload?.filters || {}), { authorize: requireJournalView });
  wrapIpcHandler('accounting.balanceSheet', async (payload) => services.accountingService.balanceSheet(payload?.filters || {}), { authorize: requireJournalView });
  wrapIpcHandler('accounting.periods.list', async (payload) => services.accountingService.listPeriods(payload || {}), { authorize: requireJournalView });
  wrapIpcHandler('accounting.periods.close', async (payload) => services.accountingService.closePeriod(payload?.period || {}), { authorize: requirePeriodClose });
  wrapIpcHandler('accounting.periods.reopen', async (payload) => services.accountingService.reopenPeriod(payload?.period || {}), { authorize: requirePeriodClose });

  wrapIpcHandler('catalog.cheques.list', async (payload) => services.catalogService.listCheques(payload?.filters || {}), { authorize: requireChequesView });
  wrapIpcHandler('catalog.cheques.get', async (payload) => services.catalogService.getCheque(payload?.chequeId), { authorize: requireChequesView });
  wrapIpcHandler('catalog.cheques.details', async (payload) => services.catalogService.updateChequeDetails(payload || {}), { authorize: requireChequesManage });
  wrapIpcHandler('catalog.cheques.status', async (payload) => services.catalogService.updateChequeStatus(payload || {}), { authorize: requireChequesManage });
  wrapIpcHandler('catalog.cheques.link', async (payload) => services.catalogService.linkCheque(payload || {}), { authorize: requireChequesManage });
  wrapIpcHandler('catalog.bankAccounts.list', async (payload) => services.catalogService.listBusinessBankAccounts(Boolean(payload?.includeInactive)), { authorize: requireChequesView });
  wrapIpcHandler('catalog.bankAccounts.save', async (payload) => services.catalogService.saveBusinessBankAccount(payload?.account || {}), { authorize: requireChequesManage });
  wrapIpcHandler('catalog.issuedCheques.list', async (payload) => services.catalogService.listIssuedCheques(payload?.filters || {}), { authorize: requireChequesView });
  wrapIpcHandler('catalog.issuedCheques.get', async (payload) => services.catalogService.getIssuedCheque(payload?.chequeId), { authorize: requireChequesView });
  wrapIpcHandler('catalog.issuedCheques.create', async (payload) => services.catalogService.createIssuedCheque(payload?.cheque || {}), { authorize: requireChequesManage });
  wrapIpcHandler('catalog.issuedCheques.status', async (payload) => services.catalogService.updateIssuedChequeStatus(payload || {}), { authorize: requireChequesManage });
  wrapIpcHandler('catalog.suppliers.list', async () => services.catalogService.listSuppliers(), { authorize: requireSuppliersView });
  wrapIpcHandler('catalog.suppliers.create', async (payload) => services.catalogService.createSupplier(payload?.supplier || {}), { authorize: requireSuppliersManage });
  wrapIpcHandler('supply.goodsReceipts.drafts.save', async (payload) => services.catalogService.saveGoodsReceiptDraft(payload?.receipt || {}), { authorize: requireReceivingManage });
  wrapIpcHandler('supply.goodsReceipts.drafts.finalize', async (payload) => services.catalogService.finalizeGoodsReceiptDraft({ goodsReceiptId: payload?.goodsReceiptId, userId: payload?.userId }), { authorize: requireReceivingManage });
  wrapIpcHandler('supply.goodsReceipts.drafts.cancel', async (payload) => services.catalogService.cancelGoodsReceiptDraft(payload || {}), { authorize: requireReceivingManage });
  wrapIpcHandler('supply.goodsReceipts.corrections.create', async (payload) => services.catalogService.createGoodsReceiptCorrection(payload || {}), { authorize: requireReceivingManage });
  wrapIpcHandler('supply.goodsReceipts.list', async (payload) => services.catalogService.listGoodsReceipts(payload?.filters || {}), { authorize: requireReceivingView });
  wrapIpcHandler('supply.goodsReceipts.get', async (payload) => services.catalogService.getGoodsReceipt(payload?.goodsReceiptId), { authorize: requireReceivingView });
  wrapIpcHandler('inventory.adjust', async (payload) => services.catalogService.adjustStock(payload?.adjustment || {}), { authorize: requireInventoryAdjust });
  wrapIpcHandler('supply.agreements.list', async (payload) => services.catalogService.listSupplyAgreements(payload?.supplierId || null), { authorize: requireSuppliersView });
  wrapIpcHandler('supply.agreements.create', async (payload) => services.catalogService.createSupplyAgreement(payload?.agreement || {}), { authorize: requireSuppliersManage });
  wrapIpcHandler('supply.suppliers.account', async (payload) => services.catalogService.getSupplierAccount(payload?.supplierId), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.settlements.create', async (payload) => services.catalogService.createSupplierSettlement(payload?.settlement || {}), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.settlements.approve', async (payload) => services.catalogService.approveSupplierSettlement(payload?.settlementId, payload?.userId), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.settlements.pay', async (payload) => services.catalogService.recordSupplierPayment(payload?.payment || {}), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.settlements.list', async (payload) => services.catalogService.listSupplierSettlements(payload?.supplierId || null), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.settlements.get', async (payload) => services.catalogService.getSupplierSettlement(payload?.settlementId), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.charges.listTypes', async () => services.catalogService.listSupplierChargeTypes(), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.charges.add', async (payload) => services.catalogService.addSupplierCharge(payload?.charge || {}), { authorize: requireSettlementsManage });
  wrapIpcHandler('inventory.lots.list', async (payload) => services.catalogService.listInventoryLots(payload?.productId || null, payload?.locCode || null), { authorize: requireReceivingView });
  wrapIpcHandler('inventory.summary.list', async (payload) => services.catalogService.listInventorySummary(payload?.locCode), { authorize: requireReceivingView });
  wrapIpcHandler('inventory.counts.finalize', async (payload) => services.catalogService.finalizeStockCount(payload?.count || {}), { authorize: requireInventoryAdjust });
  wrapIpcHandler('inventory.issues.list', async (payload) => services.inventoryIssueService.listIssues(payload?.filters || {}), { authorize: requireReceivingView });
  wrapIpcHandler('inventory.issues.record', async (payload) => services.inventoryIssueService.recordIssue({ ...(payload?.issue || {}), userId: payload?.actor?.id || null }), { authorize: requireInventoryIssue });
  wrapIpcHandler('inventory.allocations.exceptions', async (payload) => services.catalogService.listAllocationExceptions(payload?.locCode), { authorize: requireReceivingView });
  wrapIpcHandler('inventory.allocations.list', async (payload) => services.catalogService.listRecentLotAllocations(payload?.locCode, payload?.limit), { authorize: requireReceivingView });
  wrapIpcHandler('inventory.allocations.resolve', async (payload) => services.catalogService.allocateException({ ...(payload?.allocation || {}), userId: payload?.actor?.id || null }), { authorize: requireInventoryAdjust });
  wrapIpcHandler('inventory.allocations.reallocate', async (payload) => services.catalogService.reallocateSale({ ...(payload?.allocation || {}), userId: payload?.actor?.id || null }), { authorize: requireInventoryAdjust });
  wrapIpcHandler('supply.pattiyals.list', async (payload) => services.supplierSaleStatementService.list(payload?.filters || {}), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.pattiyals.get', async (payload) => services.supplierSaleStatementService.get(payload?.statementId), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.pattiyals.candidates.sales', async (payload) => services.supplierSaleStatementService.candidates(payload?.filters || {}), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.pattiyals.candidates.grns', async (payload) => services.supplierSaleStatementService.candidateGrns(payload?.filters || {}), { authorize: requireSettlementsView });
  wrapIpcHandler('supply.pattiyals.drafts.save', async (payload) => services.supplierSaleStatementService.saveDraft(payload?.statement || {}), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.pattiyals.review', async (payload) => services.supplierSaleStatementService.review(payload?.statementId, payload?.userId), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.pattiyals.reopen', async (payload) => services.supplierSaleStatementService.reopen(payload?.statementId, payload?.userId, payload?.reason), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.pattiyals.finalize', async (payload) => services.supplierSaleStatementService.finalize(payload?.statementId, payload?.userId), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.pattiyals.void', async (payload) => services.supplierSaleStatementService.void(payload?.statementId, payload?.userId, payload?.reason), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.pattiyals.attributions.set', async (payload) => services.supplierSaleStatementService.setAttribution(payload?.attribution || {}), { authorize: requireSettlementsManage });
  wrapIpcHandler('supply.pattiyals.export.xlsx', async (payload) => {
    const selected = await dialog.showSaveDialog({
      title: 'Save Supplier Sales Statement Excel',
      defaultPath: payload?.fileName || 'supplier-sales-statement.xlsx',
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }]
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    return { filePath: await services.supplierSalesStatementExportService.saveXlsx(payload?.document || {}, { filePath: selected.filePath }) };
  }, { authorize: requireSettlementsView });
  wrapIpcHandler('supply.pattiyals.export.docx', async (payload) => {
    const selected = await dialog.showSaveDialog({
      title: 'Save Supplier Sales Statement Word document',
      defaultPath: payload?.fileName || 'supplier-sales-statement.docx',
      filters: [{ name: 'Word document', extensions: ['docx'] }]
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    return { filePath: await services.supplierSalesStatementExportService.saveDocx(payload?.document || {}, { filePath: selected.filePath }) };
  }, { authorize: requireSettlementsView });

  // ── Billing ─────────────────────────────────────────────────
  // Bill-based billing (POS UI flow): live invoice_items → master at finalize
  wrapIpcHandler(
    'billing.bill.open',
    async (payload) => {
      return services.billingEngineService.openBill(payload?.session);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.invoices.search',
    async (payload) => services.billingEngineService.searchInvoices(payload?.filters || {}),
    { authorize: requireBillingView }
  );
  wrapIpcHandler(
    'billing.invoices.get',
    async (payload) => services.billingEngineService.getInvoiceArchive(payload?.invoiceId),
    { authorize: requireBillingView }
  );
  wrapIpcHandler(
    'billing.invoices.collect',
    async (payload) => services.billingEngineService.collectInvoiceBalance({
      invoiceId: payload?.invoiceId,
      sessionId: payload?.sessionId,
      userId: payload?.userId,
      payments: payload?.payments
    }),
    { authorize: requireReceivablesCollect }
  );

  wrapIpcHandler(
    'billing.bill.hold',
    async (payload) => {
      return services.billingEngineService.holdBill(payload?.session);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.addItem',
    async (payload) => {
      return services.billingEngineService.addItem(payload?.bill, payload?.item);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.updateItem',
    async (payload) => {
      return services.billingEngineService.updateItem(payload?.itemId, { ...(payload?.updates || {}), actorId: payload?.actor?.id || null });
    },
    { authorize: requireBillingCreate }
  );

  // ── Business Day Control ────────────────────────────────────
  wrapIpcHandler('businessDays.state', async (payload) => {
    return services.businessDayService.getState({ locationCode: payload?.locationCode });
  }, { authorize: requireBusinessDayView });

  wrapIpcHandler('businessDays.list', async (payload) => {
    return services.businessDayService.list({ locationCode: payload?.locationCode, limit: payload?.limit });
  }, { authorize: requireBusinessDayView });

  wrapIpcHandler('businessDays.startClosing', async (payload) => {
    return services.businessDayService.startClosing({ dayId: payload?.dayId, userId: payload?.actor?.id });
  }, { authorize: requireBusinessDayClose });

  wrapIpcHandler('businessDays.resumeTrading', async (payload) => {
    return services.businessDayService.resumeTrading({
      dayId: payload?.dayId, userId: payload?.actor?.id, reason: payload?.reason
    });
  }, { authorize: requireBusinessDayClose });

  wrapIpcHandler('businessDays.close', async (payload) => {
    return services.businessDayService.closeDay({
      dayId: payload?.dayId, userId: payload?.actor?.id, reason: payload?.reason
    });
  }, { authorize: requireBusinessDayClose });

  wrapIpcHandler('businessDays.open', async (payload) => {
    return services.businessDayService.openDay({
      locationCode: payload?.locationCode, businessDate: payload?.businessDate, userId: payload?.actor?.id
    });
  }, { authorize: requireBusinessDayOpen });

  wrapIpcHandler('businessDays.reopen', async (payload) => {
    return services.businessDayService.reopenDay({
      dayId: payload?.dayId, userId: payload?.actor?.id, reason: payload?.reason
    });
  }, { authorize: requireBusinessDayReopen });

  wrapIpcHandler(
    'billing.bill.updateCustomer',
    async (payload) => services.billingEngineService.updateBillCustomerCode(payload?.bill || {}),
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.removeItem',
    async (payload) => {
      return services.billingEngineService.removeItem(payload?.itemId);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.getItems',
    async (payload) => {
      return services.billingEngineService.getItems(payload?.bill);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.computeTotals',
    async (payload) => {
      return services.billingEngineService.computeTotals({
        locCode: payload?.locCode,
        macCode: payload?.macCode,
        txnDate: payload?.txnDate,
        receiptNo: payload?.receiptNo
      });
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.finalize',
    async (payload) => {
      return services.billingEngineService.finalizeBill({
        locCode: payload?.locCode,
        macCode: payload?.macCode,
        txnDate: payload?.txnDate,
        receiptNo: payload?.receiptNo,
        sessionId: payload?.sessionId,
        payments: payload?.payments,
        userId: payload?.userId,
        customerCode: payload?.customerCode,
        customerAccountId: payload?.customerAccountId
      });
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.abandon',
    async (payload) => {
      return services.billingEngineService.abandonBill(payload?.bill);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.recallList',
    async (payload) => {
      return services.billingEngineService.recallBills(payload);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'billing.bill.load',
    async (payload) => {
      return services.billingEngineService.loadBill(payload?.bill);
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler('billing.lots.candidates', async (payload) => {
    return services.billingEngineService.listAllocationLotCandidates({ ...(payload?.options || {}), userId: payload?.actor?.id || null });
  }, { authorize: requireBillingCreate });

  wrapIpcHandler('billing.lots.remember', async (payload) => {
    return services.billingEngineService.rememberAllocationLot({ ...(payload?.options || {}), userId: payload?.actor?.id || null });
  }, { authorize: requireBillingCreate });

  wrapIpcHandler('billing.lots.clearRemembered', async (payload) => {
    return services.billingEngineService.clearRememberedAllocationLot({ ...(payload?.options || {}), userId: payload?.actor?.id || null });
  }, { authorize: requireBillingCreate });

  wrapIpcHandler('billing.bill.setItemLotPriority', async (payload) => {
    return services.billingEngineService.setLiveItemAllocationPriority({ ...(payload?.options || {}), userId: payload?.actor?.id || null });
  }, { authorize: requireBillingCreate });

  // Refunds are separate, source-linked documents. The renderer can request
  // workflows, but the refund service revalidates source limits at completion.
  wrapIpcHandler(
    'refunds.searchSourceInvoices',
    async (payload) => services.refundService.searchSourceInvoices(payload?.options || {}),
    { authorize: requireRefundView }
  );

  wrapIpcHandler(
    'refunds.getSource',
    async (payload) => services.refundService.getSource(payload?.invoiceId),
    { authorize: requireRefundView }
  );

  wrapIpcHandler(
    'refunds.createDraft',
    async (payload) => services.refundService.createDraft(payload?.draft || {}),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'refunds.getDraft',
    async (payload) => services.refundService.getDraft(payload?.draftId),
    { authorize: requireRefundView }
  );

  wrapIpcHandler(
    'refunds.listActive',
    async (payload) => services.refundService.listActiveDrafts(payload?.context || {}),
    { authorize: requireRefundView }
  );

  wrapIpcHandler(
    'refunds.saveItem',
    async (payload) => services.refundService.addSourceItem(payload?.item || {}),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'refunds.removeItem',
    async (payload) => services.refundService.removeDraftItem(payload?.draftId, payload?.sourceInvoiceItemId),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'refunds.hold',
    async (payload) => services.refundService.holdDraft(payload?.draftId, payload?.userId),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'refunds.resume',
    async (payload) => services.refundService.resumeDraft(payload?.draftId, payload?.userId),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'refunds.abandon',
    async (payload) => services.refundService.abandonDraft(payload?.draftId, payload?.userId),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'refunds.finalize',
    async (payload) => services.refundService.finalize(payload?.refund || {}),
    { authorize: requireRefundCreate }
  );

  wrapIpcHandler(
    'billing.paymentModes',
    async () => {
      const configured = await services.paymentModeRepository.listModes();
      services.paymentModes.replaceConfigured(configured);
      return services.paymentModes.listModes();
    },
    { authorize: requireBillingCreate }
  );

  wrapIpcHandler(
    'printing.savePdf',
    async (payload) => {
      const options = payload?.options || {};
      let filePath = options.filePath || null;
      if (!filePath && options.prompt === true) {
        const selected = await dialog.showSaveDialog({
          title: 'Save invoice PDF',
          defaultPath: options.fileName || 'invoice.pdf',
          filters: [{ name: 'PDF files', extensions: ['pdf'] }]
        });
        if (selected.canceled || !selected.filePath) return { canceled: true };
        filePath = selected.filePath;
      }
      return services.pdfDocumentService.saveDocument(payload?.doc || {}, { ...options, filePath });
    },
    { authorize: requirePdfOrSettlements }
  );

  // Cash shifts are the immutable financial drawer ledger. Cashiers may open,
  // move, count, and blind-close their shifts; final reconciliation is a
  // separate manager permission.
  wrapIpcHandler(
    'cash.activeShift',
    async (payload) => services.cashManagementService.getActiveShiftForSession(payload?.sessionId),
    { authorize: requireCashView }
  );
  wrapIpcHandler(
    'cash.recoverableShift',
    async (payload) => services.cashManagementService.getRecoverableShiftForWorkstation({
      workstationId: payload?.workstationId,
      userId: payload?.userId
    }),
    { authorize: requireCashView }
  );
  wrapIpcHandler(
    'cash.getShift',
    async (payload) => services.cashManagementService.getShift(payload?.shiftId),
    { authorize: requireCashView }
  );
  wrapIpcHandler(
    'cash.reportHistory',
    async (payload) => services.cashManagementService.listReportHistory({ shiftId: payload?.shiftId }),
    { authorize: requireCashView }
  );
  wrapIpcHandler(
    'cash.archiveReportPrint',
    async (payload) => services.cashManagementService.archiveReportPrint({
      shiftId: payload?.shiftId,
      reportType: payload?.reportType,
      reportNo: payload?.reportNo,
      snapshot: payload?.snapshot,
      userId: payload?.userId
    }),
    { authorize: requireCashView }
  );
  wrapIpcHandler(
    'cash.openShift',
    async (payload) => services.cashManagementService.openShift(payload?.shift || {}),
    { authorize: requireCashOpen }
  );
  wrapIpcHandler(
    'cash.addMovement',
    async (payload) => services.cashManagementService.recordMovement({ ...(payload?.movement || {}), userId: actorId(payload) }),
    { authorize: requireCashMovement }
  );
  wrapIpcHandler(
    'cash.correctMovement',
    async (payload) => services.cashManagementService.correctMovement({ ...(payload?.movement || {}), userId: actorId(payload) }),
    { authorize: requireCashCorrection }
  );
  wrapIpcHandler(
    'cash.removeMovement',
    async (payload) => services.cashManagementService.removeMovement({ ...(payload?.movement || {}), userId: actorId(payload) }),
    { authorize: requireCashCorrection }
  );
  wrapIpcHandler(
    'cash.movementHistory',
    async (payload) => services.cashManagementService.listMovementHistory(payload?.filters || {}),
    { authorize: requireCashView }
  );
  wrapIpcHandler(
    'cash.blindClose',
    async (payload) => services.cashManagementService.blindClose(payload?.count || {}),
    { authorize: requireCashBlindClose }
  );
  wrapIpcHandler(
    'cash.closeShift',
    async (payload) => services.cashManagementService.closeShift(payload?.close || {}),
    { authorize: requireCashClose }
  );

  wrapIpcHandler(
    'billing.searchProducts',
    async (payload) => {
      return services.billingEngineService.searchProducts(payload?.term);
    },
    { authorize: requireBillingCreate }
  );

  // ── User Management ────────────────────────────────────────
  const requireUsersManage = services.ipcAuthorizationService.requirePermission('users.manage');

  wrapIpcHandler(
    'users.list',
    async () => {
      return services.userManagementService.listUsers();
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'users.get',
    async (payload) => {
      return services.userManagementService.getUser(payload?.id);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'users.create',
    async (payload) => {
      return services.userManagementService.createUser(payload);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'users.update',
    async (payload) => {
      return services.userManagementService.updateUser(payload?.id, payload);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'users.updatePassword',
    async (payload) => {
      return services.userManagementService.updatePassword(payload?.id, payload?.newPassword);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'users.delete',
    async (payload) => {
      return services.userManagementService.deleteUser(payload?.id);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'users.setRoles',
    async (payload) => {
      return services.userManagementService.setUserRoles(payload?.userId, payload?.roleIds);
    },
    { authorize: requireUsersManage }
  );

  // ── Role Management ────────────────────────────────────────
  wrapIpcHandler(
    'roles.list',
    async () => {
      return services.userManagementService.listRoles();
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'roles.get',
    async (payload) => {
      return services.userManagementService.getRole(payload?.id);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'roles.create',
    async (payload) => {
      return services.userManagementService.createRole(payload);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'roles.update',
    async (payload) => {
      return services.userManagementService.updateRole(payload?.id, payload);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'roles.delete',
    async (payload) => {
      return services.userManagementService.deleteRole(payload?.id);
    },
    { authorize: requireUsersManage }
  );

  wrapIpcHandler(
    'roles.setPermissions',
    async (payload) => {
      return services.userManagementService.setRolePermissions(payload?.roleId, payload?.permissionIds);
    },
    { authorize: requireUsersManage }
  );

  // ── Permissions ────────────────────────────────────────────
  wrapIpcHandler(
    'permissions.list',
    async () => {
      return services.userManagementService.listPermissions();
    },
    { authorize: requireUsersManage }
  );

  // ── Printing ─────────────────────────────────────────────────
  wrapIpcHandler(
    'printing.list',
    async () => {
      return services.printerService.listPrinters();
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'printing.default.get',
    async () => {
      return services.printerService.getDefaultPrinterId();
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'printing.default.set',
    async (payload) => {
      return services.printerService.setDefaultPrinter(payload?.printerId);
    },
    { authorize: requireSettingsManage }
  );

  wrapIpcHandler(
    'printing.printDocument',
    async (payload) => {
      return services.printerService.printDocument(payload?.doc, payload?.printerId);
    },
    { authorize: requirePrintOrBilling }
  );

  wrapIpcHandler(
    'printing.printTestPage',
    async (payload) => {
      return services.printerService.printTestPage(payload?.printerId);
    },
    { authorize: requireSettingsManage }
  );

  // ── Reports ─────────────────────────────────────────────────
  wrapIpcHandler('reports.sales.summary', async () => services.reportService.salesSummary(), { authorize: requireReportsView });
  wrapIpcHandler('reports.sales.detail', async (payload) => services.reportService.salesReport(payload?.filters || {}), { authorize: requireReportsView });
  wrapIpcHandler('reports.sales.items', async (payload) => services.reportService.salesItemOptions(payload?.filters || {}), { authorize: requireReportsView });
  wrapIpcHandler('reports.suppliers.summary', async (payload) => services.reportService.supplierSummary(payload?.filters || {}), { authorize: requireReportsView });
  wrapIpcHandler('reports.inventory.summary', async (payload) => services.reportService.inventoryMovementSummary(payload?.filters || {}), { authorize: requireReportsView });
  wrapIpcHandler('reports.ddec.exportXlsx', async (payload) => {
    const selected = await dialog.showSaveDialog({ title: 'Export DDEC report workbook', defaultPath: 'ddec-report.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    return { filePath: await services.reportService.exportDdecWorkbook(selected.filePath, payload?.filters || {}) };
  }, { authorize: requireReportsExport });
  wrapIpcHandler('reports.sales.exportXlsx', async (payload) => {
    const selected = await dialog.showSaveDialog({ title: 'Export DDEC sales report', defaultPath: `sales-report-${String(payload?.filters?.toDate || 'export').slice(0, 10)}.xlsx`, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    return { filePath: await services.reportService.exportSalesWorkbook(selected.filePath, payload?.filters || {}) };
  }, { authorize: requireReportsExport });

  // ── Field Transaction Inbox ─────────────────────────────────
  wrapIpcHandler('fieldInbox.configuration.get', async () => {
    return services.fieldInboxService.getConfiguration();
  }, { authorize: requireSettingsManage });
  wrapIpcHandler('fieldInbox.configuration.save', async (payload) => {
    return services.fieldInboxService.saveConfiguration(payload?.configuration || {});
  }, { authorize: requireSettingsManage });
  wrapIpcHandler('fieldInbox.configuration.test', async (payload) => {
    return services.fieldInboxService.testConnection({ date: payload?.date });
  }, { authorize: requireSettingsManage });
  wrapIpcHandler('fieldInbox.records.list', async (payload) => {
    return services.fieldInboxService.listRecords({ date: payload?.date });
  }, { authorize: requireFieldInboxView });
  wrapIpcHandler('fieldInbox.records.resolve', async (payload) => {
    return services.fieldInboxService.setResolved({
      ...payload,
      userId: payload?.actor?.id
    });
  }, { authorize: requireFieldInboxResolve });
  wrapIpcHandler('fieldInbox.media.get', async (payload) => {
    return services.fieldInboxService.getMedia({ mediaId: payload?.mediaId });
  }, { authorize: requireFieldInboxView });

  wrapIpcHandler('cloudSync.configuration.get', async () => services.cloudSyncService.getConfiguration(), { authorize: requireSettingsManage });
  wrapIpcHandler('cloudSync.configuration.save', async (payload) => {
    const result = await services.cloudSyncService.saveConfiguration(payload?.configuration || {});
    services.cloudSyncScheduler.refresh();
    return result;
  }, { authorize: requireSettingsManage });
  wrapIpcHandler('cloudSync.runNow', async () => services.cloudSyncService.runNow({ force: true }), { authorize: requireSettingsManage });
  wrapIpcHandler('cloudSync.mobileBills.list', async (payload) => services.cloudSyncService.listMobileBills(payload || {}), { authorize: requireFieldInboxView });
  wrapIpcHandler('cloudSync.mobileBills.status', async (payload) => services.cloudSyncService.setMobileBillStatus(payload || {}), { authorize: requireFieldInboxView });
}

module.exports = {
  registerIpcHandlers
};
