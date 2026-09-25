import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type { FundAccount } from '../../../../../../packages/shared/ipc/pos-api';
import type {
  PaymentLine,
  PaymentMode,
  PluginField,
  PrintDocument,
  RefundActiveDraft,
  RefundDraft,
  RefundSourceInvoice,
  RefundSourceItem
} from '../../../../../../packages/shared/ipc/pos-api';

type SourceSearchResult = {
  id: number;
  invoice_number: string;
  receipt_no: number;
  txn_date: string;
  customer_code?: string;
  grandTotal: number;
  paidTotal: number;
  refundedTotal: number;
  refundableTotal: number;
};

@Component({
  selector: 'pos-refund',
  templateUrl: './refund.component.html',
  styleUrls: ['./refund.component.css']
})
export class RefundComponent implements OnInit {
  searchTerm = '';
  searchLocation = '';
  searchMachine = '';
  searchDate = '';
  searchCustomerCode = '';
  searchResults: SourceSearchResult[] = [];
  source: RefundSourceInvoice | null = null;
  draft: RefundDraft | null = null;
  activeDrafts: RefundActiveDraft[] = [];
  pendingSourceInvoiceId: number | null = null;
  paymentModes: PaymentMode[] = [];
  pluginFields: PluginField[] = [];
  billHeaderFields: PluginField[] = [];
  payoutMethod = 'cash';
  payoutFunds: FundAccount[] = [];
  payoutFundId: number | null = null;
  reason = '';
  error = '';
  info = '';
  isLoading = false;
  isFinalizing = false;

  constructor(
    private session: SessionService,
    private printing: PrintingService
  ) {}

  async ngOnInit(): Promise<void> {
    const context = this.context();
    this.searchLocation = context.locCode;
    this.searchMachine = context.macCode;
    this.searchDate = String(context.txnDate).slice(0, 10);
    await Promise.all([this.search(), this.loadPaymentModes(), this.loadActiveDrafts(), this.loadPayoutFunds()]);
    await this.resumeSingleOpenDraft();
  }

  private actor() {
    return this.session.getActor() || undefined;
  }

  /** Where money can be handed back from: the same accounts a sale can be paid into. */
  private async loadPayoutFunds(): Promise<void> {
    const context = this.context();
    if (!window.posApi || !context.locCode) return;
    const result = await window.posApi.funds.list(context.locCode, false, this.actor());
    this.payoutFunds = result.success
      ? (result.data || []).filter((fund) => fund.fundKind === 'bank' || fund.fundKind === 'cash_safe')
      : [];
    this.payoutMethodChanged();
  }

  private context() {
    const ws = this.session.getWorkstationSession();
    const user = this.session.getUser();
    return {
      sessionId: ws?.sessionId || 0,
      locCode: ws?.locationCode || '',
      macCode: ws?.machineCode || '',
      txnDate: ws?.billingDate || '',
      userId: user?.id || 0
    };
  }

  get grandTotal(): number {
    return (this.draft?.items || []).reduce((sum, item) => sum + Number(item.total || 0), 0);
  }

  get debtReduction(): number {
    return Math.min(this.grandTotal, Number(this.source?.balance || 0));
  }

  /** Card or transfer hands money out of a real account; cash, cheque and advance do not. */
  get payoutNeedsFund(): boolean {
    return this.payoutDue > 0.005 && !['cash', 'cheque', 'advance'].includes(this.payoutMethod);
  }

  /** The account the same method reached on the original sale, if it named one. */
  private originalFundIdFor(method: string): number | null {
    const match = (this.source?.payments || []).find(
      (payment) => String(payment.method || '').toLowerCase() === method && payment.fundAccountId
    );
    return match?.fundAccountId ?? null;
  }

  /** Keeps the chosen account sensible whenever the payout method changes. */
  payoutMethodChanged(): void {
    if (!this.payoutNeedsFund) { this.payoutFundId = null; return; }
    const original = this.originalFundIdFor(this.payoutMethod);
    if (original && this.payoutFunds.some((fund) => fund.id === original)) { this.payoutFundId = original; return; }
    if (this.payoutFundId && this.payoutFunds.some((fund) => fund.id === this.payoutFundId)) return;
    this.payoutFundId = this.payoutFunds.find((fund) => fund.fundKind === 'bank')?.id ?? this.payoutFunds[0]?.id ?? null;
  }

  fundLabel(fund: FundAccount): string {
    return `${fund.name} · ${Number(fund.balance || 0).toFixed(2)}`;
  }

