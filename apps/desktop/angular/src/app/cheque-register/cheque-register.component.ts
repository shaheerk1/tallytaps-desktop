import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';

@Component({ selector: 'pos-cheque-register', templateUrl: './cheque-register.component.html', styleUrls: ['./cheque-register.component.css'] })
export class ChequeRegisterComponent implements OnInit {
  register: 'incoming' | 'issued' = 'incoming';
  error = ''; info = ''; updating = false;
  incomingTerm = ''; incomingStatus = 'open'; incomingFromDate = ''; incomingToDate = '';
  incoming: any[] = []; incomingDetail: any = null; incomingReason = ''; depositedTo = ''; incomingDepositFundId: number | null = null;
  incomingEditor: any = null;
  drawerTerm = ''; drawerMatches: any[] = [];
  issuedTerm = ''; issuedStatus = 'open'; issuedFromDate = ''; issuedToDate = '';
  issued: any[] = []; issuedDetail: any = null; issuedReason = '';
  bankAccounts: any[] = []; issuedEditor: any = null; bankEditor: any = null; showBankAccounts = false;

  constructor(public session: SessionService) {}
  private actor() { return this.session.getActor() || undefined; }
  get canManage(): boolean { return this.session.hasPermission('cheques.manage'); }
  get activeBankAccounts(): any[] {
    const locCode = this.session.getWorkstationSession()?.locationCode;
    return this.bankAccounts.filter((account) => account.is_active && account.fund_account_id && account.loc_code === locCode);
  }
  private origin() { const ws = this.session.getWorkstationSession(); return ws ? { locCode: ws.locationCode, macCode: ws.machineCode, txnDate: ws.billingDate } : null; }

  async ngOnInit(): Promise<void> { await Promise.all([this.loadIncoming(), this.loadIssued(), this.loadBankAccounts()]); }
  @HostListener('document:keydown.escape') onEscape(): void { this.closeOverlay(); }
  showRegister(register: 'incoming' | 'issued'): void { this.register = register; this.error = ''; this.info = ''; this.closeOverlay(); }
  closeOverlay(): void {
    if (this.incomingEditor) { this.incomingEditor = null; return; }
    this.incomingDetail = null; this.issuedDetail = null; this.issuedEditor = null;
    this.showBankAccounts = false; this.bankEditor = null; this.drawerMatches = [];
  }

