import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type {
  CashCountLine,
  CashMovement,
  CashMovementHistoryRow,
  CashShift,
  CashShiftReportPrint,
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
  closingLines = this.blankLines();
  movementType: 'cash_in' | 'cash_out' | 'safe_drop' | 'bank_drop' = 'cash_in';
  movementAmount = 0;
  movementReason = '';
  movementTargetFundId: number | null = null;
  funds: FundAccount[] = [];
  varianceReason = '';
  reportHistory: CashShiftReportPrint[] = [];
  movementHistory: CashMovementHistoryRow[] = [];
  historyFromDate = '';
  historyToDate = '';
  historyDirection: '' | 'in' | 'out' = '';
  historyTerm = '';
  historyIncludeVoided = true;
  editingMovementId: number | null = null;
  editDirection: 'in' | 'out' = 'in';
  editAmount = 0;
  editReason = '';
  error = '';
  info = '';
  loading = false;

  constructor(private session: SessionService, private printing: PrintingService) {}

  get canCorrectMovements(): boolean { return this.session.hasPermission('cash.movement.correct'); }
  get canTransferFunds(): boolean { return this.session.hasPermission('funds.transfer'); }
  get isFundDrop(): boolean { return this.movementType === 'safe_drop' || this.movementType === 'bank_drop'; }
  get drawerFund(): FundAccount | null {
    if (!this.shift) return null;
    return this.funds.find((fund) => fund.fundKind === 'pos_drawer' && fund.cashDrawerId === this.shift?.drawerId) || null;
  }
  get dropTargets(): FundAccount[] {
    const kind = this.movementType === 'bank_drop' ? 'bank' : 'cash_safe';
    return this.funds.filter((fund) => fund.isActive && fund.fundKind === kind);
  }

  ngOnInit(): Promise<void> { return this.load(); }

  private actor() { return this.session.getActor() || undefined; }
  private context() {
    const ws = this.session.getWorkstationSession();
    const user = this.session.getUser();
    return { sessionId: ws?.sessionId || 0, workstationId: ws?.workstationId || 0, businessDate: ws?.billingDate || '', userId: user?.id || 0 };
  }
  blankLines(): CashCountLine[] { return DEFAULT_DENOMINATIONS.map((denomination) => ({ denomination, quantity: 0 })); }
  total(lines: CashCountLine[]): number { return lines.reduce((sum, line) => sum + line.denomination * Number(line.quantity || 0), 0); }
  get movementDirection(): 'in' | 'out' { return this.movementType === 'cash_in' ? 'in' : 'out'; }
  get movementLabel(): string {
    return ({ cash_in: 'Other cash coming in', cash_out: 'Other cash going out', safe_drop: 'Cash going to safe', bank_drop: 'Cash going to bank' } as const)[this.movementType];
  }
  selectMovement(type: 'cash_in' | 'cash_out' | 'safe_drop' | 'bank_drop'): void {
    this.movementType = type;
    this.movementTargetFundId = this.dropTargets[0]?.id || null;
  }
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
  /** Switching sides keeps whichever outgoing reason was already chosen. */
  selectDirection(direction: 'in' | 'out'): void {
    if (direction === 'in') { this.movementType = 'cash_in'; return; }
    if (this.movementType === 'cash_in') this.movementType = 'cash_out';
  }

  async load(): Promise<void> {
    if (!window.posApi) return;
    const ctx = this.context();
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
    if (!window.posApi || !this.canTransferFunds) { this.funds = []; return; }
    const locCode = this.session.getWorkstationSession()?.locationCode || '';
    if (!locCode) return;
    const result = await window.posApi.funds.list(locCode, false, this.actor());
    if (!result.success) { this.funds = []; return; }
    this.funds = result.data || [];
    if (this.isFundDrop) this.movementTargetFundId = this.dropTargets[0]?.id || null;
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
      const result = await window.posApi.cash.openShift({
        workstationSessionId: ctx.sessionId, workstationId: ctx.workstationId, userId: ctx.userId,
        businessDate: ctx.businessDate, openingLines: this.openingLines
      }, this.actor());
      if (!result.success) { this.error = result.error || 'Could not open the cash shift.'; return; }
      this.shift = result.data; this.info = 'Cash shift opened and opening float recorded.';
      await this.loadHistory();
    } finally { this.loading = false; }
  }

  async addMovement(): Promise<void> {
    if (!window.posApi || !this.shift) return;
    if (!this.movementAmount || !this.movementReason.trim()) {
      this.error = 'Enter an amount and reason before recording this cash movement.'; return;
    }
    this.error = '';
    if (this.isFundDrop) {
      const workstation = this.session.getWorkstationSession();
      const fromFund = this.drawerFund;
      const toFund = this.dropTargets.find((fund) => fund.id === this.movementTargetFundId);
      if (!this.canTransferFunds) {
        this.error = 'You need permission to transfer drawer cash into a safe or bank account.'; return;
      }
      if (!workstation || !fromFund || !toFund) {
        this.error = `Choose the ${this.movementType === 'bank_drop' ? 'bank account' : 'cash safe'} receiving this money.`; return;
      }
      const transfer = await window.posApi.funds.transfer({
        fromFundAccountId: fromFund.id,
        toFundAccountId: toFund.id,
        amount: this.movementAmount,
        reason: this.movementReason,
        userId: this.context().userId,
        origin: { locCode: workstation.locationCode, macCode: workstation.machineCode, txnDate: workstation.billingDate }
      }, this.actor());
      if (!transfer.success) { this.error = transfer.error || 'Could not transfer this drawer cash.'; return; }
      const refreshed = await window.posApi.cash.activeShift(this.context().sessionId, this.actor());
      if (refreshed.success) this.shift = refreshed.data;
      this.movementAmount = 0; this.movementReason = '';
      this.info = `${this.movementLabel} recorded into ${toFund.name}.`;
      await this.loadFunds();
      await this.loadHistory();
      await this.loadMovementHistory();
      return;
    }
    const result = await window.posApi.cash.addMovement({
      shiftId: this.shift.id, type: this.movementType, amount: this.movementAmount,
      reason: this.movementReason, userId: this.context().userId
    }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not record the cash movement.'; return; }
    this.shift = result.data; this.movementAmount = 0; this.movementReason = '';
    this.info = `${this.movementLabel} recorded successfully.`;
    await this.loadHistory();
    await this.loadMovementHistory();
  }

  beginMovementEdit(movement: CashMovement): void {
    if (!movement.editable || !this.canCorrectMovements) return;
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

  async removeMovement(movement: CashMovement): Promise<void> {
    if (!window.posApi || !movement.editable || !this.canCorrectMovements) return;
    const reason = window.prompt('Why are you removing this cash movement? This reason is kept in the audit history.', movement.reason || 'Entered by mistake');
    if (!reason?.trim()) return;
    const result = await window.posApi.cash.removeMovement({ movementId: movement.id, reason, userId: this.context().userId }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not remove the cash movement.'; return; }
    this.shift = result.data;
    this.info = 'Cash movement removed from the drawer total and retained as a voided audit record.';
    await this.loadMovementHistory();
  }

  async blindClose(): Promise<void> {
    if (!window.posApi || !this.shift) return;
    this.error = '';
    const result = await window.posApi.cash.blindClose({ shiftId: this.shift.id, userId: this.context().userId, closingLines: this.closingLines }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not submit the closing count.'; return; }
    this.shift = result.data; this.info = 'Closing count submitted for manager reconciliation.';
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
        { label: 'Opening Float', value: shift.openingTotal.toFixed(2) },
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
