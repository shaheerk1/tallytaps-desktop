import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { CatalogService } from '../services/catalog.service';
import type { CatalogProduct, PluginField } from '../../../../../../packages/shared/ipc/pos-api';

const CATEGORY_COLORS = [
  '#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c',
  '#16a34a', '#9333ea', '#0284c7', '#ca8a04', '#dc2626',
  '#4f46e5', '#059669'
];

function sortPluginFields(a: PluginField, b: PluginField): number {
  const oa = a.order ?? 0;
  const ob = b.order ?? 0;
  if (oa !== ob) return oa - ob;
  if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
  return a.key.localeCompare(b.key);
}

function truthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'on';
}

@Component({
  selector: 'pos-item-management',
  templateUrl: './item-management.component.html',
  styleUrls: ['./item-management.component.css']
})
export class ItemManagementComponent implements OnInit {
  items: CatalogProduct[] = [];
  filteredItems: CatalogProduct[] = [];
  categories: string[] = [];
  isLoading = true;
  isSubmitting = false;
  errorMessage = '';
  successMessage = '';

  searchTerm = '';

  showFormModal = false;
  editingId: number | null = null;
  form = {
    sku: '',
    name: '',
    barcode: '',
    category: '',
    unit: '',
    requiresKilos: false,
    pricingBasis: 'qty' as 'qty' | 'kilos',
    quantityStep: 1,
    allowZeroQuantity: false,
    bagCharge: 0,
    wageCharge: 0,
    wageBasis: 'none' as 'none' | 'qty' | 'kilos',
    unitPrice: 0,
    priceOverrideAllowed: false,
    minimumSellPrice: null as number | null,
    maximumSellPrice: null as number | null,
    priceOverrideReasonRequired: false,
    stockQty: 0,
    isActive: true
  };

  itemFormFields: PluginField[] = [];
  itemFormValues: Record<string, unknown> = {};
  private existingMetadata: Record<string, unknown> = {};

  showDeleteModal = false;
  deleteTarget: CatalogProduct | null = null;

