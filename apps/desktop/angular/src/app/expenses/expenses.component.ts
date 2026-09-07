import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import type {
  AccountingPeriod, AllocationBasis, CostedLot, ExpenseCategory, ExpenseEntry, ExpenseRegister,
  FundAccount, FundMovement, JournalEntry, LotCostAllocation, LotProfitability, Stakeholder,
  StakeholderEntry, TrialBalance
} from '../../../../../../packages/shared/ipc/pos-api';

type Tab = 'expenses' | 'lots' | 'partners' | 'accounts';

type ExpenseDraft = {
  expenseCategoryId: number | null;
  fundAccountId: number | null;
  amount: number | null;
  payee: string;
  reference: string;
  reason: string;
};

type TransferDraft = { fromFundAccountId: number | null; toFundAccountId: number | null; amount: number | null; reason: string };

type FundDraft = {
  id?: number; name: string; fundKind: 'cash_safe' | 'bank' | 'stakeholder';
  holderName: string; accountReference: string; openingBalance: number | null; notes: string; isActive: boolean;
};

type AttachDraft = {
  expense: ExpenseEntry;
  scope: 'lot' | 'goods_receipt';
  inventoryLotId: number | null;
  goodsReceiptId: number | null;
  basis: AllocationBasis;
  amount: number | null;
};

type MoveCostDraft = {
  expenseEntryId: number | null; fromInventoryLotId: number | null;
  toInventoryLotId: number | null; amount: number | null; reason: string;
};

type PartnerDraft = {
  id?: number; displayName: string; stakeholderType: 'owner' | 'partner' | 'investor';
  borneCostTreatment: 'capital' | 'liability'; mobile: string; notes: string; isActive: boolean;
};

type PartnerMoveDraft = {
  mode: 'contribute' | 'draw' | 'settle' | 'profit_share';
  stakeholder: Stakeholder;
  fundAccountId: number | null;
  amount: number | null;
  reason: string;
  overrideReason: string;
};

@Component({
  selector: 'pos-expenses',
  templateUrl: './expenses.component.html',
  styleUrls: ['./expenses.component.css']
})
export class ExpensesComponent implements OnInit {
  activeTab: Tab = 'expenses';

  funds: FundAccount[] = [];
  categories: ExpenseCategory[] = [];
  register: ExpenseRegister | null = null;

  fromDate = '';
  toDate = '';
  term = '';
  filterCategoryId: number | null = null;
  filterFundId: number | null = null;
  unallocatedOnly = false;

  expenseDraft: ExpenseDraft | null = null;
  transferDraft: TransferDraft | null = null;
  fundDraft: FundDraft | null = null;
  ledger: { fund: FundAccount; movements: FundMovement[] } | null = null;

  // Lot costing
  profitability: LotProfitability | null = null;
  lots: CostedLot[] = [];
  attachDraft: AttachDraft | null = null;
  moveCostDraft: MoveCostDraft | null = null;
  lotDetail: { lot: CostedLot; allocations: LotCostAllocation[] } | null = null;
  ownershipFilter = '';
  reconcileResult: { checked: number; drifted: number } | null = null;

  // Partners
  partners: Stakeholder[] = [];
  partnerDraft: PartnerDraft | null = null;
  partnerMove: PartnerMoveDraft | null = null;
  partnerStatement: { stakeholder: Stakeholder; entries: StakeholderEntry[] } | null = null;
  equityCheck: { ledgerTotal: number; journalTotal: number; difference: number; inBalance: boolean } | null = null;

  // Accountant mode
  trialBalance: TrialBalance | null = null;
  profitAndLoss: any = null;
  balanceSheet: any = null;
  journal: JournalEntry[] = [];
  periods: AccountingPeriod[] = [];
  closeDraft: { periodStart: string; periodEnd: string; notes: string } | null = null;

  loading = false;
  saving = false;
  error = '';
  info = '';

  constructor(public session: SessionService) {}

  private actor() { return this.session.getActor() || undefined; }
  private origin() {
    const ws = this.session.getWorkstationSession();
    return ws ? { locCode: ws.locationCode, macCode: ws.machineCode, txnDate: ws.billingDate } : null;
  }

