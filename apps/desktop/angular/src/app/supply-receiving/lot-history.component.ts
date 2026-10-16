import { Component, Input, OnChanges, OnInit, SimpleChanges } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PageLinksService } from '../services/page-links.service';
import type {
  LotBill,
  LotBillTotals,
  LotBills,
  LotHistoryPage,
  LotHistoryRow,
  LotSaleLine,
  LotSaleLines,
  LotSummary
} from '../../../../../../packages/shared/ipc/pos-api';

/** Sale lines added up: one row per item and rate, or one row per line. */
type SaleRow = {
  key: string;
  itemCode: string;
  description: string;
  unitPrice: number;
  handlingQuantity: number;
  baseQuantity: number | null;
  merchandiseTotal: number;
  handlingUom: string | null;
  baseUom: string | null;
  /** How many bill lines this row stands for; 1 when nothing is grouped. */
  lines: number;
  /** The one line behind an ungrouped row, so it can open its bill. */
  line: LotSaleLine | null;
};

type SaleTotals = { lines: number; handlingQuantity: number; baseQuantity: number; merchandiseTotal: number };

/** A day's worth of sale rows, or the whole lot's when days are not broken out. */
type SaleGroup = { date: string | null; rows: SaleRow[]; totals: SaleTotals };

type BillGroup = { title: string; bills: LotBill[]; totals: LotBillTotals };

/** One figure worth seeing without reading anything: a number and its name. */
type GlanceTile = {
  key: string;
  label: string;
  value: string;
  second: string | null;
  note: string | null;
  kind: 'plain' | 'billed' | 'held' | 'warn' | 'total' | 'money';
};

/** One way goods left the lot, or are spoken for, in both measures. */
type OutflowRow = {
  key: string;
  label: string;
  note: string;
  handling: number;
  base: number | null;
  /** Spoken for but still here, so it is listed apart from the total. */
  pending?: boolean;
};

/**
 * Every lot this location ever had, and one lot in full.
 *
 * The lot codes list above it answers "what can I sell from today". This
 * answers "what happened to that lot", which keeps growing, so it is paged and
 * searched rather than shown whole. What a lot earned is money: that part is
 * loaded only when asked for, and only for someone allowed to see lot costs.
 */
@Component({
  selector: 'pos-lot-history',
  templateUrl: './lot-history.component.html',
  styleUrls: ['./lot-history.component.css']
})
export class LotHistoryComponent implements OnInit, OnChanges {
  /** A lot another screen asked to open, coming back from a bill. */
  @Input() openLotId: number | null = null;

  view: 'list' | 'detail' = 'list';
  /** Which part of one lot is open. The figures above it stay whatever is chosen. */
  detailTab: 'delivery' | 'movements' | 'expenses' | 'sales' | 'bills' = 'delivery';
  loading = false;
  error = '';

  page: LotHistoryPage | null = null;
  term = '';
  status: 'all' | 'live' | 'retired' = 'all';
  pageSize = 25;
  pageNo = 1;

  summary: LotSummary | null = null;
  summaryLoading = false;

  sales: LotSaleLines | null = null;
  salesLoading = false;
  groupByPrice = true;
  breakByDays = false;

  bills: LotBills | null = null;
  billsLoading = false;
  billsLayout: 'list' | 'grid' = 'list';
  billsOrder: 'newest' | 'oldest' = 'newest';
  groupBySettlement = true;

  constructor(private session: SessionService, private pageLinks: PageLinksService) {}

  private api(): any { return window.posApi?.catalog as any; }
  private actor() { return this.session.getActor() || undefined; }
  private locCode(): string { return String(this.session.getWorkstationSession()?.locationCode || '').trim(); }

  /** What a lot earned is money, and money has its own right. */
  get canSeeMoney(): boolean { return this.session.hasPermission('lot-costing.view'); }

