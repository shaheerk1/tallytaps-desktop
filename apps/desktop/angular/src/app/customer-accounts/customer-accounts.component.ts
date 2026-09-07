import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type { CustomerAdvanceSummary, FundAccount, PaymentMode } from '../../../../../../packages/shared/ipc/pos-api';

type Customer = {
  id: number; account_number?: string; name: string; shop_name?: string | null; locality?: string | null;
  mobile?: string | null; phone?: string | null; marketCodes?: string[]; outstandingBalance: number;
  lastActivityAt?: string | null; creditEnabled?: boolean;
};

@Component({ selector: 'pos-customer-accounts', templateUrl: './customer-accounts.component.html', styleUrls: ['./customer-accounts.component.css'] })
export class CustomerAccountsComponent implements OnInit {
  term = ''; outstandingOnly = true;
  sortMode: 'balance_desc' | 'balance_asc' | 'activity_desc' | 'activity_asc' = 'balance_desc';
  rows: Customer[] = []; account: any = null; editor: any = null; error = ''; info = ''; saving = false;
  fromDate = ''; toDate = '';
  advanceSummary: CustomerAdvanceSummary | null = null;
  advanceEditor: { mode: 'receive' | 'refund'; amount: number; method: string; fundAccountId: number | null; providerRef: string; reason: string } | null = null;
  advancePaymentModes: PaymentMode[] = [];
  advanceFunds: FundAccount[] = [];
  private receiptSettings: any = null;

  constructor(public session: SessionService, private printing: PrintingService) {}
  private actor() { return this.session.getActor() || undefined; }
  get canManage(): boolean { return this.session.hasPermission('customers.manage'); }
  get canReceiveAdvance(): boolean { return this.session.hasPermission('customer-advances.create'); }
  get canRefundAdvance(): boolean { return this.session.hasPermission('customer-advances.refund'); }
  private origin() { const ws = this.session.getWorkstationSession(); return ws ? { locCode: ws.locationCode, macCode: ws.machineCode, txnDate: ws.billingDate } : null; }

  async ngOnInit(): Promise<void> { await Promise.all([this.search(), this.loadReceiptSettings()]); }

