import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { SessionService } from '../services/session.service';
import type { ExpenseGoodsTarget } from '../../../../../../packages/shared/ipc/pos-api';

/**
 * Picks the GRN a lot expense belongs to, and optionally one of its lots.
 * Recent GRNs are listed first; a search reaches older ones, so the list
 * stays short however much has been received.
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

  constructor(private session: SessionService) {}

  async ngOnInit(): Promise<void> {
    const today = String(this.session.getBillingDate() || new Date().toISOString()).slice(0, 10);
    const start = new Date(`${today}T00:00:00`);
    start.setDate(start.getDate() - 30);
    this.fromDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    await this.load();
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
  }

  get selected(): ExpenseGoodsTarget | null {
    return this.targets.find((row) => row.id === this.goodsReceiptId) || null;
  }

  chooseGrn(id: number | null): void {
    this.goodsReceiptId = id;
    this.goodsReceiptIdChange.emit(id);
    this.chooseLot(null);
  }

  chooseLot(id: number | null): void {
    this.inventoryLotId = id;
    this.inventoryLotIdChange.emit(id);
  }
}
