import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { SessionService } from '../services/session.service';
import type { ExpenseGoodsLot, ExpenseGoodsTarget } from '../../../../../../packages/shared/ipc/pos-api';

/**
 * Picks the GRN a lot expense belongs to, and optionally one of its lots.
 *
 * Recent GRNs are listed first; a search reaches older ones, so the list stays
 * short however much has been received. Typing the short code a cashier uses
 * for a lot -- KAR1 -- picks that lot and its delivery outright, because that
 * code is what anybody standing at the counter actually knows the goods by.
 *
 * Whatever is chosen is shown with its quantities. A cost put on the wrong lot
 * is quiet and hard to find later, so the screen states the goods it is about
 * to be attached to rather than only their code.
 */
@Component({
  selector: 'pos-expense-goods-picker',
  templateUrl: './expense-goods-picker.component.html',
  styleUrls: ['./expense-goods-picker.component.css']
})
export class ExpenseGoodsPickerComponent implements OnInit {
  @Input() goodsReceiptId: number | null = null;
  @Output() goodsReceiptIdChange = new EventEmitter<number | null>();
  @Input() inventoryLotId: number | null = null;
  @Output() inventoryLotIdChange = new EventEmitter<number | null>();

  targets: ExpenseGoodsTarget[] = [];
  term = '';
  fromDate = '';
  loading = false;
  error = '';
  /** What a typed lot code picked on its own, so the screen can say so. */
  matchedByCode: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private session: SessionService) {}

  async ngOnInit(): Promise<void> {
    const today = String(this.session.getBillingDate() || new Date().toISOString()).slice(0, 10);
    const start = new Date(`${today}T00:00:00`);
    start.setDate(start.getDate() - 30);
    this.fromDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    await this.load();
  }

  /** Search as it is typed, once the typing pauses. */
  onTermChanged(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { void this.load(); }, 250);
  }

  async load(): Promise<void> {
    if (!window.posApi) return;
    this.loading = true; this.error = '';
    // A search looks through every GRN; without one, only the recent ones.
    const result = await window.posApi.lotCosting.goodsTargets({
      term: this.term.trim(), fromDate: this.term.trim() ? undefined : this.fromDate, limit: 60
    }, this.session.getActor() || undefined);
    this.loading = false;
    if (!result.success) { this.error = result.error || 'Could not load GRNs.'; return; }
    this.targets = result.data || [];
    if (this.goodsReceiptId && !this.targets.some((row) => row.id === this.goodsReceiptId)) {
      const chosen = await window.posApi.lotCosting.goodsTargets({ goodsReceiptId: this.goodsReceiptId }, this.session.getActor() || undefined);
      if (chosen.success && chosen.data?.length) this.targets = [...chosen.data, ...this.targets];
    }
    this.applyTypedCode();
  }

  /**
   * A typed code that is exactly one lot's own picks it, along with its
   * delivery. Anything less certain is left to the list below.
   */
  private applyTypedCode(): void {
    this.matchedByCode = null;
    const typed = this.term.trim().toUpperCase();
    if (!typed) return;
    const hits: Array<{ grn: ExpenseGoodsTarget; lot: ExpenseGoodsLot }> = [];
    for (const grn of this.targets) {
      for (const lot of grn.lots) {
        if (String(lot.lotTag || '').toUpperCase() === typed || String(lot.lotCode || '').toUpperCase() === typed) {
          hits.push({ grn, lot });
        }
      }
    }
    if (hits.length !== 1) return;
    const [hit] = hits;
    if (this.goodsReceiptId !== hit.grn.id) {
      this.goodsReceiptId = hit.grn.id;
      this.goodsReceiptIdChange.emit(hit.grn.id);
    }
    if (this.inventoryLotId !== hit.lot.id) {
      this.inventoryLotId = hit.lot.id;
      this.inventoryLotIdChange.emit(hit.lot.id);
    }
    this.matchedByCode = hit.lot.lotTag || hit.lot.lotCode;
  }

  get selected(): ExpenseGoodsTarget | null {
    return this.targets.find((row) => row.id === this.goodsReceiptId) || null;
  }

  get selectedLot(): ExpenseGoodsLot | null {
    return this.selected?.lots.find((lot) => lot.id === this.inventoryLotId) || null;
  }

  chooseGrn(id: number | null): void {
    this.goodsReceiptId = id;
    this.goodsReceiptIdChange.emit(id);
    this.chooseLot(null);
  }

  chooseLot(id: number | null): void {
    this.inventoryLotId = id;
    this.inventoryLotIdChange.emit(id);
    if (id) this.matchedByCode = null;
  }

  /** Picks a whole delivery and one of its lots in a single click. */
  pick(grn: ExpenseGoodsTarget, lot: ExpenseGoodsLot | null): void {
    this.goodsReceiptId = grn.id;
    this.goodsReceiptIdChange.emit(grn.id);
    this.chooseLot(lot ? lot.id : null);
  }

  /** A lot in a line: what it is, and how much of it there is. */
  lotLabel(lot: ExpenseGoodsLot): string {
    const name = lot.lotTag || lot.lotCode;
    return `${name} · ${lot.productName}`;
  }

  lotQuantities(lot: ExpenseGoodsLot): string {
    const measure = (value: number | null, uom: string | null) => (value == null
      ? null
      : `${Number.isInteger(value) ? value : Number(value.toFixed(3))}${uom ? ` ${uom}` : ''}`);
    if (!lot.quantityKnown) {
      const sold = [measure(lot.soldHandling, lot.handlingUom), measure(lot.soldBase, lot.baseUom)].filter(Boolean);
      return `Not counted · ${sold.join(' · ')} billed`;
    }
    const arrived = [measure(lot.receivedHandling, lot.handlingUom), measure(lot.receivedBase, lot.baseUom)].filter(Boolean);
    const left = [measure(lot.remainingHandling, lot.handlingUom), measure(lot.remainingBase, lot.baseUom)].filter(Boolean);
    return `${arrived.join(' · ')} arrived · ${left.join(' · ')} left`;
  }

  trackGrn(_index: number, grn: ExpenseGoodsTarget): number { return grn.id; }
  trackLot(_index: number, lot: ExpenseGoodsLot): number { return lot.id; }
}
