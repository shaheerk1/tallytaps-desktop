const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posApi', {
  auth: {
    login: (payload) => ipcRenderer.invoke('auth.login', payload),
    validateSession: (token) => ipcRenderer.invoke('auth.session.validate', { token }),
    logout: (token) => ipcRenderer.invoke('auth.logout', { token }),
    cleanup: () => ipcRenderer.invoke('auth.cleanup')
  },
  workstations: {
    list: () => ipcRenderer.invoke('workstations.list'),
    listAll: (actor) => ipcRenderer.invoke('workstations.listAll', { actor }),
    create: (payload, actor) => ipcRenderer.invoke('workstations.create', { ...payload, actor }),
    update: (id, payload, actor) => ipcRenderer.invoke('workstations.update', { id, ...payload, actor }),
    delete: (id, actor) => ipcRenderer.invoke('workstations.delete', { id, actor }),
    activeSession: (userId) => ipcRenderer.invoke('workstations.activeSession', { userId }),
    openSession: (payload) => ipcRenderer.invoke('workstations.openSession', payload),
    closeSession: (userId) => ipcRenderer.invoke('workstations.closeSession', { userId }),
    updateSessionDate: (userId, billingDate, actor) =>
      ipcRenderer.invoke('workstations.updateSessionDate', { userId, billingDate, actor })
  },
  businessDays: {
    state: (locationCode, actor) => ipcRenderer.invoke('businessDays.state', { locationCode, actor }),
    list: (locationCode, limit, actor) => ipcRenderer.invoke('businessDays.list', { locationCode, limit, actor }),
    startClosing: (dayId, actor) => ipcRenderer.invoke('businessDays.startClosing', { dayId, actor }),
    resumeTrading: (dayId, reason, actor) => ipcRenderer.invoke('businessDays.resumeTrading', { dayId, reason, actor }),
    close: (dayId, reason, actor) => ipcRenderer.invoke('businessDays.close', { dayId, reason, actor }),
    open: (locationCode, businessDate, actor) => ipcRenderer.invoke('businessDays.open', { locationCode, businessDate, actor }),
    reopen: (dayId, reason, actor) => ipcRenderer.invoke('businessDays.reopen', { dayId, reason, actor })
  },
  core: {
    healthCheck: () => ipcRenderer.invoke('core.health.check')
  },
  database: {
    healthCheck: () => ipcRenderer.invoke('database.health.check'),
    migrationStatus: () => ipcRenderer.invoke('database.migrations.status'),
    runPendingMigrations: () => ipcRenderer.invoke('database.migrations.runPending')
  },
  uiPreferences: {
    get: () => ipcRenderer.invoke('uiPreferences.get'),
    set: (settings, actor) => ipcRenderer.invoke('uiPreferences.set', { settings, actor })
  },
  settings: {
    get: (code, key, actor) => ipcRenderer.invoke('settings.get', { code, key, actor }),
    getByCode: (code, actor) => ipcRenderer.invoke('settings.getByCode', { code, actor }),
    getReceipt: () => ipcRenderer.invoke('settings.receipt.get'),
    getBillingOutput: (actor) => ipcRenderer.invoke('settings.billingOutput.get', { actor }),
    set: (code, key, value, actor) => ipcRenderer.invoke('settings.set', { code, key, value, actor }),
    setBulk: (code, settings, actor) => ipcRenderer.invoke('settings.setBulk', { code, settings, actor }),
    delete: (code, key, actor) => ipcRenderer.invoke('settings.delete', { code, key, actor }),
    listCodes: (actor) => ipcRenderer.invoke('settings.listCodes', { actor })
  },
  priorityLists: {
    resolveForUser: (userId) => ipcRenderer.invoke('priorityLists.resolveForUser', { userId }),
    list: (actor) => ipcRenderer.invoke('priorityLists.list', { actor }),
    get: (id, actor) => ipcRenderer.invoke('priorityLists.get', { id, actor }),
    create: (payload, actor) => ipcRenderer.invoke('priorityLists.create', { ...payload, actor }),
    update: (id, payload, actor) => ipcRenderer.invoke('priorityLists.update', { id, ...payload, actor }),
    delete: (id, actor) => ipcRenderer.invoke('priorityLists.delete', { id, actor }),
    setDefault: (id, actor) => ipcRenderer.invoke('priorityLists.setDefault', { id, actor }),
    setAssignments: (listId, assignments, actor) =>
      ipcRenderer.invoke('priorityLists.setAssignments', { listId, assignments, actor }),
    assignmentTargets: (actor) => ipcRenderer.invoke('priorityLists.assignmentTargets', { actor })
  },
  catalog: {
    listProducts: (options) => ipcRenderer.invoke('catalog.products.list', { options }),
    getProduct: (id) => ipcRenderer.invoke('catalog.products.get', { id }),
    createProduct: (payload, actor) => ipcRenderer.invoke('catalog.products.create', { ...payload, actor }),
    updateProduct: (id, updates, actor) => ipcRenderer.invoke('catalog.products.update', { id, updates, actor }),
    deleteProduct: (id, actor) => ipcRenderer.invoke('catalog.products.delete', { id, actor }),
    listProductCategories: () => ipcRenderer.invoke('catalog.products.categories'),
    listCustomers: (actor) => ipcRenderer.invoke('catalog.customers.list', { actor }),
    searchCustomers: (term, actor, options) => ipcRenderer.invoke('catalog.customers.search', { term, options, actor }),
    getCustomerAccount: (customerId, actor) => ipcRenderer.invoke('catalog.customers.account', { customerId, actor }),
    createCustomer: (customer, actor) => ipcRenderer.invoke('catalog.customers.create', { customer, actor }),
    updateCustomer: (customerId, customer, actor) => ipcRenderer.invoke('catalog.customers.update', { customerId, customer, actor }),
    assignInvoiceCustomer: (payload, actor) => ipcRenderer.invoke('catalog.customers.assignInvoice', { ...payload, actor }),
    listCheques: (filters, actor) => ipcRenderer.invoke('catalog.cheques.list', { filters, actor }),
    getCheque: (chequeId, actor) => ipcRenderer.invoke('catalog.cheques.get', { chequeId, actor }),
    updateChequeDetails: (payload, actor) => ipcRenderer.invoke('catalog.cheques.details', { ...payload, actor }),
    updateChequeStatus: (payload, actor) => ipcRenderer.invoke('catalog.cheques.status', { ...payload, actor }),
    linkCheque: (payload, actor) => ipcRenderer.invoke('catalog.cheques.link', { ...payload, actor }),
    listBusinessBankAccounts: (includeInactive, actor) => ipcRenderer.invoke('catalog.bankAccounts.list', { includeInactive, actor }),
    saveBusinessBankAccount: (account, actor) => ipcRenderer.invoke('catalog.bankAccounts.save', { account, actor }),
    listIssuedCheques: (filters, actor) => ipcRenderer.invoke('catalog.issuedCheques.list', { filters, actor }),
    getIssuedCheque: (chequeId, actor) => ipcRenderer.invoke('catalog.issuedCheques.get', { chequeId, actor }),
    createIssuedCheque: (cheque, actor) => ipcRenderer.invoke('catalog.issuedCheques.create', { cheque, actor }),
    updateIssuedChequeStatus: (payload, actor) => ipcRenderer.invoke('catalog.issuedCheques.status', { ...payload, actor })
    ,listSuppliers: (actor) => ipcRenderer.invoke('catalog.suppliers.list', { actor })
    ,createSupplier: (supplier, actor) => ipcRenderer.invoke('catalog.suppliers.create', { supplier, actor })
    ,saveGoodsReceiptDraft: (receipt, actor) => ipcRenderer.invoke('supply.goodsReceipts.drafts.save', { receipt, actor })
    ,finalizeGoodsReceiptDraft: (goodsReceiptId, userId, actor) => ipcRenderer.invoke('supply.goodsReceipts.drafts.finalize', { goodsReceiptId, userId, actor })
    ,cancelGoodsReceiptDraft: (goodsReceiptId, userId, actor) => ipcRenderer.invoke('supply.goodsReceipts.drafts.cancel', { goodsReceiptId, userId, actor })
    ,createGoodsReceiptCorrection: (goodsReceiptId, reason, userId, origin, actor) => ipcRenderer.invoke('supply.goodsReceipts.corrections.create', { goodsReceiptId, reason, userId, ...(origin || {}), actor })
    ,listGoodsReceipts: (filters, actor) => ipcRenderer.invoke('supply.goodsReceipts.list', { filters, actor })
    ,getGoodsReceipt: (goodsReceiptId, actor) => ipcRenderer.invoke('supply.goodsReceipts.get', { goodsReceiptId, actor })
    ,adjustStock: (adjustment, actor) => ipcRenderer.invoke('inventory.adjust', { adjustment, actor })
    ,listSupplyAgreements: (supplierId, actor) => ipcRenderer.invoke('supply.agreements.list', { supplierId, actor })
    ,createSupplyAgreement: (agreement, actor) => ipcRenderer.invoke('supply.agreements.create', { agreement, actor })
    ,getSupplierAccount: (supplierId, actor) => ipcRenderer.invoke('supply.suppliers.account', { supplierId, actor })
    ,createSupplierSettlement: (settlement, actor) => ipcRenderer.invoke('supply.settlements.create', { settlement, actor })
    ,approveSupplierSettlement: (settlementId, userId, actor) => ipcRenderer.invoke('supply.settlements.approve', { settlementId, userId, actor })
    ,recordSupplierPayment: (payment, actor) => ipcRenderer.invoke('supply.settlements.pay', { payment, actor })
    ,listSupplierSettlements: (supplierId, actor) => ipcRenderer.invoke('supply.settlements.list', { supplierId, actor })
    ,getSupplierSettlement: (settlementId, actor) => ipcRenderer.invoke('supply.settlements.get', { settlementId, actor })
    ,listSupplierChargeTypes: (actor) => ipcRenderer.invoke('supply.charges.listTypes', { actor })
    ,addSupplierCharge: (charge, actor) => ipcRenderer.invoke('supply.charges.add', { charge, actor })
    ,listInventoryLots: (productId, locCode, actor) => ipcRenderer.invoke('inventory.lots.list', { productId, locCode, actor })
    ,listInventorySummary: (locCode, actor) => ipcRenderer.invoke('inventory.summary.list', { locCode, actor })
    ,finalizeStockCount: (count, actor) => ipcRenderer.invoke('inventory.counts.finalize', { count, actor })
    ,listAllocationExceptions: (locCode, actor) => ipcRenderer.invoke('inventory.allocations.exceptions', { locCode, actor })
    ,listRecentLotAllocations: (locCode, limit, actor) => ipcRenderer.invoke('inventory.allocations.list', { locCode, limit, actor })
    ,allocateException: (allocation, actor) => ipcRenderer.invoke('inventory.allocations.resolve', { allocation, actor })
    ,reallocateSale: (allocation, actor) => ipcRenderer.invoke('inventory.allocations.reallocate', { allocation, actor })
  },
  pattiyals: {
    list: (filters, actor) => ipcRenderer.invoke('supply.pattiyals.list', { filters, actor }),
    get: (statementId, actor) => ipcRenderer.invoke('supply.pattiyals.get', { statementId, actor }),
    candidates: (filters, actor) => ipcRenderer.invoke('supply.pattiyals.candidates.sales', { filters, actor }),
    candidateGrns: (filters, actor) => ipcRenderer.invoke('supply.pattiyals.candidates.grns', { filters, actor }),
    saveDraft: (statement, actor) => ipcRenderer.invoke('supply.pattiyals.drafts.save', { statement, actor }),
    review: (statementId, userId, actor) => ipcRenderer.invoke('supply.pattiyals.review', { statementId, userId, actor }),
    reopen: (statementId, userId, reason, actor) => ipcRenderer.invoke('supply.pattiyals.reopen', { statementId, userId, reason, actor }),
    finalize: (statementId, userId, actor) => ipcRenderer.invoke('supply.pattiyals.finalize', { statementId, userId, actor }),
    void: (statementId, userId, reason, actor) => ipcRenderer.invoke('supply.pattiyals.void', { statementId, userId, reason, actor }),
    setAttribution: (attribution, actor) => ipcRenderer.invoke('supply.pattiyals.attributions.set', { attribution, actor }),
    exportXlsx: (document, fileName, actor) => ipcRenderer.invoke('supply.pattiyals.export.xlsx', { document, fileName, actor }),
    exportDocx: (document, fileName, actor) => ipcRenderer.invoke('supply.pattiyals.export.docx', { document, fileName, actor })
  },
  billing: {
    openBill: (session, actor) => ipcRenderer.invoke('billing.bill.open', { session, actor }),
    searchInvoices: (filters, actor) => ipcRenderer.invoke('billing.invoices.search', { filters, actor }),
    getInvoice: (invoiceId, actor) => ipcRenderer.invoke('billing.invoices.get', { invoiceId, actor }),
    collectInvoiceBalance: (payload, actor) => ipcRenderer.invoke('billing.invoices.collect', { ...payload, actor }),
    holdBill: (session, actor) => ipcRenderer.invoke('billing.bill.hold', { session, actor }),
    addItem: (bill, item, actor) => ipcRenderer.invoke('billing.bill.addItem', { bill, item, actor }),
    updateItem: (itemId, updates, actor) => ipcRenderer.invoke('billing.bill.updateItem', { itemId, updates, actor }),
    updateCustomer: (bill, actor) => ipcRenderer.invoke('billing.bill.updateCustomer', { bill, actor }),
    removeItem: (itemId, actor) => ipcRenderer.invoke('billing.bill.removeItem', { itemId, actor }),
    getItems: (bill, actor) => ipcRenderer.invoke('billing.bill.getItems', { bill, actor }),
    computeTotals: (bill, actor) => ipcRenderer.invoke('billing.bill.computeTotals', { ...bill, actor }),
    finalize: (payload, actor) => ipcRenderer.invoke('billing.finalize', { ...payload, actor }),
    paymentModes: (actor) => ipcRenderer.invoke('billing.paymentModes', { actor }),
    abandonBill: (bill, actor) => ipcRenderer.invoke('billing.bill.abandon', { bill, actor }),
    recallBills: (locCode, macCode, txnDate, actor) => ipcRenderer.invoke('billing.bill.recallList', { locCode, macCode, txnDate, actor }),
    loadBill: (bill, actor) => ipcRenderer.invoke('billing.bill.load', { bill, actor }),
    lotCandidates: (options, actor) => ipcRenderer.invoke('billing.lots.candidates', { options, actor }),
    rememberLot: (options, actor) => ipcRenderer.invoke('billing.lots.remember', { options, actor }),
    clearRememberedLot: (options, actor) => ipcRenderer.invoke('billing.lots.clearRemembered', { options, actor }),
    setItemLotPriority: (options, actor) => ipcRenderer.invoke('billing.bill.setItemLotPriority', { options, actor }),
    searchProducts: (term, actor) => ipcRenderer.invoke('billing.searchProducts', { term, actor })
  },
  refunds: {
    searchSourceInvoices: (options, actor) => ipcRenderer.invoke('refunds.searchSourceInvoices', { options, actor }),
    getSource: (invoiceId, actor) => ipcRenderer.invoke('refunds.getSource', { invoiceId, actor }),
    createDraft: (draft, actor) => ipcRenderer.invoke('refunds.createDraft', { draft, actor }),
    getDraft: (draftId, actor) => ipcRenderer.invoke('refunds.getDraft', { draftId, actor }),
    listActive: (context, actor) => ipcRenderer.invoke('refunds.listActive', { context, actor }),
    saveItem: (item, actor) => ipcRenderer.invoke('refunds.saveItem', { item, actor }),
    removeItem: (draftId, sourceInvoiceItemId, actor) => ipcRenderer.invoke('refunds.removeItem', { draftId, sourceInvoiceItemId, actor }),
    hold: (draftId, userId, actor) => ipcRenderer.invoke('refunds.hold', { draftId, userId, actor }),
    resume: (draftId, userId, actor) => ipcRenderer.invoke('refunds.resume', { draftId, userId, actor }),
    abandon: (draftId, userId, actor) => ipcRenderer.invoke('refunds.abandon', { draftId, userId, actor }),
    finalize: (refund, actor) => ipcRenderer.invoke('refunds.finalize', { refund, actor })
  },
  cash: {
    activeShift: (sessionId, actor) => ipcRenderer.invoke('cash.activeShift', { sessionId, actor }),
    recoverableShift: (workstationId, userId, actor) => ipcRenderer.invoke('cash.recoverableShift', { workstationId, userId, actor }),
    getShift: (shiftId, actor) => ipcRenderer.invoke('cash.getShift', { shiftId, actor }),
    reportHistory: (shiftId, actor) => ipcRenderer.invoke('cash.reportHistory', { shiftId, actor }),
    archiveReportPrint: (payload, actor) => ipcRenderer.invoke('cash.archiveReportPrint', { ...payload, actor }),
    openShift: (shift, actor) => ipcRenderer.invoke('cash.openShift', { shift, actor }),
    addMovement: (movement, actor) => ipcRenderer.invoke('cash.addMovement', { movement, actor }),
    blindClose: (count, actor) => ipcRenderer.invoke('cash.blindClose', { count, actor }),
    closeShift: (close, actor) => ipcRenderer.invoke('cash.closeShift', { close, actor })
  },
  reports: {
    salesSummary: (actor) => ipcRenderer.invoke('reports.sales.summary', { actor }),
    salesDetail: (filters, actor) => ipcRenderer.invoke('reports.sales.detail', { filters, actor }),
    salesItems: (filters, actor) => ipcRenderer.invoke('reports.sales.items', { filters, actor }),
    supplierSummary: (filters, actor) => ipcRenderer.invoke('reports.suppliers.summary', { filters, actor }),
    inventorySummary: (filters, actor) => ipcRenderer.invoke('reports.inventory.summary', { filters, actor }),
    exportDdecXlsx: (filters, actor) => ipcRenderer.invoke('reports.ddec.exportXlsx', { filters, actor }),
    exportSalesXlsx: (filters, actor) => ipcRenderer.invoke('reports.sales.exportXlsx', { filters, actor })
  },
  fieldInbox: {
    getConfiguration: (actor) => ipcRenderer.invoke('fieldInbox.configuration.get', { actor }),
    saveConfiguration: (configuration, actor) => ipcRenderer.invoke('fieldInbox.configuration.save', { configuration, actor }),
    testConnection: (date, actor) => ipcRenderer.invoke('fieldInbox.configuration.test', { date, actor }),
    listRecords: (date, actor) => ipcRenderer.invoke('fieldInbox.records.list', { date, actor }),
    setResolved: (recordId, clientRecordId, resolved, actor) =>
      ipcRenderer.invoke('fieldInbox.records.resolve', { recordId, clientRecordId, resolved, actor }),
    getMedia: (mediaId, actor) => ipcRenderer.invoke('fieldInbox.media.get', { mediaId, actor })
  },
  cloudSync: {
    getConfiguration: (actor) => ipcRenderer.invoke('cloudSync.configuration.get', { actor }),
    saveConfiguration: (configuration, actor) => ipcRenderer.invoke('cloudSync.configuration.save', { configuration, actor }),
    runNow: (actor) => ipcRenderer.invoke('cloudSync.runNow', { actor }),
    listMobileBills: (since, until, actor) => ipcRenderer.invoke('cloudSync.mobileBills.list', { since, until, actor }),
    setMobileBillStatus: (billId, status, actor) => ipcRenderer.invoke('cloudSync.mobileBills.status', { billId, status, actor })
  },
  users: {
    list: (actor) => ipcRenderer.invoke('users.list', { actor }),
    get: (id, actor) => ipcRenderer.invoke('users.get', { id, actor }),
    create: (payload, actor) => ipcRenderer.invoke('users.create', { ...payload, actor }),
    update: (id, payload, actor) => ipcRenderer.invoke('users.update', { id, ...payload, actor }),
    updatePassword: (id, newPassword, actor) => ipcRenderer.invoke('users.updatePassword', { id, newPassword, actor }),
    delete: (id, actor) => ipcRenderer.invoke('users.delete', { id, actor }),
    setRoles: (userId, roleIds, actor) => ipcRenderer.invoke('users.setRoles', { userId, roleIds, actor })
  },
  roles: {
    list: (actor) => ipcRenderer.invoke('roles.list', { actor }),
    get: (id, actor) => ipcRenderer.invoke('roles.get', { id, actor }),
    create: (payload, actor) => ipcRenderer.invoke('roles.create', { ...payload, actor }),
    update: (id, payload, actor) => ipcRenderer.invoke('roles.update', { id, ...payload, actor }),
    delete: (id, actor) => ipcRenderer.invoke('roles.delete', { id, actor }),
    setPermissions: (roleId, permissionIds, actor) => ipcRenderer.invoke('roles.setPermissions', { roleId, permissionIds, actor })
  },
  permissions: {
    list: (actor) => ipcRenderer.invoke('permissions.list', { actor })
  },
  printing: {
    list: (actor) => ipcRenderer.invoke('printing.list', { actor }),
    defaultGet: (actor) => ipcRenderer.invoke('printing.default.get', { actor }),
    defaultSet: (printerId, actor) => ipcRenderer.invoke('printing.default.set', { printerId, actor }),
    printDocument: (doc, printerId = null, actor) => ipcRenderer.invoke('printing.printDocument', { doc, printerId, actor }),
    printTestPage: (printerId = null, actor) => ipcRenderer.invoke('printing.printTestPage', { printerId, actor }),
    savePdf: (doc, options, actor) => ipcRenderer.invoke('printing.savePdf', { doc, options, actor })
  }
});
