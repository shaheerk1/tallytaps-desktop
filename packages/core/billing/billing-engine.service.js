function createBillingEngineService({
  liveBillRepository,
  billingRepository,
  catalogRepository,
  partyRepository,
  workstationRepository,
  paymentModes,
  paymentModeRepository,
  eventBus,
  cashManagementService
}) {
  if (!liveBillRepository) {
    throw new Error('Billing engine requires liveBillRepository.');
  }
  if (!billingRepository) {
    throw new Error('Billing engine requires billingRepository.');
  }
  if (!catalogRepository) {
    throw new Error('Billing engine requires catalogRepository.');
  }
  if (!workstationRepository) {
    throw new Error('Billing engine requires workstationRepository.');
  }
  if (!paymentModes) {
    throw new Error('Billing engine requires paymentModes.');
  }

  function toMoney(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  async function refreshPaymentModes() {
    if (!paymentModeRepository) return;
    paymentModes.replaceConfigured(await paymentModeRepository.listModes());
  }

  function optionalChequeText(value, label, maxLength) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (text.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters.`);
    return text;
  }

  function normalizeChequeDetails(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const date = optionalChequeText(source.date, 'Cheque date', 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Cheque date must use YYYY-MM-DD format.');
    }
    const details = {
      number: optionalChequeText(source.number, 'Cheque number', 80),
      date,
      bankName: optionalChequeText(source.bankName, 'Bank name', 160),
      branchName: optionalChequeText(source.branchName, 'Branch name', 160),
      drawerName: optionalChequeText(source.drawerName, 'Drawer name', 160),
      drawerPartyId: Number.isInteger(Number(source.drawerPartyId)) && Number(source.drawerPartyId) > 0
        ? Number(source.drawerPartyId)
        : null,
      accountReference: optionalChequeText(source.accountReference, 'Account reference', 100),
      notes: optionalChequeText(source.notes, 'Cheque notes', 255)
    };
    return Object.values(details).some(Boolean) ? details : null;
  }

  async function resolvePriceOverride(productId, unitPrice, actorId) {
    if (!productId) return null;
    const product = await catalogRepository.getProduct(productId);
    if (!product) return null;
    const masterPrice = Number(product.unit_price || 0);
    if (Math.abs(masterPrice - unitPrice) < 0.005) return null;
    // DDEC spot-priced products intentionally start at zero in the master.
    // Their actual rate is entered by the cashier for each sale.
    if (masterPrice === 0) {
      return { masterPrice, enteredPrice: unitPrice, changedBy: actorId || null, changedAt: new Date().toISOString() };
    }
    if (!product.price_override_allowed) throw new Error(`Price changes are not allowed for ${product.name}.`);
    if (product.minimum_sell_price != null && unitPrice + 0.005 < Number(product.minimum_sell_price)) throw new Error(`Price cannot be below ${Number(product.minimum_sell_price).toFixed(2)} for ${product.name}.`);
    if (product.maximum_sell_price != null && unitPrice - 0.005 > Number(product.maximum_sell_price)) throw new Error(`Price cannot exceed ${Number(product.maximum_sell_price).toFixed(2)} for ${product.name}.`);
    return { masterPrice, enteredPrice: unitPrice, changedBy: actorId || null, changedAt: new Date().toISOString() };
  }

  /**
   * Validate and normalize the payment list against the payment mode registry.
   *
   * Rules:
   *   - every method must be a registered payment mode
   *   - tender (cash/card/...) reduces the balance; change is only produced by
   *     tender overpayment and never mixed with a credit payment
   *   - a credit mode (e.g. Pending) must exactly cover the unpaid balance —
   *     this is how receipts complete with a borrowed/outstanding amount
   */
  function buildValidatedPayments(paymentList, grandTotal) {
    const list = paymentList || [];
    if (list.length === 0) {
      throw new Error('At least one payment is required to finalize a bill.');
    }

    const normalized = list.map((p) => {
      const method = String(p.method || 'cash').toLowerCase();
      const mode = paymentModes.getMode(method);
      if (!mode) {
        throw new Error(`Unknown payment mode "${p.method}".`);
      }
      const chequeDetails = method === 'cheque' ? normalizeChequeDetails(p.chequeDetails) : null;
      return {
        method,
        amount: toMoney(p.amount || 0),
        chequeDetails,
        providerRef: method === 'cheque'
          ? chequeDetails?.number || p.providerRef || null
          : p.providerRef || null,
        type: mode.type
      };
    });

    const tenderTotal = toMoney(
      normalized.filter((p) => p.type === 'tender').reduce((s, p) => s + p.amount, 0)
    );
    const creditTotal = toMoney(
      normalized.filter((p) => p.type === 'credit').reduce((s, p) => s + p.amount, 0)
    );

    if (creditTotal > 0) {
      const shortfall = toMoney(Math.max(grandTotal - tenderTotal, 0));
      if (tenderTotal >= grandTotal) {
        throw new Error('A credit/pending payment cannot be used when tender already covers the total.');
      }
      if (Math.abs(creditTotal - shortfall) > 0.005) {
        throw new Error(`Pending/credit amount must equal the unpaid balance (${shortfall.toFixed(2)}).`);
      }
    } else if (tenderTotal < grandTotal) {
      const shortfall = toMoney(grandTotal - tenderTotal);
      throw new Error(
        `Unpaid balance of ${shortfall.toFixed(2)} — add a Pending/credit payment or tender the full amount.`
      );
    }

    return normalized;
  }

  function billContext(sessionInfo) {
    return {
      sessionId: sessionInfo?.sessionId,
      receiptNo: sessionInfo?.receiptNo,
      locCode: sessionInfo?.locationCode || sessionInfo?.locCode,
      macCode: sessionInfo?.machineCode || sessionInfo?.macCode,
      txnDate: sessionInfo?.billingDate || sessionInfo?.txnDate,
      userId: sessionInfo?.userId
    };
  }

  function calculateLineAmounts({ unitPrice, qty, kilos, pricingBasis = 'qty', discount, tax, bagChargeRate = 0, wageChargeRate = 0, wageBasis = 'none' }) {
    const normalizedQty = Number(qty || 0);
    const normalizedKilos = Number.isFinite(Number(kilos)) && Number(kilos) > 0 ? Number(kilos) : 0;
    const measure = pricingBasis === 'kilos' ? normalizedKilos : normalizedQty;
    const merchandiseTotal = toMoney(Number(unitPrice || 0) * measure);
    const bagChargeTotal = toMoney(Number(bagChargeRate || 0) * normalizedQty);
    const wageChargeTotal = toMoney(Number(wageChargeRate || 0) * (wageBasis === 'kilos' ? normalizedKilos : wageBasis === 'qty' ? normalizedQty : 0));
    return {
      merchandiseTotal,
      bagChargeTotal,
      wageChargeTotal,
      total: toMoney(merchandiseTotal - Number(discount || 0) + Number(tax || 0) + bagChargeTotal + wageChargeTotal)
    };
  }

  // ── Bill lifecycle ─────────────────────────────────────

  /**
   * Open a fresh bill for the workstation session.
   *
   * A fresh receipt number is always allocated — mirroring MAX(receiptno) + 1
   * from the reference. Held bills are NOT auto-resumed here; they are only
   * reachable via recall. Numbers stay consumed via the session counter.
   */
  async function openBill(sessionInfo) {
    if (!sessionInfo?.sessionId) {
      throw new Error('openBill requires a valid workstation session.');
    }

    const ctx = billContext(sessionInfo);
    const receiptNo = await liveBillRepository.allocateNextReceiptNo({
      locCode: ctx.locCode,
      macCode: ctx.macCode,
      txnDate: ctx.txnDate,
      sessionId: ctx.sessionId
    });
    await liveBillRepository.updateSessionCurrentReceipt(ctx.sessionId, receiptNo);

    return {
      sessionId: ctx.sessionId,
      receiptNo,
      locCode: ctx.locCode,
      macCode: ctx.macCode,
      txnDate: ctx.txnDate,
      userId: ctx.userId,
      items: [],
      billHeader: {}
    };
  }

  /**
   * Hold the current bill (it stays held via invoice_id = NULL) and start a
   * fresh bill with the next receipt number. Nothing is written on hold — the
   * new receipt number is just allocated and persisted on the session.
   */
  async function holdBill(sessionInfo) {
    if (!sessionInfo?.sessionId) {
      throw new Error('holdBill requires a valid workstation session.');
    }
    const ctx = billContext(sessionInfo);
    const receiptNo = await liveBillRepository.allocateNextReceiptNo({
      locCode: ctx.locCode,
      macCode: ctx.macCode,
      txnDate: ctx.txnDate,
      sessionId: ctx.sessionId
    });
    await liveBillRepository.updateSessionCurrentReceipt(ctx.sessionId, receiptNo);

    return {
      sessionId: ctx.sessionId,
      receiptNo,
      locCode: ctx.locCode,
      macCode: ctx.macCode,
      txnDate: ctx.txnDate,
      userId: ctx.userId,
      items: [],
      billHeader: {}
    };
  }

  // ── Item operations ─────────────────────────────────────

  /**
   * Add an item to the current bill. Saves to DB in real-time under the bill's
   * receipt number (invoice_id stays NULL until finalize).
   */
  async function addItem(bill, item) {
    if (!bill?.sessionId || !bill?.receiptNo) {
      throw new Error('addItem requires a bill context (sessionId + receiptNo).');
    }
    if (!item?.itemCode || !item?.description) {
      throw new Error('itemCode and description are required.');
    }

    const customerCode = String(bill.customerCode || '').trim().toUpperCase();
    const supplierCode = String(item.supplierCode || '').trim().toUpperCase();
    if (!customerCode) throw new Error('Customer code is required.');
    if (!supplierCode) throw new Error('Supplier code is required.');
    const qty = item.qty === undefined || item.qty === null ? 1 : Number(item.qty);
    const product = item.productId ? await catalogRepository.getProduct(item.productId) : null;
    if (!product) throw new Error('Select an active DDEC item before adding it to the bill.');
    const kilos = Number(item.kilos);
    const pricingBasis = product.pricing_basis === 'kilos' ? 'kilos' : 'qty';
    const requiresKilos = pricingBasis === 'kilos' || Boolean(product.requires_kilos);
    const allowZeroQuantity = Boolean(product.allow_zero_quantity);
    if (!Number.isFinite(qty) || qty < 0) throw new Error('Quantity cannot be negative.');
    if (qty === 0 && !allowZeroQuantity) throw new Error(`${product.name} does not allow zero quantity.`);
    if (requiresKilos && (!Number.isFinite(kilos) || kilos <= 0)) {
      throw new Error(`${product.name} requires the measured kilos.`);
    }
    if (qty <= 0 && (!Number.isFinite(kilos) || kilos <= 0)) {
      throw new Error('Enter a positive quantity or kilos before adding the item.');
    }
    const unitPrice = Number(item.unitPrice || 0);
    const priceOverrideSnapshot = await resolvePriceOverride(item.productId, unitPrice, bill?.userId);
    const discount = Number(item.discount || 0);
    const tax = Number(item.tax || 0);
    const calculated = calculateLineAmounts({
      unitPrice, qty, kilos, pricingBasis, discount, tax,
      bagChargeRate: product.bag_charge,
      wageChargeRate: product.wage_charge,
      wageBasis: product.wage_basis
    });

    const ctx = billContext(bill);
    return liveBillRepository.addItem({
      sessionId: ctx.sessionId,
      receiptNo: ctx.receiptNo,
      locCode: ctx.locCode,
      macCode: ctx.macCode,
      txnDate: ctx.txnDate,
      userId: ctx.userId,
      customerCode,
      customerAccountId: bill.customerAccountId || null,
      productId: item.productId || null,
      supplierCode,
      itemCode: item.itemCode,
      description: item.description,
      qty,
      kilos: Number.isFinite(kilos) && kilos > 0 ? kilos : null,
      handlingUom: product.handling_uom || 'qty',
      baseUom: product.base_uom || null,
      requiresKilos,
      pricingBasis,
      quantityStep: Number(product.quantity_step || 1),
      allowZeroQuantity,
      unitPrice,
      discount,
      tax,
      merchandiseTotal: calculated.merchandiseTotal,
      bagChargeRate: Number(product.bag_charge || 0),
      bagChargeTotal: calculated.bagChargeTotal,
      wageChargeRate: Number(product.wage_charge || 0),
      wageBasis: product.wage_basis || 'none',
      wageChargeTotal: calculated.wageChargeTotal,
      total: calculated.total,
      metadata: {},
      priceOverrideSnapshot
    });
  }

  /**
   * Update a live item (e.g., change qty → recalculate total). Unspecified
   * fields keep their stored values; hooks receive the full merged item.
   */
  async function updateItem(itemId, updates) {
    if (!itemId) throw new Error('itemId is required.');

    const existing = await liveBillRepository.getItemById(itemId);
    if (!existing) {
      throw new Error('Live item not found.');
    }

    const qty = Number(updates.qty !== undefined ? updates.qty : existing.qty);
    const kilos = updates.kilos !== undefined ? Number(updates.kilos) : Number(existing.kilos);
    const unitPrice = Number(updates.unitPrice !== undefined ? updates.unitPrice : existing.unitPrice);
    const priceOverrideSnapshot = updates.unitPrice !== undefined
      ? await resolvePriceOverride(existing.productId, unitPrice, updates.actorId)
      : existing.priceOverrideSnapshot;
    const discount = Number(updates.discount !== undefined ? updates.discount : existing.discount);
    const tax = Number(updates.tax !== undefined ? updates.tax : existing.tax);
    if (!Number.isFinite(qty) || qty < 0) throw new Error('Quantity cannot be negative.');
    if (qty === 0 && !existing.allowZeroQuantity) throw new Error(`${existing.description} does not allow zero quantity.`);
    if (existing.requiresKilos && (!Number.isFinite(kilos) || kilos <= 0)) {
      throw new Error(`${existing.description} requires the measured kilos.`);
    }
    if (qty <= 0 && (!Number.isFinite(kilos) || kilos <= 0)) throw new Error('Enter a positive quantity or kilos before saving the item.');
    const calculated = calculateLineAmounts({ unitPrice, qty, kilos, pricingBasis: existing.pricingBasis, discount, tax, bagChargeRate: existing.bagChargeRate, wageChargeRate: existing.wageChargeRate, wageBasis: existing.wageBasis });

    return liveBillRepository.updateItem({
      itemId, qty, kilos: Number.isFinite(kilos) && kilos > 0 ? kilos : null, unitPrice, discount, tax,
      pricingBasis: existing.pricingBasis, quantityStep: existing.quantityStep, allowZeroQuantity: existing.allowZeroQuantity,
      merchandiseTotal: calculated.merchandiseTotal, bagChargeRate: existing.bagChargeRate, bagChargeTotal: calculated.bagChargeTotal,
      wageChargeRate: existing.wageChargeRate, wageBasis: existing.wageBasis, wageChargeTotal: calculated.wageChargeTotal,
      total: calculated.total, metadata: {}, priceOverrideSnapshot
    });
  }

  /**
   * Remove a live item from the current bill.
   */
  async function removeItem(itemId) {
    if (!itemId) throw new Error('itemId is required.');
    return liveBillRepository.removeItem(itemId);
  }

  async function updateBillCustomerCode({ locCode, macCode, txnDate, receiptNo, customerCode, customerAccountId = null }) {
    const normalized = String(customerCode || '').trim().toUpperCase();
    if (!normalized) throw new Error('Customer code is required.');
    if (!locCode || !macCode || !txnDate || !receiptNo) throw new Error('A valid bill context is required.');
    if (customerAccountId) {
      const account = partyRepository ? await partyRepository.getCustomerAccount(customerAccountId) : null;
      if (!account || account.customer?.status !== 'active') throw new Error('Select an active customer account.');
    }
    await liveBillRepository.updateBillCustomer({ locCode, macCode, txnDate, receiptNo, customerCode: normalized, customerAccountId });
    return { customerCode: normalized, customerAccountId: customerAccountId || null };
  }

  /**
   * Get all items for a bill (by receipt).
   */
  async function getItems(receiptContext) {
    return liveBillRepository.getItemsByReceipt({
      locCode: receiptContext?.locCode,
      macCode: receiptContext?.macCode,
      txnDate: receiptContext?.txnDate,
      receiptNo: receiptContext?.receiptNo
    });
  }

  // ── Finalize ────────────────────────────────────────────

  /**
   * Finalize a bill: create the invoices master + payments and backfill the
   * live items. The session's receipt counter advances to the next number.
   */
  async function finalizeBill({ locCode, macCode, txnDate, receiptNo, sessionId, payments, userId, customerCode = '', customerAccountId = null }) {
    if (!locCode || !macCode || !txnDate || !receiptNo) {
      throw new Error('finalizeBill requires a bill context (locCode, macCode, txnDate, receiptNo).');
    }

    const items = await liveBillRepository.getItemsByReceipt({ locCode, macCode, txnDate, receiptNo });
    const paymentList = payments || [{ method: 'cash', amount: 0 }];
    const subtotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.merchandiseTotal), 0));
    const bagChargeTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.bagChargeTotal), 0));
    const wageChargeTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.wageChargeTotal), 0));
    const discountTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.discount || 0), 0));
    const grandTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.total), 0));

    const effectiveGrandTotal = grandTotal;

    await refreshPaymentModes();
    const validatedPayments = buildValidatedPayments(paymentList, effectiveGrandTotal);
    const pendingAmount = toMoney(validatedPayments
      .filter((payment) => payment.type === 'credit')
      .reduce((sum, payment) => sum + toMoney(payment.amount), 0));
    let resolvedCustomerAccountId = customerAccountId == null ? null : Number(customerAccountId);
    const customerIdentity = String(customerCode || '').trim().toUpperCase();
    if (!customerIdentity) throw new Error('Customer code is required before completion.');
    let selectedAccount = null;
    if (resolvedCustomerAccountId) {
      selectedAccount = partyRepository ? await partyRepository.getCustomerAccount(resolvedCustomerAccountId) : null;
      if (!selectedAccount || selectedAccount.customer?.status !== 'active') throw new Error('Select an active customer account.');
    }
    const hasCheque = validatedPayments.some((payment) => payment.method === 'cheque');
    if ((pendingAmount > 0 || hasCheque) && !resolvedCustomerAccountId) {
      throw new Error(hasCheque
        ? 'Link a real customer account before accepting a cheque.'
        : 'Link a real customer account before recording a pending/credit balance.');
    }
    if (pendingAmount > 0 && !selectedAccount?.customer?.creditEnabled) {
      throw new Error('Credit is not enabled for the selected customer account.');
    }
    const creditLimit = selectedAccount?.customer?.creditLimit;
    const exposureAfterSale = toMoney(Number(selectedAccount?.customer?.totalExposure || 0) + pendingAmount);
    if (pendingAmount > 0 && creditLimit != null && exposureAfterSale > toMoney(creditLimit) + 0.005) {
      throw new Error(`This sale would exceed the customer credit limit of ${toMoney(creditLimit).toFixed(2)}.`);
    }

    // The desktop container always provides cash management. Keep legacy
    // programmatic callers compatible while they migrate to cash shifts.
    const cashLedger = cashManagementService
      ? await cashManagementService.prepareSale({ sessionId, userId, payments: validatedPayments, grandTotal: effectiveGrandTotal })
      : { cashShiftId: null, movements: [] };
    const result = await billingRepository.finalizeInvoice({
      locCode, macCode, txnDate, receiptNo, sessionId, userId,
      payments: validatedPayments,
      cashShiftId: cashLedger.cashShiftId,
      cashMovements: cashLedger.movements,
      customerAccountId: resolvedCustomerAccountId,
      customerCode: customerIdentity,
      receivableSaleDebt: pendingAmount,
      itemMetadata: {},
      invoiceMetadata: {},
      grandTotalOverride: effectiveGrandTotal,
      subtotalOverride: subtotal,
      bagChargeTotalOverride: bagChargeTotal,
      wageChargeTotalOverride: wageChargeTotal
    });

    // Advance the session's receipt counter (allocation stays monotonic).
    const nextReceiptNo = await liveBillRepository.allocateNextReceiptNo({
      locCode, macCode, txnDate, sessionId
    });
    if (sessionId) {
      await liveBillRepository.updateSessionCurrentReceipt(sessionId, receiptNo);
    }

    if (eventBus) {
      await eventBus.publishAsync('billing.finalized', {
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        receiptNo,
        txnDate,
        nextReceiptNo
      });
    }

    return {
      ...result,
      nextReceiptNo
    };
  }

  // ── Live totals ──────────────────────────────────────────

  /**
   * Compute the authoritative bill totals for the renderer so the payment UI
   * (gross/net/grand totals) shows the same numbers that finalize will persist.
   */
  async function computeTotals({ locCode, macCode, txnDate, receiptNo }) {
    if (!locCode || !macCode || !txnDate || !receiptNo) {
      throw new Error('computeTotals requires a bill context (locCode, macCode, txnDate, receiptNo).');
    }
    const items = await liveBillRepository.getItemsByReceipt({ locCode, macCode, txnDate, receiptNo });
    const grossTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.merchandiseTotal), 0));
    const discountTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.discount || 0), 0));
    const netTotal = toMoney(items.reduce((sum, item) => sum + toMoney(item.total), 0));

    return {
      grossTotal,
      discountTotal,
      netTotal,
      grandTotal: netTotal,
      totals: {
        merchandiseTotal: grossTotal,
        bagChargeTotal: toMoney(items.reduce((sum, item) => sum + toMoney(item.bagChargeTotal), 0)),
        wageChargeTotal: toMoney(items.reduce((sum, item) => sum + toMoney(item.wageChargeTotal), 0))
      }
    };
  }

  /** Gross merchandise value before discounts and tax. */
  async function calculateGrossTotal(items) {
    let grossTotal = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const unitPrice = Number(item.unitPrice !== undefined ? item.unitPrice : item.unit_price || 0);
      const discount = Number(item.discount || 0);
      const tax = Number(item.tax || 0);
      const calculated = calculateLineAmounts({ unitPrice, qty: item.qty, kilos: item.kilos, pricingBasis: item.pricingBasis, discount, tax });
      grossTotal += toMoney(calculated.merchandiseTotal);
    }
    return toMoney(grossTotal);
  }

  // ── Hold / Abandon / Recall ─────────────────────────────

  /**
   * Permanently abandon a held bill (deletes its live items). Numbers stay
   * consumed via the session counter.
   */
  async function abandonBill({ locCode, macCode, txnDate, receiptNo }) {
    if (!locCode || !macCode || !txnDate || !receiptNo) {
      throw new Error('abandonBill requires locCode, macCode, txnDate and receiptNo.');
    }
    return liveBillRepository.abandonBill({ locCode, macCode, txnDate, receiptNo });
  }

  /**
   * List held (unfinalized) bills for recall.
   */
  async function recallBills({ locCode, macCode, txnDate }) {
    return liveBillRepository.listHeldBills({ locCode, macCode, txnDate });
  }

  /**
   * Load a held bill's items (for recall).
   */
  async function loadBill({ locCode, macCode, txnDate, receiptNo }) {
    if (!locCode || !macCode || !txnDate || !receiptNo) {
      throw new Error('loadBill requires locCode, macCode, txnDate and receiptNo.');
    }
    const items = await liveBillRepository.getItemsByReceipt({ locCode, macCode, txnDate, receiptNo });
    return { locCode, macCode, txnDate, receiptNo, customerCode: items[0]?.customerCode || '', customerAccountId: items[0]?.customerAccountId || null, items };
  }

  // ── Product search ──────────────────────────────────────

  /**
   * Search products by SKU or name for the item code lookup.
   */
  async function searchProducts(term) {
    if (!term || !term.trim()) {
      return catalogRepository.listProducts();
    }
    return catalogRepository.searchProducts(term.trim());
  }

  async function searchInvoices(filters) {
    return billingRepository.searchInvoices(filters || {});
  }

  async function getInvoiceArchive(invoiceId) {
    if (!invoiceId) throw new Error('invoiceId is required.');
    return billingRepository.getInvoiceArchive(invoiceId);
  }

  async function collectInvoiceBalance({ invoiceId, sessionId, userId, payments }) {
    if (!invoiceId || !sessionId || !userId) {
      throw new Error('An invoice, workstation session, and cashier are required to collect a balance.');
    }
    await refreshPaymentModes();
    const normalized = (payments || []).map((payment) => {
      const method = String(payment.method || '').toLowerCase();
      const mode = paymentModes.getMode(method);
      if (!mode) throw new Error(`Unknown payment mode "${payment.method}".`);
      if (mode.type !== 'tender') throw new Error('Outstanding balances can only be collected with a tender payment method.');
      const chequeDetails = method === 'cheque' ? normalizeChequeDetails(payment.chequeDetails) : null;
      return {
        method,
        amount: toMoney(payment.amount),
        chequeDetails,
        providerRef: method === 'cheque' ? chequeDetails?.number || payment.providerRef || null : payment.providerRef || null
      };
    });
    if (normalized.length === 0) throw new Error('At least one tender payment is required.');
    if (normalized.some((payment) => payment.amount <= 0)) throw new Error('Collection payment amounts must be greater than zero.');
    const cashLedger = cashManagementService
      ? await cashManagementService.prepareCollection({ sessionId, userId, payments: normalized })
      : { cashShiftId: null, movements: [] };
    return billingRepository.collectInvoiceBalance({
      invoiceId,
      userId,
      payments: normalized,
      cashShiftId: cashLedger.cashShiftId,
      cashMovements: cashLedger.movements,
      origin: {
        locCode: cashLedger.locCode,
        macCode: cashLedger.macCode,
        businessDate: cashLedger.businessDate
      }
    });
  }

  return {
    openBill,
    holdBill,
    addItem,
    updateItem,
    removeItem,
    updateBillCustomerCode,
    getItems,
    finalizeBill,
    computeTotals,
    abandonBill,
    recallBills,
    loadBill,
    searchProducts,
    searchInvoices,
    getInvoiceArchive,
    collectInvoiceBalance
  };
}

module.exports = {
  createBillingEngineService
};
