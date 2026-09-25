/**
 * Money handed back by card or transfer leaves a real account, the same way a
 * sale put it there. Cash leaves the drawer, a cheque leaves when it clears,
 * and a stored advance only moves between documents, so those three name no
 * fund.
 */
const PAYOUT_WITHOUT_FUND = ['cash', 'cheque', 'advance'];

function createRefundService({ refundRepository, paymentModes, paymentModeRepository = null, eventBus, cashManagementService = null }) {
  if (!refundRepository) throw new Error('Refund service requires refundRepository.');
  if (!paymentModes) throw new Error('Refund service requires paymentModes.');

  const toNumber = (value) => Number(value || 0);
  const toMoney = (value) => Math.round(toNumber(value) * 100) / 100;

  /**
   * One returned line, worked out the way the sale was.
   *
   * A dual-unit line is returned in both measures, because they do not move
   * together: three bags of 60 kg can come back as two bags of 35 kg. Each
   * amount is undone on the measure it was charged on:
   *
   *   * the goods follow their pricing measure (per kg, or per unit);
   *   * packaging follows the unit count, since it is charged per unit;
   *   * the wage follows whichever measure it was charged on.
   *
   * Either charge can still be left out or entered by hand instead.
   */
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
    // An older caller that sends only the measured amount still works: the unit
    // count is then taken in proportion, as it used to be.
    const returnQuantity = !hasKilos || quantity != null
      ? toNumber(quantity)
      : toNumber((sourceQuantity * returnKilos) / sourceKilos);
    const share = (returned, source) => {
      if (!(source > 0)) return 0;
      const ratio = returned / source;
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1.000001) {
        throw new Error(`Return amount is invalid for ${sourceItem.description}.`);
      }
      return Math.min(ratio, 1);
    };
    const quantityRatio = share(returnQuantity, sourceQuantity);
    const kilosRatio = hasKilos ? share(returnKilos, sourceKilos) : 0;
    if (returnQuantity <= 0 && !(hasKilos && returnKilos > 0)) {
      throw new Error(`Enter what is coming back for ${sourceItem.description}.`);
    }
    const pricingBasis = sourceItem.pricingBasis === 'kilos' ? 'kilos' : 'qty';
    const wageBasis = ['qty', 'kilos'].includes(sourceItem.wageBasis) ? sourceItem.wageBasis : null;
    const goodsRatio = pricingBasis === 'kilos' && hasKilos ? kilosRatio : quantityRatio;
    const wageRatio = wageBasis === 'kilos' && hasKilos ? kilosRatio : wageBasis === 'qty' ? quantityRatio : goodsRatio;

    const normalizeMode = (mode) => ['proportional', 'exclude', 'custom'].includes(mode) ? mode : 'proportional';
    const resolveCharge = (sourceTotal, remainingTotal, ratio, mode, customTotal, label) => {
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
      quantityRatio, bagChargeMode, bagChargeTotal, 'Bag charge'
    );
    const wage = resolveCharge(
      toMoney(sourceItem.wageChargeTotal), toMoney(sourceItem.remainingWageChargeTotal),
      wageRatio, wageChargeMode, wageChargeTotal, 'Wage charge'
    );
    const merchandiseTotal = toMoney(sourceItem.merchandiseTotal * goodsRatio);
    const discount = toMoney(sourceItem.discount * goodsRatio);
    const tax = toMoney(sourceItem.tax * goodsRatio);
    const metadata = { ...(sourceItem.metadata || {}) };
    if (hasKilos) metadata.kilos = returnKilos;
    metadata.refundSource = {
      sourceInvoiceItemId: sourceItem.id,
      sourceQuantity,
      sourceKilos,
      pricingMode: 'source-prorated',
      // Kept on the line so a reprint or a later question can show why each
      // amount came back at the size it did.
      basis: {
        pricingBasis,
        wageBasis: wageBasis || 'none',
        goodsShare: Math.round(goodsRatio * 1e6) / 1e6,
        quantityShare: Math.round(quantityRatio * 1e6) / 1e6,
        kilosShare: hasKilos ? Math.round(kilosRatio * 1e6) / 1e6 : null,
        wageShare: Math.round(wageRatio * 1e6) / 1e6
      }
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
    // What is left on the sale line decides first, so the reason given is about
    // the goods and not about a charge worked out from them.
    const remainingQuantity = Number(sourceItem.remainingQuantity || 0);
    const remainingKilos = hasKilos ? Number(sourceItem.remainingKilos || 0) : 0;
    if (remainingQuantity <= 0.0005 && (!hasKilos || remainingKilos <= 0.0005)) {
      throw new Error(`Everything on ${sourceItem.description} has already been returned.`);
    }
    if (Number(quantity || 0) > remainingQuantity + 0.0005) {
      throw new Error(`Only ${remainingQuantity.toFixed(3)} ${sourceItem.handlingUom || 'units'} remain refundable for ${sourceItem.description}.`);
    }
    if (hasKilos && Number(kilos || 0) > remainingKilos + 0.0005) {
      throw new Error(`Only ${remainingKilos.toFixed(3)} ${sourceItem.baseUom || 'measured units'} remain refundable for ${sourceItem.description}.`);
    }
    const selected = buildDraftItem(sourceItem, {
      // A dual-unit line takes both; only the measured amount still works.
      quantity: hasKilos && quantity == null ? undefined : quantity,
      kilos: hasKilos ? kilos : undefined,
      stockDisposition,
      bagChargeMode,
      bagChargeTotal,
      wageChargeMode,
      wageChargeTotal
    });
    if (selected.returnQuantity > sourceItem.remainingQuantity + 0.0005) {
      throw new Error(`Only ${sourceItem.remainingQuantity.toFixed(3)} ${sourceItem.handlingUom || 'units'} remain refundable for ${sourceItem.description}.`);
    }
    if (hasKilos && selected.returnKilos > (sourceItem.remainingKilos || 0) + 0.0005) {
      throw new Error(`Only ${(sourceItem.remainingKilos || 0).toFixed(3)} ${sourceItem.baseUom || 'measured units'} remain refundable for ${sourceItem.description}.`);
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
      if (!mode || mode.type !== 'tender' || mode.configuration?.supportsRefundPayout === false) {
        throw new Error(`Refund payout method "${payment.method}" is not supported.`);
      }
      const amount = toMoney(payment.amount);
      if (amount <= 0) throw new Error('Refund payout amounts must be greater than zero.');
      const fundAccountId = Number(payment.fundAccountId || 0) || null;
      if (!fundAccountId && !PAYOUT_WITHOUT_FUND.includes(method)) {
        throw new Error(`Choose the account the ${method} refund is paid from, so the money leaves it.`);
      }
      return { method, amount, providerRef: payment.providerRef || null, fundAccountId };
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