  get canView(): boolean { return this.session.hasAnyPermission(['expenses.view', 'funds.view']); }
  get canRecord(): boolean { return this.session.hasPermission('expenses.create'); }
  get canManageFunds(): boolean { return this.session.hasPermission('funds.manage'); }
  get canTransfer(): boolean { return this.session.hasPermission('funds.transfer'); }
  get canSeeFunds(): boolean { return this.session.hasPermission('funds.view'); }
  get canSeeLots(): boolean { return this.session.hasPermission('lot-costing.view'); }
  get canAllocate(): boolean { return this.session.hasPermission('expenses.allocate'); }
  get canSeePartners(): boolean { return this.session.hasPermission('stakeholders.view'); }
  get canManagePartners(): boolean { return this.session.hasPermission('stakeholders.manage'); }
  get canContribute(): boolean { return this.session.hasPermission('stakeholders.contribute'); }
  get canDraw(): boolean { return this.session.hasPermission('stakeholders.drawing'); }
  get canProfitShare(): boolean { return this.session.hasPermission('stakeholders.profit-share'); }
  get canSeeAccounts(): boolean { return this.session.hasPermission('accounting.journal.view'); }
  get canClosePeriod(): boolean { return this.session.hasPermission('accounting.period.close'); }

  async ngOnInit(): Promise<void> {
    const ws = this.session.getWorkstationSession();
    if (ws?.billingDate) { this.fromDate = ws.billingDate; this.toDate = ws.billingDate; }
    await this.reload();
  }

  @HostListener('document:keydown.escape') onEscape(): void { this.closeAll(); }

  closeAll(): void {
    this.expenseDraft = null; this.transferDraft = null; this.fundDraft = null; this.ledger = null;
    this.attachDraft = null; this.moveCostDraft = null; this.lotDetail = null;
    this.partnerDraft = null; this.partnerMove = null; this.partnerStatement = null; this.closeDraft = null;
  }

  async selectTab(tab: Tab): Promise<void> {
    this.activeTab = tab; this.closeAll(); this.error = ''; this.info = '';
    if (tab === 'lots') await this.loadLotCosting();
    if (tab === 'partners') await this.loadPartners();
    if (tab === 'accounts') await this.loadAccounts();
  }

  async reload(): Promise<void> {
    if (!window.posApi) return;
    const origin = this.origin();
    if (!origin) { this.error = 'An active workstation session is required to open Expenses.'; return; }
    this.loading = true; this.error = '';
    const [funds, categories] = await Promise.all([
      this.canSeeFunds
        ? window.posApi.funds.list(origin.locCode, this.canManageFunds, this.actor())
        : Promise.resolve({ success: true as const, data: [] as FundAccount[] }),
      window.posApi.expenses.categories(false, this.actor())
    ]);
    if (funds.success) this.funds = funds.data || []; else this.error = funds.error || 'Could not load fund accounts.';
    if (categories.success) this.categories = categories.data || []; else this.error = categories.error || 'Could not load expense categories.';
    await this.search();
    if (this.activeTab === 'lots') await this.loadLotCosting();
    if (this.activeTab === 'partners') await this.loadPartners();
    if (this.activeTab === 'accounts') await this.loadAccounts();
    this.loading = false;
  }