  private successTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private session: SessionService,
    private catalog: CatalogService
  ) {}

  async ngOnInit(): Promise<void> {
    await this.loadData();
  }

  get canManage(): boolean {
    return this.session.hasPermission('products.manage');
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      this.items = await this.catalog.list(true);
      this.categories = await this.catalog.categories();
      this.applyFilter();
    } catch (err) {
      console.error('Failed to load items', err);
      this.errorMessage = 'Failed to load items.';
    } finally {
      this.isLoading = false;
    }
  }

  private metadataForItem(item: CatalogProduct | null): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const meta = (item?.metadata || {}) as Record<string, unknown>;
    for (const field of this.itemFormFields) {
      let v = field.key === 'per_kilo' ? item?.requires_kilos : meta[field.key];
      if (v === undefined && field.default !== undefined) {
        v = field.default;
      }
      if (v === undefined) continue;
      if (field.type === 'checkbox') {
        values[field.key] = v === true || v === 1 || v === '1' || v === 'true';
      } else {
        values[field.key] = v;
      }
    }
    return values;
  }

  private buildItemMetadata(): Record<string, unknown> {
    const metadata = { ...this.existingMetadata };
    delete metadata['per_kilo'];
    for (const field of this.itemFormFields) {
      if (field.key === 'per_kilo') continue;
      const raw = this.itemFormValues[field.key];
      if (raw === undefined || raw === null || raw === '') {
        delete metadata[field.key];
        continue;
      }
      metadata[field.key] = field.type === 'number'
        ? Number(raw)
        : field.type === 'checkbox'
          ? Boolean(raw)
          : raw;
    }
    return metadata;
  }

  onItemFormFieldChanged(field: PluginField): void {
    if (field.key === 'per_kilo') {
      this.form.requiresKilos = truthyFlag(this.itemFormValues[field.key]);
    }
  }

  syncPromotedItemFields(): void {
    if (this.itemFormFields.some((field) => field.key === 'per_kilo')) {
      this.itemFormValues['per_kilo'] = this.form.requiresKilos;
    }
  }

  applyFilter(): void {
    const term = this.searchTerm.toLowerCase().trim();
    if (!term) {
      this.filteredItems = [...this.items];
      return;
    }
    this.filteredItems = this.items.filter((item) =>
      item.sku.toLowerCase().includes(term) ||
      item.name.toLowerCase().includes(term) ||
      (item.barcode || '').toLowerCase().includes(term) ||
      (item.category || '').toLowerCase().includes(term)
    );
  }

  onSearchChange(): void {
    this.applyFilter();
  }

  trackByItemId(index: number, item: CatalogProduct): number {
    return item.id;
  }

  categoryColor(category: string | null): string {
    if (!category) return '#6b7280';
    let hash = 0;
    for (let i = 0; i < category.length; i++) {
      hash = (hash * 31 + category.charCodeAt(i)) | 0;
    }
    return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
  }

  stockBadge(item: CatalogProduct): { text: string; cls: string } {
    const qty = Number(item.stock_qty);
    if (qty <= 0) return { text: 'Out', cls: 'out' };
    if (qty < 10) return { text: 'Low', cls: 'low' };
    return { text: 'In', cls: 'in' };
  }

  // ── Form (create/edit) ────────────────────────────────────

  openCreateModal(): void {
    this.errorMessage = '';
    this.editingId = null;
    this.form = {
      sku: '',
      name: '',
      barcode: '',
      category: '',
      unit: '',
      requiresKilos: false, pricingBasis: 'qty', quantityStep: 1, allowZeroQuantity: false, bagCharge: 0, wageCharge: 0, wageBasis: 'none',
      unitPrice: 0,
      priceOverrideAllowed: false, minimumSellPrice: null, maximumSellPrice: null, priceOverrideReasonRequired: false,
      stockQty: 0,
      isActive: true
    };
    this.existingMetadata = {};
    this.itemFormValues = this.metadataForItem(null);
    this.showFormModal = true;
  }

  openEditModal(item: CatalogProduct): void {
    this.errorMessage = '';
    this.editingId = item.id;
    this.form = {
      sku: item.sku,
      name: item.name,
      barcode: item.barcode || '',
      category: item.category || '',
      unit: item.unit || '',
      requiresKilos: truthyFlag(item['requires_kilos']),
      pricingBasis: (item.pricing_basis || 'qty') as 'qty' | 'kilos',
      quantityStep: Number(item.quantity_step || 1),
      allowZeroQuantity: truthyFlag(item.allow_zero_quantity),
      bagCharge: Number(item.bag_charge || 0),
      wageCharge: Number(item.wage_charge || 0),
      wageBasis: (item.wage_basis || 'none') as 'none' | 'qty' | 'kilos',
      unitPrice: Number(item.unit_price),
      priceOverrideAllowed: truthyFlag(item.price_override_allowed),
      minimumSellPrice: item.minimum_sell_price == null ? null : Number(item.minimum_sell_price),
      maximumSellPrice: item.maximum_sell_price == null ? null : Number(item.maximum_sell_price),
      priceOverrideReasonRequired: truthyFlag(item.price_override_reason_required),
      stockQty: Number(item.stock_qty),
      isActive: Number(item.is_active) === 1
    };
    this.existingMetadata = { ...((item.metadata || {}) as Record<string, unknown>) };
    this.itemFormValues = this.metadataForItem(item);
    this.showFormModal = true;
  }

  closeFormModal(): void {
    this.showFormModal = false;
    this.editingId = null;
  }

  async submitForm(): Promise<void> {
    this.errorMessage = '';
    const sku = this.form.sku.trim();
    const name = this.form.name.trim();
    if (!sku || !name) {
      this.errorMessage = 'SKU and Name are required.';
      return;
    }
    if (!Number.isFinite(Number(this.form.unitPrice)) || this.form.unitPrice < 0) {
      this.errorMessage = 'Price cannot be negative.';
      return;
    }
    if (this.form.minimumSellPrice != null && this.form.maximumSellPrice != null && this.form.minimumSellPrice > this.form.maximumSellPrice) { this.errorMessage = 'Minimum sell price cannot exceed maximum sell price.'; return; }

    const payload = {
      sku,
      name,
      barcode: this.form.barcode.trim() || null,
      category: this.form.category.trim() || null,
      unit: this.form.unit.trim() || null,
      requiresKilos: this.form.requiresKilos,
      pricingBasis: this.form.pricingBasis,
      quantityStep: this.form.quantityStep,
      allowZeroQuantity: this.form.allowZeroQuantity,
      bagCharge: this.form.bagCharge,
      wageCharge: this.form.wageCharge,
      wageBasis: this.form.wageBasis,
      unitPrice: this.form.unitPrice,
      priceOverrideAllowed: this.form.priceOverrideAllowed,
      minimumSellPrice: this.form.minimumSellPrice,
      maximumSellPrice: this.form.maximumSellPrice,
      priceOverrideReasonRequired: this.form.priceOverrideReasonRequired,
      stockQty: this.form.stockQty,
      isActive: this.form.isActive,
      metadata: this.buildItemMetadata()
    };

    this.isSubmitting = true;
    const wasEditing = this.editingId !== null;
    try {
      const result = this.editingId
        ? await this.catalog.update(this.editingId, payload)
        : await this.catalog.create(payload);
      if (!result) {
        this.errorMessage = wasEditing ? 'Failed to update item.' : 'Failed to create item.';
        return;
      }
      this.showFormModal = false;
      this.editingId = null;
      await this.loadData();
      this.flashMessage(wasEditing ? 'Item updated.' : 'Item created.');
    } catch (err: any) {
      this.errorMessage = err.message || (wasEditing ? 'Failed to update item.' : 'Failed to create item.');
    } finally {
      this.isSubmitting = false;
    }
  }

  // ── Delete ────────────────────────────────────────────────

  openDeleteModal(item: CatalogProduct): void {
    this.errorMessage = '';
    this.deleteTarget = item;
    this.showDeleteModal = true;
  }

  closeDeleteModal(): void {
    this.showDeleteModal = false;
    this.deleteTarget = null;
  }

  async submitDelete(): Promise<void> {
    if (!this.deleteTarget) return;
    this.errorMessage = '';
    this.isSubmitting = true;
    try {
      const ok = await this.catalog.delete(this.deleteTarget.id);
      if (!ok) {
        this.errorMessage = `Failed to delete "${this.deleteTarget.name}". It may have stock movement history — deactivate it instead.`;
        return;
      }
      this.showDeleteModal = false;
      this.deleteTarget = null;
      await this.loadData();
      this.flashMessage('Item deleted.');
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to delete item.';
    } finally {
      this.isSubmitting = false;
    }
  }

  private flashMessage(message: string): void {
    this.successMessage = message;
    if (this.successTimer) clearTimeout(this.successTimer);
    this.successTimer = setTimeout(() => {
      this.successMessage = '';
    }, 3000);
  }
}