  formatSriLankanDate(value: unknown, includeTime = false): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: '2-digit', year: 'numeric', ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(date);
  }
  statusLabel(status: string): string {
    const labels: Record<string, string> = { received: 'Received', deposited: 'Deposited', cleared: 'Cleared', dishonoured: 'Dishonoured by bank', returned: 'Returned to customer', cancelled: 'Cancelled', replaced: 'Replaced', prepared: 'Prepared', issued: 'Issued / outstanding', stopped: 'Payment stopped', returned_unpaid: 'Returned unpaid', new: 'New' };
    return labels[String(status || '').toLowerCase()] || status;
  }

  private totalForStatuses(rows: any[], statuses: string[]): number {
    const included = new Set(statuses);
    return rows.reduce((total, row) => included.has(String(row.status || '').toLowerCase())
      ? total + Number(row.amount || 0)
      : total, 0);
  }
  get incomingHeldTotal(): number { return this.totalForStatuses(this.incoming, ['received']); }
  get incomingDepositedTotal(): number { return this.totalForStatuses(this.incoming, ['deposited']); }
  get incomingOpenTotal(): number { return this.incomingHeldTotal + this.incomingDepositedTotal; }
  get issuedPreparedTotal(): number { return this.totalForStatuses(this.issued, ['prepared']); }
  get issuedOutstandingTotal(): number { return this.totalForStatuses(this.issued, ['issued']); }
  get issuedOpenTotal(): number { return this.issuedPreparedTotal + this.issuedOutstandingTotal; }

  async loadIncoming(): Promise<void> {
    if (!window.posApi) return;
    const filters: any = { term: this.incomingTerm, fromDate: this.incomingFromDate || null, toDate: this.incomingToDate || null };
    if (!['open', 'all'].includes(this.incomingStatus)) filters.status = this.incomingStatus;
    const result = await window.posApi.catalog.listCheques(filters, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load incoming cheques.'; return; }
    const rows = result.data || [];
    this.incoming = this.incomingStatus === 'open' ? rows.filter((row: any) => ['received', 'deposited'].includes(row.status)) : rows;
  }

  async selectIncoming(id: number): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.catalog.getCheque(id, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load this cheque.'; return; }
    this.incomingDetail = result.data; this.incomingReason = ''; this.depositedTo = ''; this.drawerTerm = ''; this.drawerMatches = [];
    this.incomingDepositFundId = Number(this.incomingDetail?.cheque?.deposited_fund_account_id || this.activeBankAccounts[0]?.fund_account_id || 0) || null;
  }

  private dateInputValue(value: unknown): string {
    if (!value) return '';
    const raw = String(value);
    const sqlDate = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (sqlDate) return sqlDate[1];
    const date = value instanceof Date ? value : new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo', day: '2-digit', month: '2-digit', year: 'numeric'
    }).formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  editIncomingDetails(): void {
    const cheque = this.incomingDetail?.cheque;
    if (!cheque) return;
    this.incomingEditor = {
      number: cheque.cheque_number || '',
      date: this.dateInputValue(cheque.cheque_date),
      bankName: cheque.bank_name || '',
      branchName: cheque.branch_name || '',
      drawerName: cheque.drawer_name_snapshot || '',
      accountReference: cheque.account_reference || '',
      notes: cheque.notes || '',
      reason: ''
    };
  }

  async saveIncomingDetails(): Promise<void> {
    if (!window.posApi || !this.incomingDetail || !this.incomingEditor || this.updating) return;
    const origin = this.origin(); const user = this.session.getUser(); if (!origin || !user) return;
    this.updating = true; this.error = ''; this.info = '';
    const editor = this.incomingEditor;
    const result = await window.posApi.catalog.updateChequeDetails({
      chequeId: this.incomingDetail.cheque.id,
      details: {
        number: editor.number,
        date: editor.date,
        bankName: editor.bankName,
        branchName: editor.branchName,
        drawerName: editor.drawerName,
        accountReference: editor.accountReference,
        notes: editor.notes
      },
      reason: editor.reason,
      userId: user.id,
      origin
    }, this.actor());
    this.updating = false;
    if (!result.success) { this.error = result.error || 'Could not update the cheque details.'; return; }
    this.incomingDetail = result.data; this.incomingEditor = null;
    this.info = 'Incoming cheque details updated.';
    await this.loadIncoming();
  }

  async changeIncomingStatus(status: string): Promise<void> {
    if (!window.posApi || !this.incomingDetail || this.updating) return;
    const origin = this.origin(); const user = this.session.getUser(); if (!origin || !user) return;
    if (['dishonoured', 'returned'].includes(status) && !this.incomingReason.trim()) { this.error = 'A reason is required for a dishonoured or returned cheque.'; return; }
    if (['deposited', 'cleared'].includes(status) && !this.incomingDepositFundId && !this.incomingDetail.cheque.deposited_fund_account_id) {
      this.error = 'Choose the business bank account receiving this cheque.'; return;
    }
    this.updating = true; this.error = '';
    const result = await window.posApi.catalog.updateChequeStatus({ chequeId: this.incomingDetail.cheque.id, status, reason: this.incomingReason, depositedTo: this.depositedTo, depositedFundAccountId: this.incomingDepositFundId, userId: user.id, origin }, this.actor());
    this.updating = false;
    if (!result.success) { this.error = result.error || 'Could not update the cheque.'; return; }
    this.incomingDetail = result.data; this.info = `Incoming cheque marked ${this.statusLabel(status)}.`; await this.loadIncoming();
  }

  async searchDrawers(): Promise<void> {
    if (!window.posApi || !this.drawerTerm.trim()) { this.drawerMatches = []; return; }
    const result = await window.posApi.catalog.searchCustomers(this.drawerTerm, this.actor(), { outstandingOnly: false, balanceOrder: 'desc', activityOrder: 'desc' });
    this.drawerMatches = result.success ? (result.data || []).slice(0, 8) : [];
  }

  async linkDrawer(account: any): Promise<void> {
    if (!window.posApi || !this.incomingDetail) return;
    const origin = this.origin(); const user = this.session.getUser(); if (!origin || !user) return;
    const result = await window.posApi.catalog.linkCheque({ chequeId: this.incomingDetail.cheque.id, drawerPartyId: account.party_id, reason: 'Drawer linked from incoming cheque register', userId: user.id, origin }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not link the cheque drawer.'; return; }
    this.incomingDetail = result.data; this.drawerMatches = []; this.drawerTerm = ''; this.info = 'Cheque drawer linked.'; await this.loadIncoming();
  }

  async loadBankAccounts(): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.catalog.listBusinessBankAccounts(true, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load business bank accounts.'; return; }
    this.bankAccounts = result.data || [];
    if (!this.incomingDepositFundId) this.incomingDepositFundId = Number(this.activeBankAccounts[0]?.fund_account_id || 0) || null;
  }

  async loadIssued(): Promise<void> {
    if (!window.posApi) return;
    const filters: any = { term: this.issuedTerm, fromDate: this.issuedFromDate || null, toDate: this.issuedToDate || null };
    if (!['open', 'all'].includes(this.issuedStatus)) filters.status = this.issuedStatus;
    const result = await window.posApi.catalog.listIssuedCheques(filters, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load issued cheques.'; return; }
    const rows = result.data || [];
    this.issued = this.issuedStatus === 'open' ? rows.filter((row: any) => ['prepared', 'issued'].includes(row.status)) : rows;
  }

  async selectIssued(id: number): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.catalog.getIssuedCheque(id, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load this issued cheque.'; return; }
    this.issuedDetail = result.data; this.issuedReason = '';
  }

  newIssuedCheque(): void {
    const first = this.bankAccounts.find((account) => account.is_active);
    this.issuedEditor = { bankAccountId: first?.id || null, chequeNumber: '', chequeDate: this.session.getBillingDate() || '', payeeName: '', amount: null, reference: '', notes: '', status: 'issued' };
  }

  async saveIssuedCheque(): Promise<void> {
    if (!window.posApi || !this.issuedEditor || this.updating) return;
    const origin = this.origin(); const user = this.session.getUser(); if (!origin || !user) return;
    this.updating = true; this.error = '';
    const result = await window.posApi.catalog.createIssuedCheque({ ...this.issuedEditor, origin, userId: user.id }, this.actor());
    this.updating = false;
    if (!result.success) { this.error = result.error || 'Could not record the issued cheque.'; return; }
    this.issuedEditor = null; this.issuedDetail = result.data; this.info = 'Issued cheque recorded. This register-only entry does not post an expense or supplier settlement.'; await this.loadIssued();
  }

  async changeIssuedStatus(status: string): Promise<void> {
    if (!window.posApi || !this.issuedDetail || this.updating) return;
    const origin = this.origin(); const user = this.session.getUser(); if (!origin || !user) return;
    if (['cancelled', 'stopped', 'returned_unpaid'].includes(status) && !this.issuedReason.trim()) { this.error = 'Enter a reason for this cheque outcome.'; return; }
    this.updating = true; this.error = '';
    const result = await window.posApi.catalog.updateIssuedChequeStatus({ chequeId: this.issuedDetail.cheque.id, status, reason: this.issuedReason, userId: user.id, origin }, this.actor());
    this.updating = false;
    if (!result.success) { this.error = result.error || 'Could not update the issued cheque.'; return; }
    this.issuedDetail = result.data; this.info = `Issued cheque marked ${this.statusLabel(status)}.`; await this.loadIssued();
  }

  openBankAccounts(): void { this.showBankAccounts = true; this.bankEditor = null; }
  editBankAccount(account: any = null): void { this.bankEditor = account ? { id: account.id, bankName: account.bank_name, branchName: account.branch_name || '', accountName: account.account_name, accountNumber: account.account_number, isActive: !!account.is_active, notes: account.notes || '' } : { bankName: '', branchName: '', accountName: '', accountNumber: '', isActive: true, notes: '' }; }
  async saveBankAccount(): Promise<void> {
    if (!window.posApi || !this.bankEditor || this.updating) return;
    const origin = this.origin(); const user = this.session.getUser(); if (!origin || !user) return;
    this.updating = true; this.error = '';
    const result = await window.posApi.catalog.saveBusinessBankAccount({ ...this.bankEditor, origin, userId: user.id }, this.actor());
    this.updating = false;
    if (!result.success) { this.error = result.error || 'Could not save the bank account.'; return; }
    this.bankEditor = null; this.info = 'Business bank account saved.'; await this.loadBankAccounts();
  }
}