  /** Where the original money went, shown so the cashier hands it back the same way. */
  get originalPaymentHint(): string {
    const paid = (this.source?.payments || []).filter((payment) => Number(payment.amount || 0) > 0);
    if (!paid.length) return '';
    return paid.map((payment) => `${payment.method}${payment.fundName ? ` into ${payment.fundName}` : ''} ${Number(payment.amount).toFixed(2)}`).join(' · ');
  }

  get payoutDue(): number {
    return Math.max(0, this.grandTotal - this.debtReduction);
  }

  get availableRefundModes(): PaymentMode[] {
    return this.paymentModes.filter((mode) => mode.id !== 'advance'
      || (Number(this.source?.advanceRestorable || 0) + 0.005 >= this.payoutDue && this.payoutDue > 0.005));
  }

  itemCode(item: { itemCode?: string; item_code?: string; supplierCode?: string; supplier_code?: string }): string {
    const code = item.itemCode || item.item_code || '';
    const supplier = item.supplierCode || item.supplier_code || '';
    return supplier ? `${supplier}~${code}` : code;
  }

  hasBagCharge(item: { sourceBagChargeTotal?: number; bagChargeTotal?: number }): boolean {
    return Number(item.sourceBagChargeTotal ?? item.bagChargeTotal ?? 0) > 0;
  }

  hasWageCharge(item: { sourceWageChargeTotal?: number; wageChargeTotal?: number }): boolean {
    return Number(item.sourceWageChargeTotal ?? item.wageChargeTotal ?? 0) > 0;
  }

  formatMeasure(value: number | null | undefined): string {
    const amount = Number(value || 0);
    return Number.isInteger(amount) ? String(amount) : amount.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  pluginValues(item: { kilos?: number | null; metadata?: Record<string, unknown> }): Array<{ label: string; value: string }> {
    const metadata = item.metadata || {};
    return this.pluginFields
      .map((field) => ({ field, raw: field.key === 'kilos' ? item.kilos ?? metadata[field.key] : metadata[field.key] }))
      .filter(({ raw, field }) => raw !== undefined && raw !== null && raw !== '' && !(field.type === 'checkbox' && !raw))
      .map(({ field, raw }) => ({
        label: field.label,
        value: field.type === 'number' ? Number(raw).toFixed(field.key === 'kilos' ? 3 : 2) : String(raw)
      }));
  }

  /** Original sale header fields shown in the refund workspace only. */
  sourceHeaderValues(): Array<{ label: string; value: string }> {
    const metadata = this.source?.metadata || {};
    const headers = (this.source?.billHeader || metadata['billHeader'] || {}) as Record<string, Record<string, unknown>>;
    return this.billHeaderFields
      .map((field) => ({ field, raw: headers[field.pluginId]?.[field.key] }))
      .filter(({ raw, field }) => raw !== undefined && raw !== null && raw !== '' && !(field.type === 'checkbox' && !raw))
      .map(({ field, raw }) => ({ label: field.label, value: field.type === 'number' ? Number(raw).toFixed(2) : String(raw) }));
  }

  async search(): Promise<void> {
    if (!window.posApi) return;
    this.error = '';
    const result = await window.posApi.refunds.searchSourceInvoices({
      term: this.searchTerm,
      customerCode: this.searchCustomerCode,
      locCode: this.searchLocation,
      macCode: this.searchMachine,
      txnDate: this.searchDate
    }, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not search completed sales.';
      return;
    }
    this.searchResults = result.data || [];
  }

  async selectSource(invoiceId: number): Promise<void> {
    if (!window.posApi) return;
    if (this.draft?.source_invoice_id === invoiceId) return;
    if (this.draft && this.draft.items.length > 0 && this.draft.source_invoice_id !== invoiceId) {
      this.pendingSourceInvoiceId = invoiceId;
      this.error = '';
      this.info = '';
      return;
    }
    await this.openSource(invoiceId);
  }

  private async openSource(invoiceId: number): Promise<void> {
    if (!window.posApi) return;
    this.error = '';
    this.info = '';
    const result = await window.posApi.refunds.getSource(invoiceId, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not load the source sale.';
      return;
    }
    this.source = result.data;
    this.draft = null;
    this.reason = '';
    // Hand the money back the way it came in, unless the cashier says otherwise.
    this.payoutMethodChanged();
  }

  cancelSourceSwitch(): void {
    this.pendingSourceInvoiceId = null;
  }

  async holdAndSelectSource(): Promise<void> {
    const invoiceId = this.pendingSourceInvoiceId;
    if (!invoiceId || !(await this.holdActiveDraft())) return;
    this.pendingSourceInvoiceId = null;
    await this.openSource(invoiceId);
  }

  async clearAndSelectSource(): Promise<void> {
    const invoiceId = this.pendingSourceInvoiceId;
    if (!invoiceId || !(await this.clearActiveDraft())) return;
    this.pendingSourceInvoiceId = null;
    await this.openSource(invoiceId);
  }

  async startDraft(): Promise<boolean> {
    if (!window.posApi || !this.source) return false;
    if (this.draft) return true;
    const context = this.context();
    const result = await window.posApi.refunds.createDraft({
      sourceInvoiceId: this.source.id,
      ...context,
      reason: this.reason
    }, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not start the refund.';
      return false;
    }
    return this.loadDraft(result.data.draftId);
  }

  async loadDraft(draftId: number): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.refunds.getDraft(draftId, this.actor());
    if (!result.success || !result.data) {
      this.error = result.success ? 'Refund draft was not found.' : result.error || 'Could not load the refund draft.';
      return false;
    }
    this.draft = result.data;
    void this.loadActiveDrafts();
    if (!this.source || this.source.id !== result.data.source_invoice_id) {
      const sourceResult = await window.posApi.refunds.getSource(result.data.source_invoice_id, this.actor());
      if (sourceResult.success) this.source = sourceResult.data;
    }
    this.reason = result.data.reason || this.reason;
    return true;
  }

