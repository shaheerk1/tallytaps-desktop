const { contextBridge, ipcRenderer } = require('electron');

// Every request carries the session token, read from the page's own storage,
// so the main process can resolve who is signed in and which workstation they
// are on. No screen has to remember to send it.
function sessionToken() {
  try { return window.localStorage.getItem('pos_session_token'); } catch { return null; }
}

function invoke(channel, payload) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return ipcRenderer.invoke(channel, { ...body, __token: sessionToken() });
}

contextBridge.exposeInMainWorld('posApi', {
  auth: {
    login: (payload) => invoke('auth.login', payload),
    validateSession: (token) => invoke('auth.session.validate', { token }),
    logout: (token) => invoke('auth.logout', { token }),
    cleanup: () => invoke('auth.cleanup')
  },
  workstations: {
    list: () => invoke('workstations.list'),
    listAll: (actor) => invoke('workstations.listAll', { actor }),
    create: (payload, actor) => invoke('workstations.create', { ...payload, actor }),
    update: (id, payload, actor) => invoke('workstations.update', { id, ...payload, actor }),
    delete: (id, actor) => invoke('workstations.delete', { id, actor }),
    activeSession: (userId) => invoke('workstations.activeSession', { userId }),
    openSession: (payload) => invoke('workstations.openSession', payload),
    closeSession: (userId) => invoke('workstations.closeSession', { userId }),
    updateSessionDate: (userId, billingDate, actor) =>
      invoke('workstations.updateSessionDate', { userId, billingDate, actor })
  },
  locations: {
    list: (actor) => invoke('locations.list', { actor }),
    create: (location, actor) => invoke('locations.create', { location, actor }),
    update: (locCode, location, actor) => invoke('locations.update', { locCode, location, actor }),
    retire: (locCode, actor) => invoke('locations.retire', { locCode, actor })
  },
  businessDays: {
    state: (locationCode, actor) => invoke('businessDays.state', { locationCode, actor }),
    list: (locationCode, limit, actor) => invoke('businessDays.list', { locationCode, limit, actor }),
    startClosing: (dayId, actor) => invoke('businessDays.startClosing', { dayId, actor }),
    resumeTrading: (dayId, reason, actor) => invoke('businessDays.resumeTrading', { dayId, reason, actor }),
    close: (dayId, reason, actor) => invoke('businessDays.close', { dayId, reason, actor }),
    open: (locationCode, businessDate, actor) => invoke('businessDays.open', { locationCode, businessDate, actor }),
    reopen: (dayId, reason, actor) => invoke('businessDays.reopen', { dayId, reason, actor })
  },
  core: {
    healthCheck: () => invoke('core.health.check')
  },
  database: {
    healthCheck: () => invoke('database.health.check'),
    migrationStatus: () => invoke('database.migrations.status'),
    runPendingMigrations: () => invoke('database.migrations.runPending')
  },
  uiPreferences: {
    get: () => invoke('uiPreferences.get'),
    set: (settings, actor) => invoke('uiPreferences.set', { settings, actor })
  },
  settings: {
    get: (code, key, actor) => invoke('settings.get', { code, key, actor }),
    getByCode: (code, actor) => invoke('settings.getByCode', { code, actor }),
    getReceipt: () => invoke('settings.receipt.get'),
    getBillingOutput: (actor) => invoke('settings.billingOutput.get', { actor }),
    set: (code, key, value, actor) => invoke('settings.set', { code, key, value, actor }),
    setBulk: (code, settings, actor) => invoke('settings.setBulk', { code, settings, actor }),
    delete: (code, key, actor) => invoke('settings.delete', { code, key, actor }),
    listCodes: (actor) => invoke('settings.listCodes', { actor })
  },
  priorityLists: {
    resolveForUser: (userId) => invoke('priorityLists.resolveForUser', { userId }),
    list: (actor) => invoke('priorityLists.list', { actor }),
    get: (id, actor) => invoke('priorityLists.get', { id, actor }),
    create: (payload, actor) => invoke('priorityLists.create', { ...payload, actor }),
    update: (id, payload, actor) => invoke('priorityLists.update', { id, ...payload, actor }),
    delete: (id, actor) => invoke('priorityLists.delete', { id, actor }),
    setDefault: (id, actor) => invoke('priorityLists.setDefault', { id, actor }),
    setAssignments: (listId, assignments, actor) =>
      invoke('priorityLists.setAssignments', { listId, assignments, actor }),
    assignmentTargets: (actor) => invoke('priorityLists.assignmentTargets', { actor })
  },
  catalog: {
    listProducts: (options) => invoke('catalog.products.list', { options }),
    getProduct: (id) => invoke('catalog.products.get', { id }),
    createProduct: (payload, actor) => invoke('catalog.products.create', { ...payload, actor }),
    updateProduct: (id, updates, actor) => invoke('catalog.products.update', { id, updates, actor }),
    deleteProduct: (id, actor) => invoke('catalog.products.delete', { id, actor }),
    listProductCategories: () => invoke('catalog.products.categories'),
    listCustomers: (actor) => invoke('catalog.customers.list', { actor }),
    searchCustomers: (term, actor, options) => invoke('catalog.customers.search', { term, options, actor }),
    getCustomerAccount: (customerId, actor) => invoke('catalog.customers.account', { customerId, actor }),
    createCustomer: (customer, actor) => invoke('catalog.customers.create', { customer, actor }),
    updateCustomer: (customerId, customer, actor) => invoke('catalog.customers.update', { customerId, customer, actor }),
    assignInvoiceCustomer: (payload, actor) => invoke('catalog.customers.assignInvoice', { ...payload, actor }),
    listCheques: (filters, actor) => invoke('catalog.cheques.list', { filters, actor }),
    getCheque: (chequeId, actor) => invoke('catalog.cheques.get', { chequeId, actor }),
    updateChequeDetails: (payload, actor) => invoke('catalog.cheques.details', { ...payload, actor }),
    updateChequeStatus: (payload, actor) => invoke('catalog.cheques.status', { ...payload, actor }),
    linkCheque: (payload, actor) => invoke('catalog.cheques.link', { ...payload, actor }),
    listBusinessBankAccounts: (includeInactive, actor) => invoke('catalog.bankAccounts.list', { includeInactive, actor }),
    saveBusinessBankAccount: (account, actor) => invoke('catalog.bankAccounts.save', { account, actor }),
    listIssuedCheques: (filters, actor) => invoke('catalog.issuedCheques.list', { filters, actor }),
    getIssuedCheque: (chequeId, actor) => invoke('catalog.issuedCheques.get', { chequeId, actor }),
    createIssuedCheque: (cheque, actor) => invoke('catalog.issuedCheques.create', { cheque, actor }),
    updateIssuedChequeStatus: (payload, actor) => invoke('catalog.issuedCheques.status', { ...payload, actor })
    ,listSuppliers: (actor) => invoke('catalog.suppliers.list', { actor })
    ,createSupplier: (supplier, actor) => invoke('catalog.suppliers.create', { supplier, actor })
    ,saveGoodsReceiptDraft: (receipt, actor) => invoke('supply.goodsReceipts.drafts.save', { receipt, actor })
    ,finalizeGoodsReceiptDraft: (goodsReceiptId, userId, actor) => invoke('supply.goodsReceipts.drafts.finalize', { goodsReceiptId, userId, actor })
    ,cancelGoodsReceiptDraft: (goodsReceiptId, userId, actor) => invoke('supply.goodsReceipts.drafts.cancel', { goodsReceiptId, userId, actor })
    ,createGoodsReceiptCorrection: (goodsReceiptId, reason, userId, origin, actor) => invoke('supply.goodsReceipts.corrections.create', { goodsReceiptId, reason, userId, ...(origin || {}), actor })
    ,listGoodsReceipts: (filters, actor) => invoke('supply.goodsReceipts.list', { filters, actor })
    ,getGoodsReceipt: (goodsReceiptId, actor) => invoke('supply.goodsReceipts.get', { goodsReceiptId, actor })
    ,adjustStock: (adjustment, actor) => invoke('inventory.adjust', { adjustment, actor })
    ,listSupplyAgreements: (supplierId, actor) => invoke('supply.agreements.list', { supplierId, actor })
    ,createSupplyAgreement: (agreement, actor) => invoke('supply.agreements.create', { agreement, actor })
    ,getSupplierAccount: (supplierId, actor) => invoke('supply.suppliers.account', { supplierId, actor })
    ,createSupplierSettlement: (settlement, actor) => invoke('supply.settlements.create', { settlement, actor })
    ,approveSupplierSettlement: (settlementId, userId, actor) => invoke('supply.settlements.approve', { settlementId, userId, actor })
    ,recordSupplierPayment: (payment, actor) => invoke('supply.settlements.pay', { payment, actor })
    ,listSupplierSettlements: (supplierId, actor) => invoke('supply.settlements.list', { supplierId, actor })
    ,getSupplierSettlement: (settlementId, actor) => invoke('supply.settlements.get', { settlementId, actor })
    ,listSupplierChargeTypes: (actor) => invoke('supply.charges.listTypes', { actor })
    ,addSupplierCharge: (charge, actor) => invoke('supply.charges.add', { charge, actor })
    ,listInventoryLots: (productId, locCode, actor) => invoke('inventory.lots.list', { productId, locCode, actor })
    ,listInventorySummary: (locCode, actor) => invoke('inventory.summary.list', { locCode, actor })
    ,finalizeStockCount: (count, actor) => invoke('inventory.counts.finalize', { count, actor })
    ,listInventoryIssues: (filters, actor) => invoke('inventory.issues.list', { filters, actor })
    ,recordInventoryIssue: (issue, actor) => invoke('inventory.issues.record', { issue, actor })
    ,listAllocationExceptions: (locCode, actor) => invoke('inventory.allocations.exceptions', { locCode, actor })
    ,listRecentLotAllocations: (locCode, limit, actor) => invoke('inventory.allocations.list', { locCode, limit, actor })
    ,allocateException: (allocation, actor) => invoke('inventory.allocations.resolve', { allocation, actor })
    ,reallocateSale: (allocation, actor) => invoke('inventory.allocations.reallocate', { allocation, actor })
  },
  customerAdvances: {
    balance: (customerAccountId, locCode, actor) => invoke('customerAdvances.balance', { customerAccountId, locCode, actor }),
    summary: (customerAccountId, locCode, actor) => invoke('customerAdvances.summary', { customerAccountId, locCode, actor }),
    receive: (advance, actor) => invoke('customerAdvances.receive', { ...advance, actor }),
    refund: (refund, actor) => invoke('customerAdvances.refund', { ...refund, actor })
  },
  funds: {
    list: (locCode, includeInactive, actor) => invoke('funds.list', { locCode, includeInactive, actor }),
    save: (fund, actor) => invoke('funds.save', { fund, actor }),
    ledger: (query, actor) => invoke('funds.ledger', { ...query, actor }),
    transfer: (transfer, actor) => invoke('funds.transfer', { transfer, actor })
  },
  expenses: {
    categories: (includeInactive, actor) => invoke('expenses.categories.list', { includeInactive, actor }),
    saveCategory: (category, actor) => invoke('expenses.categories.save', { category, actor }),
    list: (filters, actor) => invoke('expenses.list', { filters, actor }),
    create: (expense, actor) => invoke('expenses.create', { expense, actor }),
    reverse: (reversal, actor) => invoke('expenses.reverse', { reversal, actor }),
    listRecurring: (locCode, includeInactive, actor) => invoke('expenses.recurring.list', { locCode, includeInactive, actor }),
    saveRecurring: (template, actor) => invoke('expenses.recurring.save', { template, actor }),
    recordRecurring: (payload, actor) => invoke('expenses.recurring.record', { ...payload, actor })
  },
  lotCosting: {
    lots: (filters, actor) => invoke('lotCosting.lots.list', { filters, actor }),
    profitability: (filters, actor) => invoke('lotCosting.profitability', { filters, actor }),
    lotDetail: (query, actor) => invoke('lotCosting.lot.detail', { ...query, actor }),
    reconcile: (locCode, actor) => invoke('lotCosting.reconcile', { locCode, actor }),
    allocate: (allocation, actor) => invoke('lotCosting.allocate', { allocation, actor }),
    reallocate: (reallocation, actor) => invoke('lotCosting.reallocate', { reallocation, actor }),
    detach: (detachment, actor) => invoke('lotCosting.detach', { detachment, actor })
  },
  stakeholders: {
    list: (locCode, includeInactive, actor) => invoke('stakeholders.list', { locCode, includeInactive, actor }),
    save: (stakeholder, actor) => invoke('stakeholders.save', { stakeholder, actor }),
    statement: (query, actor) => invoke('stakeholders.statement', { ...query, actor }),
    shares: (query, actor) => invoke('stakeholders.shares.list', { ...query, actor }),
    saveShare: (share, actor) => invoke('stakeholders.shares.save', { share, actor }),
    contribute: (entry, actor) => invoke('stakeholders.contribute', { entry, actor }),
    draw: (entry, actor) => invoke('stakeholders.draw', { entry, actor }),
    settle: (entry, actor) => invoke('stakeholders.settle', { entry, actor }),
    profitShare: (entry, actor) => invoke('stakeholders.profitShare', { entry, actor }),
    reconcile: (locCode, actor) => invoke('stakeholders.reconcile', { locCode, actor })
  },
  accounting: {
    reconcile: (options, actor) => invoke('accounting.reconcile', { options, actor }),
    accounts: (actor) => invoke('accounting.accounts.list', { actor }),
    journal: (filters, actor) => invoke('accounting.journal.list', { filters, actor }),
    trialBalance: (filters, actor) => invoke('accounting.trialBalance', { filters, actor }),
    profitAndLoss: (filters, actor) => invoke('accounting.profitAndLoss', { filters, actor }),
    balanceSheet: (filters, actor) => invoke('accounting.balanceSheet', { filters, actor }),
    periods: (locCode, actor) => invoke('accounting.periods.list', { locCode, actor }),
    closePeriod: (period, actor) => invoke('accounting.periods.close', { period, actor }),
    reopenPeriod: (period, actor) => invoke('accounting.periods.reopen', { period, actor })
  },
  pattiyals: {
    list: (filters, actor) => invoke('supply.pattiyals.list', { filters, actor }),
    get: (statementId, actor) => invoke('supply.pattiyals.get', { statementId, actor }),
    candidates: (filters, actor) => invoke('supply.pattiyals.candidates.sales', { filters, actor }),
    candidateGrns: (filters, actor) => invoke('supply.pattiyals.candidates.grns', { filters, actor }),
    saveDraft: (statement, actor) => invoke('supply.pattiyals.drafts.save', { statement, actor }),
    review: (statementId, userId, actor) => invoke('supply.pattiyals.review', { statementId, userId, actor }),
    reopen: (statementId, userId, reason, actor) => invoke('supply.pattiyals.reopen', { statementId, userId, reason, actor }),
    finalize: (statementId, userId, actor) => invoke('supply.pattiyals.finalize', { statementId, userId, actor }),
    void: (statementId, userId, reason, actor) => invoke('supply.pattiyals.void', { statementId, userId, reason, actor }),
    setAttribution: (attribution, actor) => invoke('supply.pattiyals.attributions.set', { attribution, actor }),
    exportXlsx: (document, fileName, actor) => invoke('supply.pattiyals.export.xlsx', { document, fileName, actor }),
    exportDocx: (document, fileName, actor) => invoke('supply.pattiyals.export.docx', { document, fileName, actor })
  },
  billing: {
    openBill: (session, actor) => invoke('billing.bill.open', { session, actor }),
    searchInvoices: (filters, actor) => invoke('billing.invoices.search', { filters, actor }),
    getInvoice: (invoiceId, actor) => invoke('billing.invoices.get', { invoiceId, actor }),
    collectInvoiceBalance: (payload, actor) => invoke('billing.invoices.collect', { ...payload, actor }),
    unsettleInvoice: (payload, actor) => invoke('billing.invoices.unsettle', { ...payload, actor }),
    holdBill: (session, actor) => invoke('billing.bill.hold', { session, actor }),
    addItem: (bill, item, actor) => invoke('billing.bill.addItem', { bill, item, actor }),
    updateItem: (itemId, updates, actor) => invoke('billing.bill.updateItem', { itemId, updates, actor }),
    updateCustomer: (bill, actor) => invoke('billing.bill.updateCustomer', { bill, actor }),
    removeItem: (itemId, actor) => invoke('billing.bill.removeItem', { itemId, actor }),
    getItems: (bill, actor) => invoke('billing.bill.getItems', { bill, actor }),
    computeTotals: (bill, actor) => invoke('billing.bill.computeTotals', { ...bill, actor }),
    finalize: (payload, actor) => invoke('billing.finalize', { ...payload, actor }),
    paymentModes: (actor) => invoke('billing.paymentModes', { actor }),
    abandonBill: (bill, actor) => invoke('billing.bill.abandon', { bill, actor }),
    recallBills: (locCode, macCode, txnDate, actor) => invoke('billing.bill.recallList', { locCode, macCode, txnDate, actor }),
    loadBill: (bill, actor) => invoke('billing.bill.load', { bill, actor }),
    lotCandidates: (options, actor) => invoke('billing.lots.candidates', { options, actor }),
    rememberLot: (options, actor) => invoke('billing.lots.remember', { options, actor }),
    clearRememberedLot: (options, actor) => invoke('billing.lots.clearRemembered', { options, actor }),
    setItemLotPriority: (options, actor) => invoke('billing.bill.setItemLotPriority', { options, actor }),
    searchProducts: (term, actor) => invoke('billing.searchProducts', { term, actor })
  },
  refunds: {
    searchSourceInvoices: (options, actor) => invoke('refunds.searchSourceInvoices', { options, actor }),
    getSource: (invoiceId, actor) => invoke('refunds.getSource', { invoiceId, actor }),
    createDraft: (draft, actor) => invoke('refunds.createDraft', { draft, actor }),
    getDraft: (draftId, actor) => invoke('refunds.getDraft', { draftId, actor }),
    listActive: (context, actor) => invoke('refunds.listActive', { context, actor }),
    saveItem: (item, actor) => invoke('refunds.saveItem', { item, actor }),
    removeItem: (draftId, sourceInvoiceItemId, actor) => invoke('refunds.removeItem', { draftId, sourceInvoiceItemId, actor }),
    hold: (draftId, userId, actor) => invoke('refunds.hold', { draftId, userId, actor }),
    resume: (draftId, userId, actor) => invoke('refunds.resume', { draftId, userId, actor }),
    abandon: (draftId, userId, actor) => invoke('refunds.abandon', { draftId, userId, actor }),
    finalize: (refund, actor) => invoke('refunds.finalize', { refund, actor })
  },
  cash: {
    activeShift: (sessionId, actor) => invoke('cash.activeShift', { sessionId, actor }),
    recoverableShift: (workstationId, userId, actor) => invoke('cash.recoverableShift', { workstationId, userId, actor }),
    getShift: (shiftId, actor) => invoke('cash.getShift', { shiftId, actor }),
    reportHistory: (shiftId, actor) => invoke('cash.reportHistory', { shiftId, actor }),
    archiveReportPrint: (payload, actor) => invoke('cash.archiveReportPrint', { ...payload, actor }),
    openShift: (shift, actor) => invoke('cash.openShift', { shift, actor }),
    addMovement: (movement, actor) => invoke('cash.addMovement', { movement, actor }),
    correctMovement: (movement, actor) => invoke('cash.correctMovement', { movement, actor }),
    removeMovement: (movement, actor) => invoke('cash.removeMovement', { movement, actor }),
    movementHistory: (filters, actor) => invoke('cash.movementHistory', { filters, actor }),
    blindClose: (count, actor) => invoke('cash.blindClose', { count, actor }),
    closeShift: (close, actor) => invoke('cash.closeShift', { close, actor })
  },
  reports: {
    salesSummary: (actor) => invoke('reports.sales.summary', { actor }),
    salesDetail: (filters, actor) => invoke('reports.sales.detail', { filters, actor }),
    salesItems: (filters, actor) => invoke('reports.sales.items', { filters, actor }),
    supplierSummary: (filters, actor) => invoke('reports.suppliers.summary', { filters, actor }),
    inventorySummary: (filters, actor) => invoke('reports.inventory.summary', { filters, actor }),
    exportDdecXlsx: (filters, actor) => invoke('reports.ddec.exportXlsx', { filters, actor }),
    exportSalesXlsx: (filters, actor) => invoke('reports.sales.exportXlsx', { filters, actor })
  },
  fieldInbox: {
    getConfiguration: (actor) => invoke('fieldInbox.configuration.get', { actor }),
    saveConfiguration: (configuration, actor) => invoke('fieldInbox.configuration.save', { configuration, actor }),
    testConnection: (date, actor) => invoke('fieldInbox.configuration.test', { date, actor }),
    listRecords: (date, actor) => invoke('fieldInbox.records.list', { date, actor }),
    setResolved: (recordId, clientRecordId, resolved, actor) =>
      invoke('fieldInbox.records.resolve', { recordId, clientRecordId, resolved, actor }),
    getMedia: (mediaId, actor) => invoke('fieldInbox.media.get', { mediaId, actor })
  },
  cloudSync: {
    getConfiguration: (actor) => invoke('cloudSync.configuration.get', { actor }),
    saveConfiguration: (configuration, actor) => invoke('cloudSync.configuration.save', { configuration, actor }),
    runNow: (actor) => invoke('cloudSync.runNow', { actor }),
    listMobileBills: (since, until, actor) => invoke('cloudSync.mobileBills.list', { since, until, actor }),
    setMobileBillStatus: (billId, status, actor) => invoke('cloudSync.mobileBills.status', { billId, status, actor })
  },
  users: {
    list: (actor) => invoke('users.list', { actor }),
    get: (id, actor) => invoke('users.get', { id, actor }),
    create: (payload, actor) => invoke('users.create', { ...payload, actor }),
    update: (id, payload, actor) => invoke('users.update', { id, ...payload, actor }),
    updatePassword: (id, newPassword, actor) => invoke('users.updatePassword', { id, newPassword, actor }),
    delete: (id, actor) => invoke('users.delete', { id, actor }),
    setRoles: (userId, roleIds, actor) => invoke('users.setRoles', { userId, roleIds, actor })
  },
  roles: {
    list: (actor) => invoke('roles.list', { actor }),
    get: (id, actor) => invoke('roles.get', { id, actor }),
    create: (payload, actor) => invoke('roles.create', { ...payload, actor }),
    update: (id, payload, actor) => invoke('roles.update', { id, ...payload, actor }),
    delete: (id, actor) => invoke('roles.delete', { id, actor }),
    setPermissions: (roleId, permissionIds, actor) => invoke('roles.setPermissions', { roleId, permissionIds, actor })
  },
  permissions: {
    list: (actor) => invoke('permissions.list', { actor })
  },
  printing: {
    list: (actor) => invoke('printing.list', { actor }),
    defaultGet: (actor) => invoke('printing.default.get', { actor }),
    defaultSet: (printerId, actor) => invoke('printing.default.set', { printerId, actor }),
    printDocument: (doc, printerId = null, actor) => invoke('printing.printDocument', { doc, printerId, actor }),
    printTestPage: (printerId = null, actor) => invoke('printing.printTestPage', { printerId, actor }),
    savePdf: (doc, options, actor) => invoke('printing.savePdf', { doc, options, actor })
  }
});
