import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import { ItemMeasureSummary, itemMeasureSummaryText, summarizeItemMeasures } from '../services/item-measure-summary';
import type { FundAccount, InvoiceArchive, PaymentMode, PrintDocument, PrintTextLine } from '../../../../../../packages/shared/ipc/pos-api';

type InvoiceRow = Pick<InvoiceArchive, 'id' | 'invoice_number' | 'loc_code' | 'mac_code' | 'receipt_no' | 'txn_date' | 'status' | 'subtotal' | 'grandTotal' | 'paidTotal' | 'balance' | 'customer_code'>;

@Component({ selector: 'pos-invoice-history', templateUrl: './invoice-history.component.html', styleUrls: ['./invoice-history.component.css'] })
export class InvoiceHistoryComponent implements OnInit {
  term = ''; customerCode = ''; locCode = ''; macCode = ''; txnDate = '';
  rows: InvoiceRow[] = []; invoice: any = null;
  paymentModes: PaymentMode[] = []; collectionAmount = 0; collectionMethod = 'cash'; collecting = false;
  settlementFunds: FundAccount[] = []; collectionFundAccountId: number | null = null;
  advanceAvailable = 0; advanceBalanceLoading = false;
  error = ''; info = ''; loading = false;
  accountTerm = ''; accountMatches: any[] = []; assignmentReason = ''; assigningCustomer = false;
  private receiptSettings: any = null;

  constructor(public session: SessionService, private printing: PrintingService) {}
  private actor() { return this.session.getActor() || undefined; }

  async ngOnInit(): Promise<void> {
    const ws = this.session.getWorkstationSession();
    this.locCode = ws?.locationCode || ''; this.macCode = ws?.machineCode || ''; this.txnDate = ws?.billingDate || '';
    await Promise.all([this.search(), this.loadReceiptContext(), this.loadPaymentModes(), this.loadSettlementFunds()]);
  }

  async loadSettlementFunds(): Promise<void> {
    if (!window.posApi || !this.locCode) return;
    const result = await window.posApi.funds.list(this.locCode, false, this.actor());
    this.settlementFunds = result.success
      ? (result.data || []).filter((fund) => fund.fundKind === 'bank' || fund.fundKind === 'cash_safe')
      : [];
    this.collectionFundAccountId = this.settlementFunds.find((fund) => fund.fundKind === 'bank')?.id
      || this.settlementFunds[0]?.id || null;
  }