  async addItem(item: RefundSourceItem): Promise<void> {
    if (!window.posApi || !this.source) return;
    this.error = '';
    if (!(await this.startDraft()) || !this.draft) return;
    const isWeighted = item.remainingKilos !== null;
    const result = await window.posApi.refunds.saveItem({
      draftId: this.draft.id,
      sourceInvoiceId: this.source.id,
      sourceItemId: item.id,
      // A dual-unit line comes back in both measures; they do not move together.
      quantity: item.remainingQuantity,
      kilos: isWeighted ? item.remainingKilos || undefined : undefined,
      stockDisposition: 'sellable'
    }, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not add this item to the refund.';
      return;
    }
    this.draft = result.data;
    void this.loadActiveDrafts();
  }

  async refundAll(): Promise<void> {
    if (!this.source) return;
    this.isLoading = true;
    try {
      for (const item of this.source.items) {
        const remaining = item.remainingKilos ?? item.remainingQuantity;
        if (remaining > 0) await this.addItem(item);
      }
      this.info = 'All remaining source items were added to the refund.';
    } finally {
      this.isLoading = false;
    }
  }

  sourceItem(sourceItemId: number): RefundSourceItem | undefined {
    return this.source?.items.find((item) => item.id === sourceItemId);
  }

  /** True when the line was sold in two measures, such as bags and kilos. */
  isDualMeasure(item: { returnKilos: number | null }): boolean {
    return item.returnKilos !== null;
  }

  /** What is still returnable on the sale line behind a draft line. */
  remainingText(item: { source_invoice_item_id: number }, measure: 'qty' | 'kilos'): string {
    const source = this.sourceItem(item.source_invoice_item_id);
    if (!source) return '';
    const value = measure === 'kilos' ? source.remainingKilos : source.remainingQuantity;
    if (value == null) return '';
    const unit = measure === 'kilos' ? (source.baseUom || 'measured units') : (source.handlingUom || 'units');
    return `${this.formatMeasure(value)} ${unit} left`;
  }

  /** What a proportional charge refund follows, said plainly under the choice. */
  chargeBasisText(item: { source_invoice_item_id: number }, charge: 'bag' | 'wage'): string {
    const source = this.sourceItem(item.source_invoice_item_id);
    if (!source) return '';
    const unitName = source.handlingUom || 'units';
    const baseName = source.baseUom || 'measured units';
    if (charge === 'bag') return `Charged per ${unitName}, so it follows the unit count.`;
    const basis = (source as unknown as { wageBasis?: string }).wageBasis;
    if (basis === 'kilos') return `Charged per ${baseName}, so it follows the measured amount.`;
    if (basis === 'qty') return `Charged per ${unitName}, so it follows the unit count.`;
    return 'Follows the amount of goods returned.';
  }

  async updateItem(item: RefundDraft['items'][number]): Promise<void> {
    const sourceItem = this.sourceItem(item.source_invoice_item_id);
    if (!window.posApi || !this.source || !this.draft || !sourceItem) return;
    const result = await window.posApi.refunds.saveItem({
      draftId: this.draft.id,
      sourceInvoiceId: this.source.id,
      sourceItemId: sourceItem.id,
      quantity: item.returnQuantity,
      kilos: sourceItem.remainingKilos === null ? undefined : item.returnKilos || undefined,
      stockDisposition: item.stock_disposition,
      bagChargeMode: item.bagChargeMode,
      bagChargeTotal: item.bagChargeTotal,
      wageChargeMode: item.wageChargeMode,
      wageChargeTotal: item.wageChargeTotal
    }, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not update the refund item.';
      return;
    }
    this.draft = result.data;
    void this.loadActiveDrafts();
  }

