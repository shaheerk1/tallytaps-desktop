import { Component, Input, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type {
  PattiyalAdjustmentLabel,
  PattiyalCandidate,
  PattiyalDetail,
  PattiyalExpenseDeduction,
  PattiyalDraftInput,
  PrintDocument,
  PattiyalStatementType,
  ReceiptPrintSettings
} from '../../../../../../packages/shared/ipc/pos-api';

type WorkspaceView = 'register' | 'editor' | 'detail';
type CandidateScope = 'supplier' | 'all';
type ReasonAction = 'reopen' | 'void' | null;
type CommissionRounding = PattiyalDraftInput['commissionRounding'];

type DraftHeader = {
  statementId: number | null;
  statementType: PattiyalStatementType;
  supplierId: number | null;
  fromDate: string;
  toDate: string;
  commissionRate: number;
  commissionRounding: CommissionRounding;
  commissionOverride: number | null;
  commissionOverrideReason: string;
  notes: string;
};

type SelectedAllocation = {
  candidate: PattiyalCandidate;
  allocatedQuantity: number;
  allocatedKilos: number | null;
  merchandiseAmount: number;
  attributionReason: string;
  note: string;
};

type ManualLine = {
  productId: number | null;
  itemCode: string;
  description: string;
  pricingBasis: 'qty' | 'kilos';
  unitPrice: number;
  quantity: number;
  kilos: number | null;
  merchandiseAmount: number | null;
  reason: string;
};

type AdjustmentLine = {
  adjustmentType: 'deduction' | 'credit';
  label: string;
  amount: number;
  note: string;
};

type ParsedPasteLine = ManualLine & { row: number; error: string };

/** One GRN line on an owned purchase statement: the GRN values beside what is charged. */
type PurchaseLine = {
  goodsReceiptId: number;
  goodsReceiptLineId: number;
  grnNumber: string;
  grnDate: string;
  ownershipModel: 'owned' | 'consignment';
  productId: number | null;
  itemCode: string;
  description: string;
  pricingBasis: 'qty' | 'kilos';
  grnQuantity: number;
  grnKilos: number | null;
  grnUnitCost: number | null;
  quantity: number;
  kilos: number | null;
  unitPrice: number;
  merchandiseAmount: number;
  reason: string;
  draftStatementCount: number;
};

type GroupedDraftLine = {
  productId: number | null;
  itemCode: string;
  description: string;
  pricingBasis: 'qty' | 'kilos';
  unitPrice: number;
  quantity: number;
  kilos: number;
  merchandiseAmount: number;
  sourceCount: number;
  manualCount: number;
  purchaseCount: number;
  overrideCount: number;
};

@Component({
  selector: 'pos-pattiyal-workspace',
  templateUrl: './pattiyal-workspace.component.html',
  styleUrls: ['./pattiyal-workspace.component.css']
})
export class PattiyalWorkspaceComponent implements OnInit {
  @Input() suppliers: any[] = [];
  @Input() products: any[] = [];
  @Input() agreements: any[] = [];

  view: WorkspaceView = 'register';
  loading = false;
  saving = false;
  error = '';
  info = '';

  registerRows: any[] = [];
  registerTotal = 0;
  registerPage = 1;
  registerPageSize = 10;
  registerFilters: { term: string; supplierId: number | null; status: string; statementType: string; fromDate: string; toDate: string } = {
    term: '', supplierId: null, status: '', statementType: '', fromDate: '', toDate: ''
  };

  draft: DraftHeader = this.emptyDraft();
  detail: PattiyalDetail | null = null;
  candidates: PattiyalCandidate[] = [];
  candidateTotal = 0;
  candidateTotals: Record<string, number> = {};
  candidateScope: CandidateScope = 'supplier';
  candidateTerm = '';
  includeUnavailableCandidates = false;
  candidatePage = 1;
  candidatePageSize = 25;
  selectedAllocations = new Map<number, SelectedAllocation>();
  attributionReasons: Record<number, string> = {};
  correctingAttributionId: number | null = null;

  manualLines: ManualLine[] = [];
  manualEditor: ManualLine = this.emptyManualLine();
  pasteText = '';
  pasteReason = '';
  parsedPasteLines: ParsedPasteLine[] = [];

  grnOptions: any[] = [];
  grnTerm = '';
  selectedGrnIds = new Set<number>();

  purchaseGrnOptions: any[] = [];
  /** GRN lists on both tabs cover this range; GRNs already chosen always stay listed. */
  grnFromDate = '';
  grnToDate = '';
  showSettledGrns = false;
  /** Lot expenses recorded against the statement's GRNs, pre-added as deductions. */
  expenseOffers: PattiyalExpenseDeduction[] = [];
  includedExpenseIds = new Set<number>();
  excludedExpenseIds = new Set<number>();
  leaveOutExpenses = false;
  /** True while a saved statement is being restored: expenses it did not deduct stay unticked. */
  private expenseChoicesFromSave = false;
  purchaseGrnTerm = '';
  purchaseLines = new Map<number, PurchaseLine>();

  adjustments: AdjustmentLine[] = [];
  adjustmentEditor: AdjustmentLine = this.emptyAdjustment();
  adjustmentLabels: PattiyalAdjustmentLabel[] = [];

  reasonAction: ReasonAction = null;
  lifecycleReason = '';

  constructor(private session: SessionService, private printing: PrintingService) {}

  async ngOnInit(): Promise<void> {
    await this.loadRegister();
  }

  private api() {
    return window.posApi?.pattiyals;
  }

  private actor() {
    return this.session.getActor() || undefined;
  }

  private userId(): number | null {
    const id = Number(this.actor()?.id || 0);
    return id > 0 ? id : null;
  }

  private billingDate(): string {
    return String(this.session.getBillingDate() || new Date().toISOString().slice(0, 10)).slice(0, 10);
  }

  private origin(): { locCode: string; macCode: string; txnDate: string } {
    const workstation = this.session.getWorkstationSession();
    return {
      locCode: String(workstation?.locationCode || '').trim(),
      macCode: String(workstation?.machineCode || '').trim(),
      txnDate: this.billingDate()
    };
  }

  private emptyDraft(): DraftHeader {
    const date = this.billingDate ? this.billingDate() : new Date().toISOString().slice(0, 10);
    return {
      statementId: null,
      statementType: 'consignment',
      supplierId: null,
      fromDate: date,
      toDate: date,
      commissionRate: 3,
      commissionRounding: 'cents',
      commissionOverride: null,
      commissionOverrideReason: '',
      notes: ''
    };
  }

  private emptyManualLine(): ManualLine {
    return { productId: null, itemCode: '', description: '', pricingBasis: 'kilos', unitPrice: 0, quantity: 0, kilos: null, merchandiseAmount: null, reason: '' };
  }

  private emptyAdjustment(): AdjustmentLine {
    return { adjustmentType: 'deduction', label: '', amount: 0, note: '' };
  }

  private setError(message: string): void {
    this.error = message;
    this.info = '';
  }

  private setInfo(message: string): void {
    this.info = message;
    this.error = '';
  }

  clearStatus(): void {
    this.error = '';
    this.info = '';
  }

  async loadRegister(): Promise<void> {
    const api = this.api();
    if (!api) return;
    this.loading = true;
    const result = await api.list({ ...this.registerFilters, page: this.registerPage, pageSize: this.registerPageSize }, this.actor());
    this.loading = false;
    if (!result.success) {
      this.setError(result.error || 'Could not load supplier sales statements.');
      return;
    }
    this.registerRows = result.data.rows || [];
    this.registerTotal = Number(result.data.total || 0);
    this.registerPage = Number(result.data.page || this.registerPage);
  }

  async applyRegisterFilters(): Promise<void> {
    this.registerPage = 1;
    await this.loadRegister();
  }

  async changeRegisterPage(page: number): Promise<void> {
    this.registerPage = Math.max(1, Math.min(this.registerPageCount, page));
    await this.loadRegister();
  }

  async changeRegisterPageSize(): Promise<void> {
    this.registerPage = 1;
    await this.loadRegister();
  }

  get registerPageCount(): number {
    return Math.max(1, Math.ceil(this.registerTotal / this.registerPageSize));
  }

  get registerPageNumbers(): number[] {
    const count = this.registerPageCount;
    const start = Math.max(1, Math.min(this.registerPage - 2, count - 4));
    return Array.from({ length: Math.min(5, count - start + 1) }, (_value, index) => start + index);
  }

  async newDraft(): Promise<void> {
    this.clearStatus();
    this.view = 'editor';
    this.detail = null;
    this.draft = this.emptyDraft();
    this.candidates = [];
    this.candidateTotal = 0;
    this.candidateTotals = {};
    // With no supplier chosen yet there is nothing to suggest, so open on every sale.
    this.candidateScope = 'all';
    this.candidateTerm = '';
    this.includeUnavailableCandidates = false;
    this.candidatePage = 1;
    this.selectedAllocations.clear();
    this.attributionReasons = {};
    this.manualLines = [];
    this.manualEditor = this.emptyManualLine();
    this.pasteText = '';
    this.pasteReason = '';
    this.parsedPasteLines = [];
    this.grnOptions = [];
    this.grnTerm = '';
    this.selectedGrnIds.clear();
    this.purchaseGrnOptions = [];
    this.purchaseGrnTerm = '';
    this.purchaseLines.clear();
    this.setDefaultGrnRange();
    this.showSettledGrns = false;
    this.resetExpenseOffers();
    this.adjustments = [];
    this.adjustmentEditor = this.emptyAdjustment();
    this.reasonAction = null;
    this.lifecycleReason = '';
    await Promise.all([this.loadCandidates(), this.loadAdjustmentLabels()]);
  }

  /** The last 30 days, so a GRN list stays short however much has been received. */
  private setDefaultGrnRange(): void {
    const today = this.billingDate();
    const start = new Date(`${today}T00:00:00`);
    start.setDate(start.getDate() - 30);
    this.grnFromDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    this.grnToDate = today;
  }

  private resetExpenseOffers(): void {
    this.expenseOffers = [];
    this.includedExpenseIds.clear();
    this.excludedExpenseIds.clear();
    this.leaveOutExpenses = false;
  }

  async grnDatesChanged(): Promise<void> {
    await Promise.all([this.loadCandidateGrns(), this.loadPurchaseGrns()]);
  }

  /** The GRNs this statement is about: the ones compared (consignment) or paid (owned purchase). */
  get statementGrnIds(): number[] {
    return this.isOwnedPurchase
      ? [...new Set(this.purchaseRows.map((row) => row.goodsReceiptId))]
      : [...this.selectedGrnIds];
  }

  /**
   * Offers the lot expenses recorded against the statement's GRNs. A new one is
   * ticked unless it was unticked before or everything is being left out; one
   * already deducted on a reviewed statement cannot be ticked.
   */
  async loadExpenseOffers(): Promise<void> {
    const api = this.api();
    const grnIds = this.statementGrnIds;
    if (!api || !grnIds.length) {
      this.expenseOffers = [];
      this.includedExpenseIds.clear();
      return;
    }
    const result = await api.expenseDeductions({ grnIds, statementId: this.draft.statementId }, this.actor());
    if (!result.success) {
      this.setError(result.error || 'Could not load the expenses recorded against these GRNs.');
      return;
    }
    this.expenseOffers = result.data || [];
    const offered = new Set(this.expenseOffers.map((row) => row.expenseEntryId));
    for (const id of [...this.includedExpenseIds]) if (!offered.has(id)) this.includedExpenseIds.delete(id);
    for (const offer of this.expenseOffers) {
      if (offer.committedStatementNumbers) this.includedExpenseIds.delete(offer.expenseEntryId);
      else if (this.expenseChoicesFromSave) { if (!this.includedExpenseIds.has(offer.expenseEntryId)) this.excludedExpenseIds.add(offer.expenseEntryId); }
      else if (!this.leaveOutExpenses && !this.excludedExpenseIds.has(offer.expenseEntryId)) this.includedExpenseIds.add(offer.expenseEntryId);
    }
  }

  toggleExpense(offer: PattiyalExpenseDeduction, checked: boolean): void {
    if (checked) { this.includedExpenseIds.add(offer.expenseEntryId); this.excludedExpenseIds.delete(offer.expenseEntryId); }
    else { this.includedExpenseIds.delete(offer.expenseEntryId); this.excludedExpenseIds.add(offer.expenseEntryId); }
  }

  setLeaveOutExpenses(value: boolean): void {
    this.leaveOutExpenses = value;
    if (value) { this.includedExpenseIds.clear(); return; }
    this.excludedExpenseIds.clear();
    for (const offer of this.expenseOffers) if (!offer.committedStatementNumbers) this.includedExpenseIds.add(offer.expenseEntryId);
  }

  get expenseDeductionTotal(): number {
    return this.roundMoney(this.expenseOffers
      .filter((offer) => this.includedExpenseIds.has(offer.expenseEntryId))
      .reduce((sum, offer) => sum + Number(offer.amount || 0), 0));
  }

  get visiblePurchaseGrns(): any[] {
    return this.showSettledGrns ? this.purchaseGrnOptions : this.purchaseGrnOptions.filter((grn) => !grn.settled || this.purchaseGrnSelected(grn));
  }

  get hiddenSettledGrnCount(): number {
    return this.purchaseGrnOptions.length - this.visiblePurchaseGrns.length;
  }

  get isOwnedPurchase(): boolean {
    return this.draft.statementType === 'owned_purchase';
  }

  /**
   * Switches a statement not saved yet between consignment and owned purchase.
   * Each keeps its own selections, so switching back loses nothing; only the
   * open type is saved. A saved statement keeps its type.
   */
  async setStatementType(type: PattiyalStatementType): Promise<void> {
    if (this.draft.statementId || this.draft.statementType === type) return;
    this.draft.statementType = type;
    if (type === 'owned_purchase') await this.loadPurchaseGrns();
    else await Promise.all([this.loadCandidates(), this.loadCandidateGrns()]);
    await this.loadExpenseOffers();
  }

  statementTypeLabel(value: unknown): string {
    return value === 'owned_purchase' ? 'Owned purchase' : 'Consignment';
  }

  async backToRegister(): Promise<void> {
    this.view = 'register';
    this.detail = null;
    this.reasonAction = null;
    this.lifecycleReason = '';
    await this.loadRegister();
  }

  async openStatement(id: number): Promise<void> {
    const api = this.api();
    if (!api) return;
    this.loading = true;
    const result = await api.get(id, this.actor());
    this.loading = false;
    if (!result.success || !result.data) {
      this.setError(result.success ? 'Supplier sales statement was not found.' : result.error || 'Could not load supplier sales statement.');
      return;
    }
    this.detail = result.data;
    if (String(result.data.statement['status']) === 'draft') {
      await this.hydrateEditor(result.data);
    } else {
      this.view = 'detail';
      this.reasonAction = null;
      this.lifecycleReason = '';
    }
  }

  private async hydrateEditor(detail: PattiyalDetail): Promise<void> {
    const statement = detail.statement;
    this.draft = {
      statementId: Number(statement['id']),
      statementType: statement['statement_type'] === 'owned_purchase' ? 'owned_purchase' : 'consignment',
      supplierId: Number(statement['supplier_id']),
      fromDate: String(statement['from_date'] || '').slice(0, 10),
      toDate: String(statement['to_date'] || '').slice(0, 10),
      commissionRate: Number(statement['commission_rate'] || 0),
      commissionRounding: this.roundingValue(statement['commission_rounding']),
      commissionOverride: statement['commission_override'] == null ? null : Number(statement['commission_override']),
      commissionOverrideReason: String(statement['commission_override_reason'] || ''),
      notes: String(statement['notes'] || '')
    };
    this.manualLines = (detail.manualLines || []).map((row) => ({
      productId: row['product_id'] == null ? null : Number(row['product_id']),
      itemCode: String(row['item_code'] || ''),
      description: String(row['description'] || ''),
      pricingBasis: String(row['pricing_basis']) === 'qty' ? 'qty' : 'kilos',
      unitPrice: Number(row['unit_price'] || 0),
      quantity: Number(row['quantity'] || 0),
      kilos: row['kilos'] == null ? null : Number(row['kilos']),
      merchandiseAmount: Number(row['merchandise_amount'] || 0),
      reason: String(row['reason'] || '')
    }));
    // Expense deductions are offered again from the expenses themselves; only
    // the rows typed on this statement are kept as its own adjustments.
    this.adjustments = (detail.adjustments || []).filter((row) => !row['expense_entry_id']).map((row) => ({
      adjustmentType: String(row['adjustment_type']) === 'credit' ? 'credit' : 'deduction',
      label: String(row['label'] || ''),
      amount: Number(row['amount'] || 0),
      note: String(row['note'] || '')
    }));
    this.resetExpenseOffers();
    const savedExpenseIds = (detail.adjustments || []).filter((row) => row['expense_entry_id']).map((row) => Number(row['expense_entry_id']));
    savedExpenseIds.forEach((id) => this.includedExpenseIds.add(id));
    // A saved statement's choices are kept: expenses it did not deduct stay unticked.
    this.expenseChoicesFromSave = true;
    this.showSettledGrns = false;
    if (String(statement['statement_type']) === 'owned_purchase') {
      this.grnFromDate = String(statement['from_date'] || '').slice(0, 10);
      this.grnToDate = String(statement['to_date'] || '').slice(0, 10);
    } else {
      this.setDefaultGrnRange();
    }
    this.selectedGrnIds = new Set((detail.grns || []).map((row) => Number(row['id'])));
    this.purchaseLines.clear();
    for (const row of detail.purchaseLines || []) {
      const lineId = Number(row['goods_receipt_line_id']);
      this.purchaseLines.set(lineId, {
        goodsReceiptId: Number(row['goods_receipt_id']),
        goodsReceiptLineId: lineId,
        grnNumber: String(row['grn_number'] || ''),
        grnDate: String(row['grn_business_date'] || '').slice(0, 10),
        ownershipModel: 'owned',
        productId: row['product_id'] == null ? null : Number(row['product_id']),
        itemCode: String(row['item_code'] || ''),
        description: String(row['description'] || ''),
        pricingBasis: String(row['pricing_basis']) === 'kilos' ? 'kilos' : 'qty',
        grnQuantity: Number(row['grn_quantity'] || 0),
        grnKilos: row['grn_kilos'] == null ? null : Number(row['grn_kilos']),
        grnUnitCost: row['grn_unit_cost'] == null ? null : Number(row['grn_unit_cost']),
        quantity: Number(row['quantity'] || 0),
        kilos: row['kilos'] == null ? null : Number(row['kilos']),
        unitPrice: Number(row['unit_price'] || 0),
        merchandiseAmount: Number(row['merchandise_amount'] || 0),
        reason: String(row['reason'] || ''),
        draftStatementCount: 0
      });
    }
    this.purchaseGrnTerm = '';
    this.selectedAllocations.clear();
    const ids = (detail.allocations || []).map((row) => Number(row['invoice_item_id'])).filter((id) => id > 0);
    if (ids.length && this.api()) {
      const result = await this.api()!.candidates({ scope: 'all', statementId: this.draft.statementId, invoiceItemIds: ids, limit: ids.length }, this.actor());
      if (result.success) {
        const byId = new Map(result.data.rows.map((row) => [row.invoiceItemId, row]));
        for (const stored of detail.allocations) {
          const invoiceItemId = Number(stored['invoice_item_id']);
          const candidate = byId.get(invoiceItemId);
          if (!candidate) continue;
          this.selectedAllocations.set(invoiceItemId, {
            candidate,
            allocatedQuantity: Number(stored['allocated_quantity'] || 0),
            allocatedKilos: stored['allocated_kilos'] == null ? null : Number(stored['allocated_kilos']),
            merchandiseAmount: Number(stored['merchandise_amount'] || 0),
            attributionReason: String(stored['attribution_reason'] || ''),
            note: String(stored['note'] || '')
          });
        }
      }
    }
    this.manualEditor = this.emptyManualLine();
    this.adjustmentEditor = this.emptyAdjustment();
    this.pasteText = '';
    this.pasteReason = '';
    this.parsedPasteLines = [];
    this.candidateScope = 'supplier';
    this.candidateTerm = '';
    this.includeUnavailableCandidates = false;
    this.candidatePage = 1;
    this.view = 'editor';
    if (this.isOwnedPurchase) await Promise.all([this.loadPurchaseGrns(), this.loadAdjustmentLabels()]);
    else await Promise.all([this.loadCandidates(), this.loadCandidateGrns(), this.loadAdjustmentLabels()]);
    await this.loadExpenseOffers();
    this.expenseChoicesFromSave = false;
  }

  private roundingValue(value: unknown): CommissionRounding {
    const text = String(value || 'cents');
    return ['cents', 'nearest_rupee', 'floor_rupee', 'ceil_rupee', 'manual'].includes(text) ? text as CommissionRounding : 'cents';
  }

  selectedSupplierName(): string {
    const supplier = this.suppliers.find((row) => Number(row.id) === Number(this.draft.supplierId));
    if (!supplier) return 'Select supplier';
    return `${supplier.supplier_code || ''} ${supplier.name || ''}`.trim();
  }

  async supplierChanged(): Promise<void> {
    const agreement = this.agreements.find((row) => Number(row.supplier_id) === Number(this.draft.supplierId) && Number(row.is_active ?? 1) === 1);
    if (agreement) this.draft.commissionRate = Number(agreement.commission_rate || 0);
    this.candidatePage = 1;
    this.selectedGrnIds.clear();
    // GRN lines belong to one supplier, so a new supplier starts the purchase lines over.
    this.purchaseLines.clear();
    this.resetExpenseOffers();
    await Promise.all([this.loadCandidates(), this.loadCandidateGrns(), this.loadPurchaseGrns()]);
  }

  async sourceDatesChanged(): Promise<void> {
    this.candidatePage = 1;
    await Promise.all([this.loadCandidates(), this.loadCandidateGrns(), this.loadPurchaseGrns()]);
  }

  async applyCandidateSearch(): Promise<void> {
    this.candidatePage = 1;
    await this.loadCandidates();
  }

  async availabilityFilterChanged(): Promise<void> {
    this.candidatePage = 1;
    await this.loadCandidates();
  }

  async setCandidateScope(scope: CandidateScope): Promise<void> {
    this.candidateScope = scope;
    this.candidatePage = 1;
    await this.loadCandidates();
  }

  async loadCandidates(): Promise<void> {
    const api = this.api();
    // Suggestions need a supplier; searching every sale does not, and the date
    // range keeps that list small.
    if (!api || (!this.draft.supplierId && this.candidateScope === 'supplier')) {
      this.candidates = [];
      this.candidateTotal = 0;
      this.candidateTotals = {};
      return;
    }
    this.loading = true;
    const result = await api.candidates({
      supplierId: this.draft.supplierId || null,
      fromDate: this.draft.fromDate,
      toDate: this.draft.toDate,
      scope: this.candidateScope,
      statementId: this.draft.statementId,
      term: this.candidateTerm,
      includeUnavailable: this.includeUnavailableCandidates,
      page: this.candidatePage,
      pageSize: this.candidatePageSize
    }, this.actor());
    this.loading = false;
    if (!result.success) {
      this.setError(result.error || 'Could not load eligible sales.');
      return;
    }
    this.candidates = result.data.rows || [];
    this.candidateTotal = Number(result.data.total || 0);
    this.candidateTotals = result.data.totals || {};
    if (!this.candidates.length && this.candidateTotal && this.candidatePage > 1) {
      this.candidatePage = 1;
      await this.loadCandidates();
      return;
    }
    this.candidatePage = Math.min(this.candidatePage, this.candidatePageCount);
    for (const candidate of this.candidates) {
      const selected = this.selectedAllocations.get(candidate.invoiceItemId);
      if (selected) selected.candidate = candidate;
    }
  }

  get visibleCandidates(): PattiyalCandidate[] {
    return this.candidates;
  }

  get candidatePageCount(): number {
    return Math.max(1, Math.ceil(this.candidateTotal / this.candidatePageSize));
  }

  async changeCandidatePage(page: number): Promise<void> {
    this.candidatePage = Math.max(1, Math.min(this.candidatePageCount, page));
    await this.loadCandidates();
  }

  candidateSelected(candidate: PattiyalCandidate): boolean {
    return this.selectedAllocations.has(candidate.invoiceItemId);
  }

  toggleCandidate(candidate: PattiyalCandidate, checked: boolean): void {
    if (!checked) {
      this.selectedAllocations.delete(candidate.invoiceItemId);
      return;
    }
    if (!this.candidateHasAvailableMeasure(candidate)) return;
    this.selectedAllocations.set(candidate.invoiceItemId, {
      candidate,
      allocatedQuantity: candidate.availableQuantity,
      allocatedKilos: candidate.availableKilos,
      merchandiseAmount: candidate.availableMerchandise,
      attributionReason: candidate.attributionReason || this.attributionReason(candidate),
      note: ''
    });
  }

  candidateHasAvailableMeasure(candidate: PattiyalCandidate): boolean {
    return candidate.pricingBasis === 'kilos'
      ? Number(candidate.availableKilos || 0) > 0
      : Number(candidate.availableQuantity || 0) > 0;
  }

  removeAllocation(invoiceItemId: number): void {
    this.selectedAllocations.delete(invoiceItemId);
  }

  get allocationRows(): SelectedAllocation[] {
    return [...this.selectedAllocations.values()];
  }

  allocationChanged(row: SelectedAllocation): void {
    const candidate = row.candidate;
    const availableMeasure = candidate.pricingBasis === 'kilos' ? Number(candidate.availableKilos || 0) : Number(candidate.availableQuantity || 0);
    const selectedMeasure = candidate.pricingBasis === 'kilos' ? Number(row.allocatedKilos || 0) : Number(row.allocatedQuantity || 0);
    const ratio = availableMeasure > 0 ? Math.max(0, Math.min(1, selectedMeasure / availableMeasure)) : 0;
    row.merchandiseAmount = this.roundMoney(candidate.availableMerchandise * ratio);
  }

  expectedAllocationMerchandise(row: SelectedAllocation): number {
    const candidate = row.candidate;
    const availableMeasure = candidate.pricingBasis === 'kilos' ? Number(candidate.availableKilos || 0) : Number(candidate.availableQuantity || 0);
    const selectedMeasure = candidate.pricingBasis === 'kilos' ? Number(row.allocatedKilos || 0) : Number(row.allocatedQuantity || 0);
    const ratio = availableMeasure > 0 ? Math.max(0, Math.min(1, selectedMeasure / availableMeasure)) : 0;
    return this.roundMoney(candidate.availableMerchandise * ratio);
  }

  allocationNeedsExplanation(row: SelectedAllocation): boolean {
    return this.isCrossSupplier(row.candidate)
      || Math.abs(Number(row.merchandiseAmount || 0) - this.expectedAllocationMerchandise(row)) > 0.005;
  }

  isCrossSupplier(candidate: PattiyalCandidate): boolean {
    return Number(candidate.effectiveSupplierId || 0) !== Number(this.draft.supplierId || 0);
  }

  attributionReason(candidate: PattiyalCandidate): string {
    return this.attributionReasons[candidate.invoiceItemId] || '';
  }

  setAttributionReason(candidate: PattiyalCandidate, value: string): void {
    this.attributionReasons[candidate.invoiceItemId] = value;
  }

  async correctAttribution(candidate: PattiyalCandidate): Promise<void> {
    const api = this.api();
    const reason = this.attributionReason(candidate).trim();
    if (!api || !this.draft.supplierId) return;
    if (!reason) {
      this.setError('Enter a reason before correcting the sale line supplier.');
      return;
    }
    this.correctingAttributionId = candidate.invoiceItemId;
    const result = await api.setAttribution({ invoiceItemId: candidate.invoiceItemId, supplierId: this.draft.supplierId, reason, userId: this.userId() }, this.actor());
    this.correctingAttributionId = null;
    if (!result.success) {
      this.setError(result.error || 'Could not correct the sale line supplier.');
      return;
    }
    this.setInfo(`Supplier attribution corrected for receipt ${candidate.receiptNo}, line ${candidate.seqNo}. The original billed code remains in the audit history.`);
    delete this.attributionReasons[candidate.invoiceItemId];
    await this.loadCandidates();
  }

  productSelectedForManual(): void {
    const product = this.products.find((row) => Number(row.id) === Number(this.manualEditor.productId));
    if (!product) return;
    this.manualEditor.itemCode = String(product.sku || '');
    this.manualEditor.description = String(product.name || '');
    this.manualEditor.pricingBasis = String(product.pricing_basis) === 'qty' ? 'qty' : 'kilos';
    this.manualEditor.unitPrice = Number(product.unit_price || 0);
    this.updateManualAmount(this.manualEditor);
  }

  updateManualAmount(line: ManualLine): void {
    const measure = line.pricingBasis === 'kilos' ? Number(line.kilos || 0) : Number(line.quantity || 0);
    line.merchandiseAmount = this.roundMoney(measure * Number(line.unitPrice || 0));
  }

  addManualLine(): void {
    const line = this.manualEditor;
    const measure = line.pricingBasis === 'kilos' ? Number(line.kilos || 0) : Number(line.quantity || 0);
    if (!line.itemCode.trim() || !line.description.trim() || measure <= 0 || !line.reason.trim()) {
      this.setError('Manual lines need an item, a positive pricing measure, and a reason.');
      return;
    }
    if (line.merchandiseAmount == null || !Number.isFinite(Number(line.merchandiseAmount))) this.updateManualAmount(line);
    this.manualLines.push({ ...line });
    this.manualEditor = this.emptyManualLine();
  }

  removeManualLine(index: number): void {
    this.manualLines.splice(index, 1);
  }

  parsePaste(): void {
    const commonReason = this.pasteReason.trim();
    const sourceLines = this.pasteText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    this.parsedPasteLines = sourceLines.map((source, index) => {
      const delimiter = source.includes('\t') ? '\t' : ',';
      const cells = this.splitPasteCells(source, delimiter);
      if (index === 0 && /item|code|product/i.test(cells[0] || '') && /description|name|bags|qty|quantity/i.test(cells[1] || '')) {
        return { ...this.emptyManualLine(), row: index + 1, error: 'header' };
      }
      const compactLayout = cells.length >= 4 && this.isNumericText(cells[1]);
      const itemReference = cells[0] || '';
      const product = this.products.find((row) => {
        const reference = itemReference.toUpperCase();
        return String(row.sku || '').toUpperCase() === reference || String(row.name || '').toUpperCase() === reference;
      });
      const itemCode = product ? String(product.sku || itemReference) : itemReference;
      const description = compactLayout ? String(product?.name || itemReference) : (cells[1] || String(product?.name || itemReference));
      const quantityIndex = compactLayout ? 1 : 2;
      const kilosIndex = compactLayout ? 2 : 3;
      const rateIndex = compactLayout ? 3 : 4;
      const quantity = this.parseNumeric(cells[quantityIndex]);
      const kilos = cells[kilosIndex] === '' || cells[kilosIndex] == null ? null : this.parseNumeric(cells[kilosIndex]);
      const unitPrice = this.parseNumeric(cells[rateIndex]);
      const optionStart = rateIndex + 1;
      const hasExplicitAmount = this.isNumericText(cells[optionStart]);
      const explicitAmount = hasExplicitAmount ? this.parseNumeric(cells[optionStart]) : null;
      const basisIndex = hasExplicitAmount ? optionStart + 1 : optionStart;
      const basisText = String(cells[basisIndex] || '').trim().toLowerCase();
      const hasExplicitBasis = /^(q|qty|quantity|bag|bags|k|kg|kilo|kilos)/.test(basisText);
      const pricingBasis: 'qty' | 'kilos' = hasExplicitBasis
        ? (/^(q|qty|quantity|bag|bags)/.test(basisText) ? 'qty' : 'kilos')
        : (Number(kilos || 0) > 0 ? 'kilos' : 'qty');
      const reasonStart = hasExplicitBasis ? basisIndex + 1 : basisIndex;
      const reason = cells.slice(reasonStart).join(' ').trim() || commonReason;
      const controlling = pricingBasis === 'kilos' ? Number(kilos || 0) : quantity;
      let error = '';
      if (!itemCode || !description) error = 'Item code and description are required.';
      else if (controlling <= 0) error = `A positive ${pricingBasis === 'kilos' ? 'kilo' : 'quantity'} value is required.`;
      else if (!reason) error = 'A reason is required.';
      return {
        productId: product ? Number(product.id) : null,
        itemCode,
        description,
        pricingBasis,
        unitPrice,
        quantity,
        kilos,
        merchandiseAmount: explicitAmount == null ? this.roundMoney(controlling * unitPrice) : this.roundMoney(explicitAmount),
        reason,
        row: index + 1,
        error
      };
    }).filter((line) => line.error !== 'header');
  }

  addParsedLines(): void {
    if (!this.parsedPasteLines.length) {
      this.setError('Paste and preview at least one row first.');
      return;
    }
    const invalid = this.parsedPasteLines.find((line) => line.error);
    if (invalid) {
      this.setError(`Resolve the error on pasted row ${invalid.row} before adding the rows.`);
      return;
    }
    this.manualLines.push(...this.parsedPasteLines.map(({ row: _row, error: _error, ...line }) => line));
    this.pasteText = '';
    this.pasteReason = '';
    this.parsedPasteLines = [];
    this.setInfo('Pasted rows were added as structured manual lines.');
  }

  private parseNumeric(value: unknown): number {
    const parsed = Number(String(value ?? '').replace(/rs\.?/ig, '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private splitPasteCells(source: string, delimiter: string): string[] {
    if (delimiter === '\t') return source.split('\t').map((cell) => cell.trim());
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (quoted && source[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === ',' && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  private isNumericText(value: unknown): boolean {
    const normalized = String(value ?? '').replace(/rs\.?/ig, '').replace(/,/g, '').trim();
    return normalized !== '' && Number.isFinite(Number(normalized));
  }

  async loadCandidateGrns(): Promise<void> {
    const api = this.api();
    if (!api || !this.draft.supplierId) {
      this.grnOptions = [];
      return;
    }
    const result = await api.candidateGrns({
      supplierId: this.draft.supplierId, term: this.grnTerm, fromDate: this.grnFromDate, toDate: this.grnToDate,
      statementId: this.draft.statementId, includeIds: [...this.selectedGrnIds]
    }, this.actor());
    if (!result.success) {
      this.setError(result.error || 'Could not load matching GRNs.');
      return;
    }
    this.grnOptions = result.data || [];
  }

  grnSelected(id: number): boolean {
    return this.selectedGrnIds.has(Number(id));
  }

  async toggleGrn(id: number, checked: boolean): Promise<void> {
    if (checked) this.selectedGrnIds.add(Number(id));
    else this.selectedGrnIds.delete(Number(id));
    await this.loadExpenseOffers();
  }

  grnQuantity(grn: any): number {
    return (grn.lines || []).reduce((sum: number, line: any) => sum + Number(line.quantity || 0), 0);
  }

  grnKilos(grn: any): number {
    return (grn.lines || []).reduce((sum: number, line: any) => sum + Number(line.kilos || 0), 0);
  }

  addAdjustment(): void {
    const line = this.adjustmentEditor;
    if (!line.label.trim() || Number(line.amount) <= 0) {
      this.setError('An adjustment needs a label and a positive amount.');
      return;
    }
    // Reuse the wording already in use for this type, so reports group it.
    const known = this.labelsForType(line.adjustmentType).find((row) => row.label.toUpperCase() === line.label.trim().toUpperCase());
    this.adjustments.push({ ...line, label: known ? known.label : line.label.trim(), amount: this.roundMoney(line.amount) });
    this.adjustmentEditor = { ...this.emptyAdjustment(), adjustmentType: line.adjustmentType };
  }

  async loadAdjustmentLabels(): Promise<void> {
    const api = this.api();
    if (!api) return;
    const result = await api.adjustmentLabels({}, this.actor());
    this.adjustmentLabels = result.success ? result.data || [] : [];
  }

  labelsForType(type: 'credit' | 'deduction'): PattiyalAdjustmentLabel[] {
    return this.adjustmentLabels.filter((row) => row.adjustmentType === type);
  }

  // ---- owned purchase statements -------------------------------------------

  async loadPurchaseGrns(): Promise<void> {
    const api = this.api();
    if (!api || !this.isOwnedPurchase || !this.draft.supplierId) {
      this.purchaseGrnOptions = [];
      return;
    }
    const result = await api.candidateGrns({
      supplierId: this.draft.supplierId, fromDate: this.grnFromDate, toDate: this.grnToDate,
      term: this.purchaseGrnTerm, statementId: this.draft.statementId,
      includeIds: [...new Set(this.purchaseRows.map((row) => row.goodsReceiptId))]
    }, this.actor());
    if (!result.success) {
      this.setError(result.error || 'Could not load GRNs.');
      return;
    }
    this.purchaseGrnOptions = result.data || [];
    for (const grn of this.purchaseGrnOptions) {
      for (const line of grn.lines || []) {
        const selected = this.purchaseLines.get(Number(line.goodsReceiptLineId));
        if (selected) { selected.draftStatementCount = Number(line.draftStatementCount || 0); selected.ownershipModel = grn.ownershipModel; }
      }
    }
  }

  purchaseGrnSelected(grn: any): boolean {
    return (grn.lines || []).some((line: any) => this.purchaseLines.has(Number(line.goodsReceiptLineId)));
  }

  purchaseGrnFullyPaid(grn: any): boolean {
    return (grn.lines || []).length > 0 && (grn.lines || []).every((line: any) => Boolean(line.committedStatementNumbers));
  }

  purchaseGrnPaidOn(grn: any): string {
    return [...new Set((grn.lines || []).map((line: any) => line.committedStatementNumbers).filter(Boolean))].join(', ');
  }

  purchaseGrnDraftCount(grn: any): number {
    return Math.max(0, ...(grn.lines || []).map((line: any) => Number(line.draftStatementCount || 0)));
  }

  async togglePurchaseGrn(grn: any, checked: boolean): Promise<void> {
    this.applyPurchaseGrn(grn, checked);
    await this.loadExpenseOffers();
  }

  private applyPurchaseGrn(grn: any, checked: boolean): void {
    for (const line of grn.lines || []) {
      const lineId = Number(line.goodsReceiptLineId);
      if (!checked) { this.purchaseLines.delete(lineId); continue; }
      if (line.committedStatementNumbers || this.purchaseLines.has(lineId)) continue;
      const pricingBasis: 'qty' | 'kilos' = line.kilos == null ? 'qty' : 'kilos';
      const unitPrice = Number(line.unitCost || 0);
      const measure = pricingBasis === 'kilos' ? Number(line.kilos || 0) : Number(line.quantity || 0);
      this.purchaseLines.set(lineId, {
        goodsReceiptId: Number(grn.id), goodsReceiptLineId: lineId, grnNumber: grn.grnNumber, grnDate: grn.businessDate,
        ownershipModel: grn.ownershipModel === 'consignment' ? 'consignment' : 'owned',
        productId: line.productId ?? null, itemCode: line.itemCode, description: line.description, pricingBasis,
        grnQuantity: Number(line.quantity || 0), grnKilos: line.kilos == null ? null : Number(line.kilos),
        grnUnitCost: line.unitCost == null ? null : Number(line.unitCost),
        quantity: Number(line.quantity || 0), kilos: line.kilos == null ? null : Number(line.kilos),
        unitPrice, merchandiseAmount: this.roundMoney(measure * unitPrice), reason: '',
        draftStatementCount: Number(line.draftStatementCount || 0)
      });
    }
  }

  get purchaseRows(): PurchaseLine[] {
    return [...this.purchaseLines.values()];
  }

  get purchaseHasConsignmentGrn(): boolean {
    return this.purchaseRows.some((row) => row.ownershipModel === 'consignment');
  }

  purchaseLineChanged(line: PurchaseLine): void {
    line.merchandiseAmount = this.expectedPurchaseAmount(line);
  }

  expectedPurchaseAmount(line: PurchaseLine): number {
    const measure = line.pricingBasis === 'kilos' ? Number(line.kilos || 0) : Number(line.quantity || 0);
    return this.roundMoney(measure * Number(line.unitPrice || 0));
  }

  /** A line changed from its GRN must say why; the server holds the same rule. */
  purchaseLineNeedsReason(line: PurchaseLine): boolean {
    return Math.abs(Number(line.quantity || 0) - line.grnQuantity) > 0.0005
      || (line.pricingBasis === 'kilos' && Math.abs(Number(line.kilos || 0) - Number(line.grnKilos || 0)) > 0.0005)
      || (line.grnUnitCost != null && Math.abs(Number(line.unitPrice || 0) - line.grnUnitCost) > 0.005)
      || Math.abs(Number(line.merchandiseAmount || 0) - this.expectedPurchaseAmount(line)) > 0.005;
  }

  async removePurchaseLine(lineId: number): Promise<void> {
    this.purchaseLines.delete(lineId);
    await this.loadExpenseOffers();
  }

  removeAdjustment(index: number): void {
    this.adjustments.splice(index, 1);
  }

  get groupedDraftLines(): GroupedDraftLine[] {
    const grouped = new Map<string, GroupedDraftLine>();
    const add = (row: GroupedDraftLine) => {
      const key = `${row.productId || row.itemCode}|${row.pricingBasis}|${row.unitPrice.toFixed(2)}`;
      const current = grouped.get(key) || { ...row, quantity: 0, kilos: 0, merchandiseAmount: 0, sourceCount: 0, manualCount: 0, purchaseCount: 0, overrideCount: 0 };
      current.quantity = this.roundMeasure(current.quantity + row.quantity);
      current.kilos = this.roundMeasure(current.kilos + row.kilos);
      current.merchandiseAmount = this.roundMoney(current.merchandiseAmount + row.merchandiseAmount);
      current.sourceCount += row.sourceCount;
      current.manualCount += row.manualCount;
      current.purchaseCount += row.purchaseCount;
      current.overrideCount += row.overrideCount;
      grouped.set(key, current);
    };
    if (this.isOwnedPurchase) {
      for (const row of this.purchaseRows) {
        add({
          productId: row.productId, itemCode: row.itemCode, description: row.description, pricingBasis: row.pricingBasis,
          unitPrice: Number(row.unitPrice || 0), quantity: Number(row.quantity || 0), kilos: Number(row.kilos || 0),
          merchandiseAmount: Number(row.merchandiseAmount || 0), sourceCount: 0, manualCount: 0, purchaseCount: 1,
          overrideCount: this.purchaseLineNeedsReason(row) ? 1 : 0
        });
      }
      return [...grouped.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.unitPrice - b.unitPrice);
    }
    for (const row of this.allocationRows) {
      const candidate = row.candidate;
      add({
        productId: candidate.productId,
        itemCode: candidate.itemCode,
        description: candidate.description,
        pricingBasis: candidate.pricingBasis,
        unitPrice: candidate.unitPrice,
        quantity: Number(row.allocatedQuantity || 0),
        kilos: Number(row.allocatedKilos || 0),
        merchandiseAmount: Number(row.merchandiseAmount || 0),
        sourceCount: 1,
        manualCount: 0,
        purchaseCount: 0,
        overrideCount: this.isCrossSupplier(candidate) || Boolean(candidate.attributionId) ? 1 : 0
      });
    }
    for (const row of this.manualLines) {
      add({
        productId: row.productId,
        itemCode: row.itemCode,
        description: row.description,
        pricingBasis: row.pricingBasis,
        unitPrice: Number(row.unitPrice || 0),
        quantity: Number(row.quantity || 0),
        kilos: Number(row.kilos || 0),
        merchandiseAmount: Number(row.merchandiseAmount || 0),
        sourceCount: 0,
        manualCount: 1,
        purchaseCount: 0,
        overrideCount: 0
      });
    }
    return [...grouped.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.unitPrice - b.unitPrice);
  }

  get draftReconciliation(): any[] {
    const received = new Map<string, any>();
    for (const grn of this.grnOptions.filter((row) => this.selectedGrnIds.has(Number(row.id)))) {
      for (const line of grn.lines || []) {
        const key = String(line.productId || line.itemCode);
        const current = received.get(key) || { productId: line.productId || null, itemCode: line.itemCode || '', description: line.description || '', receivedQuantity: 0, receivedKilos: 0 };
        current.receivedQuantity += Number(line.quantity || 0);
        current.receivedKilos += Number(line.kilos || 0);
        received.set(key, current);
      }
    }
    const sold = new Map<string, any>();
    for (const line of this.groupedDraftLines) {
      const key = String(line.productId || line.itemCode);
      const current = sold.get(key) || { productId: line.productId, itemCode: line.itemCode, description: line.description, soldQuantity: 0, soldKilos: 0 };
      current.soldQuantity += line.quantity;
      current.soldKilos += line.kilos;
      sold.set(key, current);
    }
    return [...new Set([...received.keys(), ...sold.keys()])].map((key) => {
      const inRow = received.get(key) || {};
      const outRow = sold.get(key) || {};
      return {
        itemCode: inRow.itemCode || outRow.itemCode || '',
        description: inRow.description || outRow.description || '',
        receivedQuantity: this.roundMeasure(inRow.receivedQuantity || 0),
        soldQuantity: this.roundMeasure(outRow.soldQuantity || 0),
        quantityDifference: this.roundMeasure(Number(inRow.receivedQuantity || 0) - Number(outRow.soldQuantity || 0)),
        receivedKilos: this.roundMeasure(inRow.receivedKilos || 0),
        soldKilos: this.roundMeasure(outRow.soldKilos || 0),
        kilosDifference: this.roundMeasure(Number(inRow.receivedKilos || 0) - Number(outRow.soldKilos || 0))
      };
    });
  }

  get merchandiseSubtotal(): number {
    return this.roundMoney(this.groupedDraftLines.reduce((sum, row) => sum + row.merchandiseAmount, 0));
  }

  get draftQuantityTotal(): number {
    return this.roundMeasure(this.groupedDraftLines.reduce((sum, row) => sum + row.quantity, 0));
  }

  get draftKilosTotal(): number {
    return this.roundMeasure(this.groupedDraftLines.reduce((sum, row) => sum + row.kilos, 0));
  }

  get commissionAmount(): number {
    if (this.isOwnedPurchase) return 0;
    if (this.draft.commissionRounding === 'manual') return this.roundMoney(this.draft.commissionOverride || 0);
    const raw = this.merchandiseSubtotal * Math.max(0, Number(this.draft.commissionRate || 0)) / 100;
    if (this.draft.commissionRounding === 'nearest_rupee') return Math.round(raw);
    if (this.draft.commissionRounding === 'floor_rupee') return Math.floor(raw + 0.0000001);
    if (this.draft.commissionRounding === 'ceil_rupee') return Math.ceil(raw - 0.0000001);
    return this.roundMoney(raw);
  }

  /** Typed credits and deductions, less the lot expenses being deducted. */
  get adjustmentTotal(): number {
    const typed = this.adjustments.reduce((sum, row) => sum + (row.adjustmentType === 'credit' ? Number(row.amount) : -Number(row.amount)), 0);
    return this.roundMoney(typed - this.expenseDeductionTotal);
  }

  get netPayable(): number {
    return this.roundMoney(this.merchandiseSubtotal - this.commissionAmount + this.adjustmentTotal);
  }

  get draftLineCount(): number {
    return this.isOwnedPurchase ? this.purchaseLines.size : this.selectedAllocations.size + this.manualLines.length;
  }

  private validateDraft(): string {
    if (!this.draft.supplierId) return 'Select the supplier for this sales statement.';
    if (this.isOwnedPurchase && (!this.grnFromDate || !this.grnToDate || this.grnFromDate > this.grnToDate)) return 'Enter a valid GRN date range.';
    if (!this.isOwnedPurchase && (!this.draft.fromDate || !this.draft.toDate || this.draft.fromDate > this.draft.toDate)) return 'Enter a valid source date range.';
    if (this.isOwnedPurchase) {
      if (!this.draftLineCount) return 'Select at least one GRN to pay on this statement.';
      for (const row of this.purchaseRows) {
        const measure = row.pricingBasis === 'kilos' ? Number(row.kilos || 0) : Number(row.quantity || 0);
        if (measure <= 0) return `${row.itemCode} on ${row.grnNumber} needs a positive ${row.pricingBasis === 'kilos' ? 'measured quantity' : 'unit count'}.`;
        if (Number(row.unitPrice) < 0 || Number(row.merchandiseAmount) < 0) return `${row.itemCode} on ${row.grnNumber} has an invalid rate or amount.`;
        if (this.purchaseLineNeedsReason(row) && !row.reason.trim()) return `Explain why ${row.itemCode} on ${row.grnNumber} differs from its GRN.`;
      }
      return '';
    }
    if (!this.draftLineCount) return 'Add at least one assisted or manual sales line.';
    if (Number(this.draft.commissionRate) < 0 || Number(this.draft.commissionRate) > 100) return 'Commission rate must be between 0 and 100.';
    if (this.draft.commissionRounding === 'manual' && (!this.draft.commissionOverrideReason.trim() || Number(this.draft.commissionOverride) < 0)) return 'Manual commission needs a valid amount and reason.';
    for (const row of this.allocationRows) {
      const measure = row.candidate.pricingBasis === 'kilos' ? Number(row.allocatedKilos || 0) : Number(row.allocatedQuantity || 0);
      if (measure <= 0) return `${row.candidate.itemCode} needs a positive allocation.`;
      if (this.isCrossSupplier(row.candidate) && !row.attributionReason.trim()) return `Explain why ${row.candidate.itemCode} belongs to ${this.selectedSupplierName()}.`;
      if (Math.abs(Number(row.merchandiseAmount || 0) - this.expectedAllocationMerchandise(row)) > 0.005 && !row.attributionReason.trim()) {
        return `Explain the merchandise amount override for ${row.candidate.itemCode}.`;
      }
    }
    return '';
  }

  private draftPayload(): PattiyalDraftInput {
    const origin = this.origin();
    if (this.isOwnedPurchase) {
      return {
        statementId: this.draft.statementId,
        statementType: 'owned_purchase',
        supplierId: Number(this.draft.supplierId),
        fromDate: this.grnFromDate,
        toDate: this.grnToDate,
        ...origin,
        userId: this.userId(),
        commissionRate: 0,
        commissionRounding: 'cents',
        notes: this.draft.notes,
        grnIds: [],
        allocations: [],
        manualLines: [],
        purchaseLines: this.purchaseRows.map((row) => ({
          goodsReceiptLineId: row.goodsReceiptLineId,
          quantity: Number(row.quantity || 0),
          kilos: row.kilos == null ? null : Number(row.kilos),
          unitPrice: Number(row.unitPrice || 0),
          merchandiseAmount: Number(row.merchandiseAmount || 0),
          reason: row.reason
        })),
        adjustments: this.adjustments.map((row) => ({ ...row })),
        expenseDeductions: [...this.includedExpenseIds].map((expenseEntryId) => ({ expenseEntryId }))
      };
    }
    return {
      statementId: this.draft.statementId,
      statementType: 'consignment',
      supplierId: Number(this.draft.supplierId),
      fromDate: this.draft.fromDate,
      toDate: this.draft.toDate,
      ...origin,
      userId: this.userId(),
      commissionRate: Number(this.draft.commissionRate || 0),
      commissionRounding: this.draft.commissionRounding,
      commissionOverride: this.draft.commissionOverride,
      commissionOverrideReason: this.draft.commissionOverrideReason,
      notes: this.draft.notes,
      grnIds: [...this.selectedGrnIds],
      allocations: this.allocationRows.map((row) => ({
        invoiceItemId: row.candidate.invoiceItemId,
        allocatedQuantity: Number(row.allocatedQuantity || 0),
        allocatedKilos: row.allocatedKilos == null ? null : Number(row.allocatedKilos),
        merchandiseAmount: Number(row.merchandiseAmount || 0),
        attributionReason: row.attributionReason,
        note: row.note
      })),
      manualLines: this.manualLines.map((row) => ({ ...row, merchandiseAmount: Number(row.merchandiseAmount || 0) })),
      adjustments: this.adjustments.map((row) => ({ ...row })),
        expenseDeductions: [...this.includedExpenseIds].map((expenseEntryId) => ({ expenseEntryId }))
    };
  }

  async saveDraft(showMessage = true): Promise<boolean> {
    const api = this.api();
    if (!api) return false;
    const validation = this.validateDraft();
    if (validation) {
      this.setError(validation);
      return false;
    }
    this.saving = true;
    const result = await api.saveDraft(this.draftPayload(), this.actor());
    this.saving = false;
    if (!result.success) {
      this.setError(result.error || 'Could not save supplier sales statement draft.');
      return false;
    }
    this.detail = result.data;
    this.draft.statementId = Number(result.data.statement['id']);
    await this.loadAdjustmentLabels();
    if (showMessage) this.setInfo(`${result.data.statement['statement_number']} saved as a draft.`);
    return true;
  }

  async reviewDraft(): Promise<void> {
    const api = this.api();
    if (!api || !(await this.saveDraft(false)) || !this.draft.statementId) return;
    this.saving = true;
    const result = await api.review(this.draft.statementId, this.userId(), this.actor());
    this.saving = false;
    if (!result.success) {
      this.setError(result.error || 'Could not move the supplier sales statement to review.');
      return;
    }
    this.detail = result.data;
    this.view = 'detail';
    this.setInfo(`${result.data.statement['statement_number']} is reviewed and ready to finalize.`);
  }

  async finalizeStatement(): Promise<void> {
    const api = this.api();
    const id = Number(this.detail?.statement['id'] || 0);
    if (!api || !id) return;
    this.saving = true;
    const result = await api.finalize(id, this.userId(), this.actor());
    this.saving = false;
    if (!result.success) {
      this.setError(result.error || 'Could not finalize supplier sales statement.');
      return;
    }
    this.detail = result.data;
    this.setInfo(`${result.data.statement['statement_number']} finalized as an evaluation document. The legacy supplier ledger was not changed.`);
  }

  startReasonAction(action: Exclude<ReasonAction, null>): void {
    this.reasonAction = action;
    this.lifecycleReason = '';
  }

  cancelReasonAction(): void {
    this.reasonAction = null;
    this.lifecycleReason = '';
  }

  async confirmReasonAction(): Promise<void> {
    const api = this.api();
    const id = Number(this.detail?.statement['id'] || 0);
    const reason = this.lifecycleReason.trim();
    if (!api || !id || !this.reasonAction) return;
    if (!reason) {
      this.setError('Enter an audit reason for this action.');
      return;
    }
    this.saving = true;
    const result = this.reasonAction === 'reopen'
      ? await api.reopen(id, this.userId(), reason, this.actor())
      : await api.void(id, this.userId(), reason, this.actor());
    this.saving = false;
    if (!result.success) {
      this.setError(result.error || `Could not ${this.reasonAction} supplier sales statement.`);
      return;
    }
    this.detail = result.data;
    const action = this.reasonAction;
    this.cancelReasonAction();
    if (action === 'reopen') {
      this.setInfo(`${result.data.statement['statement_number']} reopened as a draft.`);
      await this.hydrateEditor(result.data);
    } else {
      this.setInfo(`${result.data.statement['statement_number']} voided with an audit reason.`);
      this.view = 'detail';
    }
  }

  private detailGroups(): any[] {
    return this.detail?.groupedLines || [];
  }

  detailQuantityTotal(): number {
    return this.roundMeasure(this.detailGroups().reduce((sum, row) => sum + Number(row['quantity'] || 0), 0));
  }

  detailKilosTotal(): number {
    return this.roundMeasure(this.detailGroups().reduce((sum, row) => sum + Number(row['kilos'] || 0), 0));
  }

  private async printSettings(): Promise<ReceiptPrintSettings | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.settings.getReceipt();
    return result.success ? result.data : null;
  }

  private async printDocument(): Promise<PrintDocument | null> {
    if (!this.detail) return null;
    const settings = await this.printSettings();
    const statement = this.detail.statement;
    const grouped = this.detail.groupedLines || [];
    const adjustments = this.detail.adjustments || [];
    const commissionRate = this.compactNumber(statement['commission_rate']);
    const ownedPurchase = statement['statement_type'] === 'owned_purchase';
    const title = ownedPurchase ? 'Supplier Purchase Statement' : 'Supplier Sales Statement';
    return {
      documentTitle: title,
      brand: {
        name: settings?.storeName || title,
        tagline: settings?.tagline || '',
        addressLines: settings?.addressLines || [],
        phone: settings?.phone || ''
      },
      logoDataUrl: settings?.logoDataUrl || '',
      secondaryHeaderLines: [{ text: title.toUpperCase(), align: 'center', bold: true }],
      meta: [
        { label: 'Statement', value: String(statement['statement_number'] || '') },
        { label: 'Supplier', value: `${statement['supplier_code'] || ''} ${statement['supplier_name'] || ''}`.trim() },
        { label: 'Date', value: this.statementDate(statement['created_at'] || statement['txn_date']) },
        { label: 'Status', value: String(statement['status'] || '').toUpperCase() }
      ],
      itemLayout: 'invoice-measures',
      pdfLayout: 'supplier-sales-statement',
      statementSummary: { quantityTotal: this.compactNumber(this.detailQuantityTotal()), kilosTotal: this.compactNumber(this.detailKilosTotal()) },
      items: grouped.map((row) => ({
        description: `${row['itemCode'] || row['item_code'] || ''} ${row['description'] || ''}`.trim(),
        qty: `${this.compactNumber(row['quantity'])} qty / ${this.compactNumber(row['kilos'])} kg x ${this.money(row['unitPrice'] ?? row['unit_price'])}`,
        measure: {
          qty: this.compactNumber(row['quantity']),
          kilos: this.compactNumber(row['kilos']),
          rate: this.money(row['unitPrice'] ?? row['unit_price'])
        },
        amount: this.money(row['merchandiseAmount'] ?? row['merchandise_amount'])
      })),
      totals: [
        { label: 'TOTAL BAGS / QTY', value: this.compactNumber(this.detailQuantityTotal()) },
        { label: 'TOTAL KG', value: this.compactNumber(this.detailKilosTotal()) },
        { label: 'SUB TOTAL', value: this.money(statement['merchandise_subtotal']) },
        ...(ownedPurchase ? [] : [{ label: `COMMISSION (${commissionRate}%)`, value: this.money(statement['commission_amount']) }]),
        ...adjustments.map((row) => ({
          label: `${String(row['adjustment_type']) === 'credit' ? '+' : '-'} ${String(row['label'] || 'ADJUSTMENT').toUpperCase()}`,
          value: this.money(row['amount'])
        })),
        { label: 'BL / NET PAYABLE', value: this.money(statement['net_payable']), bold: true }
      ],
      footerLines: settings?.footers || [],
      cut: true
    };
  }

  async printPattiyal(): Promise<void> {
    const document = await this.printDocument();
    if (!document) return;
    const result = await this.printing.printDocument(document);
    if (result.success) this.setInfo('Supplier sales statement sent to the receipt printer.');
    else this.setError(result.error || 'Supplier sales statement printing failed.');
  }

  async savePattiyalPdf(): Promise<void> {
    const document = await this.printDocument();
    if (!document || !this.detail) return;
    const number = String(this.detail.statement['statement_number'] || 'Supplier_Sales_Statement');
    const result = await this.printing.savePdf(document, { prompt: true, fileName: `${number}.pdf` });
    if (!result.success) this.setError(result.error || 'Supplier sales statement PDF save failed.');
    else if (!result.canceled) this.setInfo(`Supplier sales statement PDF saved to ${result.filePath || 'the selected location'}.`);
  }

  async savePattiyalXlsx(): Promise<void> {
    const document = await this.printDocument();
    const api = this.api();
    if (!document || !this.detail || !api) return;
    const number = String(this.detail.statement['statement_number'] || 'Supplier_Sales_Statement');
    const result = await api.exportXlsx(document, `${number}.xlsx`, this.actor());
    if (!result.success) this.setError(result.error || 'Supplier sales statement Excel export failed.');
    else if (!result.data?.canceled) this.setInfo(`Supplier sales statement Excel file saved to ${result.data?.filePath || 'the selected location'}.`);
  }

  async savePattiyalDocx(): Promise<void> {
    const document = await this.printDocument();
    const api = this.api();
    if (!document || !this.detail || !api) return;
    const number = String(this.detail.statement['statement_number'] || 'Supplier_Sales_Statement');
    const result = await api.exportDocx(document, `${number}.docx`, this.actor());
    if (!result.success) this.setError(result.error || 'Supplier sales statement Word export failed.');
    else if (!result.data?.canceled) this.setInfo(`Supplier sales statement Word document saved to ${result.data?.filePath || 'the selected location'}.`);
  }

  money(value: unknown): string {
    return Number(value || 0).toFixed(2);
  }

  compactNumber(value: unknown): string {
    const number = Number(value || 0);
    return Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  private statementDate(value: unknown): string {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 10);
    return date.toLocaleDateString('en-LK', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private roundMoney(value: unknown): number {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  private roundMeasure(value: unknown): number {
    return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
  }
}
