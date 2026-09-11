const { createDatabase } = require('../../../../packages/database/connection/mysql-connection');
const { createMigrationRunner } = require('../../../../packages/database/migration-runner');
const { createSettingsRepository } = require('../../../../packages/database/repositories/settings.repository');
const { createCatalogRepository } = require('../../../../packages/database/repositories/catalog.repository');
const { createPartyRepository } = require('../../../../packages/database/repositories/party.repository');
const { createIssuedChequeRepository } = require('../../../../packages/database/repositories/issued-cheque.repository');
const { createPaymentModeRepository } = require('../../../../packages/database/repositories/payment-mode.repository');
const { createBillingRepository } = require('../../../../packages/database/repositories/billing.repository');
const { createLiveBillRepository } = require('../../../../packages/database/repositories/live-bill.repository');
const { createRefundRepository } = require('../../../../packages/database/repositories/refund.repository');
const { createCashManagementRepository } = require('../../../../packages/database/repositories/cash-management.repository');
const { createAuthRepository } = require('../../../../packages/database/repositories/auth.repository');
const { createWorkstationRepository } = require('../../../../packages/database/repositories/workstation.repository');
const { createUserManagementRepository } = require('../../../../packages/database/repositories/user-management.repository');
const { createPriorityListRepository } = require('../../../../packages/database/repositories/priority-list.repository');
const { createFieldInboxRepository } = require('../../../../packages/database/repositories/field-inbox.repository');
const { createCloudSyncRepository } = require('../../../../packages/database/repositories/cloud-sync.repository');
const { createDocumentSequenceRepository } = require('../../../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../../../packages/database/repositories/business-day.repository');
const { createInventoryLedgerRepository } = require('../../../../packages/database/repositories/inventory-ledger.repository');
const { createSupplierSaleStatementRepository } = require('../../../../packages/database/repositories/supplier-sale-statement.repository');
const { createCustomerAdvanceRepository } = require('../../../../packages/database/repositories/customer-advance.repository');
const { createExpenseRepository } = require('../../../../packages/database/repositories/expense.repository');
const { createJournalRepository } = require('../../../../packages/database/repositories/journal.repository');
const { createLotCostingRepository } = require('../../../../packages/database/repositories/lot-costing.repository');
const { createInventoryIssueRepository } = require('../../../../packages/database/repositories/inventory-issue.repository');
const { createStakeholderRepository } = require('../../../../packages/database/repositories/stakeholder.repository');
const { createOperationalAccountingRepository } = require('../../../../packages/database/repositories/operational-accounting.repository');
const { seedAdminUser } = require('../../../../packages/database/seeders/seed-admin-user');
const { seedDefaultSettings } = require('../../../../packages/database/seeders/seed-default-settings');
const { createAuthService } = require('../../../../packages/core/auth/auth.service');
const { createWorkstationService } = require('../../../../packages/core/workstations/workstation.service');
const { createSettingsService } = require('../../../../packages/core/settings/settings.service');
const { createCatalogService } = require('../../../../packages/core/catalog/catalog.service');
const { createPaymentModeRegistry } = require('../../../../packages/core/payments/payment-mode-registry');
const { createBillingEngineService } = require('../../../../packages/core/billing/billing-engine.service');
const { createRefundService } = require('../../../../packages/core/refunds/refund.service');
const { createCashManagementService } = require('../../../../packages/core/cash-management/cash-management.service');
const { createPrintService } = require('../../../../packages/core/printing/print.service');
const { createEscposPrinterService } = require('../../../../packages/core/printing/escpos-printer.service');
const { createPdfDocumentService } = require('../../../../packages/core/printing/pdf-document.service');
const { createSupplierSalesStatementExportService } = require('../../../../packages/core/printing/supplier-sales-statement-export.service');
const { createReceiptRasterService } = require('../../../../packages/core/printing/receipt-raster.service');
const { createReportService } = require('../../../../packages/core/reports/report.service');
const { createEventBus } = require('../../../../packages/core/events/event-bus');
const { createCoreHealthService } = require('../../../../packages/core/health/core-health.service');
const { createDatabaseHealthService } = require('../../../../packages/core/health/database-health.service');
const { createUserManagementService } = require('../../../../packages/core/user-management/user-management.service');
const { createPriorityListService } = require('../../../../packages/core/priority-lists/priority-list.service');
const { createIpcAuthorizationService } = require('../../../../packages/core/security/ipc-authorization.service');
const { createSessionContextService } = require('../../../../packages/core/security/session-context.service');
const requestContext = require('../../../../packages/core/security/request-context');
const { createFieldInboxService } = require('../../../../packages/core/field-inbox/field-inbox.service');
const { createCloudSyncService } = require('../../../../packages/core/cloud-sync/cloud-sync.service');
const { createCloudSyncScheduler } = require('../../../../packages/core/cloud-sync/cloud-sync.scheduler');
const { createBusinessDayService } = require('../../../../packages/core/business-days/business-day.service');
const { createSupplierSaleStatementService } = require('../../../../packages/core/supplier-sale-statements/supplier-sale-statement.service');
const { createCustomerAdvanceService } = require('../../../../packages/core/customer-advances/customer-advance.service');
const { createExpenseService } = require('../../../../packages/core/expenses/expense.service');
const { createLotCostingService } = require('../../../../packages/core/lot-costing/lot-costing.service');
const { createInventoryIssueService } = require('../../../../packages/core/inventory-issues/inventory-issue.service');
const { createStakeholderService } = require('../../../../packages/core/stakeholders/stakeholder.service');
const { createAccountingService } = require('../../../../packages/core/accounting/accounting.service');
const { safeStorage } = require('electron');