  async removeItem(item: RefundDraft['items'][number]): Promise<void> {
    if (!window.posApi || !this.draft) return;
    const result = await window.posApi.refunds.removeItem(this.draft.id, item.source_invoice_item_id, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not remove the refund item.';
      return;
    }
    this.draft = result.data;
    void this.loadActiveDrafts();
  }

  async hold(): Promise<void> {
    if (await this.holdActiveDraft()) {
      this.pendingSourceInvoiceId = null;
      this.source = null;
      this.reason = '';
      this.info = 'Refund draft held safely. Resume it from Refund drafts when ready.';
    }
  }

  private async holdActiveDraft(): Promise<boolean> {
    if (!window.posApi || !this.draft) return false;
    const result = await window.posApi.refunds.hold(this.draft.id, this.context().userId, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not hold the refund.';
      return false;
    }
    this.draft = null;
    await this.loadActiveDrafts();
    return true;
  }

  async clear(): Promise<void> {
    if (await this.clearActiveDraft()) {
      this.pendingSourceInvoiceId = null;
      this.info = 'Refund draft cleared and recorded as abandoned.';
    }
  }

  private async clearActiveDraft(): Promise<boolean> {
    if (!window.posApi || !this.draft) return false;
    const result = await window.posApi.refunds.abandon(this.draft.id, this.context().userId, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not clear the refund.';
      return false;
    }
    this.draft = null;
    await this.loadActiveDrafts();
    return true;
  }

  async loadActiveDrafts(): Promise<void> {
    if (!window.posApi) return;
    const ctx = this.context();
    if (!ctx.locCode || !ctx.macCode || !ctx.txnDate) return;
    const result = await window.posApi.refunds.listActive({ locCode: ctx.locCode, macCode: ctx.macCode, txnDate: ctx.txnDate }, this.actor());
    if (result.success) this.activeDrafts = result.data || [];
  }

  private async resumeSingleOpenDraft(): Promise<void> {
    const userId = this.context().userId;
    const ownOpenDrafts = this.activeDrafts.filter((draft) => draft.status === 'open' && draft.userId === userId);
    if (ownOpenDrafts.length !== 1) return;
    if (await this.loadDraft(ownOpenDrafts[0].id)) {
      this.info = `Resumed refund draft #${ownOpenDrafts[0].refundNo}.`;
    }
  }

  async resumeDraft(draft: RefundActiveDraft): Promise<void> {
    if (!window.posApi) return;
    if (this.draft && this.draft.id !== draft.id && this.draft.items.length > 0) {
      const shouldHold = window.confirm('Hold the current refund and resume the selected refund draft?');
      if (!shouldHold || !(await this.holdActiveDraft())) return;
    }
    this.error = '';
    const result = await window.posApi.refunds.resume(draft.id, this.context().userId, this.actor());
    if (!result.success) {
      this.error = result.error || 'Could not resume the refund draft.';
      return;
    }
    if (!result.data) {
      this.error = 'Refund draft was not found.';
      return;
    }
    this.draft = result.data;
    if (!this.source || this.source.id !== result.data.source_invoice_id) {
      const sourceResult = await window.posApi.refunds.getSource(result.data.source_invoice_id, this.actor());
      if (!sourceResult.success) {
        this.error = sourceResult.error || 'Could not load the original sale for this refund.';
        return;
      }
      this.source = sourceResult.data;
    }
    this.reason = result.data.reason || '';
    this.info = `Refund draft #${draft.refundNo} resumed.`;
    await this.loadActiveDrafts();
  }