  async loadPaymentModes(): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.billing.paymentModes(this.actor());
    if (!result.success) return;
    this.paymentModes = (result.data || []).filter((mode) => mode.type === 'tender');
    if (this.paymentModes.length && !this.paymentModes.some((mode) => mode.id === this.collectionMethod)) {
      this.collectionMethod = this.paymentModes[0].id;
    }
  }

  async loadReceiptContext(): Promise<void> {
    if (!window.posApi) return;
    const settings = await window.posApi.settings.getReceipt();
    this.receiptSettings = settings.success ? settings.data : null;
  }

  async search(): Promise<void> {
    if (!window.posApi) return;
    this.loading = true; this.error = ''; this.invoice = null;
    try {
      const result = await window.posApi.billing.searchInvoices({ term: this.term, customerCode: this.customerCode, locCode: this.locCode, macCode: this.macCode, txnDate: this.txnDate }, this.actor());
      if (!result.success) throw new Error(result.error || 'Could not search invoices.');
      this.rows = result.data || [];
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not search invoices.'; }
    finally { this.loading = false; }
  }

  async select(row: InvoiceRow): Promise<void> {
    if (!window.posApi) return;
    this.error = ''; this.info = '';
    const result = await window.posApi.billing.getInvoice(row.id, this.actor());
    if (!result.success || !result.data) { this.error = result.success ? 'Invoice was not found.' : result.error || 'Invoice was not found.'; return; }
    this.invoice = result.data;
    this.collectionAmount = Number(this.invoice.balance || 0);
    await this.loadAdvanceBalance();
  }

  /** Stored advance is location-scoped, so it is read for the terminal doing the collection. */
  async loadAdvanceBalance(): Promise<void> {
    this.advanceAvailable = 0;
    const ws = this.session.getWorkstationSession();
    if (!window.posApi || !ws || !this.invoice?.customer?.id || !this.session.hasPermission('customer-advances.view')) {
      if (this.collectionMethod === 'advance') this.collectionMethod = this.collectionModes[0]?.id || 'cash';
      return;
    }
    this.advanceBalanceLoading = true;
    const result = await window.posApi.customerAdvances.balance(this.invoice.customer.id, ws.locationCode, this.actor());
    this.advanceBalanceLoading = false;
    this.advanceAvailable = result.success ? Number(result.data || 0) : 0;
    if (this.collectionMethod === 'advance' && this.advanceAvailable <= 0.005) {
      this.collectionMethod = this.collectionModes[0]?.id || 'cash';
    }
  }

  /** Advance only appears once the linked customer actually holds a balance here. */
  get collectionModes(): PaymentMode[] {
    return this.paymentModes.filter((mode) => mode.id !== 'advance' || this.advanceAvailable > 0.005);
  }
  get maxCollectionAmount(): number {
    const balance = Number(this.invoice?.balance || 0);
    return this.collectionMethod === 'advance' ? Math.min(balance, this.advanceAvailable) : balance;
  }
  onCollectionMethodChange(): void {
    if (this.collectionAmount > this.maxCollectionAmount) this.collectionAmount = this.maxCollectionAmount;
  }
  get collectionNeedsFund(): boolean { return !['cash', 'cheque', 'advance'].includes(this.collectionMethod); }

  async collectBalance(): Promise<void> {
    if (!window.posApi || !this.invoice || this.collecting) return;
    const workstation = this.session.getWorkstationSession();
    const user = this.session.getUser();
    if (!workstation || !user) { this.error = 'An active workstation session and cashier are required to collect a balance.'; return; }
    if (Number(this.collectionAmount) > this.maxCollectionAmount + 0.005) {
      this.error = this.collectionMethod === 'advance'
        ? `Only ${this.money(this.advanceAvailable)} of customer advance is available at this location.`
        : `Collection exceeds the outstanding balance (${this.money(Number(this.invoice.balance || 0))}).`;
      return;
    }
    this.collecting = true; this.error = ''; this.info = '';
    try {
      const result = await window.posApi.billing.collectInvoiceBalance({
        invoiceId: this.invoice.id,
        sessionId: workstation.sessionId,
        userId: user.id,
        payments: [{ method: this.collectionMethod, amount: Number(this.collectionAmount), fundAccountId: this.collectionNeedsFund ? this.collectionFundAccountId : null }]
      }, this.actor());
      if (!result.success) throw new Error(result.error || 'Could not collect the outstanding balance.');
      this.info = this.collectionMethod === 'advance'
        ? `${this.money(result.data.collected)} settled from stored advance. Remaining balance: ${this.money(result.data.balance)}.`
        : `${this.money(result.data.collected)} collected. Remaining balance: ${this.money(result.data.balance)}.`;
      const invoiceId = this.invoice.id;
      await this.search();
      await this.select({ id: invoiceId } as InvoiceRow);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not collect the outstanding balance.';
    } finally { this.collecting = false; }
  }

  private money(value: number): string { return `${this.receiptSettings?.currencySymbol || 'Rs.'} ${Number(value || 0).toFixed(2)}`; }
  formatSriLankanDate(value: unknown): string {
    if (!value) return '';
    const raw = String(value);
    const sqlDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (sqlDate) return `${sqlDate[3]}/${sqlDate[2]}/${sqlDate[1]}`;

    const date = value instanceof Date ? value : new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Colombo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date);
  }
  paymentLabel(payment: any): string {
    const method = String(payment?.method || '');
    if (method === 'advance') return 'Advance';
    if (method !== 'cheque') return method;
    const number = String(payment?.chequeDetails?.number || payment?.providerRef || payment?.cheque_number || '').trim();
    return number ? `Cheque #${number}` : 'Cheque';
  }

  async searchAccounts(): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.catalog.searchCustomers(this.accountTerm, this.actor(), {
      outstandingOnly: false, balanceOrder: 'desc', activityOrder: 'desc'
    });
    this.accountMatches = result.success ? (result.data || []).slice(0, 10) : [];
  }

  async assignCustomerAccount(accountId: number | null): Promise<void> {
    if (!window.posApi || !this.invoice || this.assigningCustomer) return;
    if (this.invoice.customer && accountId !== this.invoice.customer.id && !this.assignmentReason.trim()) {
      this.error = 'Enter a reason before changing the linked customer account.';
      return;
    }
    const workstation = this.session.getWorkstationSession(); const user = this.session.getUser();
    if (!workstation || !user) { this.error = 'An active workstation session is required.'; return; }
    this.assigningCustomer = true; this.error = ''; this.info = '';
    try {
      const result = await window.posApi.catalog.assignInvoiceCustomer({
        invoiceId: this.invoice.id, customerAccountId: accountId, reason: this.assignmentReason,
        userId: user.id,
        origin: { locCode: workstation.locationCode, macCode: workstation.machineCode, txnDate: workstation.billingDate }
      }, this.actor());
      if (!result.success) throw new Error(result.error || 'Could not update the invoice customer account.');
      const id = this.invoice.id; this.accountMatches = []; this.accountTerm = ''; this.assignmentReason = '';
      await this.select({ id } as InvoiceRow);
      this.info = accountId ? 'Invoice linked to the selected customer account.' : 'Customer account link removed.';
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not update the invoice customer account.'; }
    finally { this.assigningCustomer = false; }
  }
  headerValues(): Array<{ label: string; value: string }> {
    return [];
  }
  itemExtras(item: any): Array<{ label: string; value: string }> {
    return [];
  }
  get itemMeasureSummaries(): ItemMeasureSummary[] {
    return summarizeItemMeasures(this.invoice?.items || []);
  }
  itemMeasureSummaryText(summary: ItemMeasureSummary): string { return itemMeasureSummaryText(summary); }
  trackItemMeasureSummary(_index: number, summary: ItemMeasureSummary): string { return summary.key; }
  scrollItemMeasureSummary(event: WheelEvent, element: HTMLElement): void {
    if (element.scrollWidth <= element.clientWidth) return;
    const movement = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    element.scrollLeft += movement;
    event.preventDefault();
  }
  itemQuantityLabel(item: any): string {
    const kilos = item.kilos;
    const qty = this.formatMeasure(item.qty);
    if (kilos !== undefined && kilos !== null && kilos !== '') {
      return `${qty} qty / ${this.formatMeasure(kilos)} kg x ${Number(item.unitPrice).toFixed(2)} per ${item.pricingBasis === 'kilos' ? 'kg' : 'qty'}`;
    }
    return `${qty} x ${Number(item.unitPrice).toFixed(2)}`;
  }
  itemMeasure(item: any): NonNullable<PrintDocument['items'][number]['measure']> {
    return {
      qty: this.formatMeasure(item.qty),
      ...(item.kilos !== undefined && item.kilos !== null && item.kilos !== '' ? { kilos: this.formatMeasure(item.kilos) } : {}),
      rate: Number(item.unitPrice || 0).toFixed(2)
    };
  }
  itemCode(item: any): string { return item.supplier_code ? `${item.supplier_code}~${item.item_code}` : item.item_code || ''; }
  supplierCode(item: any): string { return String(item.supplier_code || '').trim(); }
  formatMeasure(value: unknown): string { const amount = Number(value || 0); return Number.isInteger(amount) ? String(amount) : amount.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); }
  private receiptIdentityLines(customerCode: string): PrintTextLine[] {
    const tagline = String(this.receiptSettings?.tagline || '').trim();
    const customer = String(customerCode || '').trim().toUpperCase();
    if (!tagline && !customer) return [];
    const width = 24;
    if (!tagline) return [{ text: customer.slice(0, width), align: 'right', bold: true, size: 1, identity: { left: '', right: customer.slice(0, width) } }];
    if (!customer) return [{ text: tagline.slice(0, width), align: 'left', bold: true, size: 1, identity: { left: tagline.slice(0, width), right: '' } }];
    const right = customer.slice(0, Math.floor(width / 2));
    const left = tagline.slice(0, Math.max(1, width - right.length - 1));
    return [{ text: `${left}${' '.repeat(Math.max(1, width - left.length - right.length))}${right}`, align: 'left', bold: true, size: 1, identity: { left, right } }];
  }
  private document(): PrintDocument {
    const i = this.invoice; if (!i) throw new Error('Choose an invoice first.');
    const s = this.receiptSettings || {}; const headers = (s.headers || []).filter(Boolean); const footers = (s.footers || []).filter(Boolean);
    return {
      documentTitle: 'Tax Invoice',
      brand: { name: s.storeName || 'POS Platform', tagline: '', addressLines: s.addressLines || [], phone: s.phone || '' },
      logoDataUrl: s.logoDataUrl || undefined,
      secondaryHeaderLines: [
        ...headers.map((text: string) => ({ text, align: 'center' as const })),
        ...this.receiptIdentityLines(i.customer_code || '')
      ],
      meta: [
        { label: 'Receipt', value: `#${i.receipt_no}` },
        // Retain invoice_number for lookup and PDF filenames, but omit it from reprinted receipts.
        // { label: 'Invoice', value: i.invoice_number },
        { label: 'Date', value: String(i.txn_date).slice(0, 10) }, { label: 'Terminal', value: `${i.loc_code}/${i.mac_code}` },
        ...(i.customer_code ? [{ label: 'Customer', value: i.customer_code }] : []), ...this.headerValues()
      ],
      itemLayout: 'invoice-measures',
      receiptLanguage: s.language || 'en-LK',
      rasterHeaderLayout: 'billing',
      quantityTotal: this.formatMeasure(i.items.reduce((sum: number, item: any) => sum + Number(item.qty || 0), 0)),
      items: i.items.map((item: any) => ({
        // description: `${this.itemCode(item) ? `${this.itemCode(item)} ` : ''}${item.description}`,
        description: `${this.supplierCode(item) ? `${this.supplierCode(item)}~` : ''}${item.description}`,
        qty: this.itemQuantityLabel(item), amount: this.money(item.merchandiseTotal ?? item.total), measure: this.itemMeasure(item), extras: this.itemExtras(item)
      })),
      totals: [
        { label: 'Subtotal', value: this.money(i.subtotal) }, ...(i.discountTotal > 0 ? [{ label: 'Discount', value: `-${this.money(i.discountTotal)}` }] : []),
        ...(Number(i.bag_charge_total || 0) > 0 ? [{ label: 'Bag Charge', value: this.money(i.bag_charge_total) }] : []),
        ...(Number(i.wage_charge_total || 0) > 0 ? [{ label: 'Wage Charge', value: this.money(i.wage_charge_total) }] : []),
        { label: 'TOTAL', value: this.money(i.grandTotal), bold: true }, ...i.payments.filter((p: any) => p.method !== 'pending').map((p: any) => ({ label: this.paymentLabel(p), value: this.money(p.amount) })), ...(i.balance > 0 ? [{ label: 'Pending Balance', value: this.money(i.balance) }] : [])
      ], footerLines: footers
    };
  }
  async reprint(): Promise<void> { try { const result = await this.printing.printDocument(this.document()); this.info = result.success ? 'Invoice sent to the receipt printer.' : result.error || 'Print failed.'; } catch (e) { this.error = e instanceof Error ? e.message : 'Print failed.'; } }
  async savePdf(): Promise<void> { if (!window.posApi || !this.invoice) return; const result = await window.posApi.printing.savePdf(this.document(), { prompt: true, fileName: `${this.invoice.invoice_number}.pdf` }, this.actor()); if (!result.success) this.error = result.error || 'PDF save failed.'; else if (!result.data.canceled) this.info = `PDF saved to ${result.data.filePath}.`; }
}
