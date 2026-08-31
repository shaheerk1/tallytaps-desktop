function createPrintService({ eventBus }) {
  if (!eventBus) {
    throw new Error('Print service requires eventBus.');
  }

  async function printReceipt(invoice) {
    await eventBus.publishAsync('receipt.printed', {
      invoiceId: invoice.id,
      timestamp: new Date().toISOString()
    });
    return {
      status: 'queued',
      type: 'receipt',
      invoiceId: invoice.id
    };
  }

  return {
    printReceipt
  };
}

module.exports = {
  createPrintService
};
