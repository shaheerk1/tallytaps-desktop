function createRefundService({ refundRepository, paymentModes, paymentModeRepository = null, eventBus, cashManagementService = null }) {
  if (!refundRepository) throw new Error('Refund service requires refundRepository.');
  if (!paymentModes) throw new Error('Refund service requires paymentModes.');

  const toNumber = (value) => Number(value || 0);
  const toMoney = (value) => Math.round(toNumber(value) * 100) / 100;

  function buildDraftItem(sourceItem, {
    quantity, kilos, stockDisposition = 'sellable',
    bagChargeMode = 'proportional', bagChargeTotal,
    wageChargeMode = 'proportional', wageChargeTotal
  } = {}) {
    const sourceQuantity = toNumber(sourceItem.qty);
    const sourceKilos = sourceItem.kilos == null
      ? (sourceItem.metadata && sourceItem.metadata.kilos != null ? toNumber(sourceItem.metadata.kilos) : null)
      : toNumber(sourceItem.kilos);
    const hasKilos = sourceKilos !== null && sourceKilos > 0;
    const returnKilos = hasKilos ? toNumber(kilos) : null;
    const returnQuantity = hasKilos
      ? toNumber((sourceQuantity * returnKilos) / sourceKilos)
      : toNumber(quantity);
    const ratio = hasKilos ? returnKilos / sourceKilos : returnQuantity / sourceQuantity;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1.000001) {
      throw new Error(`Return amount is invalid for ${sourceItem.description}.`);
    }
    const normalizeMode = (mode) => ['proportional', 'exclude', 'custom'].includes(mode) ? mode : 'proportional';
    const resolveCharge = (sourceTotal, remainingTotal, mode, customTotal, label) => {
      const selectedMode = normalizeMode(mode);
      if (selectedMode === 'exclude' || sourceTotal <= 0) return { mode: selectedMode, total: 0 };
      const total = selectedMode === 'custom' ? toMoney(customTotal) : toMoney(sourceTotal * ratio);
      if (!Number.isFinite(total) || total < 0 || total > remainingTotal + 0.005) {
        throw new Error(`${label} refund amount is outside the remaining charge for ${sourceItem.description}.`);
      }
      return { mode: selectedMode, total };
    };
    const bag = resolveCharge(
      toMoney(sourceItem.bagChargeTotal), toMoney(sourceItem.remainingBagChargeTotal),
      bagChargeMode, bagChargeTotal, 'Bag charge'
    );
    const wage = resolveCharge(
      toMoney(sourceItem.wageChargeTotal), toMoney(sourceItem.remainingWageChargeTotal),
      wageChargeMode, wageChargeTotal, 'Wage charge'
    );
    const merchandiseTotal = toMoney(sourceItem.merchandiseTotal * ratio);
    const discount = toMoney(sourceItem.discount * ratio);
    const tax = toMoney(sourceItem.tax * ratio);
    const metadata = { ...(sourceItem.metadata || {}) };
    if (hasKilos) metadata.kilos = returnKilos;
    metadata.refundSource = {
      sourceInvoiceItemId: sourceItem.id,
      sourceQuantity,
      sourceKilos,
      pricingMode: 'source-prorated'
    };
    return {
      sourceInvoiceItemId: sourceItem.id,
      productId: sourceItem.productId,
      itemCode: sourceItem.itemCode,
      supplierCode: sourceItem.supplierCode || '',
      description: sourceItem.description,
      sourceQuantity,
      sourceKilos,
      returnQuantity,
      returnKilos,
      unitPrice: sourceItem.unitPrice,
      discount,
      tax,
      sourceMerchandiseTotal: toMoney(sourceItem.merchandiseTotal),
      sourceBagChargeTotal: toMoney(sourceItem.bagChargeTotal),
      sourceWageChargeTotal: toMoney(sourceItem.wageChargeTotal),
      merchandiseTotal,
      bagChargeMode: bag.mode,
      bagChargeTotal: bag.total,
      wageChargeMode: wage.mode,
      wageChargeTotal: wage.total,
      total: toMoney(merchandiseTotal + bag.total + wage.total - discount + tax),
      stockDisposition,
      metadata
    };
  }

  async function getSource(invoiceId) {
    const source = await refundRepository.getSourceInvoice(invoiceId);
    if (!source) throw new Error('Sale not found or not eligible for a refund.');
    return source;
  }

  async function createDraft(context) {
    return refundRepository.createDraft(context);
  }

  async function addSourceItem({
    draftId, sourceInvoiceId, sourceItemId, quantity, kilos, stockDisposition,
    bagChargeMode, bagChargeTotal, wageChargeMode, wageChargeTotal
  }) {
    const source = await getSource(sourceInvoiceId);
    const sourceItem = source.items.find((item) => Number(item.id) === Number(sourceItemId));
    if (!sourceItem) throw new Error('Only items from the original sale may be refunded.');
    const hasKilos = sourceItem.kilos !== null;
    const selected = buildDraftItem(sourceItem, {
      quantity: hasKilos ? undefined : quantity,
      kilos: hasKilos ? kilos : undefined,
      stockDisposition,
      bagChargeMode,
      bagChargeTotal,
      wageChargeMode,
      wageChargeTotal
    });
    const remainingMeasure = hasKilos ? sourceItem.remainingKilos : sourceItem.remainingQuantity;
    const selectedMeasure = hasKilos ? selected.returnKilos : selected.returnQuantity;
    if (selectedMeasure > remainingMeasure + 0.0005) {
      throw new Error(`Only ${remainingMeasure.toFixed(3)} remains refundable for ${sourceItem.description}.`);
    }
    return refundRepository.saveDraftItem(draftId, selected);
  }

  async function removeDraftItem(draftId, sourceInvoiceItemId) {
    return refundRepository.removeDraftItem(draftId, sourceInvoiceItemId);
  }

  async function holdDraft(draftId, userId) {
    return refundRepository.setDraftStatus(draftId, 'held', userId);
  }

  async function resumeDraft(draftId, userId) {
    return refundRepository.setDraftStatus(draftId, 'open', userId, 'resumed');
  }

  async function abandonDraft(draftId, userId) {
    return refundRepository.setDraftStatus(draftId, 'abandoned', userId);
  }

  async function validatePayments(payments, payoutDue) {
    if (paymentModeRepository) {
      paymentModes.replaceConfigured(await paymentModeRepository.listModes());
    }
    if (payoutDue <= 0.005) {
      if (Array.isArray(payments) && payments.some((payment) => toMoney(payment.amount) > 0.005)) {
        throw new Error('This return is fully applied to the outstanding customer balance and has no payout due.');
      }
      return [];
    }
    if (!Array.isArray(payments) || payments.length === 0) {
      throw new Error('Choose at least one refund payout method.');
    }
    const normalized = payments.map((payment) => {
      const method = String(payment.method || '').toLowerCase();
      const mode = paymentModes.getMode(method);
      if (!mode || mode.type !== 'tender') {
        throw new Error(`Refund payout method "${payment.method}" is not supported.`);
      }
      const amount = toMoney(payment.amount);
      if (amount <= 0) throw new Error('Refund payout amounts must be greater than zero.');
      return { method, amount, providerRef: payment.providerRef || null };
    });
    const total = toMoney(normalized.reduce((sum, payment) => sum + payment.amount, 0));
    if (Math.abs(total - payoutDue) > 0.005) {
      throw new Error(`Refund payout must equal ${payoutDue.toFixed(2)} after outstanding debt is applied.`);
    }
    return normalized;
  }

  async function finalize({ draftId, payments, userId, reason, sessionId }) {
    const draft = await refundRepository.getDraft(draftId);
    if (!draft) throw new Error('Refund draft not found.');
    const normalizedReason = String(reason || draft.reason || '').trim();
    if (!normalizedReason) throw new Error('A refund reason is required before completion.');
    const settlement = await refundRepository.getSettlementQuote(draftId);
    const normalizedPayments = await validatePayments(payments, settlement.payoutDue);
    const cashLedger = cashManagementService
      ? await cashManagementService.prepareRefund({ sessionId, userId, payments: normalizedPayments })
      : { cashShiftId: null, movements: [] };
    const result = await refundRepository.finalizeDraft({
      draftId,
      payments: normalizedPayments,
      expectedSettlement: settlement,
      userId,
      reason: normalizedReason,
      cashShiftId: cashLedger.cashShiftId,
      cashMovements: cashLedger.movements
    });
    if (eventBus) {
      await eventBus.publishAsync('refund.finalized', { ...result, draftId });
    }
    return result;
  }

  return {
    searchSourceInvoices: (options) => refundRepository.searchSourceInvoices(options),
    getSource,
    createDraft,
    getDraft: (draftId) => refundRepository.getDraft(draftId),
    listActiveDrafts: (context) => refundRepository.listActiveDrafts(context),
    addSourceItem,
    removeDraftItem,
    holdDraft,
    resumeDraft,
    abandonDraft,
    finalize,
    buildDraftItem
  };
}

module.exports = { createRefundService };
