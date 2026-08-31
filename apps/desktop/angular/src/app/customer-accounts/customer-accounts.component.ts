import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';

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

  constructor(public session: SessionService, private printing: PrintingService) {}
  private actor() { return this.session.getActor() || undefined; }
  get canManage(): boolean { return this.session.hasPermission('customers.manage'); }
  private origin() { const ws = this.session.getWorkstationSession(); return ws ? { locCode: ws.locationCode, macCode: ws.machineCode, txnDate: ws.billingDate } : null; }

  async ngOnInit(): Promise<void> { await this.search(); }
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
    this.account = result.data; this.editor = null;
  }

  closeWorkspace(): void { this.account = null; this.editor = null; }
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
}