  async search(): Promise<void> {
    if (!window.posApi) return;
    const origin = this.origin();
    if (!origin) return;
    const result = await window.posApi.expenses.list({
      locCode: origin.locCode,
      fromDate: this.fromDate || undefined,
      toDate: this.toDate || undefined,
      categoryId: this.filterCategoryId || undefined,
      fundAccountId: this.filterFundId || undefined,
      term: this.term || undefined,
      unallocatedOnly: this.unallocatedOnly || undefined
    } as any, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load the expense register.'; return; }
    this.register = result.data;
  }

  // ── Funds ─────────────────────────────────────────────────

  get spendableFunds(): FundAccount[] { return this.funds.filter((fund) => fund.isActive); }
  /** Funds a partner's money can actually move through. A pocket is the person. */
  get businessFunds(): FundAccount[] { return this.spendableFunds.filter((fund) => fund.fundKind !== 'stakeholder'); }
  get totalHeld(): number { return this.funds.filter((f) => f.isActive && f.fundKind !== 'stakeholder').reduce((sum, fund) => sum + Number(fund.balance || 0), 0); }

  fundKindLabel(kind: string): string {
    switch (kind) {
      case 'pos_drawer': return 'Till';
      case 'cash_safe': return 'Safe';
      case 'bank': return 'Bank';
      case 'stakeholder': return 'Pocket';
      default: return kind;
    }
  }

  /** The one sentence that explains what a fund's balance actually means. */
  fundBalanceHint(fund: FundAccount): string {
    if (fund.fundKind === 'pos_drawer') return 'What the open shift is holding right now. Closed shifts were counted and emptied.';
    if (fund.fundKind === 'stakeholder') return 'Money this person spends from their own hand. A negative figure is what the business owes them.';
    return 'Opening balance plus everything recorded in and out of this fund.';
  }

  newFund(): void {
    this.closeAll();
    this.fundDraft = { name: '', fundKind: 'cash_safe', holderName: '', accountReference: '', openingBalance: 0, notes: '', isActive: true };
  }

  editFund(fund: FundAccount): void {
    if (fund.fundKind === 'pos_drawer') return;
    this.closeAll();
    this.fundDraft = {
      id: fund.id, name: fund.name, fundKind: fund.fundKind as FundDraft['fundKind'],
      holderName: fund.holderName || '', accountReference: fund.accountReference || '',
      openingBalance: fund.openingBalance, notes: fund.notes || '', isActive: fund.isActive
    };
  }

  async saveFund(): Promise<void> {
    if (!window.posApi || !this.fundDraft || this.saving) return;
    const origin = this.origin();
    if (!origin) { this.error = 'An active workstation session is required.'; return; }
    this.saving = true; this.error = '';
    const result = await window.posApi.funds.save({ ...this.fundDraft, locCode: origin.locCode } as any, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not save the fund account.'; return; }
    this.info = `${result.data.name} saved.`; this.fundDraft = null; await this.reload();
  }

  async openLedger(fund: FundAccount): Promise<void> {
    if (!window.posApi) return;
    const origin = this.origin();
    if (!origin) return;
    this.closeAll();
    const result = await window.posApi.funds.ledger({
      fundAccountId: fund.id, locCode: origin.locCode,
      fromDate: this.fromDate || undefined, toDate: this.toDate || undefined
    }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load this fund ledger.'; return; }
    this.ledger = result.data;
  }

  // ── Expenses ──────────────────────────────────────────────

  newExpense(): void {
    this.closeAll();
    this.expenseDraft = {
      expenseCategoryId: this.categories[0]?.id ?? null,
      fundAccountId: this.spendableFunds[0]?.id ?? null,
      amount: null, payee: '', reference: '', reason: ''
    };
  }

  get draftCategory(): ExpenseCategory | null {
    return this.categories.find((row) => row.id === this.expenseDraft?.expenseCategoryId) || null;
  }
  get draftFund(): FundAccount | null {
    return this.funds.find((row) => row.id === this.expenseDraft?.fundAccountId) || null;
  }

  /**
   * "Does this cost belong to the goods or to the month" is the decision a new
   * owner gets wrong, so the answer is spelled out beside the category.
   */
  get draftTreatmentHint(): string {
    const category = this.draftCategory;
    if (!category) return '';
    if (category.defaultTreatment === 'lot_cost') {
      return 'This kind of cost belongs to received goods. After you record it, attach it to a delivery so it raises what those goods really cost.';
    }
    if (category.defaultTreatment === 'supplier_deduction') return 'This kind of cost is normally recovered from a supplier settlement.';
    return 'A general business cost. It affects your profit for the period, not the cost price of any one delivery.';
  }

  get draftPocketHint(): string {
    const fund = this.draftFund;
    return fund?.fundKind === 'stakeholder'
      ? 'This money comes from a partner, not from the business. Recording it here means the business owes them the amount.'
      : '';
  }

  get draftShortfall(): boolean {
    const fund = this.draftFund;
    // A partner's own pocket has no balance the business can check.
    if (!fund || fund.fundKind === 'stakeholder') return false;
    return Number(this.expenseDraft?.amount || 0) > Number(fund.balance || 0) + 0.005;
  }

  async saveExpense(): Promise<void> {
    if (!window.posApi || !this.expenseDraft || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) { this.error = 'An active workstation session is required to record an expense.'; return; }
    this.saving = true; this.error = '';
    const result = await window.posApi.expenses.create({
      expenseCategoryId: Number(this.expenseDraft.expenseCategoryId),
      fundAccountId: Number(this.expenseDraft.fundAccountId),
      amount: Number(this.expenseDraft.amount),
      payee: this.expenseDraft.payee, reference: this.expenseDraft.reference,
      reason: this.expenseDraft.reason, userId: user.id, origin
    }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not record this expense.'; return; }
    const saved = result.data as any;
    this.info = `${saved.expenseNumber} recorded. ${saved.fundName} now holds ${this.formatMoney(saved.fundBalance)}.`;
    if (saved.stakeholderName) this.info += ` The business now owes ${saved.stakeholderName} this amount.`;
    if (saved.categoryTreatment === 'lot_cost' && this.canAllocate) {
      this.info += ' Attach it to a delivery so it raises what those goods cost.';
    }
    this.expenseDraft = null;
    await this.reload();
  }

  // ── Transfers ─────────────────────────────────────────────

  newTransfer(): void {
    this.closeAll();
    this.transferDraft = {
      fromFundAccountId: this.spendableFunds[0]?.id ?? null,
      toFundAccountId: this.spendableFunds[1]?.id ?? null, amount: null, reason: ''
    };
  }
  get transferFrom(): FundAccount | null {
    return this.funds.find((row) => row.id === this.transferDraft?.fromFundAccountId) || null;
  }
  get transferShortfall(): boolean {
    const fund = this.transferFrom;
    if (!fund || fund.fundKind === 'stakeholder') return false;
    return Number(this.transferDraft?.amount || 0) > Number(fund.balance || 0) + 0.005;
  }

  async saveTransfer(): Promise<void> {
    if (!window.posApi || !this.transferDraft || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) { this.error = 'An active workstation session is required to move money.'; return; }
    this.saving = true; this.error = '';
    const result = await window.posApi.funds.transfer({
      fromFundAccountId: Number(this.transferDraft.fromFundAccountId),
      toFundAccountId: Number(this.transferDraft.toFundAccountId),
      amount: Number(this.transferDraft.amount), reason: this.transferDraft.reason,
      userId: user.id, origin
    }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not move the money.'; return; }
    const moved = result.data;
    this.info = `${moved.transferNumber}: ${this.formatMoney(moved.amount)} moved from ${moved.fromFund} to ${moved.toFund}.`;
    this.transferDraft = null; await this.reload();
  }

  // ── Lot costing ───────────────────────────────────────────

  async loadLotCosting(): Promise<void> {
    if (!window.posApi || !this.canSeeLots) return;
    const origin = this.origin();
    if (!origin) return;
    const [profit, lots] = await Promise.all([
      window.posApi.lotCosting.profitability({
        locCode: origin.locCode, fromDate: this.fromDate || undefined, toDate: this.toDate || undefined,
        ownershipModel: this.ownershipFilter || undefined, term: this.term || undefined
      }, this.actor()),
      window.posApi.lotCosting.lots({ locCode: origin.locCode, limit: 200 }, this.actor())
    ]);
    if (profit.success) this.profitability = profit.data; else this.error = profit.error || 'Could not load lot profitability.';
    if (lots.success) this.lots = lots.data || [];
  }

  get unattachedExpenses(): ExpenseEntry[] {
    return (this.register?.rows || []).filter((row) => row.unallocatedTotal > 0.005 && row.categoryTreatment === 'lot_cost');
  }

  openAttach(expense: ExpenseEntry): void {
    this.closeAll();
    this.attachDraft = {
      expense, scope: 'goods_receipt', inventoryLotId: null,
      goodsReceiptId: this.lots[0]?.goodsReceiptId ?? null,
      basis: 'base_quantity', amount: expense.unallocatedTotal
    };
  }

  get attachGrns(): Array<{ id: number; label: string; lotCount: number }> {
    const map = new Map<number, { id: number; label: string; lotCount: number }>();
    for (const lot of this.lots) {
      if (lot.goodsReceiptId == null) continue;
      const current = map.get(lot.goodsReceiptId);
      if (current) current.lotCount += 1;
      else map.set(lot.goodsReceiptId, { id: lot.goodsReceiptId, label: `${lot.grnNumber} · ${lot.supplierName}`, lotCount: 1 });
    }
    return [...map.values()];
  }

  get attachBasisHint(): string {
    switch (this.attachDraft?.basis) {
      case 'base_quantity': return 'Divided by weight. Usual for transport and unloading — heavier goods carry more of the cost.';
      case 'handling_quantity': return 'Divided by the number of bags or crates. Usual for handling paid per package.';
      case 'sale_value': return 'Divided by what each lot sold for. Usual for commission and value-based charges.';
      case 'equal': return 'Split evenly between the lots, whatever their size.';
      default: return 'The whole cost goes on this one lot.';
    }
  }

  async saveAttach(): Promise<void> {
    if (!window.posApi || !this.attachDraft || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) { this.error = 'An active workstation session is required.'; return; }
    this.saving = true; this.error = '';
    const draft = this.attachDraft;
    const result = await window.posApi.lotCosting.allocate({
      expenseEntryId: draft.expense.id,
      inventoryLotId: draft.scope === 'lot' ? Number(draft.inventoryLotId) : null,
      goodsReceiptId: draft.scope === 'goods_receipt' ? Number(draft.goodsReceiptId) : null,
      basis: draft.scope === 'lot' ? 'direct' : draft.basis,
      amount: draft.amount == null ? null : Number(draft.amount),
      userId: user.id, origin
    }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not attach this cost.'; return; }
    const saved = result.data;
    this.info = `${saved.expenseNumber} attached across ${saved.allocations.length} lot${saved.allocations.length === 1 ? '' : 's'}.`
      + (saved.unallocatedTotal > 0.005 ? ` ${this.formatMoney(saved.unallocatedTotal)} is still unattached.` : '');
    this.attachDraft = null;
    await this.reload();
  }

  openMoveCost(allocation?: LotCostAllocation): void {
    const detail = this.lotDetail;
    this.closeAll();
    this.moveCostDraft = {
      expenseEntryId: allocation?.expenseEntryId ?? null,
      fromInventoryLotId: detail?.lot.id ?? null,
      toInventoryLotId: null, amount: allocation ? Math.abs(allocation.amount) : null, reason: ''
    };
  }

  async saveMoveCost(): Promise<void> {
    if (!window.posApi || !this.moveCostDraft || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) { this.error = 'An active workstation session is required.'; return; }
    this.saving = true; this.error = '';
    const result = await window.posApi.lotCosting.reallocate({
      expenseEntryId: Number(this.moveCostDraft.expenseEntryId),
      fromInventoryLotId: Number(this.moveCostDraft.fromInventoryLotId),
      toInventoryLotId: Number(this.moveCostDraft.toInventoryLotId),
      amount: Number(this.moveCostDraft.amount),
      reason: this.moveCostDraft.reason, userId: user.id, origin
    }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not move this cost.'; return; }
    this.info = `${result.data.reallocationNumber}: ${this.formatMoney(result.data.amount)} moved between lots. Both lots keep their history.`;
    this.moveCostDraft = null;
    await this.loadLotCosting();
  }

  async openLotDetail(lotId: number): Promise<void> {
    if (!window.posApi) return;
    const origin = this.origin();
    if (!origin) return;
    this.closeAll();
    const result = await window.posApi.lotCosting.lotDetail({ inventoryLotId: lotId, locCode: origin.locCode }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load this lot.'; return; }
    this.lotDetail = result.data;
  }

  async runReconcile(): Promise<void> {
    if (!window.posApi) return;
    const origin = this.origin();
    if (!origin) return;
    const result = await window.posApi.lotCosting.reconcile(origin.locCode, this.actor());
    if (!result.success) { this.error = result.error || 'Could not reconcile landed cost.'; return; }
    this.reconcileResult = result.data;
    this.info = result.data.drifted === 0
      ? `Checked ${result.data.checked} lots. Every stored cost matches its ledger.`
      : `${result.data.drifted} of ${result.data.checked} lots no longer match their ledger.`;
  }

  // ── Partners ──────────────────────────────────────────────

  async loadPartners(): Promise<void> {
    if (!window.posApi || !this.canSeePartners) return;
    const origin = this.origin();
    if (!origin) return;
    const [list, check] = await Promise.all([
      window.posApi.stakeholders.list(origin.locCode, this.canManagePartners, this.actor()),
      window.posApi.stakeholders.reconcile(origin.locCode, this.actor())
    ]);
    if (list.success) this.partners = list.data || []; else this.error = list.error || 'Could not load stakeholders.';
    if (check.success) this.equityCheck = check.data;
  }

  newPartner(): void {
    this.closeAll();
    this.partnerDraft = { displayName: '', stakeholderType: 'partner', borneCostTreatment: 'capital', mobile: '', notes: '', isActive: true };
  }

  editPartner(partner: Stakeholder): void {
    this.closeAll();
    this.partnerDraft = {
      id: partner.id, displayName: partner.displayName, stakeholderType: partner.stakeholderType,
      borneCostTreatment: partner.borneCostTreatment, mobile: partner.mobile || '',
      notes: partner.notes || '', isActive: partner.isActive
    };
  }

  async savePartner(): Promise<void> {
    if (!window.posApi || !this.partnerDraft || this.saving) return;
    const origin = this.origin();
    if (!origin) { this.error = 'An active workstation session is required.'; return; }
    this.saving = true; this.error = '';
    const result = await window.posApi.stakeholders.save({ ...this.partnerDraft, locCode: origin.locCode } as any, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not save this stakeholder.'; return; }
    this.info = `${result.data.displayName} saved.`;
    this.partnerDraft = null;
    await Promise.all([this.loadPartners(), this.reload()]);
  }

  openPartnerMove(stakeholder: Stakeholder, mode: PartnerMoveDraft['mode']): void {
    this.closeAll();
    this.partnerMove = {
      mode, stakeholder, fundAccountId: this.businessFunds[0]?.id ?? null,
      amount: null, reason: '', overrideReason: ''
    };
  }

  get partnerMoveTitle(): string {
    switch (this.partnerMove?.mode) {
      case 'contribute': return 'Money put in';
      case 'draw': return 'Money taken out';
      case 'settle': return 'Repay what the business owes';
      case 'profit_share': return 'Allocate a profit share';
      default: return '';
    }
  }

  get partnerMoveHint(): string {
    switch (this.partnerMove?.mode) {
      case 'contribute': return 'Recording money you put in is how the system knows what is yours. Without it, your own money looks like business profit.';
      case 'draw': return `Available to take: ${this.formatMoney(this.partnerMove?.stakeholder.claim)}. This is what they put in, plus their allocated profit, minus what they have already taken.`;
      case 'settle': return 'Use this when the business pays a partner back for something they bought with their own money.';
      case 'profit_share': return 'No cash moves here. This only records that part of the profit now belongs to this person, so they may take it later.';
      default: return '';
    }
  }

  get partnerMoveOverLimit(): boolean {
    if (!this.partnerMove || this.partnerMove.mode === 'contribute' || this.partnerMove.mode === 'profit_share') return false;
    return Number(this.partnerMove.amount || 0) > Number(this.partnerMove.stakeholder.claim || 0) + 0.005;
  }

  async savePartnerMove(): Promise<void> {
    if (!window.posApi || !this.partnerMove || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) { this.error = 'An active workstation session is required.'; return; }
    this.saving = true; this.error = '';
    const move = this.partnerMove;
    const payload: any = {
      stakeholderId: move.stakeholder.id, fundAccountId: Number(move.fundAccountId),
      amount: Number(move.amount), reason: move.reason, userId: user.id, origin
    };
    if (this.partnerMoveOverLimit) { payload.overrideApprovedBy = user.id; payload.overrideReason = move.overrideReason; }
    const api = window.posApi.stakeholders;
    const result = move.mode === 'contribute' ? await api.contribute(payload, this.actor())
      : move.mode === 'draw' ? await api.draw(payload, this.actor())
        : move.mode === 'settle' ? await api.settle(payload, this.actor())
          : await api.profitShare({ ...payload, reason: move.reason }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not record this.'; return; }
    const saved = result.data as any;
    this.info = `${saved.entryNumber} recorded. The business now owes ${saved.stakeholderName} ${this.formatMoney(saved.claim)}.`;
    this.partnerMove = null;
    await Promise.all([this.loadPartners(), this.reload()]);
  }

  async openPartnerStatement(stakeholder: Stakeholder): Promise<void> {
    if (!window.posApi) return;
    const origin = this.origin();
    if (!origin) return;
    this.closeAll();
    const result = await window.posApi.stakeholders.statement({ stakeholderId: stakeholder.id, locCode: origin.locCode }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load the partner statement.'; return; }
    this.partnerStatement = result.data;
  }

  entryTypeLabel(type: string): string {
    switch (type) {
      case 'capital_contribution': return 'Put in';
      case 'expense_borne': return 'Paid for the business';
      case 'drawing': return 'Taken out';
      case 'profit_share_allocation': return 'Profit share';
      case 'settlement': return 'Repaid';
      default: return type;
    }
  }

  // ── Accountant mode ───────────────────────────────────────

  async loadAccounts(): Promise<void> {
    if (!window.posApi || !this.canSeeAccounts) return;
    const origin = this.origin();
    if (!origin) return;
    const filters = { locCode: origin.locCode, fromDate: this.fromDate || undefined, toDate: this.toDate || undefined };
    const api = window.posApi.accounting;
    const [trial, pnl, sheet, journal, periods] = await Promise.all([
      api.trialBalance(filters, this.actor()),
      api.profitAndLoss(filters, this.actor()),
      api.balanceSheet(filters, this.actor()),
      api.journal({ ...filters, limit: 50 }, this.actor()),
      api.periods(origin.locCode, this.actor())
    ]);
    if (trial.success) this.trialBalance = trial.data; else this.error = trial.error || 'Could not run the trial balance.';
    if (pnl.success) this.profitAndLoss = pnl.data;
    if (sheet.success) this.balanceSheet = sheet.data;
    if (journal.success) this.journal = journal.data || [];
    if (periods.success) this.periods = periods.data || [];
  }

  openClosePeriod(): void {
    this.closeAll();
    const today = this.toDate || new Date().toISOString().slice(0, 10);
    this.closeDraft = { periodStart: today.slice(0, 8) + '01', periodEnd: today, notes: '' };
  }

  async saveClosePeriod(): Promise<void> {
    if (!window.posApi || !this.closeDraft || this.saving) return;
    const origin = this.origin(); const user = this.session.getUser();
    if (!origin || !user) return;
    this.saving = true; this.error = '';
    const result = await window.posApi.accounting.closePeriod({
      locCode: origin.locCode, periodStart: this.closeDraft.periodStart,
      periodEnd: this.closeDraft.periodEnd, userId: user.id, notes: this.closeDraft.notes
    }, this.actor());
    this.saving = false;
    if (!result.success) { this.error = result.error || 'Could not close the period.'; return; }
    this.info = `Period ${result.data.periodStart} to ${result.data.periodEnd} is closed and read-only.`;
    this.closeDraft = null;
    await this.loadAccounts();
  }

  async reopenPeriod(period: AccountingPeriod): Promise<void> {
    if (!window.posApi) return;
    const user = this.session.getUser();
    const reason = window.prompt('Reopening a closed period is recorded. Why is it being reopened?');
    if (!reason || !user) return;
    const result = await window.posApi.accounting.reopenPeriod({ periodId: period.id, userId: user.id, reason }, this.actor());
    if (!result.success) { this.error = result.error || 'Could not reopen the period.'; return; }
    this.info = 'The period is open again. The reason has been recorded.';
    await this.loadAccounts();
  }

  // ── Formatting ────────────────────────────────────────────

  formatMoney(value: number | null | undefined): string { return `Rs. ${Number(value || 0).toFixed(2)}`; }

  formatDate(value: unknown): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }

  formatQty(value: number | null | undefined, uom: string | null): string {
    if (value == null) return '—';
    return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 2)} ${uom || ''}`.trim();
  }

  movementLabel(kind: string): string { return String(kind || '').replace(/_/g, ' '); }

  categoryShare(total: number): number {
    const grand = Number(this.register?.total || 0);
    return grand > 0 ? Math.round((Number(total || 0) / grand) * 100) : 0;
  }

  lotName(lotId: number | null): string {
    const lot = this.lots.find((row) => row.id === lotId);
    return lot ? `${lot.lotCode} · ${lot.productName}` : '';
  }
}
