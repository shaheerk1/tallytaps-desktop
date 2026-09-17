const requestContext = require('../security/request-context');

function createBillingEngineService({
  liveBillRepository,
  billingRepository,
  catalogRepository,
  partyRepository,
  workstationRepository,
  paymentModes,
  paymentModeRepository,
  eventBus,
  cashManagementService,
  customerAdvanceRepository = null,
  settingsService = null
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
        fundAccountId: Number(p.fundAccountId) || null,
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
   * Whether this location asks for a supply code on every bill line, and what
   * a line without one is saved with.
   *
   * The default is the location's receipt tagline, by the owner's choice: it
   * reads as the shop's own supply, and it keeps the supply code filled on every
   * line so reports and settlements see the same shape of data either way. A
   * line saved with the default is never matched against lot codes and never
   * remembered.
   */
  async function supplyCodePolicy() {
    if (!settingsService) return { required: true, defaultCode: '' };
    const [billingSettings, general] = await Promise.all([
      settingsService.getSettingsByCode('billing'),
      settingsService.getSettingsByCode('general')
    ]);
    const flag = billingSettings.supply_code_required;
    const required = !(flag === false || flag === 'false' || flag === '0' || flag === 0);
    const locCode = String(requestContext.workstation()?.locCode || '').trim().toUpperCase();
    const defaultCode = String(general.store_tagline || '').trim().toUpperCase().slice(0, 120) || locCode;
    return { required, defaultCode };
  }

  /** Remembering a code must never stop a sale. */
  async function rememberLineSupplyCode({ locCode, productId, userId, businessDate, supplyCode }) {
    if (!locCode || !Number(productId) || !Number(userId) || !businessDate || !supplyCode) return;
    try {
      await liveBillRepository.rememberSupplyCode({
        locCode, productId: Number(productId), userId: Number(userId), businessDate, supplyCode
      });
    } catch (error) {
      console.warn('Supply code was not remembered:', error.message);
    }
  }

  /** The code this cashier used for an item earlier today, to fill in again. */
  async function rememberedSupplyCode({ productId }) {
    const ws = requestContext.workstation();
    const userId = requestContext.resolveUserId({});
    if (!ws || !userId || !Number(productId)) return { supplyCode: null };
    const origin = requestContext.resolveOrigin({});
    const supplyCode = await liveBillRepository.getRememberedSupplyCode({
      locCode: origin.locCode, productId: Number(productId), userId: Number(userId), businessDate: origin.txnDate
    });
    return { supplyCode };
  }

  async function forgetSupplyCode({ productId }) {
    const ws = requestContext.workstation();
    const userId = requestContext.resolveUserId({});
    if (!ws || !userId || !Number(productId)) return { forgotten: false };
    await liveBillRepository.forgetSupplyCode({ locCode: ws.locCode, productId: Number(productId), userId: Number(userId) });
    return { forgotten: true };
  }

  /**
   * Which lot a bill line takes its stock from first.
   *
   * The code typed at the counter is a lot's short tag (KAR1), so one code
   * names one lot. A code matching nothing leaves the line unmatched: it takes
   * no stock at all, and stays visible as an unmatched allocation, instead of
   * quietly consuming the oldest lot. Picking a lot from the stock list wins
   * over the typed text, and the screen writes that lot's tag back into the
   * field so the two always agree.
   */
  async function resolveLineAllocation({ productId, locCode, txnDate, supplyCode, lotId, source }) {
    // Choosing "no lot" on the screen is a decision, not a failed match: it
    // holds even when the typed code would have found a lot.
    if (source === 'unmatched') return { lotId: null, source: 'unmatched' };
    const chosenLotId = Number(lotId) || null;
    if (chosenLotId) {
      const valid = await billingRepository.lotIsAvailableForLine({ lotId: chosenLotId, productId, locCode, txnDate });
      if (valid) return { lotId: valid, source: ['tag', 'automatic', 'remembered'].includes(source) ? source : 'manual' };
    }
    const tag = String(supplyCode || '').trim();
    if (!tag) return { lotId: null, source: 'automatic' };
    const lot = await billingRepository.findActiveLotByTag({ tag, productId, locCode, txnDate });
    return lot ? { lotId: lot.id, source: 'tag' } : { lotId: null, source: 'unmatched' };
  }

  /**
   * Add an item to the current bill. Saves to DB in real-time under the bill's
   * receipt number (invoice_id stays NULL until finalize).
   */
  async function addItem(bill, item) {
    return addLineToBill(bill, item, {});
  }

  /**
   * The one way a line reaches a live bill, whether a cashier typed it or it
   * was copied from a finished bill. `lineMetadata` is set by trusted code in
   * this service only; the screen cannot supply it.
   */
  async function addLineToBill(bill, item, lineMetadata = {}) {
    if (!bill?.sessionId || !bill?.receiptNo) {
      throw new Error('addItem requires a bill context (sessionId + receiptNo).');
    }
    if (!item?.itemCode || !item?.description) {
      throw new Error('itemCode and description are required.');
    }

    const customerCode = String(bill.customerCode || '').trim().toUpperCase();
    const typedSupplyCode = String(item.supplierCode || '').trim().toUpperCase();
    if (!customerCode) throw new Error('Customer code is required.');
    // A line without a supply code is saved with the location's default code,
    // but only where the owner switched the requirement off.
    const policy = typedSupplyCode ? null : await supplyCodePolicy();
    if (!typedSupplyCode && policy.required) throw new Error('Supply code is required.');
    const usesDefaultCode = !typedSupplyCode;
    const supplierCode = typedSupplyCode || policy.defaultCode;
    if (!supplierCode) throw new Error('Set a receipt tagline in Settings, or type a supply code: every bill line needs one.');
    const qty = item.qty === undefined || item.qty === null ? 1 : Number(item.qty);
    const product = item.productId ? await catalogRepository.getProduct(item.productId) : null;
    // Looked up by id, an item is found even after it was switched off; a bill
    // may only carry what is still sold here, typed or copied.
    if (!product || Number(product.is_active) === 0) throw new Error('Select an active DDEC item before adding it to the bill.');
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
    const allocation = await resolveLineAllocation({
      productId: item.productId, locCode: ctx.locCode, txnDate: ctx.txnDate,
      // The default code is not a lot code: it must never pick a lot by accident.
      supplyCode: usesDefaultCode ? '' : supplierCode, lotId: item.allocationPriorityLotId, source: item.allocationPrioritySource
    });
    const saved = await liveBillRepository.addItem({
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
      metadata: lineMetadata || {},
      priceOverrideSnapshot,
      allocationPriorityLotId: allocation.lotId,
      allocationPrioritySource: allocation.source,
      allocationPrioritySetBy: allocation.lotId && Number.isInteger(Number(ctx.userId)) && Number(ctx.userId) > 0
        ? Number(ctx.userId)
        : null
    });
    // What ended up in the field is remembered for this item today. The default
    // code is not a choice anyone made, and a copied bill is not a new habit.
    if (!usesDefaultCode && !lineMetadata?.copiedFrom) {
      await rememberLineSupplyCode({
        locCode: ctx.locCode, productId: item.productId, userId: ctx.userId, businessDate: ctx.txnDate, supplyCode: supplierCode
      });
    }
    return saved;
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

    const saved = await liveBillRepository.updateItem({
      itemId, qty, kilos: Number.isFinite(kilos) && kilos > 0 ? kilos : null, unitPrice, discount, tax,
      pricingBasis: existing.pricingBasis, quantityStep: existing.quantityStep, allowZeroQuantity: existing.allowZeroQuantity,
      merchandiseTotal: calculated.merchandiseTotal, bagChargeRate: existing.bagChargeRate, bagChargeTotal: calculated.bagChargeTotal,
      wageChargeRate: existing.wageChargeRate, wageBasis: existing.wageBasis, wageChargeTotal: calculated.wageChargeTotal,
      total: calculated.total, metadata: {}, priceOverrideSnapshot
    });
    // Changing the supply code on a line moves it to that lot, or to no lot.
    if (updates.supplyCode !== undefined) {
      const supplyCode = String(updates.supplyCode || '').trim().toUpperCase();
      const line = await billingRepository.updateLiveItemSupplyCode({ itemId, supplyCode });
      const allocation = await resolveLineAllocation({
        productId: line.productId, locCode: line.locCode, txnDate: line.txnDate, supplyCode
      });
      await billingRepository.setLiveItemAllocationPriority({
        itemId, lotId: allocation.lotId, source: allocation.source, userId: updates.actorId
      });
      if (supplyCode) {
        await rememberLineSupplyCode({
          locCode: line.locCode, productId: line.productId,
          userId: requestContext.resolveUserId({ userId: updates.actorId }),
          businessDate: requestContext.workstation()?.businessDate || line.txnDate, supplyCode
        });
      }
    }
    return saved;
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
    const advanceAmount = toMoney(validatedPayments.filter((payment) => payment.method === 'advance')
      .reduce((sum, payment) => sum + toMoney(payment.amount), 0));
    if ((pendingAmount > 0 || hasCheque || advanceAmount > 0) && !resolvedCustomerAccountId) {
      throw new Error(hasCheque
        ? 'Link a real customer account before accepting a cheque.'
        : advanceAmount > 0
          ? 'Link a real customer account before using advance money.'
          : 'Link a real customer account before recording a pending/credit balance.');
    }
    if (advanceAmount > 0) {
      if (!customerAdvanceRepository) throw new Error('Customer advance settlement is not available.');
      // Prepaid money settles only what the other tenders leave unpaid. Without
      // this cap a bill could be over-tendered with advance and the difference
      // handed back as cash change, turning a stored balance into drawer cash.
      const otherTenderTotal = toMoney(validatedPayments
        .filter((payment) => payment.type === 'tender' && payment.method !== 'advance')
        .reduce((sum, payment) => sum + toMoney(payment.amount), 0));
      const applicable = toMoney(Math.max(effectiveGrandTotal - otherTenderTotal, 0));
      if (advanceAmount > applicable + 0.005) {
        throw new Error(`Advance money can only settle the ${applicable.toFixed(2)} left after the other payments. Advance is never returned as change.`);
      }
      const available = await customerAdvanceRepository.getBalance(resolvedCustomerAccountId, locCode);
      if (advanceAmount > available + 0.005) throw new Error(`Only ${available.toFixed(2)} of customer advance is available at this location.`);
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

  async function listAllocationLotCandidates(options) {
    return billingRepository.listAllocationLotCandidates(options || {});
  }

  async function rememberAllocationLot(options) {
    return billingRepository.rememberAllocationLot(options || {});
  }

  async function clearRememberedAllocationLot(options) {
    return billingRepository.clearRememberedAllocationLot(options || {});
  }

  async function setLiveItemAllocationPriority(options) {
    return billingRepository.setLiveItemAllocationPriority(options || {});
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
        fundAccountId: Number(payment.fundAccountId) || null,
        chequeDetails,
        providerRef: method === 'cheque' ? chequeDetails?.number || payment.providerRef || null : payment.providerRef || null
      };
    });
    if (normalized.length === 0) throw new Error('At least one tender payment is required.');
    if (normalized.some((payment) => payment.amount <= 0)) throw new Error('Collection payment amounts must be greater than zero.');
    const cashLedger = cashManagementService
      ? await cashManagementService.prepareCollection({ sessionId, userId, payments: normalized })
      : { cashShiftId: null, movements: [] };
    // Settling an outstanding balance from stored advance money moves one
    // customer liability onto another; it must still respect the balance the
    // customer actually holds at this location.
    const collectionAdvance = toMoney(normalized.filter((payment) => payment.method === 'advance')
      .reduce((sum, payment) => sum + toMoney(payment.amount), 0));
    if (collectionAdvance > 0) {
      if (!customerAdvanceRepository) throw new Error('Customer advance settlement is not available.');
      const invoice = await billingRepository.getInvoice(invoiceId);
      if (!invoice) throw new Error('Invoice was not found.');
      if (!invoice.customer_account_id) throw new Error('This invoice has no customer account to settle.');
      const available = await customerAdvanceRepository.getBalance(invoice.customer_account_id, cashLedger.locCode);
      if (collectionAdvance > available + 0.005) {
        throw new Error(`Only ${available.toFixed(2)} of customer advance is available at this location.`);
      }
    }
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

  /**
   * Starts a new bill from a finished one.
   *
   * Every line of the source bill is added to a fresh receipt exactly as a
   * cashier would add it by hand: the item must still be sold at this location,
   * and a changed rate still has to pass that item's price rules. Nothing is
   * posted -- no stock, drawer, supplier or customer effect -- until the new
   * bill is finalized like any other, and abandoning it leaves nothing behind.
   * Payments are never copied. The new lines carry a note of the bill they
   * came from, which finalize writes onto the new invoice.
   *
   * Lines that can no longer be sold are left out and named. If none can be,
   * the new receipt is abandoned at once.
   */
  async function copyInvoiceToBill({ invoiceId }) {
    if (!Number(invoiceId)) throw new Error('Choose the bill to copy.');
    const ws = requestContext.workstation();
    const origin = requestContext.resolveOrigin({});
    const userId = requestContext.resolveUserId({});
    if (!ws || !userId) throw new Error('Open a workstation session before copying a bill.');

    const source = await billingRepository.getInvoice(Number(invoiceId));
    if (!source) throw new Error('That bill no longer exists.');
    if (source.loc_code !== origin.locCode) throw new Error('That bill belongs to another location.');
    if (source.inv_stat !== 'active' || !['paid', 'partial'].includes(source.status)) {
      throw new Error('Only a finalized bill can be copied.');
    }
    const lines = [...(source.items || [])].sort((a, b) => Number(a.seq_no) - Number(b.seq_no));
    if (!lines.length) throw new Error('That bill has no lines to copy.');

    const bill = {
      sessionId: ws.workstationSessionId,
      locCode: origin.locCode, macCode: origin.macCode, txnDate: origin.txnDate, userId,
      customerCode: String(source.customer_code || '').trim().toUpperCase(),
      customerAccountId: source.customer_account_id ? Number(source.customer_account_id) : null
    };
    bill.receiptNo = await liveBillRepository.allocateNextReceiptNo(bill);
    await liveBillRepository.updateSessionCurrentReceipt(bill.sessionId, bill.receiptNo);

    const copiedFrom = { invoiceId: Number(source.id), invoiceNumber: source.invoice_number };
    const skipped = [];
    let copied = 0;
    for (const line of lines) {
      const kilos = line.kilos ?? line.base_quantity;
      try {
        await addLineToBill(bill, {
          productId: line.product_id,
          supplierCode: line.supplier_code,
          itemCode: line.item_code,
          description: line.description,
          qty: Number(line.quantity ?? line.handling_quantity ?? 0),
          kilos: kilos == null ? null : Number(kilos),
          unitPrice: Number(line.unit_price || 0),
          discount: Number(line.discount || 0),
          tax: Number(line.tax || 0)
        }, { copiedFrom });
        copied += 1;
      } catch (error) {
        skipped.push({ itemCode: line.item_code, description: line.description, reason: error.message });
      }
    }
    if (!copied) {
      await liveBillRepository.abandonBill(bill);
      throw new Error(`Nothing on ${source.invoice_number} can be sold now: `
        + skipped.map((row) => `${row.description} (${row.reason})`).join('; '));
    }

    const items = await liveBillRepository.getItemsByReceipt(bill);
    return {
      sessionId: bill.sessionId, receiptNo: bill.receiptNo,
      locCode: bill.locCode, macCode: bill.macCode, txnDate: bill.txnDate, userId,
      customerCode: bill.customerCode, customerAccountId: bill.customerAccountId,
      items, billHeader: {}, copiedFrom, copied, skipped
    };
  }

  /**
   * Moves a settled bill, or part of it, back to being owed. The rules live in
   * billingRepository.unsettleInvoice; this only checks the request makes sense
   * and takes the place and person from the signed-in session.
   */
  async function unsettleInvoice({ invoiceId, amount, reason, method }) {
    if (!invoiceId) throw new Error('Choose the bill to mark unpaid.');
    if (toMoney(amount) <= 0) throw new Error('Enter how much of this bill is going back to unpaid.');
    if (!String(reason || '').trim()) throw new Error('Write why this bill is going back to unpaid.');
    const origin = requestContext.resolveOrigin({});
    const userId = requestContext.resolveUserId({});
    if (!userId) throw new Error('A signed-in user is required.');
    return billingRepository.unsettleInvoice({
      invoiceId: Number(invoiceId), amount: toMoney(amount),
      reason: String(reason).trim(), method: String(method || '').trim(), userId, origin
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
    listAllocationLotCandidates,
    rememberAllocationLot,
    clearRememberedAllocationLot,
    setLiveItemAllocationPriority,
    searchInvoices,
    getInvoiceArchive,
    collectInvoiceBalance,
    unsettleInvoice,
    copyInvoiceToBill,
    supplyCodePolicy,
    rememberedSupplyCode,
    forgetSupplyCode
  };
}

module.exports = {
  createBillingEngineService
};
