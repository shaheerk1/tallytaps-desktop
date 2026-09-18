import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import type {
  FundAccount, SupplierAccountLine, SupplierAccountSheet, SupplierAccountSummary
} from '../../../../../../packages/shared/ipc/pos-api';

type BalanceFilter = '' | 'owed' | 'owes_us' | 'settled';
type EntryForm =
  | { kind: 'payment'; supplierId: number; supplierName: string; balance: number; amount: number | null; fundAccountId: number | null; reference: string; note: string; paidOn: string; paidOnReason: string; requestId: string }
  | { kind: 'opening'; supplierId: number; supplierName: string; balance: number; amount: number | null; effect: 'owe_more' | 'owe_less'; note: string; paidOn: string; paidOnReason: string; requestId: string }
  | { kind: 'adjustment'; supplierId: number; supplierName: string; balance: number; amount: number | null; effect: 'owe_more' | 'owe_less'; reason: string; reference: string; paidOn: string; paidOnReason: string; requestId: string };

/**
 * Supplier accounts: who the business owes, and a shareable sheet of every
 * statement, payment and adjustment behind each balance.
 *
 * A balance is from the business's side: plus is what we owe the supplier,
 * minus is what the supplier owes us.
 */
@Component({
  selector: 'pos-supplier-accounts',
  templateUrl: './supplier-accounts.component.html',
  styleUrls: ['./supplier-accounts.component.css']
})
export class SupplierAccountsComponent implements OnInit {
  view: 'list' | 'sheet' = 'list';
  loading = false;
  saving = false;
  error = '';
  info = '';

  // List
  accounts: SupplierAccountSummary[] = [];
  term = '';
  balanceFilter: BalanceFilter = '';
  includeAll = false;

  // Sheet
  sheet: SupplierAccountSheet | null = null;
  sheetSupplierId: number | null = null;
  sheetView: 'detailed' | 'compact' = 'detailed';
  fromDate = '';
  toDate = '';
  reversingEntryId: number | null = null;
  reverseReason = '';

  // Forms
  form: EntryForm | null = null;
  funds: FundAccount[] = [];
  drawerId: number | null = null;

  constructor(private session: SessionService) {}

  get canManage(): boolean { return this.session.hasPermission('supplier-settlements.manage'); }
  get canBackdate(): boolean { return this.session.hasPermission('money.backdate'); }
  get today(): string { return String(this.session.getWorkstationSession()?.billingDate || '').slice(0, 10); }
  private actor() { return this.session.getActor() || undefined; }

  async ngOnInit(): Promise<void> {
    await this.loadAccounts();
  }

  @HostListener('document:keydown.escape') onEscape(): void {
    if (this.form) this.form = null;
    else if (this.reversingEntryId) this.cancelReverse();
  }

  // ── List ───────────────────────────────────────────────────

  async loadAccounts(): Promise<void> {
    if (!window.posApi) return;
    this.loading = true;
    const result = await window.posApi.supplierAccounts.list({ term: this.term.trim(), balance: this.balanceFilter, includeAll: this.includeAll }, this.actor());
    this.loading = false;
    if (!result.success) { this.error = result.error || 'Could not load supplier accounts.'; return; }
    this.accounts = result.data || [];
  }

  setBalanceFilter(filter: BalanceFilter): void {
    this.balanceFilter = filter;
    void this.loadAccounts();
  }

  get totalWeOwe(): number { return this.money(this.accounts.filter((row) => row.balance > 0).reduce((sum, row) => sum + row.balance, 0)); }
  get totalOwedToUs(): number { return this.money(this.accounts.filter((row) => row.balance < 0).reduce((sum, row) => sum - row.balance, 0)); }

  trackAccount(_index: number, row: SupplierAccountSummary): number { return row.supplierId; }

  // ── Sheet ──────────────────────────────────────────────────

  async openSheet(supplierId: number): Promise<void> {
    this.sheetSupplierId = supplierId;
    this.view = 'sheet';
    this.reversingEntryId = null;
    this.clearMessages();
    await this.loadSheet();
  }

  async backToList(): Promise<void> {
    this.view = 'list';
    this.sheet = null;
    this.sheetSupplierId = null;
    await this.loadAccounts();
  }

  async loadSheet(): Promise<void> {
    if (!window.posApi || !this.sheetSupplierId) return;
    this.loading = true;
    const result = await window.posApi.supplierAccounts.sheet({
      supplierId: this.sheetSupplierId, view: this.sheetView, fromDate: this.fromDate || undefined, toDate: this.toDate || undefined
    }, this.actor());
    this.loading = false;
    if (!result.success) { this.error = result.error || 'Could not load this supplier account.'; return; }
    this.sheet = result.data;
  }

  async setSheetView(view: 'detailed' | 'compact'): Promise<void> {
    if (this.sheetView === view) return;
    this.sheetView = view;
    await this.loadSheet();
  }