  async loadPaymentModes(): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.billing.paymentModes(this.actor());
    if (result.success) this.paymentModes = (result.data || []).filter((mode) =>
      mode.type === 'tender' && mode.configuration?.['supportsRefundPayout'] !== false);
  }

  async complete(): Promise<void> {
    if (!window.posApi || !this.draft || this.grandTotal <= 0) return;
    this.error = '';
    if (this.payoutMethod === 'advance' && Number(this.source?.advanceRestorable || 0) + 0.005 < this.payoutDue) {
      this.error = `Only ${Number(this.source?.advanceRestorable || 0).toFixed(2)} from this invoice can be restored to customer advance.`;
      return;
    }
    this.isFinalizing = true;
    try {
      if (this.payoutNeedsFund && !this.payoutFundId) {
        this.error = 'Choose the account this refund is paid from.';
        this.isFinalizing = false;
        return;
      }
      const payments: PaymentLine[] = this.payoutDue > 0.005
        ? [{ method: this.payoutMethod, amount: this.payoutDue, fundAccountId: this.payoutNeedsFund ? this.payoutFundId : null }]
        : [];
      const result = await window.posApi.refunds.finalize({
        draftId: this.draft.id,
        payments,
        userId: this.context().userId,
        sessionId: this.context().sessionId,
        reason: this.reason
      }, this.actor());
      if (!result.success) {
        this.error = result.error || 'Refund completion failed.';
        return;
      }
      await this.printReceipt(result.data.refundNumber, result.data.refundNo, result.data.grandTotal);
      this.info = `Refund ${result.data.refundNumber} completed.`;
      this.draft = null;
      await this.selectSource(this.source?.id || 0);
      await this.loadActiveDrafts();
    } finally {
      this.isFinalizing = false;
    }
  }

  private formatRefundReceiptDateTime(value: Date): string {
    return new Intl.DateTimeFormat('en-LK', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(value).replace(',', '');
  }
  refundModeName(mode: PaymentMode): string { return mode.id === 'advance' ? 'Restore to Customer Advance' : mode.name; }

  private async printReceipt(refundNumber: string, refundNo: number, total: number): Promise<void> {
    if (!this.source || !window.posApi) return;
    const settingsResult = await window.posApi.settings.getReceipt();
    const settings = settingsResult.success ? settingsResult.data : null;
    const items = this.draft?.items || [];
    const doc: PrintDocument = {
      documentTitle: 'Refund Voucher',
      brand: settings ? {
        name: settings.storeName,
        tagline: settings.tagline,
        addressLines: settings.addressLines,
        phone: settings.phone
      } : { name: 'POS Platform' },
      logoDataUrl: settings?.logoDataUrl || undefined,
      secondaryHeaderLines: settings?.headers.map((text) => ({ text, align: 'center' })) || [],
      meta: [
        // Keep the customer-facing refund reference short. The full portable
        // document identifier remains stored in the database and archive.
        { label: 'Refund', value: `R${refundNo || refundNumber}` },
        { label: 'Original', value: `Receipt #${this.source.receipt_no}` },
        { label: 'Date', value: this.formatRefundReceiptDateTime(new Date()) },
        { label: 'Terminal', value: `${this.source.loc_code}/${this.source.mac_code}` },
        ...(this.source.customer_code ? [{ label: 'Customer', value: this.source.customer_code }] : []),
        { label: 'Cashier', value: this.session.getUser()?.displayName || '' }
      ],
      itemLayout: 'invoice-measures',
      receiptLanguage: settings?.language || 'en-LK',
      quantityTotal: this.formatMeasure(items.reduce((sum, item) => sum + Number(item.returnQuantity || 0), 0)),
      items: items.map((item) => ({
        description: `${this.itemCode(item)} ${item.description}`.trim(),
        qty: item.returnKilos !== null ? `${this.formatMeasure(item.returnKilos)} kg x ${item.unitPrice.toFixed(2)}` : `${this.formatMeasure(item.returnQuantity)} x ${item.unitPrice.toFixed(2)}`,
        amount: `${settings?.currencySymbol || 'Rs.'} ${item.merchandiseTotal.toFixed(2)}`,
        measure: {
          qty: this.formatMeasure(item.returnQuantity),
          ...(item.returnKilos !== null ? { kilos: this.formatMeasure(item.returnKilos) } : {}),
          rate: item.unitPrice.toFixed(2)
        }
      })),
      totals: [
        { label: 'Subtotal', value: `${settings?.currencySymbol || 'Rs.'} ${(items.reduce((sum, item) => sum + item.merchandiseTotal, 0)).toFixed(2)}` },
        ...(items.some((item) => item.bagChargeTotal > 0) ? [{ label: 'Bag Charge', value: `${settings?.currencySymbol || 'Rs.'} ${(items.reduce((sum, item) => sum + item.bagChargeTotal, 0)).toFixed(2)}` }] : []),
        ...(items.some((item) => item.wageChargeTotal > 0) ? [{ label: 'Wage Charge', value: `${settings?.currencySymbol || 'Rs.'} ${(items.reduce((sum, item) => sum + item.wageChargeTotal, 0)).toFixed(2)}` }] : []),
        { label: 'REFUND TOTAL', value: `${settings?.currencySymbol || 'Rs.'} ${total.toFixed(2)}`, bold: true }
      ],
      footerLines: settings?.footers || []
    };
    await this.printing.printDocument(doc);
  }
}
