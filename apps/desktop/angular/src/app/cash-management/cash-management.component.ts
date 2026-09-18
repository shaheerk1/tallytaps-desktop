import { Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type {
  CashCountLine,
  CashMovement,
  CashMovementHistoryRow,
  CashShift,
  CashShiftReportPrint,
  ExpenseCategory,
  FundAccount,
  PrintDocument
} from '../../../../../../packages/shared/ipc/pos-api';

const DEFAULT_DENOMINATIONS = [5000, 2000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];

@Component({
  selector: 'pos-cash-management',
  templateUrl: './cash-management.component.html',
  styleUrls: ['./cash-management.component.css']
})
export class CashManagementComponent implements OnInit {
  shift: CashShift | null = null;
  openingLines = this.blankLines();
  openingExpectation: import('../../../../../../packages/shared/ipc/pos-api').CashOpeningExpectation | null = null;
  openingDifferenceReason = '';
  closingLines = this.blankLines();
  movementDirection: 'in' | 'out' = 'in';
  movementAmount = 0;
  movementReason = '';
  funds: FundAccount[] = [];
  /**
   * Cash going out is always an expense: a reason, the amount, what it was for,
   * and the fund that paid -- this drawer unless someone else's money paid it.
   */
  expenseReasons: ExpenseCategory[] = [];
  outCategoryId: number | null = null;
  outFundId: number | null = null;
  outGoodsReceiptId: number | null = null;
  outLotId: number | null = null;
  outRequestId = crypto.randomUUID();
  saving = false;
  /** The closing count is a day-end task, so it stays folded behind its button until started. */
  closingCountOpen = false;
  @ViewChild('movementForm') movementForm?: ElementRef<HTMLElement>;
  @ViewChild('closingForm') closingForm?: ElementRef<HTMLElement>;
  varianceReason = '';
  reportHistory: CashShiftReportPrint[] = [];
  movementHistory: CashMovementHistoryRow[] = [];
  historyFromDate = '';
  historyToDate = '';
  historyDirection: '' | 'in' | 'out' = '';
  historyTerm = '';
  historyIncludeVoided = true;
  editingMovementId: number | null = null;
  // Removal asks for its reason in the row itself. window.prompt() is not
  // supported in Electron -- it returns nothing -- which silently stopped removal.
  removingMovementId: number | null = null;
  removeReason = '';
  editDirection: 'in' | 'out' = 'in';
  editAmount = 0;
  editReason = '';
  error = '';
  info = '';
  loading = false;

  constructor(private session: SessionService, private printing: PrintingService) {}

  get canCorrectMovements(): boolean { return this.session.hasPermission('cash.movement.correct'); }
  get canRecordExpense(): boolean { return this.session.hasPermission('expenses.create') && this.session.hasPermission('funds.view'); }
  get drawerFund(): FundAccount | null {
    if (!this.shift) return null;
    return this.funds.find((fund) => fund.fundKind === 'pos_drawer' && fund.cashDrawerId === this.shift?.drawerId) || null;
  }
  /** This drawer first, then every other place money can come from. Other tills are counted by their own shifts. */
  get payingFunds(): FundAccount[] {
    const drawer = this.drawerFund;
    return [
      ...(drawer ? [drawer] : []),
      ...this.funds.filter((fund) => fund.isActive && fund.fundKind !== 'pos_drawer')
    ];
  }
  get outCategory(): ExpenseCategory | null { return this.expenseReasons.find((row) => row.id === this.outCategoryId) || null; }
  get outFund(): FundAccount | null { return this.funds.find((fund) => fund.id === this.outFundId) || null; }
  get outFromDrawer(): boolean { return !!this.outFund && this.outFund.id === this.drawerFund?.id; }
  get outNeedsGoods(): boolean { return this.outCategory?.defaultTreatment === 'lot_cost' && !this.outGoodsReceiptId; }

  ngOnInit(): Promise<void> { return this.load(); }

  private actor() { return this.session.getActor() || undefined; }
  private context() {
    const ws = this.session.getWorkstationSession();
    const user = this.session.getUser();
    return { sessionId: ws?.sessionId || 0, workstationId: ws?.workstationId || 0, businessDate: ws?.billingDate || '', userId: user?.id || 0 };
  }
  blankLines(): CashCountLine[] { return DEFAULT_DENOMINATIONS.map((denomination) => ({ denomination, quantity: 0 })); }
  total(lines: CashCountLine[]): number { return lines.reduce((sum, line) => sum + line.denomination * Number(line.quantity || 0), 0); }

  /**
   * A shift carries its business date straight from a MySQL DATE column, and
   * Electron IPC preserves it as a Date. Stringifying one prints "Wed Sep 02"
   * and serializing one shifts it across the Colombo offset, so the calendar
   * parts are read explicitly.
   */
  businessDateText(value: unknown): string {
    if (value instanceof Date) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    return String(value || '').slice(0, 10);
  }
  // ── Keyboard flow ─────────────────────────────────────────

  /**
   * Enter moves to the next field of the form; Enter on the last field, or
   * Ctrl+Enter anywhere, runs the form's action; Esc clears the movement form.
   * Fields take part by carrying `data-flow`, in page order.
   */
  onFlowKeydown(event: KeyboardEvent, action: () => void): void {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape' && action === this.recordFromKeyboard) {
      event.preventDefault();
      this.clearMovementForm();
      return;
    }
    if (event.key !== 'Enter' || target.hasAttribute('data-flow-stay') || target.tagName === 'TEXTAREA') return;
    if (target.tagName === 'BUTTON' && !target.hasAttribute('data-flow')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || target.tagName === 'BUTTON') { action(); return; }
    const container = event.currentTarget as HTMLElement;
    const fields = Array.from(container.querySelectorAll<HTMLElement>('[data-flow]'))
      .filter((field) => !(field as HTMLInputElement).disabled && field.offsetParent !== null);
    const next = fields.find((field) => target.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!next || next.tagName === 'BUTTON') { action(); return; }
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
  }

  readonly recordFromKeyboard = (): void => { if (!this.saving) void this.addMovement(); };
  readonly submitCountFromKeyboard = (): void => { void this.blindClose(); };
  readonly openShiftFromKeyboard = (): void => { if (!this.loading) void this.openShift(); };

  /** Alt+I and Alt+O switch direction from anywhere on the page. */
  @HostListener('document:keydown', ['$event'])
  onPageKeydown(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || this.shift?.status !== 'open') return;
    const key = event.key.toLowerCase();
    if (key === 'i' || key === 'o') {
      event.preventDefault();
      this.chooseDirection(key === 'i' ? 'in' : 'out');
    }
  }

  onDirectionKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.chooseDirection(this.movementDirection === 'in' ? 'out' : 'in');
    }
  }

  chooseDirection(direction: 'in' | 'out'): void {
    this.selectDirection(direction);
    this.focusMovementStart();
  }

  /** The first field of the form, ready for the next entry. */
  focusMovementStart(): void {
    setTimeout(() => {
      const start = this.movementForm?.nativeElement.querySelector<HTMLElement>('[data-flow-start]');
      start?.focus();
      if (start instanceof HTMLInputElement) start.select();
    });
  }

  clearMovementForm(): void {
    this.movementAmount = 0;
    this.movementReason = '';
    if (this.movementDirection === 'out') this.resetOutgoing();
    this.focusMovementStart();
  }

  openClosingCount(): void {
    this.closingCountOpen = true;
    setTimeout(() => this.closingForm?.nativeElement.querySelector<HTMLInputElement>('input')?.focus());
  }

  // ── Labels ────────────────────────────────────────────────

  statusLabel(status: string): string {
    const labels: Record<string, string> = { open: 'Shift open', blind_closed: 'Counted, awaiting close', closed: 'Shift closed' };
    return labels[status] || status;
  }

  movementTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      opening_float: 'Opening float', sale_cash: 'Sale', cash_in: 'Cash in', cash_out: 'Cash out',
      expense_cash: 'Expense', refund_cash: 'Refund', customer_advance_cash: 'Customer advance',
      receivable_collection: 'Debt collected', supplier_settlement_cash: 'Supplier payment', correction: 'Correction', safe_drop: 'To safe', bank_drop: 'To bank',
      fund_transfer_out: 'Moved out', fund_transfer_in: 'Moved in', supplier_payment: 'Supplier payment'
    };
    const plain = String(type || '').replace(/_/g, ' ');
    return labels[type] || (plain.charAt(0).toUpperCase() + plain.slice(1));
  }

  referenceLabel(type: string | null | undefined): string {
    return String(type || '').replace(/_/g, ' ');
  }

  /** Cash taken in during the shift, not counting the opening float. */
  get shiftCashIn(): number {
    return (this.shift?.movements || []).filter((row) => row.direction === 'in' && row.movement_type !== 'opening_float')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  }

  get shiftCashOut(): number {
    return (this.shift?.movements || []).filter((row) => row.direction === 'out').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  }

  selectDirection(direction: 'in' | 'out'): void {
    this.movementDirection = direction;
    if (direction === 'out') this.resetOutgoing(false);
  }

  /** The drawer pays by default, and "Other expense" is the reason until one is chosen. */
  private resetOutgoing(clearAmount = true): void {
    if (clearAmount) { this.movementAmount = 0; this.movementReason = ''; }
    if (!this.outCategoryId || !this.outCategory) this.outCategoryId = (this.expenseReasons.find((row) => row.isDefault) || this.expenseReasons[0])?.id ?? null;
    if (!this.outFundId || !this.payingFunds.some((fund) => fund.id === this.outFundId)) this.outFundId = this.drawerFund?.id ?? null;
    if (clearAmount) { this.outGoodsReceiptId = null; this.outLotId = null; }
    this.outRequestId = crypto.randomUUID();
  }

  onOutCategoryChanged(): void {
    if (this.outCategory?.defaultTreatment !== 'lot_cost') { this.outGoodsReceiptId = null; this.outLotId = null; }
  }

  /**
   * Movement history opens on the current business day. Without this the page
   * pulled every past movement on each load, which is slow and buries today's
   * entries. Widening the range is one edit away in the filter row.
   */
  private applyDefaultHistoryRange(businessDate: string): void {
    if (!businessDate) return;
    if (!this.historyFromDate) this.historyFromDate = businessDate;
    if (!this.historyToDate) this.historyToDate = businessDate;
  }

  async load(): Promise<void> {
    if (!window.posApi) return;
    const ctx = this.context();
    this.applyDefaultHistoryRange(ctx.businessDate);
    if (!ctx.sessionId) { this.error = 'Open a workstation session before managing cash.'; return; }
    const result = await window.posApi.cash.activeShift(ctx.sessionId, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load the active cash shift.'; return; }
    this.shift = result.data;
    await this.loadFunds();
    if (this.shift) {
      await this.loadHistory();
      await this.loadMovementHistory();
      return;
    }

    await this.loadOpeningExpectation();
    const recovery = await window.posApi.cash.recoverableShift(ctx.workstationId, ctx.userId, this.actor());
    if (!recovery.success) { this.error = recovery.error || 'Could not check for a pending cash shift.'; return; }
    this.shift = recovery.data;
    if (this.shift?.status === 'blind_closed') {
      this.info = 'A pending closing count was restored. Complete the reconciliation to finish this shift.';
    }
    await this.loadHistory();
    await this.loadMovementHistory();
  }

  private async loadFunds(): Promise<void> {
    if (!window.posApi || !this.canRecordExpense) { this.funds = []; return; }
    if (!this.expenseReasons.length) {
      const reasons = await window.posApi.expenses.categories(false, this.actor());
      if (reasons.success) this.expenseReasons = reasons.data || [];
    }
    const locCode = this.session.getWorkstationSession()?.locationCode || '';
    if (!locCode) return;
    const result = await window.posApi.funds.list(locCode, false, this.actor());
    if (!result.success) { this.funds = []; return; }
    this.funds = result.data || [];
    if (this.movementDirection === 'out') this.resetOutgoing(false);
  }

  async loadMovementHistory(): Promise<void> {
    if (!window.posApi) return;
    const locCode = this.session.getWorkstationSession()?.locationCode || '';
    if (!locCode) return;
    const result = await window.posApi.cash.movementHistory({
      locCode,
      fromDate: this.historyFromDate || undefined,
      toDate: this.historyToDate || undefined,
      direction: this.historyDirection,
      term: this.historyTerm.trim() || undefined,
      includeVoided: this.historyIncludeVoided,
      limit: 300
    }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load cash movement history.'; return; }
    this.movementHistory = result.data || [];
  }

  /** The cash the last closed shift left in this drawer, which the next opening count should match. */
  async loadOpeningExpectation(): Promise<void> {
    const ctx = this.context();
    if (!window.posApi || !ctx.workstationId) return;
    const result = await window.posApi.cash.openingExpectation(ctx.workstationId, this.actor());
    this.openingExpectation = result.success ? result.data : null;
  }

  /** Opening minus what should be in the drawer; null before the drawer's first shift closes. */
  get openingDifference(): number | null {
    if (!this.openingExpectation) return null;
    return Math.round((this.total(this.openingLines) - this.openingExpectation.carriedTotal) * 100) / 100;
  }

  useCarriedCount(): void {
    const counted = new Map((this.openingExpectation?.lines || []).map((line) => [Number(line.denomination), line.quantity]));
    this.openingLines = this.openingLines.map((line) => ({ ...line, quantity: counted.get(Number(line.denomination)) || 0 }));
  }

  async loadHistory(): Promise<void> {
    if (!window.posApi || !this.shift) {
      this.reportHistory = [];
      return;
    }
    const result = await window.posApi.cash.reportHistory(this.shift.id, this.actor());
    this.reportHistory = result.success ? (result.data || []) : [];
  }

  async openShift(): Promise<void> {
    if (!window.posApi) return;
    this.loading = true; this.error = '';
    try {
      const ctx = this.context();
      const difference = this.openingDifference;
      if (difference !== null && difference !== 0 && !this.openingDifferenceReason.trim()) {
        this.error = `The drawer should hold ${this.openingExpectation!.carriedTotal.toFixed(2)}. Count again, or write why it is different.`;
        return;
      }
      const result = await window.posApi.cash.openShift({
        workstationSessionId: ctx.sessionId, workstationId: ctx.workstationId, userId: ctx.userId,
        businessDate: ctx.businessDate, openingLines: this.openingLines,
        openingDifferenceReason: this.openingDifferenceReason.trim()
      }, this.actor());
      if (!result.success) { this.error = result.error || 'Could not open the cash shift.'; return; }
      this.shift = result.data;
      this.info = difference ? `Cash shift opened. The ${difference > 0 ? 'excess' : 'shortage'} of ${Math.abs(difference).toFixed(2)} was recorded with its reason.` : 'Cash shift opened and opening float recorded.';
      this.openingExpectation = null; this.openingDifferenceReason = '';
      await this.loadFunds();
      await this.loadHistory();
    } finally { this.loading = false; }
  }

  async addMovement(): Promise<void> {
    if (!window.posApi || !this.shift) return;
    if (!this.movementAmount || !this.movementReason.trim()) {
      this.error = 'Enter an amount and reason before recording this cash movement.'; return;
    }
    this.error = '';
    if (this.movementDirection === 'out') { await this.recordOutgoing(); return; }
    const result = await window.posApi.cash.addMovement({
      shiftId: this.shift.id, type: 'cash_in', amount: this.movementAmount,
      reason: this.movementReason, userId: this.context().userId
    }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not record the cash movement.'; return; }
    this.shift = result.data; this.movementAmount = 0; this.movementReason = '';
    this.info = 'Cash coming in recorded.';
    this.focusMovementStart();
    await this.loadHistory();
    await this.loadMovementHistory();
  }

  /** Records money going out as an expense, paid from the chosen fund. */
  private async recordOutgoing(): Promise<void> {
    const workstation = this.session.getWorkstationSession();
    if (!window.posApi || !workstation || this.saving) return;
    if (!this.canRecordExpense) { this.error = 'Your role cannot record expenses. Ask a manager to record this cash going out.'; return; }
    if (!this.outCategory) { this.error = 'Choose what this money was for.'; return; }
    if (!this.outFund) { this.error = 'Choose which fund paid.'; return; }
    if (this.outNeedsGoods) { this.error = `${this.outCategory.name} is a lot expense. Choose the GRN it was for.`; return; }
    this.saving = true;
    const result = await window.posApi.expenses.create({
      expenseCategoryId: this.outCategory.id,
      fundAccountId: this.outFund.id,
      amount: Number(this.movementAmount),
      reason: this.movementReason.trim(),
      requestId: this.outRequestId,
      goodsReceiptId: this.outGoodsReceiptId,
      inventoryLotId: this.outLotId,
      userId: this.context().userId,
      origin: { locCode: workstation.locationCode, macCode: workstation.machineCode, txnDate: workstation.billingDate }
    }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not record this expense.'; return; }
    const saved = result.data;
    this.info = this.outFromDrawer
      ? `${saved.expenseNumber}: ${saved.categoryName} paid from the drawer.`
      : `${saved.expenseNumber}: ${saved.categoryName} paid from ${saved.fundName}. The drawer is unchanged.`;
    if (saved.stakeholderName) this.info += ` The business now owes ${saved.stakeholderName} this amount.`;
    if (saved.attached) this.info += ` Put on ${saved.attached.lotCode || saved.attached.grnNumber}.`;
    const refreshed = await window.posApi!.cash.activeShift(this.context().sessionId, this.actor());
    if (refreshed.success) this.shift = refreshed.data;
    this.resetOutgoing();
    this.focusMovementStart();
    await this.loadFunds();
    await this.loadHistory();
    await this.loadMovementHistory();
  }

  beginMovementEdit(movement: CashMovement): void {
    if (!movement.editable || !this.canCorrectMovements) return;
    this.removingMovementId = null;
    this.editingMovementId = movement.id;
    this.editDirection = movement.direction;
    this.editAmount = movement.amount;
    this.editReason = movement.reason || '';
  }

  cancelMovementEdit(): void {
    this.editingMovementId = null;
    this.editAmount = 0;
    this.editReason = '';
  }

  async saveMovementEdit(): Promise<void> {
    if (!window.posApi || !this.editingMovementId) return;
    const result = await window.posApi.cash.correctMovement({
      movementId: this.editingMovementId,
      direction: this.editDirection,
      amount: this.editAmount,
      reason: this.editReason,
      userId: this.context().userId
    }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not correct the cash movement.'; return; }
    this.shift = result.data;
    this.cancelMovementEdit();
    this.info = 'Cash movement corrected. The original values are retained in its audit history.';
    await this.loadMovementHistory();
  }

  beginMovementRemove(movement: CashMovement): void {
    if (!movement.editable || !this.canCorrectMovements) return;
    this.cancelMovementEdit();
    this.removingMovementId = movement.id;
    this.removeReason = 'Entered by mistake';
  }

  cancelMovementRemove(): void {
    this.removingMovementId = null;
    this.removeReason = '';
  }

  async confirmMovementRemove(): Promise<void> {
    if (!window.posApi || !this.removingMovementId) return;
    if (!this.removeReason.trim()) { this.error = 'Write why this entry is being removed. The reason is kept in the audit history.'; return; }
    const result = await window.posApi.cash.removeMovement({ movementId: this.removingMovementId, reason: this.removeReason.trim(), userId: this.context().userId }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not remove the cash movement.'; return; }
    this.shift = result.data;
    this.cancelMovementRemove();
    this.info = 'Cash movement removed from the drawer total and retained as a voided audit record.';
    await this.loadMovementHistory();
  }

  async blindClose(): Promise<void> {
    if (!window.posApi || !this.shift) return;
    this.error = '';
    const result = await window.posApi.cash.blindClose({ shiftId: this.shift.id, userId: this.context().userId, closingLines: this.closingLines }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not submit the closing count.'; return; }
    this.shift = result.data; this.closingCountOpen = false; this.info = 'Closing count submitted for manager reconciliation.';
    await this.loadHistory();
  }

  async closeShift(): Promise<void> {
    if (!window.posApi || !this.shift) return;
    this.error = '';
    const result = await window.posApi.cash.closeShift({ shiftId: this.shift.id, userId: this.context().userId, varianceReason: this.varianceReason }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not close the shift.'; return; }
    this.shift = result.data; this.info = 'Shift reconciled and Z-closed.';
    await this.loadHistory();
  }

  private reportSnapshot(type: 'X' | 'Z'): Record<string, unknown> {
    if (!this.shift) return {};
    return {
      reportType: type,
      shiftId: this.shift.id,
      drawerName: this.shift.drawerName,
      businessDate: this.businessDateText(this.shift.businessDate),
      openingTotal: this.shift.openingTotal,
      carriedInTotal: this.shift.carriedInTotal ?? null,
      openingDifference: this.shift.openingDifference ?? null,
      expectedTotal: this.shift.expectedTotal,
      declaredTotal: this.shift.declaredTotal,
      varianceTotal: this.shift.varianceTotal,
      movementCount: this.shift.movements.length,
      countState: this.shift.status
    };
  }

  snapshotAmount(report: CashShiftReportPrint, key: string): number {
    return Number(report.snapshot?.[key] ?? 0);
  }

  async printReport(type: 'X' | 'Z'): Promise<void> {
    if (!this.shift || !window.posApi) return;
    const settingsResult = await window.posApi.settings.getReceipt();
    const settings = settingsResult.success ? settingsResult.data : null;
    const shift = this.shift;
    const items = shift.movements.map((movement) => ({
      description: `${movement.direction === 'in' ? 'IN' : 'OUT'} ${movement.movement_type}`,
      qty: movement.reason || 'System transaction',
      amount: `${movement.direction === 'out' ? '-' : ''}${movement.amount.toFixed(2)}`
    }));
    const doc: PrintDocument = {
      documentTitle: `${type} Cash Shift Report`,
      brand: settings ? { name: settings.storeName, tagline: settings.tagline, addressLines: settings.addressLines, phone: settings.phone } : { name: 'POS Platform' },
      meta: [
        { label: 'Report', value: `${type} REPORT` },
        { label: 'Shift', value: String(shift.id) },
        { label: 'Drawer', value: shift.drawerName },
        { label: 'Cashier', value: this.session.getUser()?.displayName || '' },
        { label: 'Business Date', value: this.businessDateText(shift.businessDate) }
      ],
      items,
      totals: [
        ...(shift.carriedInTotal == null ? [] : [{ label: 'Left by last shift', value: shift.carriedInTotal.toFixed(2) }]),
        { label: 'Opening Float', value: shift.openingTotal.toFixed(2) },
        ...(!shift.openingDifference ? [] : [{ label: shift.openingDifference > 0 ? 'Opening excess' : 'Opening shortage', value: shift.openingDifference.toFixed(2) }]),
        { label: 'Expected Cash', value: shift.expectedTotal.toFixed(2), bold: true },
        ...(shift.declaredTotal === null ? [] : [{ label: 'Declared Cash', value: shift.declaredTotal.toFixed(2) }]),
        ...(shift.varianceTotal === null ? [] : [{ label: 'Variance', value: shift.varianceTotal.toFixed(2), bold: true }])
      ],
      footerLines: settings?.footers || []
    };
    await this.printing.printDocument(doc);
    const archive = await window.posApi.cash.archiveReportPrint({
      shiftId: shift.id,
      reportType: type,
      reportNo: type === 'Z' ? shift.id : null,
      snapshot: this.reportSnapshot(type),
      userId: this.context().userId
    }, this.actor());
    if (!archive.success) {
      this.error = archive.error || 'Report history save failed.';
      this.info = `${type} report printed, but the archive entry could not be saved.`;
      return;
    }
    await this.loadHistory();
    this.info = `${type} report sent to the receipt printer.`;
  }
}