  async clearRange(): Promise<void> {
    this.fromDate = '';
    this.toDate = '';
    await this.loadSheet();
  }

  /** Lines of one statement share a reference and are drawn as one group. */
  startsGroup(index: number): boolean {
    const lines = this.sheet?.lines || [];
    if (index === 0) return true;
    const line = lines[index]; const previous = lines[index - 1];
    return !(line.statementId && line.kind === 'statement' && previous.statementId === line.statementId && previous.kind === 'statement');
  }

  trackLine(index: number, line: SupplierAccountLine): string {
    return `${line.statementId || ''}:${line.entryId || ''}:${line.kind}:${index}`;
  }

  kindLabel(line: SupplierAccountLine): string {
    const labels: Record<string, string> = {
      statement: 'Statement', statement_void: 'Voided', payment: 'Payment',
      opening_balance: 'Opening', adjustment: 'Adjustment', reversal: 'Reversal'
    };
    return labels[line.kind] || line.kind;
  }

  // ── Reversal ───────────────────────────────────────────────

  beginReverse(line: SupplierAccountLine): void {
    if (!line.entryId || !line.reversible) return;
    this.reversingEntryId = line.entryId;
    this.reverseReason = '';
  }

  cancelReverse(): void {
    this.reversingEntryId = null;
    this.reverseReason = '';
  }

