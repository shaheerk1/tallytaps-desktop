function createCatalogService({ catalogRepository, partyRepository = null, issuedChequeRepository = null }) {
  if (!catalogRepository) {
    throw new Error('Catalog service requires catalogRepository.');
  }

  return {
    listProducts: catalogRepository.listProducts,
    getProduct: catalogRepository.getProduct,
    createProduct: catalogRepository.createProduct,
    updateProduct: catalogRepository.updateProduct,
    deleteProduct: catalogRepository.deleteProduct,
    searchProducts: catalogRepository.searchProducts,
    listProductCategories: catalogRepository.listProductCategories,
    listCustomers: partyRepository ? () => partyRepository.searchCustomerAccounts('') : catalogRepository.listCustomers,
    searchCustomers: partyRepository ? partyRepository.searchCustomerAccounts : catalogRepository.searchCustomers,
    getCustomerAccount: partyRepository ? partyRepository.getCustomerAccount : catalogRepository.getCustomerAccount,
    createCustomer: partyRepository
      ? (payload) => partyRepository.createCustomer(payload, payload?.origin, payload?.userId || null)
      : catalogRepository.createCustomer,
    updateCustomer: partyRepository
      ? (id, payload) => partyRepository.updateCustomer(id, payload, payload?.origin, payload?.userId || null)
      : catalogRepository.updateCustomer,
    resolveCustomer: catalogRepository.resolveCustomer,
    assignInvoiceCustomer: partyRepository ? partyRepository.assignInvoiceCustomer : null,
    listCheques: partyRepository ? partyRepository.listCheques : null,
    getCheque: partyRepository ? partyRepository.getCheque : null,
    updateChequeDetails: partyRepository ? partyRepository.updateChequeDetails : null,
    updateChequeStatus: partyRepository ? partyRepository.updateChequeStatus : null,
    linkCheque: partyRepository ? partyRepository.linkCheque : null,
    listBusinessBankAccounts: issuedChequeRepository ? issuedChequeRepository.listBankAccounts : null,
    saveBusinessBankAccount: issuedChequeRepository ? issuedChequeRepository.saveBankAccount : null,
    listIssuedCheques: issuedChequeRepository ? issuedChequeRepository.listIssuedCheques : null,
    getIssuedCheque: issuedChequeRepository ? issuedChequeRepository.getIssuedCheque : null,
    createIssuedCheque: issuedChequeRepository ? issuedChequeRepository.createIssuedCheque : null,
    updateIssuedChequeStatus: issuedChequeRepository ? issuedChequeRepository.updateIssuedChequeStatus : null,
    listSuppliers: catalogRepository.listSuppliers,
    createSupplier: catalogRepository.createSupplier
    ,saveGoodsReceiptDraft: catalogRepository.saveGoodsReceiptDraft
    ,finalizeGoodsReceiptDraft: catalogRepository.finalizeGoodsReceiptDraft
    ,cancelGoodsReceiptDraft: catalogRepository.cancelGoodsReceiptDraft
    ,createGoodsReceiptCorrection: catalogRepository.createGoodsReceiptCorrection
    ,listGoodsReceipts: catalogRepository.listGoodsReceipts
    ,getGoodsReceipt: catalogRepository.getGoodsReceipt
    ,adjustStock: catalogRepository.adjustStock
    ,listSupplyAgreements: catalogRepository.listSupplyAgreements
    ,createSupplyAgreement: catalogRepository.createSupplyAgreement
    ,getSupplierAccount: catalogRepository.getSupplierAccount
    ,createSupplierSettlement: catalogRepository.createSupplierSettlement
    ,approveSupplierSettlement: catalogRepository.approveSupplierSettlement
    ,recordSupplierPayment: catalogRepository.recordSupplierPayment
    ,listSupplierSettlements: catalogRepository.listSupplierSettlements
    ,getSupplierSettlement: catalogRepository.getSupplierSettlement
    ,listSupplierChargeTypes: catalogRepository.listSupplierChargeTypes
    ,addSupplierCharge: catalogRepository.addSupplierCharge
    ,listInventoryLots: catalogRepository.listInventoryLots
    ,listInventorySummary: catalogRepository.listInventorySummary
    ,finalizeStockCount: catalogRepository.finalizeStockCount
    ,listAllocationExceptions: catalogRepository.listAllocationExceptions
    ,listRecentLotAllocations: catalogRepository.listRecentLotAllocations
    ,allocateException: catalogRepository.allocateException
    ,reallocateSale: catalogRepository.reallocateSale
  };
}

module.exports = {
  createCatalogService
};