  async ngOnInit(): Promise<void> {
    await this.load();
    if (this.openLotId) await this.openLot(this.openLotId);
  }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    const lotId = Number(changes['openLotId']?.currentValue || 0);
    if (!changes['openLotId']?.firstChange && lotId) await this.openLot(lotId);
  }

  async load(page = this.pageNo): Promise<void> {
    if (!this.api() || !this.locCode()) return;
    this.loading = true;
    this.error = '';
    const result = await this.api().listLotHistory({
      locCode: this.locCode(), page, pageSize: this.pageSize,
      term: this.term.trim(), status: this.status
    }, this.actor());
    this.loading = false;
    if (!result?.success) { this.error = result?.error || 'The lot history could not be read.'; return; }
    this.page = result.data;
    this.pageNo = result.data.page;
  }

  async search(): Promise<void> { await this.load(1); }

  async setStatus(status: 'all' | 'live' | 'retired'): Promise<void> {
    this.status = status;
    await this.load(1);
  }

  async goToPage(page: number): Promise<void> {
    const last = this.page?.pageCount || 1;
    const wanted = Math.min(Math.max(1, page), last);
    if (wanted === this.pageNo) return;
    await this.load(wanted);
  }

  get firstShown(): number {
    if (!this.page || !this.page.total) return 0;
    return (this.page.page - 1) * this.page.pageSize + 1;
  }

  get lastShown(): number {
    if (!this.page) return 0;
    return Math.min(this.page.total, this.page.page * this.page.pageSize);
  }

  /** Opens one lot in full. Its sales and bills wait to be asked for. */
  async openLot(lotId: number): Promise<void> {
    if (!this.api() || !lotId) return;
    this.view = 'detail';
    this.summaryLoading = true;
    this.error = '';
    this.sales = null;
    this.bills = null;
    const result = await this.api().getLotSummary(lotId, this.locCode(), this.actor());
    this.summaryLoading = false;
    if (!result?.success) {
      this.error = result?.error || 'That lot could not be opened.';
      this.summary = null;
      return;
    }
    this.summary = result.data;
  }

  backToList(): void {
    this.view = 'list';
    this.detailTab = 'delivery';
    this.summary = null;
    this.sales = null;
    this.bills = null;
  }

  async loadSales(): Promise<void> {
    const lotId = this.summary?.lot.id;
    if (!lotId || !this.api()) return;
    this.salesLoading = true;
    const result = await this.api().listLotSaleLines(lotId, this.locCode(), this.actor());
    this.salesLoading = false;
    if (!result?.success) { this.error = result?.error || 'The sales of this lot could not be read.'; return; }
    this.sales = result.data;
  }

  async loadBills(): Promise<void> {
    const lotId = this.summary?.lot.id;
    if (!lotId || !this.api()) return;
    this.billsLoading = true;
    const result = await this.api().listLotBills(lotId, this.locCode(), this.actor());
    this.billsLoading = false;
    if (!result?.success) { this.error = result?.error || 'The bills of this lot could not be read.'; return; }
    this.bills = result.data;
  }

  // ── Sales, the way the person asked to see them ──────────────────────────

  /**
   * One group per day when days are broken out, otherwise one group for the
   * lot. Within a group, lines are added up by item and rate when that is
   * ticked; otherwise every line stands on its own.
   */
  get saleGroups(): SaleGroup[] {
    const lines = this.sales?.lines || [];
    if (!lines.length) return [];
    if (!this.breakByDays) return [{ date: null, rows: this.rowsOf(lines), totals: this.totalsOf(lines) }];
    const days = new Map<string, LotSaleLine[]>();
    for (const line of lines) {
      const day = line.date || '';
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(line);
    }
    return [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, dayLines]) => ({ date, rows: this.rowsOf(dayLines), totals: this.totalsOf(dayLines) }));
  }

  private rowsOf(lines: LotSaleLine[]): SaleRow[] {
    if (!this.groupByPrice) {
      return lines.map((line) => ({
        key: `line-${line.id}`,
        itemCode: line.itemCode,
        description: line.description,
        unitPrice: line.unitPrice,
        handlingQuantity: line.handlingQuantity,
        baseQuantity: line.baseQuantity,
        merchandiseTotal: line.merchandiseTotal,
        handlingUom: line.handlingUom,
        baseUom: line.baseUom,
        lines: 1,
        line
      }));
    }
    const groups = new Map<string, SaleRow>();
    for (const line of lines) {
      const key = `${line.itemCode}|${line.unitPrice}`;
      const row = groups.get(key);
      if (!row) {
        groups.set(key, {
          key,
          itemCode: line.itemCode,
          description: line.description,
          unitPrice: line.unitPrice,
          handlingQuantity: line.handlingQuantity,
          baseQuantity: line.baseQuantity,
          merchandiseTotal: line.merchandiseTotal,
          handlingUom: line.handlingUom,
          baseUom: line.baseUom,
          lines: 1,
          line: null
        });
        continue;
      }
      row.handlingQuantity = round(row.handlingQuantity + line.handlingQuantity);
      row.baseQuantity = line.baseQuantity == null && row.baseQuantity == null
        ? null
        : round(Number(row.baseQuantity || 0) + Number(line.baseQuantity || 0));
      row.merchandiseTotal = money(row.merchandiseTotal + line.merchandiseTotal);
      row.lines += 1;
    }
    return [...groups.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.unitPrice - b.unitPrice);
  }

  private totalsOf(lines: LotSaleLine[]): SaleTotals {
    return lines.reduce((sum, line) => ({
      lines: sum.lines + 1,
      handlingQuantity: round(sum.handlingQuantity + line.handlingQuantity),
      baseQuantity: round(sum.baseQuantity + Number(line.baseQuantity || 0)),
      merchandiseTotal: money(sum.merchandiseTotal + line.merchandiseTotal)
    }), { lines: 0, handlingQuantity: 0, baseQuantity: 0, merchandiseTotal: 0 });
  }

  // ── The figures worth seeing at a glance ─────────────────────────────────

  /**
   * What a person wants to know standing in front of this lot: how much was
   * billed, how much is spoken for, how much left another way, what it cost.
   * A figure that is zero because nothing of that kind ever happened is left
   * out -- it is noise -- and the Movements tab below still lists every one.
   */
  get glanceTiles(): GlanceTile[] {
    const summary = this.summary;
    if (!summary) return [];
    const lot = summary.lot;
    const pair = (handling: number, base: number | null): { value: string; second: string | null } => ({
      value: this.measure(handling, lot.handlingUom),
      second: lot.baseUom ? this.measure(base ?? 0, lot.baseUom) : null
    });
    const tiles: GlanceTile[] = [];

    tiles.push(lot.quantityKnown
      ? { key: 'arrived', label: 'Arrived', ...pair(lot.receivedHandling, lot.receivedBase), note: null, kind: 'plain' }
      : { key: 'arrived', label: 'Arrived', value: 'Not counted', second: null, note: 'Sells on its code until it is finished', kind: 'plain' });

    if (lot.quantityKnown) {
      tiles.push({
        key: 'left', label: 'Still on the lot', ...pair(lot.remainingHandling, lot.remainingBase),
        note: null, kind: 'plain'
      });
    }

    tiles.push({
      key: 'billed', label: 'Sold', ...pair(lot.soldHandling, lot.soldBase),
      note: `${lot.saleLineCount} bill ${lot.saleLineCount === 1 ? 'line' : 'lines'}`, kind: 'billed'
    });

    if (lot.heldHandling || lot.heldBase) {
      tiles.push({
        key: 'held', label: 'On hold', ...pair(lot.heldHandling, lot.heldBase),
        note: 'Not billed yet', kind: 'held'
      });
    }
    if (summary.sentOut.handling || summary.sentOut.base) {
      tiles.push({
        key: 'sent', label: 'Sent out', ...pair(summary.sentOut.handling, summary.sentOut.base),
        note: `${summary.issues.length} ${summary.issues.length === 1 ? 'load' : 'loads'}`, kind: 'plain'
      });
    }
    if (summary.adjusted.handling || summary.adjusted.base) {
      const added = summary.adjusted.handling > 0 || Number(summary.adjusted.base) > 0;
      tiles.push({
        key: 'adjusted', label: added ? 'Added back' : 'Wastage',
        ...pair(Math.abs(summary.adjusted.handling), Math.abs(Number(summary.adjusted.base || 0))),
        note: `${summary.adjustments.length} ${summary.adjustments.length === 1 ? 'adjustment' : 'adjustments'}`,
        kind: 'warn'
      });
    }

    const total = this.outflowTotal;
    tiles.push({
      key: 'total', label: 'Gone out altogether', ...pair(total.handling, total.base),
      note: this.outflowWithHeld
        ? `${this.measure(this.outflowWithHeld.handling, lot.handlingUom)} with the bills on the counter`
        : (lot.quantityKnown ? null : 'What it is taken to have received when finished'),
      kind: 'total'
    });

    tiles.push({
      key: 'expenses', label: 'Lot expenses', value: this.amount(summary.expenseTotal), second: null,
      note: `${summary.expenses.length} ${summary.expenses.length === 1 ? 'entry' : 'entries'}`, kind: 'money'
    });

    if (lot.ownershipModel === 'consignment' && summary.supplierDue) {
      tiles.push({
        key: 'due', label: 'Owed to supplier', value: this.amount(summary.supplierDue), second: null,
        note: 'Accrued as it sold', kind: 'money'
      });
    }
    return tiles;
  }

  /** How many entries each tab holds, so a tab can say whether it is worth opening. */
  get movementCount(): number {
    return (this.summary?.issues.length || 0) + (this.summary?.adjustments.length || 0);
  }

  amount(value: number): string {
    return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  trackTile(_index: number, tile: GlanceTile): string { return tile.key; }

  // ── Everything that left the lot ─────────────────────────────────────────

  /**
   * Goods leave a lot three ways -- billed, sent out on another lorry, lost --
   * and a fourth figure, what bills still on the counter have booked, is
   * spoken for without having gone anywhere yet. It is listed with them but
   * kept out of the total, because nothing has left on it.
   */
  get outflowRows(): OutflowRow[] {
    const summary = this.summary;
    if (!summary) return [];
    const lot = summary.lot;
    const rows: OutflowRow[] = [{
      key: 'billed',
      label: 'Billed',
      note: `${lot.saleLineCount} bill ${lot.saleLineCount === 1 ? 'line' : 'lines'}`,
      handling: lot.soldHandling,
      base: lot.baseUom ? lot.soldBase : null
    }];
    if (summary.sentOut.handling || summary.sentOut.base) {
      rows.push({
        key: 'sent',
        label: 'Sent out',
        note: `${summary.issues.length} ${summary.issues.length === 1 ? 'load' : 'loads'} on another lorry`,
        handling: summary.sentOut.handling,
        base: lot.baseUom ? summary.sentOut.base : null
      });
    }
    if (summary.adjusted.handling || summary.adjusted.base) {
      // Written as a signed number: a loss is negative, so it is turned round
      // to read as something that left, like the rows beside it.
      rows.push({
        key: 'adjusted',
        label: summary.adjusted.handling > 0 || Number(summary.adjusted.base) > 0 ? 'Added back' : 'Wastage and losses',
        note: `${summary.adjustments.length} ${summary.adjustments.length === 1 ? 'adjustment' : 'adjustments'}`,
        handling: -summary.adjusted.handling,
        base: lot.baseUom ? -summary.adjusted.base : null
      });
    }
    if (lot.heldHandling || lot.heldBase) {
      rows.push({
        key: 'held',
        label: 'On hold',
        note: 'On bills still being written. Not billed yet.',
        handling: lot.heldHandling,
        base: lot.baseUom ? (lot.heldBase || 0) : null,
        pending: true
      });
    }
    return rows;
  }

  /** What has actually left the lot, by every route. */
  get outflowTotal(): { handling: number; base: number | null } {
    const counted = this.outflowRows.filter((row) => !row.pending);
    const base = this.summary?.lot.baseUom
      ? round(counted.reduce((sum, row) => sum + Number(row.base || 0), 0))
      : null;
    return { handling: round(counted.reduce((sum, row) => sum + row.handling, 0)), base };
  }

  /** The same, if every bill on the counter were finished as it stands. */
  get outflowWithHeld(): { handling: number; base: number | null } | null {
    const held = this.outflowRows.find((row) => row.pending);
    if (!held) return null;
    const total = this.outflowTotal;
    return {
      handling: round(total.handling + held.handling),
      base: total.base == null ? null : round(total.base + Number(held.base || 0))
    };
  }

  adjustmentKindLabel(kind: string): string {
    if (kind === 'loss') return 'Wastage';
    if (kind === 'damage') return 'Damaged';
    if (kind === 'supplier_return') return 'Back to supplier';
    if (kind === 'physical_count') return 'Counted';
    return 'Correction';
  }

  trackOutflow(_index: number, row: OutflowRow): string { return row.key; }

  // ── Bills ────────────────────────────────────────────────────────────────

  get billGroups(): BillGroup[] {
    if (!this.bills) return [];
    const ordered = [...this.bills.bills].sort((a, b) => {
      const left = String(a.billedAt || a.date || '');
      const right = String(b.billedAt || b.date || '');
      return this.billsOrder === 'newest' ? right.localeCompare(left) : left.localeCompare(right);
    });
    if (!this.groupBySettlement) {
      return [{ title: 'All bills', bills: ordered, totals: this.bills.totals }];
    }
    return [
      { title: 'Not settled', bills: ordered.filter((bill) => !bill.settled), totals: this.bills.unsettledTotals },
      { title: 'Settled', bills: ordered.filter((bill) => bill.settled), totals: this.bills.settledTotals }
    ].filter((group) => group.bills.length > 0);
  }

  /** Opens one bill in the invoice archive, with a way back to this lot. */
  openBill(bill: LotBill): void {
    const lot = this.summary?.lot;
    void this.pageLinks.openInvoiceArchive(
      {
        invoiceId: bill.id,
        invoiceNumber: bill.invoiceNumber,
        locCode: bill.locCode,
        macCode: bill.macCode,
        txnDate: bill.date || undefined,
        showReturned: true
      },
      lot ? { url: '/receiving', queryParams: { open: 'lot-codes', lot: lot.id }, label: `lot ${lot.lotTag || lot.lotCode}` } : null
    );
  }

  // ── Small helpers the template reads ─────────────────────────────────────

  measure(value: number | null | undefined, uom: string | null): string {
    if (value == null) return '—';
    const amount = Number(value);
    const shown = Number.isInteger(amount) ? String(amount) : String(Number(amount.toFixed(3)));
    return uom ? `${shown} ${uom}` : shown;
  }

  /** What a lot is doing now, in the fewest words that are still true. */
  statusOf(lot: LotHistoryRow): string {
    if (!lot.quantityKnown) return lot.closedAt ? 'Finished' : 'Not counted';
    if (lot.stockMode === 'purchase_record') return 'Purchase record';
    return lot.live ? 'Selling' : 'Sold out';
  }

  statusKind(lot: LotHistoryRow): string {
    if (!lot.quantityKnown) return lot.closedAt ? 'done' : 'open';
    if (lot.stockMode === 'purchase_record') return 'record';
    return lot.live ? 'live' : 'done';
  }

  trackLot(_index: number, lot: LotHistoryRow): number { return lot.id; }
  trackSaleRow(_index: number, row: SaleRow): string { return row.key; }
  trackBill(_index: number, bill: LotBill): number { return bill.id; }
}

function round(value: number): number { return Math.round(Number(value || 0) * 1000) / 1000; }
function money(value: number): number { return Math.round(Number(value || 0) * 100) / 100; }