  async confirmReverse(): Promise<void> {
    if (!window.posApi || !this.reversingEntryId || this.saving) return;
    if (!this.reverseReason.trim()) { this.error = 'Write why this entry is being reversed.'; return; }
    this.saving = true;
    const result = await window.posApi.supplierAccounts.reverse({ entryId: this.reversingEntryId, reason: this.reverseReason.trim() }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not reverse this entry.'; return; }
    this.info = `${result.data.reverses} reversed as ${result.data.entryNumber}. Balance now ${this.balanceText(result.data.balance)}.`;
    this.error = '';
    this.cancelReverse();
    await this.loadSheet();
  }

  // ── Forms ──────────────────────────────────────────────────

  async openPayment(supplierId: number, supplierName: string, balance: number): Promise<void> {
    this.clearMessages();
    await this.loadFunds();
    const drawer = this.funds.find((fund) => fund.fundKind === 'pos_drawer' && fund.cashDrawerId === this.drawerId);
    this.form = {
      kind: 'payment', supplierId, supplierName, balance,
      amount: balance > 0 ? this.money(balance) : null,
      fundAccountId: drawer?.id ?? this.payingFunds[0]?.id ?? null,
      reference: '', note: '', paidOn: this.today, paidOnReason: '', requestId: crypto.randomUUID()
    };
    this.focusFirstField();
  }

  openOpeningBalance(): void {
    if (!this.sheet) return;
    this.clearMessages();
    this.form = {
      kind: 'opening', supplierId: this.sheet.supplier.id, supplierName: this.sheet.supplier.name, balance: this.sheet.currentBalance,
      amount: null, effect: 'owe_more', note: '', paidOn: this.today, paidOnReason: '', requestId: crypto.randomUUID()
    };
    this.focusFirstField();
  }

  openAdjustment(): void {
    if (!this.sheet) return;
    this.clearMessages();
    this.form = {
      kind: 'adjustment', supplierId: this.sheet.supplier.id, supplierName: this.sheet.supplier.name, balance: this.sheet.currentBalance,
      amount: null, effect: 'owe_less', reason: '', reference: '', paidOn: this.today, paidOnReason: '', requestId: crypto.randomUUID()
    };
    this.focusFirstField();
  }

  closeForm(): void { this.form = null; }

  /** This counter's own drawer, then every other place money can come from. Other tills are counted by their own shifts. */
  get payingFunds(): FundAccount[] {
    const drawer = this.funds.find((fund) => fund.fundKind === 'pos_drawer' && fund.cashDrawerId === this.drawerId);
    return [...(drawer ? [drawer] : []), ...this.funds.filter((fund) => fund.isActive && fund.fundKind !== 'pos_drawer')];
  }

  get selectedFund(): FundAccount | null {
    const form = this.form;
    return form?.kind === 'payment' ? this.funds.find((fund) => fund.id === form.fundAccountId) || null : null;
  }

  fundLabel(fund: FundAccount): string {
    if (fund.fundKind === 'pos_drawer') return `This drawer · ${this.moneyText(fund.balance)}`;
    if (fund.fundKind === 'stakeholder') return `${fund.name} · partner's own money`;
    return `${fund.name} · ${this.moneyText(fund.balance)}`;
  }

  /** The balance this entry would leave, shown before saving. */
  get balanceAfter(): number {
    const form = this.form;
    if (!form) return 0;
    const amount = Number(form.amount || 0);
    if (form.kind === 'payment') return this.money(form.balance - amount);
    return this.money(form.balance + (form.effect === 'owe_more' ? amount : -amount));
  }

  isEarlier(form: { paidOn: string }): boolean {
    return Boolean(form.paidOn && this.today && form.paidOn !== this.today);
  }

  get formReady(): boolean {
    const form = this.form;
    if (!form || !(Number(form.amount) > 0)) return false;
    if (this.isEarlier(form) && !form.paidOnReason.trim()) return false;
    if (form.kind === 'payment') return Boolean(form.fundAccountId);
    if (form.kind === 'adjustment') return Boolean(form.reason.trim());
    return true;
  }

  async saveForm(): Promise<void> {
    const form = this.form;
    if (!window.posApi || !form || this.saving || !this.formReady) return;
    this.saving = true;
    const dated = this.isEarlier(form) ? { paidOn: form.paidOn, paidOnReason: form.paidOnReason.trim() } : {};
    const api = window.posApi.supplierAccounts;
    let message = '';
    if (form.kind === 'payment') {
      const result = await api.pay({
        supplierId: form.supplierId, fundAccountId: Number(form.fundAccountId), amount: Number(form.amount),
        reference: form.reference.trim(), note: form.note.trim(), requestId: form.requestId, ...dated
      }, this.actor());
      if (!result.success) { this.saving = false; this.error = result.error || 'Could not record this payment.'; return; }
      message = `${result.data.entryNumber}: paid ${form.supplierName} ${this.moneyText(result.data.amount)} from ${result.data.fundName}. Balance now ${this.balanceText(result.data.balance)}.`;
      if (result.data.stakeholderName) message += ` The business now owes ${result.data.stakeholderName} this amount.`;
    } else if (form.kind === 'opening') {
      const result = await api.openingBalance({ supplierId: form.supplierId, amount: Number(form.amount), effect: form.effect, note: form.note.trim(), requestId: form.requestId, ...dated }, this.actor());
      if (!result.success) { this.saving = false; this.error = result.error || 'Could not record the opening balance.'; return; }
      message = `Opening balance recorded as ${result.data.entryNumber}. Balance now ${this.balanceText(result.data.balance)}.`;
    } else {
      const result = await api.adjust({ supplierId: form.supplierId, amount: Number(form.amount), effect: form.effect, reason: form.reason.trim(), reference: form.reference.trim(), requestId: form.requestId, ...dated }, this.actor());
      if (!result.success) { this.saving = false; this.error = result.error || 'Could not record the adjustment.'; return; }
      message = `Adjustment recorded as ${result.data.entryNumber}. Balance now ${this.balanceText(result.data.balance)}.`;
    }
    this.saving = false;
    this.form = null;
    this.error = '';
    this.info = message;
    if (this.view === 'sheet') await this.loadSheet();
    else await this.loadAccounts();
  }

  onFormKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || (event.target as HTMLElement).tagName === 'INPUT')) {
      event.preventDefault();
      void this.saveForm();
    }
  }

  private focusFirstField(): void {
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.entry-drawer input[type="number"]');
      input?.focus();
      input?.select();
    });
  }

  private async loadFunds(): Promise<void> {
    const ws = this.session.getWorkstationSession();
    if (!window.posApi || !ws) return;
    const [funds, shift] = await Promise.all([
      window.posApi.funds.list(ws.locationCode, false, this.actor()),
      this.session.hasPermission('cash.shift.view') ? window.posApi.cash.activeShift(ws.sessionId, this.actor()) : Promise.resolve(null)
    ]);
    this.funds = funds.success ? funds.data || [] : [];
    this.drawerId = shift?.success && shift.data ? shift.data.drawerId : null;
  }

  // ── Sharing ────────────────────────────────────────────────

  async exportSheet(format: 'pdf' | 'xlsx'): Promise<void> {
    if (!window.posApi || !this.sheetSupplierId) return;
    const settings = await window.posApi.settings.getReceipt();
    const brand = settings.success && settings.data
      ? { name: settings.data.storeName, addressLines: settings.data.addressLines || [], phone: settings.data.phone || '' }
      : {};
    const result = await window.posApi.supplierAccounts.exportSheet({
      supplierId: this.sheetSupplierId, view: this.sheetView, fromDate: this.fromDate || undefined, toDate: this.toDate || undefined
    }, format, brand, this.actor());
    if (!result.success) { this.error = result.error || 'Could not save the account sheet.'; return; }
    if (!result.data?.canceled) this.info = `Saved to ${result.data?.filePath}.`;
  }

  // ── Formatting ─────────────────────────────────────────────

  balanceText(value: number): string {
    if (Math.abs(value) <= 0.005) return 'Settled';
    return value > 0 ? `${this.moneyText(value)} to pay` : `${this.moneyText(-value)} owed to us`;
  }

  moneyText(value: number | null | undefined): string {
    return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private money(value: number): number { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }

  clearMessages(): void { this.error = ''; this.info = ''; }
}