function createSecretProtector() {
  function ensureAvailable() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is not available on this computer.');
    }
  }

  return {
    encrypt(value) {
      ensureAvailable();
      return safeStorage.encryptString(String(value)).toString('base64');
    },
    decrypt(ciphertext) {
      ensureAvailable();
      try {
        return safeStorage.decryptString(Buffer.from(String(ciphertext), 'base64'));
      } catch {
        throw new Error('A saved cloud credential cannot be decrypted. Save the connection again in Settings.');
      }
    }
  };
}

async function createServiceContainer() {
  const database = createDatabase();
  const migrationRunner = await createMigrationRunner({ database });
  await migrationRunner.runPending();

  const settingsRepository = createSettingsRepository({ database });
  const documentSequenceRepository = createDocumentSequenceRepository({ database });
  const businessDayRepository = createBusinessDayRepository({ database });
  const inventoryLedgerRepository = createInventoryLedgerRepository({ database });
  const issuedChequeRepository = createIssuedChequeRepository({ database, documentSequenceRepository, businessDayRepository });
  const catalogRepository = createCatalogRepository({ database, documentSequenceRepository, businessDayRepository, issuedChequeRepository, inventoryLedgerRepository });
  const partyRepository = createPartyRepository({ database, businessDayRepository });
  const paymentModeRepository = createPaymentModeRepository({ database });
  const customerAdvanceRepository = createCustomerAdvanceRepository({ database, documentSequenceRepository, businessDayRepository });
  const billingRepository = createBillingRepository({ database, businessDayRepository, documentSequenceRepository, inventoryLedgerRepository, customerAdvanceRepository });
  const liveBillRepository = createLiveBillRepository({ database, documentSequenceRepository, businessDayRepository });
  const refundRepository = createRefundRepository({ database, documentSequenceRepository, businessDayRepository, inventoryLedgerRepository, customerAdvanceRepository });
  const cashManagementRepository = createCashManagementRepository({ database, documentSequenceRepository, businessDayRepository });
  const authRepository = createAuthRepository({ database });
  const workstationRepository = createWorkstationRepository({ database, businessDayRepository });
  const userManagementRepository = createUserManagementRepository({ database });
  const priorityListRepository = createPriorityListRepository({ database });
  const fieldInboxRepository = createFieldInboxRepository({ database });
  const cloudSyncRepository = createCloudSyncRepository({ database });
  const supplierSaleStatementRepository = createSupplierSaleStatementRepository({ database, documentSequenceRepository, businessDayRepository });
  // The journal is created first: every money-side repository posts through it
  // inside the same transaction as the business event it records.
  const journalRepository = createJournalRepository({ database, documentSequenceRepository });
  // Costing comes first: reversing an expense takes its cost back off goods.
  const lotCostingRepository = createLotCostingRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
  const expenseRepository = createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, lotCostingRepository });
  const inventoryIssueRepository = createInventoryIssueRepository({ database, documentSequenceRepository, businessDayRepository, inventoryLedgerRepository });
  const stakeholderRepository = createStakeholderRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, expenseRepository });
  const operationalAccountingRepository = createOperationalAccountingRepository({ database, journalRepository });

  const eventBus = createEventBus();
  const ipcAuthorizationService = createIpcAuthorizationService();
  const sessionContextService = createSessionContextService({ authRepository });
  const paymentModes = createPaymentModeRegistry();
  paymentModes.replaceConfigured(await paymentModeRepository.listModes());

  const authService = createAuthService({
    authRepository,
    seedAdminUser: async () => seedAdminUser(database),
    seedDefaultSettings: async () => seedDefaultSettings(database)
  });
  const businessDayService = createBusinessDayService({ businessDayRepository });
  const workstationService = createWorkstationService({ workstationRepository, settingsRepository, businessDayService });
  const settingsService = createSettingsService({ settingsRepository });
  const catalogService = createCatalogService({ catalogRepository, partyRepository, issuedChequeRepository });
  const cashManagementService = createCashManagementService({ cashManagementRepository });
  const billingEngineService = createBillingEngineService({
    liveBillRepository,
    billingRepository,
    catalogRepository,
    partyRepository,
    workstationRepository,
    paymentModes,
    paymentModeRepository,
    eventBus,
    cashManagementService,
    customerAdvanceRepository
  });
  const customerAdvanceService = createCustomerAdvanceService({ repository: customerAdvanceRepository, paymentModes, paymentModeRepository, cashManagementService });
  const refundService = createRefundService({ refundRepository, paymentModes, paymentModeRepository, eventBus, cashManagementService });
  const printService = createPrintService({ eventBus });
  const receiptRasterService = createReceiptRasterService();
  const printerService = createEscposPrinterService({ settingsService, eventBus, receiptRasterService });
  const pdfDocumentService = createPdfDocumentService({ settingsService, receiptRasterService });
  const supplierSalesStatementExportService = createSupplierSalesStatementExportService();
  const reportService = createReportService({ database });
  const userManagementService = createUserManagementService({ userManagementRepository });
  const priorityListService = createPriorityListService({ priorityListRepository, userManagementRepository });
  const secretProtector = createSecretProtector();
  const fieldInboxService = createFieldInboxService({
    fieldInboxRepository,
    cloudSyncRepository,
    secretProtector
  });
  const cloudSyncService = createCloudSyncService({ repository: cloudSyncRepository, secretProtector });
  const cloudSyncScheduler = createCloudSyncScheduler({ service: cloudSyncService });
  const supplierSaleStatementService = createSupplierSaleStatementService({ repository: supplierSaleStatementRepository });
  const expenseService = createExpenseService({ expenseRepository });
  const lotCostingService = createLotCostingService({ lotCostingRepository });
  const inventoryIssueService = createInventoryIssueService({ inventoryIssueRepository, expenseRepository, lotCostingRepository });
  const stakeholderService = createStakeholderService({ stakeholderRepository });
  const accountingService = createAccountingService({ journalRepository, operationalAccountingRepository, lotCostingRepository });

  return {
    database,
    migrationRunner,
    settingsRepository,
    catalogRepository,
    partyRepository,
    issuedChequeRepository,
    paymentModeRepository,
    supplierSaleStatementRepository,
    customerAdvanceRepository,
    expenseRepository,
    journalRepository,
    lotCostingRepository,
    inventoryIssueRepository,
    stakeholderRepository,
    operationalAccountingRepository,
    billingRepository,
    liveBillRepository,
    refundRepository,
    cashManagementRepository,
    authRepository,
    workstationRepository,
    userManagementRepository,
    priorityListRepository,
    fieldInboxRepository,
    cloudSyncRepository,
    ipcAuthorizationService,
    sessionContextService,
    requestContext,
    authService,
    workstationService,
    settingsService,
    catalogService,
    supplierSaleStatementService,
    customerAdvanceService,
    expenseService,
    lotCostingService,
    inventoryIssueService,
    stakeholderService,
    accountingService,
    billingEngineService,
    refundService,
    cashManagementService,
    printService,
    receiptRasterService,
    printerService,
    pdfDocumentService,
    supplierSalesStatementExportService,
    reportService,
    userManagementService,
    priorityListService,
    fieldInboxService,
    cloudSyncService,
    cloudSyncScheduler,
    businessDayService,
    inventoryLedgerRepository,
    paymentModes,
    eventBus,
    coreHealthService: createCoreHealthService(),
    databaseHealthService: createDatabaseHealthService({ database })
  };
}

module.exports = { createServiceContainer };
