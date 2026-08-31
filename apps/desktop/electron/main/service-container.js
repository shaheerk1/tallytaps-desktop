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
const { createDocumentSequenceRepository } = require('../../../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../../../packages/database/repositories/business-day.repository');
const { createSupplierSaleStatementRepository } = require('../../../../packages/database/repositories/supplier-sale-statement.repository');
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
const { createFieldInboxService } = require('../../../../packages/core/field-inbox/field-inbox.service');
const { createBusinessDayService } = require('../../../../packages/core/business-days/business-day.service');
const { createSupplierSaleStatementService } = require('../../../../packages/core/supplier-sale-statements/supplier-sale-statement.service');
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
        throw new Error('The saved transaction inbox API key cannot be decrypted. Save it again in Settings.');
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
  const issuedChequeRepository = createIssuedChequeRepository({ database, documentSequenceRepository, businessDayRepository });
  const catalogRepository = createCatalogRepository({ database, documentSequenceRepository, businessDayRepository, issuedChequeRepository });
  const partyRepository = createPartyRepository({ database, businessDayRepository });
  const paymentModeRepository = createPaymentModeRepository({ database });
  const billingRepository = createBillingRepository({ database, businessDayRepository, documentSequenceRepository });
  const liveBillRepository = createLiveBillRepository({ database, documentSequenceRepository, businessDayRepository });
  const refundRepository = createRefundRepository({ database, documentSequenceRepository, businessDayRepository });
  const cashManagementRepository = createCashManagementRepository({ database, documentSequenceRepository, businessDayRepository });
  const authRepository = createAuthRepository({ database });
  const workstationRepository = createWorkstationRepository({ database, businessDayRepository });
  const userManagementRepository = createUserManagementRepository({ database });
  const priorityListRepository = createPriorityListRepository({ database });
  const fieldInboxRepository = createFieldInboxRepository({ database });
  const supplierSaleStatementRepository = createSupplierSaleStatementRepository({ database, documentSequenceRepository, businessDayRepository });

  const eventBus = createEventBus();
  const ipcAuthorizationService = createIpcAuthorizationService();
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
    cashManagementService
  });
  const refundService = createRefundService({ refundRepository, paymentModes, paymentModeRepository, eventBus, cashManagementService });
  const printService = createPrintService({ eventBus });
  const receiptRasterService = createReceiptRasterService();
  const printerService = createEscposPrinterService({ settingsService, eventBus, receiptRasterService });
  const pdfDocumentService = createPdfDocumentService({ settingsService, receiptRasterService });
  const supplierSalesStatementExportService = createSupplierSalesStatementExportService();
  const reportService = createReportService({ database });
  const userManagementService = createUserManagementService({ userManagementRepository });
  const priorityListService = createPriorityListService({ priorityListRepository, userManagementRepository });
  const fieldInboxService = createFieldInboxService({
    fieldInboxRepository,
    documentSequenceRepository,
    secretProtector: createSecretProtector()
  });
  const supplierSaleStatementService = createSupplierSaleStatementService({ repository: supplierSaleStatementRepository });

  return {
    database,
    migrationRunner,
    settingsRepository,
    catalogRepository,
    partyRepository,
    issuedChequeRepository,
    paymentModeRepository,
    supplierSaleStatementRepository,
    billingRepository,
    liveBillRepository,
    refundRepository,
    cashManagementRepository,
    authRepository,
    workstationRepository,
    userManagementRepository,
    priorityListRepository,
    fieldInboxRepository,
    ipcAuthorizationService,
    authService,
    workstationService,
    settingsService,
    catalogService,
    supplierSaleStatementService,
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
    businessDayService,
    paymentModes,
    eventBus,
    coreHealthService: createCoreHealthService(),
    databaseHealthService: createDatabaseHealthService({ database })
  };
}

module.exports = { createServiceContainer };