  private async loadReceiptSettings(): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.settings.getReceipt();
    this.receiptSettings = result.success ? result.data : null;
  }
  @HostListener('document:keydown.escape') onEscape(): void { if (this.account || this.editor) this.closeWorkspace(); }
  get totalOutstanding(): number { return this.rows.reduce((sum, row) => sum + Number(row.outstandingBalance || 0), 0); }
  get creditCustomerCount(): number { return this.rows.filter((row) => row.creditEnabled).length; }

  async search(): Promise<void> {
    if (!window.posApi) return;
    const balanceOrder = this.sortMode === 'balance_asc' ? 'asc' : 'desc';
    const activityOrder = this.sortMode === 'activity_asc' ? 'asc' : 'desc';
    const result = await window.posApi.catalog.searchCustomers(this.term, this.actor(), {
      outstandingOnly: this.outstandingOnly, balanceOrder, activityOrder,
      sortBy: this.sortMode.startsWith('activity') ? 'activity' : 'balance'
    } as any);
    if (!result.success) { this.error = result.error || 'Could not load customer accounts.'; return; }
    this.rows = result.data || [];
  }

  async select(id: number): Promise<void> {
    if (!window.posApi) return; this.error = ''; this.info = '';
    const result = await window.posApi.catalog.getCustomerAccount(id, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load this account.'; return; }
    this.account = result.data; this.editor = null; this.advanceEditor = null;
    await this.loadAdvanceSummary();
  }

  closeWorkspace(): void { this.account = null; this.editor = null; this.advanceEditor = null; this.advanceSummary = null; }
  cancelEditor(): void { if (this.account) this.editor = null; else this.closeWorkspace(); }

  newCustomer(): void {
    this.account = null;
    this.editor = { name: '', legalName: '', partyType: 'other', shopName: '', marketCodesText: '', phone: '', mobile: '', email: '', address: '', locality: '', secondaryTag: '', notes: '', creditEnabled: false, creditLimit: '', paymentTermsDays: 0, isActive: true };
  }

  edit(): void {
    if (!this.account) return; const c = this.account.customer;
    this.editor = { name: c.name, legalName: c.legalName || '', partyType: c.partyType || 'other', shopName: c.shopName || '', marketCodesText: (c.marketCodes || []).join(', '), phone: c.phone || '', mobile: c.mobile || '', email: c.email || '', address: c.address || '', locality: c.locality || '', secondaryTag: c.secondaryTag || '', notes: c.notes || '', creditEnabled: !!c.creditEnabled, creditLimit: c.creditLimit ?? '', paymentTermsDays: c.paymentTermsDays || 0, isActive: !!c.is_active };
  }

  private dateKey(value: unknown): string {
    const date = value instanceof Date ? value : new Date(String(value)); if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  formatSriLankanDate(value: unknown, includeTime = false): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: '2-digit', year: 'numeric', ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(date);
  }
  filteredEntries(): any[] { return (this.account?.entries || []).filter((entry: any) => { const date = this.dateKey(entry.transaction_date || entry.created_at); return (!this.fromDate || date >= this.fromDate) && (!this.toDate || date <= this.toDate); }); }

  async printStatement(): Promise<void> {
    if (!this.account) return; const c = this.account.customer;
    const result = await this.printing.printDocument({ brand: { name: 'Customer Statement' }, meta: [{ label: 'Account', value: c.accountNumber }, { label: 'Customer', value: c.name }, ...(c.marketCodes?.length ? [{ label: 'Market codes', value: c.marketCodes.join(', ') }] : []), ...(c.mobile ? [{ label: 'Mobile', value: c.mobile }] : []), { label: 'Outstanding', value: Number(c.outstandingBalance).toFixed(2) }], items: this.filteredEntries().map((entry: any) => ({ description: `${entry.entry_type} ${entry.invoice_number || entry.refund_number || ''}`, qty: this.dateKey(entry.transaction_date || entry.created_at), amount: Number(entry.amount).toFixed(2) })), totals: [{ label: 'ACCOUNT OUTSTANDING', value: Number(c.outstandingBalance).toFixed(2), bold: true }] });
    this.info = result.success ? 'Customer statement sent to the printer.' : result.error || 'Statement print failed.';
  }

  async save(): Promise<void> {
    if (!window.posApi || !this.editor || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) { this.error = 'An active workstation session is required to save a customer.'; return; }
    this.saving = true; this.error = '';
    const customer = { ...this.editor, marketCodes: String(this.editor.marketCodesText || '').split(',').map((value: string) => value.trim().toUpperCase()).filter(Boolean), origin, userId: user.id };
    const result = this.account ? await window.posApi.catalog.updateCustomer(this.account.customer.id, customer, this.actor()) : await window.posApi.catalog.createCustomer(customer, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not save customer.'; return; }
    this.account = result.data; this.editor = null; this.info = 'Customer account saved.'; await this.search();
  }

  async loadAdvanceSummary(): Promise<void> {
    const origin = this.origin();
    if (!window.posApi || !origin || !this.account?.customer?.id || !this.session.hasPermission('customer-advances.view')) {
      this.advanceSummary = null; return;
    }
    const result = await window.posApi.customerAdvances.summary(this.account.customer.id, origin.locCode, this.actor());
    if (result.success) this.advanceSummary = result.data;
    else this.error = result.error || 'Could not load customer advance balance.';
  }

  async openAdvanceEditor(mode: 'receive' | 'refund'): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.billing.paymentModes(this.actor());
    this.advancePaymentModes = result.success ? (result.data || []).filter((item) =>
      item.type === 'tender' && item.id !== 'advance' && item.id !== 'cheque') : [];
    const origin = this.origin();
    const funds = origin ? await window.posApi.funds.list(origin.locCode, false, this.actor()) : null;
    this.advanceFunds = funds?.success
      ? (funds.data || []).filter((fund) => fund.fundKind === 'bank' || fund.fundKind === 'cash_safe')
      : [];
    const fundAccountId = this.advanceFunds.find((fund) => fund.fundKind === 'bank')?.id || this.advanceFunds[0]?.id || null;
    this.advanceEditor = { mode, amount: 0, method: this.advancePaymentModes[0]?.id || 'cash', fundAccountId, providerRef: '', reason: '' };
  }

  get advanceNeedsFund(): boolean { return Boolean(this.advanceEditor && this.advanceEditor.method !== 'cash'); }

  async saveAdvance(): Promise<void> {
    if (!window.posApi || !this.advanceEditor || !this.account?.customer?.id || this.saving) return;
    const ws = this.session.getWorkstationSession(); const user = this.session.getUser();
    if (!ws || !user) { this.error = 'An active workstation session and cash shift are required.'; return; }
    this.saving = true; this.error = '';
    const mode = this.advanceEditor.mode;
    const base = { customerAccountId: this.account.customer.id, sessionId: ws.sessionId, userId: user.id,
      amount: Number(this.advanceEditor.amount), method: this.advanceEditor.method,
      fundAccountId: this.advanceNeedsFund ? this.advanceEditor.fundAccountId : null,
      providerRef: this.advanceEditor.providerRef || null, reason: this.advanceEditor.reason };
    const result = mode === 'receive'
      ? await window.posApi.customerAdvances.receive({ ...base, payments: [{ method: base.method, amount: base.amount, fundAccountId: base.fundAccountId, providerRef: base.providerRef }] }, this.actor())
      : await window.posApi.customerAdvances.refund(base, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not record the customer advance transaction.'; return; }
    const saved = result.data as { advanceNumber?: string; refundNumber?: string };
    this.info = mode === 'receive'
      ? `Advance ${saved.advanceNumber} received.`
      : `Unused advance refund ${saved.refundNumber} recorded.`;
    const printed = await this.printAdvanceReceipt(mode, {
      number: (mode === 'receive' ? saved.advanceNumber : saved.refundNumber) || '',
      amount: Number((result.data as { amount?: number }).amount || base.amount),
      balance: Number((result.data as { availableBalance?: number }).availableBalance || 0),
      method: base.method, reason: base.reason
    });
    if (!printed.success) this.info += ` Receipt print failed: ${printed.error || 'printer unavailable'}.`;
    this.advanceEditor = null;
    await this.loadAdvanceSummary();
  }

  /**
   * Every advance movement hands the customer a numbered slip. The advance is a
   * liability, not a sale, so the document deliberately carries no invoice,
   * item or tax lines.
   */
  private async printAdvanceReceipt(
    mode: 'receive' | 'refund',
    advance: { number: string; amount: number; balance: number; method: string; reason: string }
  ): Promise<{ success: boolean; error?: string }> {
    const settings = this.receiptSettings || {};
    const ws = this.session.getWorkstationSession();
    const customer = this.account?.customer;
    const currency = settings.currencySymbol || 'Rs.';
    const money = (value: number) => `${currency} ${Number(value || 0).toFixed(2)}`;
    const title = mode === 'receive' ? 'CUSTOMER ADVANCE RECEIPT' : 'ADVANCE REFUND VOUCHER';
    return this.printing.printDocument({
      documentTitle: title,
      brand: { name: settings.storeName || 'POS Platform', addressLines: settings.addressLines || [], phone: settings.phone || '' },
      logoDataUrl: settings.logoDataUrl || undefined,
      secondaryHeaderLines: [{ text: title, align: 'center', bold: true }],
      meta: [
        { label: 'Document', value: advance.number },
        { label: 'Date', value: this.formatSriLankanDate(ws?.billingDate || new Date().toISOString()) },
        { label: 'Terminal', value: ws ? `${ws.locationCode}/${ws.machineCode}` : '' },
        { label: 'Cashier', value: this.session.getUser()?.displayName || '' },
        { label: 'Account', value: customer?.accountNumber || '' },
        { label: 'Customer', value: customer?.name || '' }
      ].filter((row) => String(row.value || '').trim()),
      items: [{
        description: mode === 'receive'
          ? `Advance received by ${advance.method}`
          : `Unused advance returned by ${advance.method}`,
        amount: money(advance.amount)
      }],
      totals: [
        { label: mode === 'receive' ? 'ADVANCE RECEIVED' : 'ADVANCE REFUNDED', value: money(advance.amount), bold: true },
        { label: 'Advance balance now', value: money(advance.balance) }
      ],
      footerLines: [
        advance.reason ? `Reason: ${advance.reason}` : '',
        'This is not a sales invoice. The amount above is held to your account',
        'until it is used on a bill or returned to you.',
        ...(settings.footers || []).filter(Boolean)
      ].filter(Boolean)
    });
  }
}
