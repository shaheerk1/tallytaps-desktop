import { Component, OnInit, ViewChild, ElementRef, OnDestroy, AfterViewInit, QueryList, ViewChildren, HostListener } from '@angular/core';
import { Router } from '@angular/router';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import { ItemMeasureSummary, itemMeasureSummaryText, summarizeItemMeasures } from '../services/item-measure-summary';
import type {
  BillItem, HeldBill, OpenBillResult, FinalizeResult, PaymentMode, PaymentLine, ChequePaymentDetails, PluginField, PrintDocument, PrintDocItem, PrintTextLine, ReceiptLabels, ReceiptLanguage
} from '../../../../../../packages/shared/ipc/pos-api';

interface Product {
  id: number;
  sku: string;
  name: string;
  unit_price: number;
  stock_qty: number;
  requires_kilos?: number | boolean;
  pricing_basis?: 'qty' | 'kilos';
  quantity_step?: number;
  allow_zero_quantity?: number | boolean;
  bag_charge?: number;
  wage_charge?: number;
  wage_basis?: 'none' | 'qty' | 'kilos';
  price_override_allowed?: number | boolean;
  metadata: Record<string, unknown>;
}

interface ReceiptConfig {
  storeName: string;
  tagline: string;
  headers: string[];
  footers: string[];
  addressLines: string[];
  phone: string;
  currencySymbol: string;
  dateFormat: string;
  logoDataUrl: string;
  language: ReceiptLanguage;
  labels: ReceiptLabels;
}

interface CustomerAccountSummary {
  id: number;
  account_number?: string;
  name: string;
  display_name?: string;
  shop_name?: string | null;
  locality?: string | null;
  mobile?: string | null;
  customer_code?: string | null;
  marketCodes?: string[];
  outstandingBalance?: number;
  creditEnabled?: boolean;
  creditLimit?: number | null;
}

const ENGLISH_RECEIPT_LABELS: ReceiptLabels = {
  item: 'ITEM', qty: 'QTY', kg: 'KG', rate: 'RATE', amount: 'AMOUNT', qtyTotal: 'QTY TOTAL', subtotal: 'Subtotal', bagCharge: 'Bag Charge', wageCharge: 'Wage Charge', discount: 'Discount', total: 'TOTAL', receipt: 'Receipt', invoice: 'Invoice', date: 'Date', terminal: 'Terminal', cashier: 'Cashier', customer: 'Customer', document: 'Document', original: 'Original', refund: 'REFUND', refundTotal: 'REFUND TOTAL', cash: 'Cash', card: 'Card', cheque: 'Cheque', change: 'Change', pendingBalance: 'Pending Balance', phone: 'Tel', salesReport: 'DDEC Sales Report', period: 'Period', lines: 'Lines', order: 'Order'
};

interface SettledReceiptView {
  items: BillItem[];
  payments: PaymentLine[];
  grossTotal: number;
  totalDiscount: number;
  bagChargeTotal: number;
  wageChargeTotal: number;
  netTotal: number;
  pluginTotals: Array<{ key: string; label: string; value: number }>;
  billHeader: Record<string, Record<string, unknown>>;
  receiptNo: number;
  invoiceNumber: string;
  billingDate: string;
  locationCode: string;
  machineCode: string;
  cashierName: string;
  customerCode: string;
  settledAt: Date;
  grandTotal: number;
  paidTotal: number;
  changeAmt: number;
  balance: number;
  status: FinalizeResult['status'];
}

/** Backend-computed bill totals (grand-total hooks included). */
interface AuthoritativeTotals {
  grossTotal: number;
  discountTotal: number;
  netTotal: number;
  grandTotal: number;
  totals: Record<string, number>;
}

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
  selector: 'pos-billing',
  templateUrl: './billing.component.html',
  styleUrls: ['./billing.component.css']
})
export class BillingComponent implements OnInit, OnDestroy {
  // Info pane
  userName = '';
  userRole = '';
  billingDate = '';
  machineCode = '';
  locationCode = '';
  receiptNo = 0;
  sessionId = 0;

  // Input fields
  itemCode = '';
  customerCode = '';
  customerAccountId: number | null = null;
  linkedCustomer: CustomerAccountSummary | null = null;
  customerAccountMatches: CustomerAccountSummary[] = [];
  customerAccountDropdownIndex = -1;
  private customerSearchToken = 0;
  private customerSearchTimer?: ReturnType<typeof setTimeout>;
  supplierCode = '';
  description = '';
  rate = 0;
  private rateEnteredBeforeProduct = false;
  qty = 1;
  kilos: number | null = null;
  discount = 0;
  value = 0;
  selectedProductId: number | null = null;

  // Billed items (live invoice_items for the current receipt)
  billItems: BillItem[] = [];

  // Authoritative bill totals from the billing engine (live recompute after
  // each bill mutation). Falls back to client-side sums when unavailable.
  private authoritativeTotals: AuthoritativeTotals | null = null;
  private totalsRefreshToken = 0;

  // SDL behavior is owned by the plugin that contributed each field. Keys are
  // namespaced so independently configured domain packs cannot collide.
  private formVisible: Map<string, boolean> | null = null;
  private formEnabled: Map<string, boolean> | null = null;
  private tableVisible: Map<string, boolean> | null = null;
  private formBehaviorToken = 0;

  // Item dropdown
  showItemDropdown = false;
  products: Product[] = [];
  filteredProducts: Product[] = [];
  selectedDropdownIndex = -1;

  // Full item picker, opened with Enter from an empty Item field. This stays
  // on-demand so routine scanning and billing do not preload the item master.
  isItemPickerVisible = false;
  itemPickerQuery = '';
  itemPickerProducts: Product[] = [];
  itemPickerIndex = -1;
  isItemPickerLoading = false;
  private itemPickerSearchTimer?: ReturnType<typeof setTimeout>;
  private itemPickerSearchToken = 0;

  // Plugin-contributed fields
  lineFields: PluginField[] = [];
  billHeaderFields: PluginField[] = [];
  totalsFields: PluginField[] = [];
  tableFields: PluginField[] = [];
  receiptFields: PluginField[] = [];
  billHeaderReceiptFields: PluginField[] = [];
  billHeaderValues: Record<string, Record<string, unknown>> = {};
  customerMatches: Record<string, Array<{ customer_code: string | null; name: string; mobile?: string | null }>> = {};
  customerDropdownIndex: Record<string, number> = {};
  lineFieldValues: Record<string, string> = {};
  lineError = '';
  receiptConfig: ReceiptConfig = {
    storeName: 'POS Platform',
    tagline: '',
    headers: [],
    footers: [],
    addressLines: [],
    phone: '',
    currencySymbol: 'Rs.',
    dateFormat: 'Y-m-d',
    logoDataUrl: '',
    language: 'en-LK',
    labels: ENGLISH_RECEIPT_LABELS
  };
  settledReceipt: SettledReceiptView | null = null;

  // Payment popup
  isPaymentPopupVisible = false;
  isPaymentModesLoading = false;
  paymentModes: PaymentMode[] = [];
  private modeMap = new Map<string, PaymentMode>();
  payments: PaymentLine[] = [];
  selectedModeId = 'cash';
  enteredAmount = '';
  chequeDetails: ChequePaymentDetails = {};
  showChequeDetailsEditor = false;
  paymentAccountTerm = '';
  paymentAccountMatches: CustomerAccountSummary[] = [];
  paymentAccountSearchOpen = false;
  isPaymentAccountSearching = false;
  private paymentAccountSearchToken = 0;
  private paymentAccountSearchTimer?: ReturnType<typeof setTimeout>;
  paymentError = '';
  paymentSuccess: FinalizeResult | null = null;
  isFinalizing = false;
  numpadKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

  // Recall bill
  isRecallPopupVisible = false;
  unfinalizedBills: HeldBill[] = [];
  filteredBills: HeldBill[] = [];
  pendingBills: HeldBill[] = [];
  isPendingBillsLoading = false;
  newlyPendingReceiptNo: number | null = null;
  private pendingBillAnimationTimer?: ReturnType<typeof setTimeout>;
  searchTerm = '';
  selectedBill: HeldBill | null = null;
  previewItems: BillItem[] = [];
  private previewBillHeader: Record<string, Record<string, unknown>> = {};
  isLoadingPreview = false;

  // Abandon confirm
  isAbandonConfirmVisible = false;

  // State
  isLoading = false;
  isSubmitting = false;

  @ViewChild('itemCodeInput') itemCodeInput!: ElementRef;
  @ViewChild('itemPickerSearchInput') itemPickerSearchInput!: ElementRef;
  @ViewChild('customerCodeInput') customerCodeInput!: ElementRef;
  @ViewChild('supplierCodeInput') supplierCodeInput!: ElementRef;
  @ViewChild('kilosInput') kilosInput!: ElementRef;
  @ViewChild('pmAmountInput') pmAmountInput!: ElementRef;
  @ViewChild('chequeNumberInput') chequeNumberInput!: ElementRef;
  @ViewChild('rateInput') rateInput!: ElementRef;
  @ViewChild('qtyInput') qtyInput!: ElementRef;
  @ViewChild('addBtn') addBtn!: ElementRef;
  @ViewChildren('lineInput') lineInputs!: QueryList<ElementRef>;
  @ViewChildren('billHeaderInput') billHeaderInputs!: QueryList<ElementRef>;

  constructor(
    private session: SessionService,
    private router: Router,
    private printing: PrintingService
  ) {}

  async ngOnInit(): Promise<void> {
    this.loadSessionInfo();
    await this.loadProducts();
    await this.loadSettings();
    await this.openOrResumeBill();
    await this.refreshPendingBills();
    this.focusFirstBillInput();
  }

  ngOnDestroy(): void {
    if (this.pendingBillAnimationTimer) clearTimeout(this.pendingBillAnimationTimer);
    if (this.itemPickerSearchTimer) clearTimeout(this.itemPickerSearchTimer);
    if (this.customerSearchTimer) clearTimeout(this.customerSearchTimer);
    if (this.paymentAccountSearchTimer) clearTimeout(this.paymentAccountSearchTimer);
  }

  /** Billing-only keyboard shortcuts: F2 finalize, Shift+F2 cash complete, F10 new bill. */
  @HostListener('window:keydown', ['$event'])
  onFinalizeHotkey(event: KeyboardEvent): void {
    if (event.repeat) return;

    if (event.key === 'Escape' && this.isPaymentPopupVisible) {
      event.preventDefault();
      event.stopPropagation();
      if (this.isFinalizing) return;
      if (this.showChequeDetailsEditor) this.closeChequeDetailsEditor();
      else this.hidePaymentPopup();
      return;
    }

    if (this.isItemPickerVisible) return;

    if (event.key === 'Enter' && this.isPaymentPopupVisible && this.paymentSuccess) {
      event.preventDefault();
      this.doneWithPayment();
      return;
    }

    if (event.key === 'F10') {
      if (this.isPaymentPopupVisible || this.isRecallPopupVisible || this.isAbandonConfirmVisible || this.isFinalizing) return;
      event.preventDefault();
      void this.startNewBill();
      return;
    }

    if (event.key !== 'F2' || this.isPaymentPopupVisible || this.isRecallPopupVisible || this.isAbandonConfirmVisible || this.isFinalizing) return;
    event.preventDefault();
    if (event.shiftKey) void this.completeCurrentBillAsCash();
    else void this.showPaymentPopup();
  }

  loadSessionInfo(): void {
    const user = this.session.getUser();
    const ws = this.session.getWorkstationSession();

    if (user) {
      this.userName = user.displayName || user.username;
      this.userRole = user.roles.map(r => r.name).join(', ');
    }
    if (ws) {
      this.billingDate = ws.billingDate;
      this.machineCode = ws.machineCode;
      this.locationCode = ws.locationCode;
      this.sessionId = ws.sessionId;
    }
  }

  async loadProducts(): Promise<void> {
    // Billing deliberately does not preload the entire item master. Searches
    // are indexed in MySQL and return only the operator's current matches.
    this.products = [];
    this.filteredProducts = [];
  }

  private async loadSettings(): Promise<void> {
    if (!window.posApi) return;
    try {
      const result = await window.posApi.settings.getReceipt();
      if (!result.success) {
        throw new Error(result.error || 'Receipt settings are unavailable.');
      }

      const settings = result.data;
      const storeName = settings.storeName;
      const tagline = settings.tagline;
      const addressLines = settings.addressLines;
      const phone = settings.phone;
      this.receiptConfig = {
        storeName: storeName || 'POS Platform',
        tagline,
        headers: this.nonEmptyLines(settings.headers),
        footers: settings.footers,
        addressLines,
        phone,
        currencySymbol: settings.currencySymbol,
        dateFormat: settings.dateFormat,
        logoDataUrl: settings.logoDataUrl,
        language: settings.language || 'en-LK',
        labels: settings.labels || ENGLISH_RECEIPT_LABELS
      };

    } catch (err) {
      console.error('Failed to load receipt settings', err);
      this.receiptConfig = {
        storeName: 'POS Platform',
        tagline: '',
        headers: [],
        footers: [],
        addressLines: [],
        phone: '',
        currencySymbol: 'Rs.',
        dateFormat: 'Y-m-d',
        logoDataUrl: '',
        language: 'en-LK',
        labels: ENGLISH_RECEIPT_LABELS
      };
    }
  }

  private nonEmptyLines(values: unknown[]): string[] {
    return values
      .map((v) => String(v ?? '').trim())
      .filter((line) => line.length > 0);
  }

  formatReceiptCurrency(amount: number): string {
    const symbol = this.receiptConfig.currencySymbol;
    const spaced = symbol.endsWith('.') || symbol.endsWith(' ') ? symbol : `${symbol} `;
    return `${spaced}${amount.toFixed(2)}`;
  }

  formatReceiptDateTime(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const datePart = this.receiptConfig.dateFormat === 'd-m-Y'
      ? `${day}-${month}-${year}`
      : this.receiptConfig.dateFormat === 'm/d/Y'
        ? `${month}/${day}/${year}`
        : this.receiptConfig.dateFormat === 'd/m/Y'
          ? `${day}/${month}/${year}`
          : `${year}-${month}-${day}`;
    const timePart = date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    return `${datePart} ${timePart}`;
  }

  receiptQtyLabel(item: BillItem): string {
    const kilos = item.kilos;
    const qty = this.formatReceiptMeasure(item.qty);
    if (kilos != null) {
      return `${qty} qty / ${this.formatReceiptMeasure(kilos)} kg x ${item.unitPrice.toFixed(2)} per ${item.pricingBasis === 'kilos' ? 'kg' : 'qty'}`;
    }
    return `${qty} x ${item.unitPrice.toFixed(2)}`;
  }

  receiptMeasure(item: BillItem): NonNullable<PrintDocItem['measure']> {
    return {
      qty: this.formatReceiptMeasure(item.qty),
      ...(item.kilos != null ? { kilos: this.formatReceiptMeasure(item.kilos) } : {}),
      rate: item.unitPrice.toFixed(2)
    };
  }

  receiptQuantityTotal(items: BillItem[]): string {
    return this.formatReceiptMeasure(items.reduce((sum, item) => sum + Number(item.qty || 0), 0));
  }

  receiptLabel(key: keyof ReceiptLabels): string {
    return this.receiptConfig.labels[key] || ENGLISH_RECEIPT_LABELS[key];
  }

  receiptPaymentLabel(payment: PaymentLine | string): string {
    const method = typeof payment === 'string' ? payment : payment.method;
    const modeName = this.modeMapName(method).trim().toLocaleLowerCase();
    const label = modeName === 'cash'
      ? this.receiptLabel('cash')
      : modeName === 'card'
        ? this.receiptLabel('card')
        : method === 'cheque'
          ? this.receiptLabel('cheque')
        : this.modeMapName(method);
    const chequeNumber = typeof payment === 'string' ? '' : String(payment.chequeDetails?.number || payment.providerRef || '').trim();
    return method === 'cheque' && chequeNumber ? `${label} #${chequeNumber}` : label;
  }

  private formatReceiptMeasure(value: number | string | null | undefined): string {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '0';
    return amount.toFixed(3).replace(/\.?0+$/, '');
  }

  receiptItemCode(item: BillItem): string {
    return `${item.supplierCode ? `${item.supplierCode}~` : ''}${item.itemCode || ''}`;
  }

  receiptSupplierCode(item: BillItem): string {
    return String(item.supplierCode || '').trim();
  }

  receiptItemExtras(item: BillItem): Array<{ label: string; value: string }> {
    const extras: Array<{ label: string; value: string }> = [];
    for (const field of this.receiptFields) {
      // Kilos are part of the standard quantity line so receipts do not show
      // the same measure twice when the SDL also exposes the field.
      if (field.key === 'kilos') continue;
      const raw = field.key === 'kilos' ? item.kilos : undefined;
      if (raw === undefined || raw === null) continue;
      if (field.type === 'checkbox' && !raw) continue;
      extras.push({
        label: field.label,
        value: field.type === 'number'
          ? Number(raw).toFixed(field.key === 'kilos' ? 3 : 2)
          : String(raw)
      });
    }
    return extras;
  }

  /** Gross value of a single line (per-kilo items value by kilos, not qty). */
  private lineGross(item: BillItem): number {
    const kilos = item.kilos;
    if (item.pricingBasis === 'kilos' && kilos != null) {
      return item.unitPrice * Number(kilos);
    }
    return item.unitPrice * item.qty;
  }

  /** The line table deliberately excludes bag and wage charges from Value. */
  lineMerchandiseTotal(item: BillItem): number {
    const raw = item as unknown as Record<string, unknown>;
    const stored = raw['merchandiseTotal'] ?? raw['merchandise_total'];
    const value = Number(stored);
    return Number.isFinite(value) ? value : this.lineGross(item);
  }

  /** Use the persisted line amount; the fallback keeps older live rows visible. */
  lineWageChargeTotal(item: BillItem): number {
    const raw = item as unknown as Record<string, unknown>;
    const stored = raw['wageChargeTotal'] ?? raw['wage_charge_total'];
    const value = Number(stored);
    if (Number.isFinite(value)) return value;

    const rate = Number(raw['wageChargeRate'] ?? raw['wage_charge_rate'] ?? 0);
    if (!Number.isFinite(rate)) return 0;
    const basis = raw['wageBasis'] ?? raw['wage_basis'];
    const units = basis === 'kilos' ? Number(item.kilos || 0) : basis === 'qty' ? Number(item.qty || 0) : 0;
    return rate * units;
  }

  private snapshotPluginTotals(): Array<{ key: string; label: string; value: number }> { return []; }

  private buildSettledReceiptSnapshot(
    items: BillItem[],
    payments: PaymentLine[],
    result: FinalizeResult
  ): SettledReceiptView {
    const grossTotal = items.reduce((sum, item) => sum + Number(item.merchandiseTotal ?? this.lineGross(item)), 0);
    const totalDiscount = items.reduce((sum, item) => sum + (item.discount || 0), 0);
    const netTotal = items.reduce((sum, item) => sum + item.total, 0);

    return {
      items: [...items],
      payments: payments.map((p) => ({ ...p, chequeDetails: p.chequeDetails ? { ...p.chequeDetails } : null })),
      grossTotal,
      totalDiscount,
      bagChargeTotal: items.reduce((sum, item) => sum + Number(item.bagChargeTotal || 0), 0),
      wageChargeTotal: items.reduce((sum, item) => sum + Number(item.wageChargeTotal || 0), 0),
      netTotal,
      pluginTotals: this.snapshotPluginTotals(),
      billHeader: JSON.parse(JSON.stringify(this.billHeaderValues)),
      receiptNo: result.receiptNo,
      invoiceNumber: result.invoiceNumber,
      billingDate: this.billingDate,
      locationCode: this.locationCode,
      machineCode: this.machineCode,
      cashierName: this.userName,
      customerCode: this.customerCode.trim().toUpperCase(),
      settledAt: new Date(),
      grandTotal: result.grandTotal,
      paidTotal: result.paidTotal,
      changeAmt: result.changeAmt,
      balance: result.balance,
      status: result.status
    };
  }

  private buildLineMetadata(): Record<string, unknown> { return {}; }

  /** True when a billing.line field should be shown for the selected product.
   *  SDL segments are gated by their owning backend; legacy fields fall back
   *  to the metadata-key check. */
  lineFieldVisible(field: PluginField): boolean {
    const behaviorKey = this.behaviorFieldKey(field);
    if (this.formVisible?.has(behaviorKey)) {
      return this.formVisible.get(behaviorKey) ?? true;
    }
    return this.legacyLineFieldVisible(field);
  }

  /** True when the field is interactive (editable) for the selected product. */
  lineFieldEnabled(field: PluginField): boolean {
    const behaviorKey = this.behaviorFieldKey(field);
    if (this.formEnabled?.has(behaviorKey)) {
      return this.formEnabled.get(behaviorKey) ?? true;
    }
    return true;
  }

  /** Legacy gating: a bare metadata key (e.g. produce-market's "per_kilo"). */
  private legacyLineFieldVisible(field: PluginField): boolean {
    if (!field.visibleWhen) return true;
    const product = this.products.find((p) => p.id === this.selectedProductId);
    const meta = ((product?.metadata || {}) as Record<string, unknown>);
    if (field.visibleWhen === 'per_kilo') {
      return truthyFlag(product?.requires_kilos ?? meta[field.visibleWhen]);
    }
    return Boolean(meta[field.visibleWhen]);
  }

  /** True when the field holds a usable value (required-fields guard). */
  hasFieldValue(field: PluginField): boolean {
    const raw = this.lineFieldValues[field.key];
    if (raw === undefined || raw === null || raw === '') return false;
    if (field.type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0;
    }
    return Boolean(raw);
  }

  private defaultLineValues(product: Product): Record<string, string> {
    const values: Record<string, string> = {};
    const meta = (product.metadata || {}) as Record<string, unknown>;
    for (const field of this.lineFields) {
      let v = meta[field.key];
      if ((v === undefined || v === null || v === '') && field.default !== undefined) {
        v = field.default;
      }
      if (v !== undefined && v !== null && v !== '') {
        values[field.key] = String(v);
      }
    }
    return values;
  }

  /** Aggregate a numeric plugin field across the current bill's lines. For
   *  totals-scope segments the authoritative backend-evaluated value wins. */
  fieldTotal(key: string): number {
    const authoritative = this.authoritativeTotals?.totals?.[key];
    if (authoritative !== undefined && Number.isFinite(authoritative)) {
      return authoritative;
    }
    return this.billItems.reduce((sum, item) => {
      const raw = key === 'kilos'
        ? item.kilos ?? (item.metadata ? (item.metadata as Record<string, unknown>)[key] : undefined)
        : item.metadata ? (item.metadata as Record<string, unknown>)[key] : undefined;
      const n = Number(raw);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  private billContext(): {
    sessionId: number;
    receiptNo: number;
    locationCode: string;
    machineCode: string;
    billingDate: string;
    userId?: number;
    customerCode: string;
    customerAccountId: number | null;
  } {
    return {
      sessionId: this.sessionId,
      receiptNo: this.receiptNo,
      locationCode: this.locationCode,
      machineCode: this.machineCode,
      billingDate: this.billingDate,
      userId: this.session.getUser()?.id,
      customerCode: this.customerCode.trim().toUpperCase(),
      customerAccountId: this.customerAccountId
    };
  }

  private actor(): { id: string; permissions: string[] } | undefined {
    return this.session.getActor() || undefined;
  }

  billHeaderValue(field: PluginField): unknown {
    return this.billHeaderValues[field.pluginId]?.[field.key] ?? field.default ?? '';
  }

  setBillHeaderValue(field: PluginField, value: unknown): void {
    this.billHeaderValues[field.pluginId] = {
      ...(this.billHeaderValues[field.pluginId] || {}),
      [field.key]: field.type === 'number' && value !== '' ? Number(value) : value
    };
  }

  async searchCustomerIdentifier(field: PluginField, value: string): Promise<void> {
    this.setBillHeaderValue(field, value);
    this.customerDropdownIndex[field.key] = -1;
    if (field.purpose !== 'customer_identifier' || !window.posApi) return;
    const result = await window.posApi.catalog.searchCustomers(value, this.actor());
    this.customerMatches[field.key] = result.success ? (result.data || []).slice(0, 8) : [];
  }

  async chooseCustomerIdentifier(field: PluginField, customerCode: string): Promise<void> {
    this.setBillHeaderValue(field, customerCode);
    this.customerMatches[field.key] = [];
    await this.saveBillHeader();
  }

  async chooseCustomerAndAdvance(field: PluginField, customerCode: string, index: number): Promise<void> {
    await this.chooseCustomerIdentifier(field, customerCode);
    this.advanceBillHeaderInput(index);
  }

  async onCustomerIdentifierKeyDown(event: KeyboardEvent, field: PluginField, index: number): Promise<void> {
    const matches = this.customerMatches[field.key] || [];
    if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); this.customerDropdownIndex[field.key] = Math.min((this.customerDropdownIndex[field.key] ?? -1) + 1, matches.length - 1); return; }
    if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); this.customerDropdownIndex[field.key] = Math.max((this.customerDropdownIndex[field.key] ?? -1) - 1, -1); return; }
    if (event.key === 'Escape') { this.customerMatches[field.key] = []; this.customerDropdownIndex[field.key] = -1; return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const selected = matches[this.customerDropdownIndex[field.key] ?? -1];
    if (selected?.customer_code) await this.chooseCustomerIdentifier(field, selected.customer_code);
    else await this.saveBillHeader();
    this.customerMatches[field.key] = [];
    this.customerDropdownIndex[field.key] = -1;
    this.advanceBillHeaderInput(index);
  }

  async saveBillHeader(): Promise<void> {
    // Transaction headers are no longer dynamically configured or persisted
    // through a plugin namespace.
    return;
  }

  private focusFirstBillInput(): void {
    setTimeout(() => {
      const first = this.billHeaderInputs?.first?.nativeElement as HTMLElement | undefined;
      (first || this.customerCodeInput?.nativeElement)?.focus();
    }, 300);
  }

  private async openOrResumeBill(): Promise<void> {
    if (!window.posApi || !this.sessionId) return;
    try {
      const result = await window.posApi.billing.openBill(this.billContext(), this.actor());
      if (result.success) {
        const data = result.data as OpenBillResult;
        this.receiptNo = data.receiptNo;
        this.billItems = data.items || [];
        this.customerCode = (data.customerCode || '').toUpperCase();
        this.customerAccountId = data.customerAccountId || null;
        await this.loadLinkedCustomer();
        this.billHeaderValues = data.billHeader || {};
        this.scheduleTotalsRefresh();
      }
    } catch (err) {
      console.error('Failed to open bill', err);
    }
  }

  /**
   * Invalidate and re-fetch the authoritative bill totals from the billing
   * engine after any bill mutation. The UI falls back to client-side sums
   * until the fresh totals arrive; a token guards against out-of-order
   * responses.
   */
  private scheduleTotalsRefresh(): void {
    this.authoritativeTotals = null;
    const token = ++this.totalsRefreshToken;
    const posApi = window.posApi;
    if (!posApi || !this.receiptNo) return;
    const timer = setTimeout(async () => {
      if (token !== this.totalsRefreshToken) return;
      try {
        const result = await this.refreshAuthoritativeTotals();
        if (token !== this.totalsRefreshToken) return;
        if (!result) console.error('Failed to refresh authoritative totals');
      } catch (err) {
        console.error('Failed to refresh authoritative totals', err);
      }
      this.refreshTableBehavior();
    }, 120);
  }

  /** Read the server-calculated total before payment or after a bill mutation. */
  private async refreshAuthoritativeTotals(): Promise<boolean> {
    const posApi = window.posApi;
    if (!posApi || !this.receiptNo) return false;
    const result = await posApi.billing.computeTotals({
      locCode: this.locationCode,
      macCode: this.machineCode,
      txnDate: this.billingDate,
      receiptNo: this.receiptNo
    }, this.actor());
    if (!result.success) return false;
    this.authoritativeTotals = result.data as AuthoritativeTotals;
    return true;
  }

  /** Line-form metadata context for SDL gating: product facts + entered values. */
  private formContext(): Record<string, unknown> {
    const product = this.products.find((p) => p.id === this.selectedProductId);
    const meta = { ...((product?.metadata || {}) as Record<string, unknown>) };
    if (product?.requires_kilos !== undefined) {
      meta['requires_kilos'] = truthyFlag(product.requires_kilos);
    }
    for (const key of Object.keys(this.lineFieldValues)) {
      meta[key] = this.lineFieldValues[key];
    }
    return meta;
  }

  private behaviorFieldKey(field: PluginField): string {
    return `${field.pluginId}:${field.key}`;
  }

  /** Plugins with billing fields may own SDL visible/enabled behavior. */
  private behaviorPluginIds(): string[] {
    return [];
  }

  /**
   * Re-fetch which billing.line fields are visible/enabled for the current
   * item form (product + entered values). A token guards out-of-order replies;
   * failure leaves the previous (or legacy) gating in place.
   */
  private refreshFormBehavior(): void {
    const token = ++this.formBehaviorToken;
    const posApi = window.posApi;
    const product = this.products.find((p) => p.id === this.selectedProductId);
    if (!posApi || !product) {
      this.formVisible = null;
      this.formEnabled = null;
      return;
    }
    const line = {
      qty: this.qty || 1,
      price: this.rate || 0,
      discount: this.discount || 0,
      tax: 0,
      metadata: this.formContext()
    };
    const pluginIds = this.behaviorPluginIds();
    if (pluginIds.length === 0) {
      this.formVisible = null;
      this.formEnabled = null;
      return;
    }
    Promise.all(pluginIds.map(async (pluginId) => {
      try {
        return {
          pluginId,
          result: null as any
        };
      } catch {
        return null;
      }
    }))
      .then((responses) => {
        if (token !== this.formBehaviorToken) return;
        const visible = new Map<string, boolean>();
        const enabled = new Map<string, boolean>();
        let receivedBehavior = false;
        for (const response of responses) {
          if (!response?.result.success) continue;
          const data = (response.result.data || {}) as {
            line?: { visible?: Record<string, boolean>; enabled?: Record<string, boolean> };
          };
          for (const [key, value] of Object.entries(data.line?.visible || {})) {
            visible.set(`${response.pluginId}:${key}`, Boolean(value));
          }
          for (const [key, value] of Object.entries(data.line?.enabled || {})) {
            enabled.set(`${response.pluginId}:${key}`, Boolean(value));
          }
          receivedBehavior = true;
        }
        this.formVisible = receivedBehavior ? visible : null;
        this.formEnabled = receivedBehavior ? enabled : null;
      });
  }

  /**
   * Re-fetch table-column gating after the bill changes: a column shows when
   * its SDL visibleWhen passes for at least one bill line.
   */
  private refreshTableBehavior(): void {
    const posApi = window.posApi;
    if (!posApi || this.billItems.length === 0) {
      this.tableVisible = null;
      return;
    }
    const lines = this.billItems.map((item) => ({
      qty: item.qty,
      unitPrice: item.unitPrice,
      discount: item.discount || 0,
      tax: item.tax || 0,
      metadata: item.metadata || {}
    }));
    const pluginIds = this.behaviorPluginIds();
    if (pluginIds.length === 0) {
      this.tableVisible = null;
      return;
    }
    Promise.all(pluginIds.map(async (pluginId) => {
      try {
        return {
          pluginId,
          result: null as any
        };
      } catch {
        return null;
      }
    }))
      .then((responses) => {
        const anyVisible = new Map<string, boolean>();
        let receivedBehavior = false;
        for (const response of responses) {
          if (!response?.result.success) continue;
          const data = (response.result.data || {}) as { lines?: Array<{ visible: Record<string, boolean> }> };
          for (const entry of data.lines || []) {
            for (const [key, vis] of Object.entries(entry.visible || {})) {
              const behaviorKey = `${response.pluginId}:${key}`;
              anyVisible.set(behaviorKey, (anyVisible.get(behaviorKey) ?? false) || Boolean(vis));
            }
          }
          receivedBehavior = true;
        }
        this.tableVisible = receivedBehavior ? anyVisible : null;
      });
  }

  onItemCodeInput(): void {
    const term = this.itemCode.trim();
    if (!term) { this.filteredProducts = []; this.showItemDropdown = false; return; }
    void this.searchProductSuggestions(term);
    this.selectedDropdownIndex = -1;
  }

  onCustomerCodeChange(value: string): void {
    this.customerCode = String(value || '').toUpperCase();
    // The market/loading code is a bill-level operational snapshot. It may be
    // changed without altering the deliberately selected durable account;
    // unlinking remains an explicit cashier action.
    if (this.customerSearchTimer) clearTimeout(this.customerSearchTimer);
    if (!this.customerCode.trim()) {
      this.customerAccountMatches = [];
      this.customerAccountDropdownIndex = -1;
      return;
    }
    // Keep account lookup off the cashier's critical keystroke path. A short
    // debounce avoids a database request for every character while leaving
    // the ordinary code + Enter workflow immediate.
    this.customerSearchTimer = setTimeout(() => void this.searchCustomerAccounts(this.customerCode), 100);
  }

  private async searchCustomerAccounts(term: string): Promise<void> {
    if (!window.posApi || !String(term || '').trim()) {
      this.customerAccountMatches = [];
      this.customerAccountDropdownIndex = -1;
      return;
    }
    const token = ++this.customerSearchToken;
    const result = await window.posApi.catalog.searchCustomers(String(term).trim(), this.actor(), {
      outstandingOnly: false, balanceOrder: 'desc', activityOrder: 'desc'
    });
    if (token !== this.customerSearchToken) return;
    this.customerAccountMatches = result.success ? (result.data as CustomerAccountSummary[]).slice(0, 8) : [];
    // A market code is deliberately non-unique. Keep ordinary Enter as the
    // fast "operational code only" path; the cashier must explicitly click a
    // result or press ArrowDown before a durable customer is linked.
    this.customerAccountDropdownIndex = -1;
  }

  async chooseCustomerAccount(account: CustomerAccountSummary, advance = false): Promise<void> {
    this.customerAccountId = Number(account.id);
    this.linkedCustomer = account;
    if (!this.customerCode.trim()) this.customerCode = String(account.customer_code || account.marketCodes?.[0] || '').toUpperCase();
    this.customerAccountMatches = [];
    this.customerAccountDropdownIndex = -1;
    await this.persistCustomerCode();
    if (advance) this.supplierCodeInput?.nativeElement?.focus();
  }

  async unlinkCustomerAccount(): Promise<void> {
    this.customerAccountId = null;
    this.linkedCustomer = null;
    await this.persistCustomerCode();
    this.customerCodeInput?.nativeElement?.focus();
  }

  private async loadLinkedCustomer(): Promise<void> {
    this.linkedCustomer = null;
    if (!this.customerAccountId || !window.posApi) return;
    const result = await window.posApi.catalog.getCustomerAccount(this.customerAccountId, this.actor());
    if (result.success && result.data) this.linkedCustomer = (result.data as any).customer as CustomerAccountSummary;
  }

  onSupplierCodeChange(value: string): void {
    this.supplierCode = String(value || '').toUpperCase();
  }

  async persistCustomerCode(): Promise<void> {
    const customerCode = this.customerCode.trim().toUpperCase();
    this.customerCode = customerCode;
    if (!customerCode || !window.posApi || !this.receiptNo || this.billItems.length === 0) return;
    const result = await window.posApi.billing.updateCustomer({
      locCode: this.locationCode, macCode: this.machineCode, txnDate: this.billingDate, receiptNo: this.receiptNo,
      customerCode, customerAccountId: this.customerAccountId
    }, this.actor());
    if (!result.success) this.lineError = result.error || 'Could not update the bill customer.';
  }

  onCustomerCodeKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && this.customerAccountMatches.length) {
      event.preventDefault();
      this.customerAccountDropdownIndex = Math.min(this.customerAccountDropdownIndex + 1, this.customerAccountMatches.length - 1);
      return;
    }
    if (event.key === 'ArrowUp' && this.customerAccountMatches.length) {
      event.preventDefault();
      this.customerAccountDropdownIndex = Math.max(this.customerAccountDropdownIndex - 1, 0);
      return;
    }
    if (event.key === 'Escape') { this.customerAccountMatches = []; return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const selected = this.customerAccountMatches[this.customerAccountDropdownIndex];
    if (selected) { void this.chooseCustomerAccount(selected, true); return; }
    void this.persistCustomerCode();
    this.customerAccountMatches = [];
    this.supplierCodeInput?.nativeElement?.focus();
  }

  onCustomerCodeBlur(): void {
    void this.persistCustomerCode();
    setTimeout(() => { this.customerAccountMatches = []; }, 160);
  }

  onSupplierCodeKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.itemCodeInput?.nativeElement?.focus();
  }

  private async searchProductSuggestions(term: string): Promise<void> {
    if (!window.posApi || term !== this.itemCode.trim()) return;
    const result = await window.posApi.billing.searchProducts(term, this.actor());
    if (term !== this.itemCode.trim()) return;
    if (!result.success) { this.filteredProducts = []; this.showItemDropdown = false; return; }
    this.filteredProducts = result.data as Product[];
    this.products = this.filteredProducts;
    this.showItemDropdown = this.filteredProducts.length > 0;
  }

  onItemCodeFocus(): void {
    this.onItemCodeInput();
  }

  onItemCodeBlur(): void {
    setTimeout(() => {
      this.showItemDropdown = false;
      this.selectedDropdownIndex = -1;
    }, 200);
  }

  onItemCodeKeyDown(event: KeyboardEvent): void {
    if (!this.showItemDropdown) {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.lookupItem();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectedDropdownIndex = Math.min(this.selectedDropdownIndex + 1, this.filteredProducts.length - 1);
        this.scrollItemDropdownIntoView(this.selectedDropdownIndex);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selectedDropdownIndex = Math.max(this.selectedDropdownIndex - 1, -1);
        this.scrollItemDropdownIntoView(this.selectedDropdownIndex);
        break;
      case 'Enter':
        event.preventDefault();
        if (this.selectedDropdownIndex >= 0) {
          this.selectProduct(this.filteredProducts[this.selectedDropdownIndex]);
        } else {
          this.lookupItem();
        }
        break;
      case 'Escape':
        this.showItemDropdown = false;
        this.selectedDropdownIndex = -1;
        break;
    }
  }

  selectProduct(product: Product): void {
    const productAllowsPriceOverride = this.isProductPriceAdjustable(product);
    // Cashiers may type kilos and a spot price before choosing an item. Keep
    // that rate only for flexible-price products; fixed-price products always
    // restore their configured rate.
    const keepEnteredRate = productAllowsPriceOverride && Number.isFinite(Number(this.rate));
    if (!this.products.some((entry) => entry.id === product.id)) {
      this.products = [product, ...this.products];
    }
    this.itemCode = product.sku;
    this.description = product.name;
    this.rate = keepEnteredRate ? this.rate : product.unit_price;
    this.rateEnteredBeforeProduct = false;
    this.discount = 0;
    this.qty = 1;
    if (!truthyFlag(product.requires_kilos)) this.kilos = null;
    this.selectedProductId = product.id;
    this.lineFieldValues = this.defaultLineValues(product);
    this.lineError = '';
    this.updateValue();
    this.showItemDropdown = false;
    this.refreshFormBehavior();
    setTimeout(() => {
      const nextInput = this.selectedProductRequiresKilos
        ? this.kilosInput?.nativeElement as HTMLInputElement | undefined
        : this.isSelectedProductPriceChangeable
        ? this.rateInput?.nativeElement as HTMLInputElement | undefined
        : this.qtyInput?.nativeElement as HTMLInputElement | undefined;
      nextInput?.focus();
      nextInput?.select();
    }, 0);
  }

  private lookupItem(): void {
    if (!this.itemCode.trim()) {
      this.openItemPicker();
      return;
    }
    const found = this.products.find(p => p.sku.toLowerCase() === this.itemCode.toLowerCase());
    if (found) {
      this.selectProduct(found);
    } else {
      // Try backend search
      this.searchProductBackend(this.itemCode);
    }
  }

  private async searchProductBackend(code: string): Promise<void> {
    if (!window.posApi) return;
    try {
      const result = await window.posApi.billing.searchProducts(code, this.actor());
      if (result.success) {
        const items = result.data as Product[];
        if (items.length > 0) {
          this.selectProduct(items[0]);
          return;
        }
      }
    } catch (err) {
      console.error('Product search failed', err);
    }
    this.description = this.itemCode;
  }

  private isProductPriceAdjustable(product: Product | undefined | null): boolean {
    return truthyFlag(product?.price_override_allowed) || Number(product?.unit_price ?? 0) === 0;
  }

  private scrollItemDropdownIntoView(index: number): void {
    if (index < 0) return;
    setTimeout(() => document.getElementById(`item-dropdown-option-${index}`)?.scrollIntoView({ block: 'nearest' }), 0);
  }

  private scrollItemPickerIntoView(index: number): void {
    if (index < 0) return;
    setTimeout(() => document.getElementById(`item-picker-option-${index}`)?.scrollIntoView({ block: 'nearest' }), 0);
  }

  openItemPicker(): void {
    this.showItemDropdown = false;
    this.selectedDropdownIndex = -1;
    this.itemPickerQuery = '';
    this.itemPickerProducts = [];
    this.itemPickerIndex = -1;
    this.isItemPickerVisible = true;
    void this.searchItemPicker('');
    setTimeout(() => this.itemPickerSearchInput?.nativeElement?.focus(), 0);
  }

  closeItemPicker(): void {
    this.isItemPickerVisible = false;
    this.isItemPickerLoading = false;
    if (this.itemPickerSearchTimer) clearTimeout(this.itemPickerSearchTimer);
    this.itemPickerSearchTimer = undefined;
    setTimeout(() => this.itemCodeInput?.nativeElement?.focus(), 0);
  }

  onItemPickerQueryChange(): void {
    if (this.itemPickerSearchTimer) clearTimeout(this.itemPickerSearchTimer);
    // Invalidate an in-flight earlier search as soon as the cashier types,
    // rather than waiting for the debounce interval to elapse.
    const token = ++this.itemPickerSearchToken;
    this.isItemPickerLoading = true;
    this.itemPickerSearchTimer = setTimeout(() => {
      void this.searchItemPicker(this.itemPickerQuery, token);
    }, 120);
  }

  private async searchItemPicker(term: string, requestToken = ++this.itemPickerSearchToken): Promise<void> {
    if (!window.posApi || !this.isItemPickerVisible) return;
    const token = requestToken;
    this.isItemPickerLoading = true;
    try {
      const result = await window.posApi.billing.searchProducts(String(term || ''), this.actor());
      if (!this.isItemPickerVisible || token !== this.itemPickerSearchToken) return;
      this.itemPickerProducts = result.success ? result.data as Product[] : [];
      this.itemPickerIndex = this.itemPickerProducts.length ? 0 : -1;
      this.scrollItemPickerIntoView(this.itemPickerIndex);
    } finally {
      if (token === this.itemPickerSearchToken) this.isItemPickerLoading = false;
    }
  }

  onItemPickerKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.itemPickerIndex = Math.min(this.itemPickerIndex + 1, this.itemPickerProducts.length - 1);
        this.scrollItemPickerIntoView(this.itemPickerIndex);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.itemPickerIndex = Math.max(this.itemPickerIndex - 1, 0);
        this.scrollItemPickerIntoView(this.itemPickerIndex);
        break;
      case 'Enter':
        event.preventDefault();
        if (this.itemPickerIndex >= 0) this.selectPickerProduct(this.itemPickerProducts[this.itemPickerIndex]);
        break;
      case 'Escape':
        event.preventDefault();
        this.closeItemPicker();
        break;
    }
  }

  selectPickerProduct(product: Product): void {
    if (!product) return;
    this.isItemPickerVisible = false;
    if (this.itemPickerSearchTimer) clearTimeout(this.itemPickerSearchTimer);
    this.itemPickerSearchTimer = undefined;
    this.selectProduct(product);
  }

  itemPickerPrice(product: Product): string {
    return this.isProductPriceAdjustable(product)
      ? 'Set at sale'
      : Number(product.unit_price || 0).toFixed(2);
  }

  updateValue(): void {
    const product = this.products.find((p) => p.id === this.selectedProductId);
    const units = product?.pricing_basis === 'kilos' ? (Number(this.kilos) || 0) : (this.qty || 0);
    this.value = Math.max((this.rate * units) - this.discount, 0);
  }

  onRateInput(): void {
    if (this.selectedProductId === null) this.rateEnteredBeforeProduct = true;
    this.updateValue();
  }

  /** Recompute the value preview whenever a plugin line field changes (e.g. kilos). */
  onLineFieldChanged(): void {
    this.updateValue();
    this.refreshFormBehavior();
  }

  onQtyChange(): void {
    this.refreshFormBehavior();
    if (this.qty === null || this.qty === undefined || Number.isNaN(this.qty)) {
      this.qty = 1;
      this.updateValue();
      return;
    }
    if (this.qty <= 0) {
      this.qty = 0;
    }
    this.updateValue();
  }

  onRateKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.qtyInput?.nativeElement?.focus();
    this.qtyInput?.nativeElement?.select();
  }

  onKilosKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const next = this.isSelectedProductPriceChangeable ? this.rateInput?.nativeElement : this.qtyInput?.nativeElement;
    next?.focus();
    next?.select();
  }

  onQtyKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addBtn.nativeElement.focus();
    }
  }

  /** Advance through transaction header fields before item entry. */
  onBillHeaderInputKeyDown(event: KeyboardEvent, index: number): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.advanceBillHeaderInput(index);
  }

  advanceBillHeaderInput(index: number): void {
    const inputs = this.billHeaderInputs.toArray();
    const next = inputs[index + 1]?.nativeElement as HTMLElement | undefined;
    if (next) {
      next.focus();
      return;
    }
    this.itemCodeInput?.nativeElement?.focus();
  }

  onLineInputKeyDown(event: KeyboardEvent, index: number): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const nextIndex = index + 1;
      if (nextIndex < this.lineInputs.length) {
        // Focus the next line input
        const inputs = this.lineInputs.toArray();
        inputs[nextIndex].nativeElement.focus();
      } else {
        // Focus the Add button
        this.addBtn.nativeElement.focus();
      }
    }
  }

  async addItemToBill(): Promise<void> {
    if (!window.posApi || !this.receiptNo) return;

    if (!this.customerCode.trim()) { this.lineError = 'Customer code is required.'; this.customerCodeInput?.nativeElement?.focus(); return; }
    if (!this.supplierCode.trim()) { this.lineError = 'Supplier code is required.'; this.supplierCodeInput?.nativeElement?.focus(); return; }
    if (!this.itemCode.trim() || !this.description || !this.selectedProductId) { this.lineError = 'Item code is required.'; this.itemCodeInput?.nativeElement?.focus(); return; }
    if (!Number.isFinite(Number(this.qty)) || this.qty < 0) { this.lineError = 'Quantity is required.'; this.qtyInput?.nativeElement?.focus(); return; }

    const product = this.products.find((entry) => entry.id === this.selectedProductId);
    if (this.qty === 0 && !truthyFlag(product?.allow_zero_quantity)) {
      this.lineError = `${this.description} does not allow zero quantity.`;
      this.qtyInput?.nativeElement?.focus();
      return;
    }
    if (truthyFlag(product?.requires_kilos) && (!this.kilos || this.kilos <= 0)) {
      this.lineError = `Kilos is required for ${this.description}.`;
      this.kilosInput?.nativeElement?.focus();
      return;
    }
    this.lineError = '';

    this.isSubmitting = true;
    try {
      const result = await window.posApi.billing.addItem(this.billContext(), {
        productId: this.selectedProductId,
        supplierCode: this.supplierCode.trim().toUpperCase(),
        itemCode: this.itemCode,
        description: this.description,
        qty: this.qty,
        unitPrice: this.rate,
        discount: this.discount,
        tax: 0,
        kilos: this.kilos,
        metadata: {}
      }, this.actor());
      if (result.success) {
        const saved = result.data as BillItem;
        this.billItems.push(saved);
        this.resetInputs({ keepSupplier: true, focusSupplier: true });
        this.scheduleTotalsRefresh();
        void this.refreshPendingBills();
      } else {
        this.lineError = result.error || 'Could not add this item to the bill.';
      }
    } catch (err) {
      console.error('Failed to add item', err);
      this.lineError = err instanceof Error ? err.message : 'Could not add this item to the bill.';
    } finally {
      this.isSubmitting = false;
    }
  }

  async updateItemQty(index: number, newQty: number): Promise<void> {
    if (newQty < 0) return;
    const item = this.billItems[index];
    item.qty = newQty;
    await this.persistItemAndRefresh(index, item.metadata || {});
  }

  async updateItemKilos(index: number, newKilos: number): Promise<void> {
    if (!Number.isFinite(newKilos) || newKilos <= 0) return;
    const item = this.billItems[index];
    const previous = item.kilos;
    item.kilos = newKilos;
    if (!await this.persistItemAndRefresh(index, {})) item.kilos = previous;
  }

  canOverrideLinePrice(item: BillItem): boolean { return this.isProductPriceAdjustable(this.products.find((entry) => entry.id === item.productId)); }
  get isSelectedProductPriceChangeable(): boolean { return this.isProductPriceAdjustable(this.products.find((entry) => entry.id === this.selectedProductId)); }
  get selectedProductRequiresKilos(): boolean { return truthyFlag(this.products.find((product) => product.id === this.selectedProductId)?.requires_kilos); }
  get showKilosField(): boolean { return this.selectedProductId === null || this.selectedProductRequiresKilos; }
  get selectedProductQuantityStep(): number { return Math.max(Number(this.products.find((product) => product.id === this.selectedProductId)?.quantity_step || 1), 0.001); }
  async updateItemPrice(index: number, newPrice: number): Promise<void> { const item = this.billItems[index]; if (!Number.isFinite(newPrice) || newPrice < 0 || !this.canOverrideLinePrice(item)) return; const previous = item.unitPrice; item.unitPrice = newPrice; if (!await this.persistItemAndRefresh(index, item.metadata || {})) { item.unitPrice = previous; this.lineError = 'Price change was not accepted by this item policy.'; } }

  /** Persist metadata (e.g. edited kilos/ownership/buyer) and re-run plugin math. */
  async updateItemField(index: number, field: PluginField, event: Event): Promise<void> {
    const item = this.billItems[index];
    const meta = { ...((item.metadata || {}) as Record<string, unknown>) };
    const target = event.target as HTMLInputElement;
    if (field.type === 'number') {
      const n = Number(target.value);
      meta[field.key] = Number.isFinite(n) ? n : 0;
    } else if (field.type === 'checkbox') {
      meta[field.key] = Boolean(target.checked);
    } else {
      meta[field.key] = target.value;
    }
    await this.persistItemAndRefresh(index, meta);
  }

  private async persistItemAndRefresh(index: number, metadata: Record<string, unknown>): Promise<boolean> {
    const item = this.billItems[index];
    if (!item.id || !window.posApi) {
      item.metadata = metadata;
      return true;
    }
    try {
      const updated = await window.posApi.billing.updateItem(item.id, {
        qty: item.qty,
        kilos: item.kilos ?? null,
        unitPrice: item.unitPrice,
        discount: item.discount || 0,
        tax: item.tax || 0,
        total: item.total,
        metadata: {}
      }, this.actor());
      if (!updated.success) { this.lineError = updated.error || 'Item update was rejected.'; return false; }
      // Refresh the entire bill items to get plugin-calculated totals (wage, bags, net, etc.)
      const billContext = {
        locCode: this.locationCode,
        macCode: this.machineCode,
        txnDate: this.billingDate,
        receiptNo: this.receiptNo
      };
      const result = await window.posApi.billing.getItems(billContext, this.actor());
      if (result.success) {
        this.billItems = result.data as BillItem[];
      } else {
        console.error('Failed to refresh bill items after update:', result.error);
        item.metadata = metadata;
        this.applyLocalItemTotal(item);
      }
    } catch (err) {
      console.error('Failed to update item', err);
      item.metadata = metadata;
      this.applyLocalItemTotal(item);
      return false;
    }
    this.scheduleTotalsRefresh();
    return true;
  }

  private applyLocalItemTotal(item: BillItem): void {
    item.total = Math.max((item.unitPrice * item.qty) - (item.discount || 0) + (item.tax || 0), 0);
  }

  async removeItem(index: number): Promise<void> {
    const item = this.billItems[index];
    if (!item.id || !window.posApi) {
      this.billItems.splice(index, 1);
      void this.refreshPendingBills();
      return;
    }
    try {
      await window.posApi.billing.removeItem(item.id, this.actor());
      this.billItems.splice(index, 1);
      this.scheduleTotalsRefresh();
      void this.refreshPendingBills();
    } catch (err) {
      console.error('Failed to remove item', err);
    }
  }

  resetInputs(options: { keepSupplier?: boolean; focusSupplier?: boolean } = {}): void {
    const { keepSupplier = false, focusSupplier = false } = options;
    this.itemCode = '';
    if (!keepSupplier) this.supplierCode = '';
    this.description = '';
    this.rate = 0;
    this.rateEnteredBeforeProduct = false;
    this.discount = 0;
    this.qty = 1;
    this.kilos = null;
    this.value = 0;
    this.selectedProductId = null;
    this.lineFieldValues = {};
    this.lineError = '';
    setTimeout(() => {
      const target = focusSupplier
        ? this.supplierCodeInput?.nativeElement
        : this.customerCodeInput?.nativeElement;
      target?.focus();
      if (focusSupplier) target?.select();
    }, 0);
  }

  private resetItemFields(): void {
    this.description = '';
    this.rate = 0;
    this.kilos = null;
    this.discount = 0;
    this.value = 0;
    this.selectedProductId = null;
  }

  get grossTotal(): number {
    const authoritative = this.authoritativeTotals?.grossTotal;
    if (authoritative !== undefined && Number.isFinite(authoritative)) {
      return authoritative;
    }
    return this.billItems.reduce((sum, item) => sum + this.lineGross(item), 0);
  }

  get totalDiscount(): number {
    return this.billItems.reduce((sum, item) => sum + (item.discount || 0), 0);
  }

  get bagChargeTotal(): number { return this.authoritativeTotals?.totals?.['bagChargeTotal'] ?? this.billItems.reduce((sum, item) => sum + Number(item.bagChargeTotal || 0), 0); }
  get wageChargeTotal(): number { return this.authoritativeTotals?.totals?.['wageChargeTotal'] ?? this.billItems.reduce((sum, item) => sum + Number(item.wageChargeTotal || 0), 0); }

  get netTotal(): number {
    const authoritative = this.authoritativeTotals?.grandTotal;
    if (authoritative !== undefined && Number.isFinite(authoritative)) {
      return authoritative;
    }
    return this.billItems.reduce((sum, item) => sum + item.total, 0);
  }

  get itemMeasureSummaries(): ItemMeasureSummary[] {
    return summarizeItemMeasures(this.billItems);
  }

  itemMeasureSummaryText(summary: ItemMeasureSummary): string {
    return itemMeasureSummaryText(summary);
  }

  trackItemMeasureSummary(_index: number, summary: ItemMeasureSummary): string {
    return summary.key;
  }

  scrollItemMeasureSummary(event: WheelEvent, element: HTMLElement): void {
    if (element.scrollWidth <= element.clientWidth) return;
    const movement = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    element.scrollLeft += movement;
    event.preventDefault();
  }

  // ── Plugin table columns ──────────────────────────────

  /** A table column is shown when its SDL visibleWhen passes for at least one
   *  bill line, or — for legacy fields — when no
   *  gate exists or any line carries truthy metadata for the gate key. */
  tableFieldVisible(field: PluginField): boolean {
    const behaviorKey = this.behaviorFieldKey(field);
    if (this.tableVisible?.has(behaviorKey)) {
      return this.tableVisible.get(behaviorKey) ?? false;
    }
    const gate = field.visibleWhen;
    if (!gate) return true;
    return this.billItems.some((item) => {
      const meta = (item.metadata || {}) as Record<string, unknown>;
      return Boolean(meta[gate]);
    });
  }

  get visibleTableFields(): PluginField[] {
    return this.tableFields.filter((f) => this.tableFieldVisible(f));
  }

  get itemsGridTemplate(): string {
    const base = '1.2fr 2.5fr 1fr 0.8fr 0.8fr 0.9fr 1fr 40px';
    const extra = this.visibleTableFields.map(() => 'minmax(70px, 0.9fr)').join(' ');
    return extra ? `${base} ${extra}` : base;
  }

  rawTableField(item: BillItem, field: PluginField): string {
    const meta = (item.metadata || {}) as Record<string, unknown>;
    const raw = field.key === 'kilos' ? item.kilos ?? meta[field.key] : meta[field.key];
    if (raw === undefined || raw === null || raw === '') return '';
    return String(raw);
  }

  formatTableField(item: BillItem, field: PluginField): string {
    const raw = this.rawTableField(item, field);
    if (!raw) return '';
    if (field.type === 'number') {
      return Number(raw).toFixed(field.format === 'kilos' ? 3 : 2);
    }
    return raw;
  }

  // ── Hold Bill ──────────────────────────────────────────

  /**
   * Hold the current bill (items stay persisted, recallable) and start the
   * next receipt number.
   */
  async holdBill(): Promise<void> {
    if (!window.posApi || !this.sessionId) return;
    if (this.billItems.length === 0) return;
    const heldReceiptNo = this.receiptNo;
    try {
      const result = await window.posApi.billing.holdBill(this.billContext(), this.actor());
      if (result.success) {
        const data = result.data as OpenBillResult;
        this.receiptNo = data.receiptNo;
        this.billItems = [];
        this.customerCode = '';
        this.customerAccountId = null;
        this.linkedCustomer = null;
        this.resetInputs();
        this.scheduleTotalsRefresh();
        await this.refreshPendingBills(heldReceiptNo);
      }
    } catch (err) {
      console.error('Hold bill failed', err);
    }
  }

  // ── Abandon / Clear ────────────────────────────────────

  /** Start a fresh bill while preserving any entered live lines as pending. */
  async startNewBill(): Promise<void> {
    if (this.isPaymentPopupVisible || this.isRecallPopupVisible || this.isAbandonConfirmVisible || this.isFinalizing) return;
    if (this.billItems.length > 0) {
      await this.holdBill();
      return;
    }
    this.customerCode = '';
    this.customerAccountId = null;
    this.linkedCustomer = null;
    this.resetInputs();
    this.focusFirstBillInput();
  }

  confirmAbandon(): void {
    if (this.billItems.length === 0) return;
    this.isAbandonConfirmVisible = true;
  }

  hideAbandonConfirm(): void {
    this.isAbandonConfirmVisible = false;
  }

  /**
   * Permanently delete the current bill's items. Receipt numbers stay consumed.
   * Confirmation popup is structured so manager/supervisor approval can be
   * added later.
   */
  async performAbandon(): Promise<void> {
    if (!window.posApi || !this.receiptNo) return;
    this.hideAbandonConfirm();
    try {
      await window.posApi.billing.abandonBill({
        locCode: this.locationCode,
        macCode: this.machineCode,
        txnDate: this.billingDate,
        receiptNo: this.receiptNo
      }, this.actor());
      this.billItems = [];
      this.customerCode = '';
      this.customerAccountId = null;
      this.linkedCustomer = null;
      this.resetInputs();
      await this.openOrResumeBill();
      await this.refreshPendingBills();
    } catch (err) {
      console.error('Abandon bill failed', err);
    }
  }

  // ── Payment ────────────────────────────────────────

  get tenderTotal(): number {
    return this.payments.reduce((sum, p) =>
      this.modeMap.get(p.method)?.type === 'credit' ? sum : sum + p.amount, 0);
  }

  get creditTotal(): number {
    return this.payments.reduce((sum, p) =>
      this.modeMap.get(p.method)?.type === 'credit' ? sum + p.amount : sum, 0);
  }

  get shortfall(): number {
    return Math.max(this.netTotal - this.tenderTotal, 0);
  }

  get changeAmount(): number {
    return Math.max(this.tenderTotal - this.netTotal, 0);
  }

  get outstanding(): number {
    return Math.max(this.shortfall - this.creditTotal, 0);
  }

  get paymentProgressPct(): number {
    if (this.netTotal <= 0) return 0;
    return Math.min(Math.round(((this.tenderTotal + this.creditTotal) / this.netTotal) * 100), 100);
  }

  get selectedMode(): PaymentMode | null {
    return this.modeMap.get(this.selectedModeId) || null;
  }

  get isChequeModeSelected(): boolean {
    return this.selectedMode?.id === 'cheque';
  }

  get canCompletePayment(): boolean {
    if (this.netTotal <= 0 || this.payments.length === 0) return false;
    if (this.tenderTotal >= this.netTotal) return true;
    return this.creditTotal > 0 && Math.abs(this.tenderTotal + this.creditTotal - this.netTotal) < 0.005;
  }

  get hasPendingBalance(): boolean {
    return this.shortfall > 0 && this.creditTotal > 0;
  }

  isModeUsed(modeId: string): boolean {
    return this.payments.some((p) => p.method === modeId);
  }

  modeMapName(modeId: string): string {
    return this.modeMap.get(modeId)?.name || modeId;
  }

  isModeCredit(modeId: string): boolean {
    return this.modeMap.get(modeId)?.type === 'credit';
  }

  async showPaymentPopup(): Promise<void> {
    try {
      if (!await this.refreshAuthoritativeTotals()) {
        this.lineError = 'Unable to calculate the bill total. Check the SDL configuration and try again.';
        return;
      }
    } catch (err) {
      this.lineError = err instanceof Error ? err.message : 'Unable to calculate the bill total.';
      return;
    }
    if (this.netTotal <= 0) return;
    this.payments = [];
    this.enteredAmount = '';
    this.resetChequeDetails();
    this.paymentAccountTerm = '';
    this.paymentAccountMatches = [];
    this.paymentAccountSearchOpen = !this.linkedCustomer;
    this.paymentError = '';
    this.paymentSuccess = null;
    this.isPaymentPopupVisible = true;
    this.isPaymentModesLoading = true;
    this.focusAmountInput();

    try {
      if (!window.posApi) {
        this.paymentError = 'POS bridge unavailable.';
        return;
      }
      const result = await window.posApi.billing.paymentModes(this.actor());
      if (result.success) {
        this.paymentModes = result.data || [];
        this.modeMap.clear();
        for (const mode of this.paymentModes) this.modeMap.set(mode.id, mode);
        const firstTender = this.paymentModes.find((m) => m.type === 'tender');
        this.selectedModeId = firstTender?.id || this.paymentModes[0]?.id || 'cash';
        this.enteredAmount = this.netTotal.toFixed(2);
        this.focusAmountInput();
      } else {
        this.paymentError = (result as { error: string }).error || 'Failed to load payment modes.';
      }
    } catch (err) {
      this.paymentError = err instanceof Error ? err.message : 'Failed to load payment modes.';
    } finally {
      this.isPaymentModesLoading = false;
    }
  }

  /** Shift+F2: settle the current bill in full using the configured cash tender. */
  private async completeCurrentBillAsCash(): Promise<void> {
    if (this.billItems.length === 0) return;
    await this.showPaymentPopup();
    if (!this.isPaymentPopupVisible || this.isPaymentModesLoading || this.netTotal <= 0) return;

    const cashMode = this.paymentModes.find((mode) => mode.id.toLowerCase() === 'cash' || mode.name.toLowerCase() === 'cash')
      || this.paymentModes.find((mode) => mode.type === 'tender');
    if (!cashMode) {
      this.paymentError = 'No cash tender payment mode is configured.';
      return;
    }

    this.selectedModeId = cashMode.id;
    this.enteredAmount = this.netTotal.toFixed(2);
    this.payments = [{ method: cashMode.id, amount: this.netTotal }];
    await this.completePayment();
  }

  private focusAmountInput(): void {
    setTimeout(() => {
      const input = this.pmAmountInput?.nativeElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  hidePaymentPopup(): void {
    this.showChequeDetailsEditor = false;
    this.isPaymentPopupVisible = false;
    this.paymentSuccess = null;
    this.settledReceipt = null;
  }

  selectMode(modeId: string): void {
    this.selectedModeId = modeId;
    this.showChequeDetailsEditor = false;
    const remaining = this.outstanding > 0 ? this.outstanding : this.netTotal;
    this.enteredAmount = remaining.toFixed(2);
    this.focusAmountInput();
  }

  private resetChequeDetails(): void {
    this.chequeDetails = {};
    this.showChequeDetailsEditor = false;
  }

  get hasChequeDetails(): boolean {
    return Boolean(this.currentChequeDetails());
  }

  get chequeDetailsSummary(): string {
    const details = this.currentChequeDetails();
    if (!details) return 'Enter Cheque Details';
    return [
      details.number ? `Cheque #${details.number}` : 'Cheque details entered',
      details.bankName,
      details.date
    ].filter(Boolean).join(' · ');
  }

  toggleChequeDetailsEditor(): void {
    this.showChequeDetailsEditor = !this.showChequeDetailsEditor;
    if (this.showChequeDetailsEditor) {
      setTimeout(() => this.chequeNumberInput?.nativeElement?.focus(), 0);
    }
  }

  closeChequeDetailsEditor(): void {
    this.showChequeDetailsEditor = false;
    this.focusAmountInput();
  }

  openPaymentAccountSearch(): void {
    this.paymentAccountSearchOpen = true;
    this.paymentAccountTerm = '';
    this.paymentAccountMatches = [];
  }

  closePaymentAccountSearch(): void {
    this.paymentAccountSearchOpen = !this.linkedCustomer;
    this.paymentAccountTerm = '';
    this.paymentAccountMatches = [];
  }

  onPaymentAccountTermChange(): void {
    if (this.paymentAccountSearchTimer) clearTimeout(this.paymentAccountSearchTimer);
    const term = this.paymentAccountTerm.trim();
    if (!term) {
      this.paymentAccountMatches = [];
      return;
    }
    this.paymentAccountSearchTimer = setTimeout(() => void this.searchPaymentAccounts(term), 100);
  }

  private async searchPaymentAccounts(term: string): Promise<void> {
    if (!window.posApi) return;
    const token = ++this.paymentAccountSearchToken;
    this.isPaymentAccountSearching = true;
    const result = await window.posApi.catalog.searchCustomers(term, this.actor(), {
      outstandingOnly: false, balanceOrder: 'desc', activityOrder: 'desc'
    });
    if (token !== this.paymentAccountSearchToken) return;
    this.isPaymentAccountSearching = false;
    this.paymentAccountMatches = result.success ? (result.data as CustomerAccountSummary[]).slice(0, 8) : [];
  }

  async choosePaymentCustomerAccount(account: CustomerAccountSummary): Promise<void> {
    if (!window.posApi || !this.receiptNo) return;
    const previousId = this.customerAccountId;
    const previousCustomer = this.linkedCustomer;
    this.customerAccountId = Number(account.id);
    this.linkedCustomer = account;
    const result = await window.posApi.billing.updateCustomer({
      locCode: this.locationCode, macCode: this.machineCode, txnDate: this.billingDate,
      receiptNo: this.receiptNo, customerCode: this.customerCode.trim().toUpperCase(),
      customerAccountId: this.customerAccountId
    }, this.actor());
    if (!result.success) {
      this.customerAccountId = previousId;
      this.linkedCustomer = previousCustomer;
      this.paymentError = result.error || 'Could not link the customer account.';
      return;
    }
    this.paymentError = '';
    this.paymentAccountTerm = '';
    this.paymentAccountMatches = [];
    this.paymentAccountSearchOpen = false;
  }

  private currentChequeDetails(): ChequePaymentDetails | null {
    const details: ChequePaymentDetails = {
      number: String(this.chequeDetails.number || '').trim() || null,
      date: String(this.chequeDetails.date || '').trim() || null,
      bankName: String(this.chequeDetails.bankName || '').trim() || null,
      branchName: String(this.chequeDetails.branchName || '').trim() || null,
      drawerName: String(this.chequeDetails.drawerName || '').trim() || null,
      accountReference: String(this.chequeDetails.accountReference || '').trim() || null,
      notes: String(this.chequeDetails.notes || '').trim() || null
    };
    return Object.values(details).some(Boolean) ? details : null;
  }

  paymentDetailsLabel(payment: PaymentLine): string {
    if (payment.method !== 'cheque') return '';
    const cheque = payment.chequeDetails || {};
    const number = String(cheque.number || payment.providerRef || '').trim();
    const bank = String(cheque.bankName || '').trim();
    return [number ? `Cheque #${number}` : '', bank].filter(Boolean).join(' · ');
  }

  onNumpadClick(value: string): void {
    if (value === '⌫') {
      this.enteredAmount = this.enteredAmount.slice(0, -1);
    } else if (value === '.' && this.enteredAmount.includes('.')) {
      return;
    } else {
      this.enteredAmount += value;
    }
  }

  onAmountKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.handleAmountEnter();
    }
  }

  /**
   * Enter on the amount input:
   *   - adds the entered payment (same as the Add Payment button) and advances
   *     to the next unused paymode when the total isn't settled yet, or
   *   - completes/finalizes the receipt once the payments cover the total.
   */
  private handleAmountEnter(): void {
    if (this.canCompletePayment) {
      this.completePayment();
      return;
    }
    this.addPayment();
    if (this.canCompletePayment) {
      this.completePayment();
    }
  }

  addPayment(): void {
    const amount = parseFloat(this.enteredAmount);
    if (!amount || amount <= 0) return;
    const mode = this.selectedMode;
    if (!mode) {
      this.paymentError = 'Select a payment mode.';
      return;
    }

    if (mode.type === 'credit') {
      if (amount > this.shortfall + 0.005) {
        this.paymentError = `Pending/credit cannot exceed the outstanding balance (${this.shortfall.toFixed(2)}).`;
        return;
      }
    } else if (this.creditTotal > 0 && this.tenderTotal + amount > this.netTotal + 0.005) {
      this.paymentError = 'Tender exceeds the total while a Pending payment is present.';
      return;
    }

    const chequeDetails = mode.id === 'cheque' ? this.currentChequeDetails() : null;
    if ((mode.type === 'credit' || mode.id === 'cheque') && !this.customerAccountId) {
      this.paymentError = mode.id === 'cheque'
        ? 'Link a real customer account before accepting a cheque.'
        : 'Link a real customer account before adding pending credit.';
      return;
    }
    if (mode.type === 'credit' && this.linkedCustomer?.creditEnabled === false) {
      this.paymentError = 'Credit is not enabled for the linked customer account.';
      return;
    }
    const payment: PaymentLine = {
      method: mode.id,
      amount,
      providerRef: chequeDetails?.number || null,
      chequeDetails
    };
    // Each cheque is a separately traceable instrument. Other modes retain
    // the existing compact one-line aggregation behavior.
    if (mode.id === 'cheque') {
      this.payments.push(payment);
      this.resetChequeDetails();
    } else {
      const existing = this.payments.find((p) => p.method === mode.id);
      if (existing) {
        existing.amount = Math.round((existing.amount + amount) * 100) / 100;
      } else {
        this.payments.push(payment);
      }
    }

    this.enteredAmount = '';
    this.paymentError = '';
    this.selectNextAvailableMode();
    this.focusAmountInput();
  }

  private selectNextAvailableMode(): void {
    const remaining = this.outstanding;
    const next = this.paymentModes.find((m) => !this.isModeUsed(m.id));
    if (next) {
      this.selectedModeId = next.id;
      if (remaining > 0) {
        this.enteredAmount = remaining.toFixed(2);
      }
    } else {
      this.enteredAmount = remaining > 0 ? remaining.toFixed(2) : '';
    }
  }

  removePayment(index: number): void {
    this.payments.splice(index, 1);
    this.paymentError = '';
    if (this.payments.length === 0) {
      const firstTender = this.paymentModes.find((m) => m.type === 'tender');
      this.selectedModeId = firstTender?.id || 'cash';
      this.enteredAmount = this.netTotal.toFixed(2);
    }
    this.focusAmountInput();
  }

  clearAllPayments(): void {
    this.payments = [];
    this.resetChequeDetails();
    this.paymentError = '';
    const firstTender = this.paymentModes.find((m) => m.type === 'tender');
    this.selectedModeId = firstTender?.id || 'cash';
    this.enteredAmount = this.netTotal.toFixed(2);
    this.focusAmountInput();
  }

  async completePayment(): Promise<void> {
    // Keyboard Enter and the action button can arrive close together. Once a
    // settlement begins, never let a second request reuse the same receipt.
    if (this.isFinalizing) return;
    if (!this.canCompletePayment) return;
    if (!window.posApi || !this.receiptNo || !this.sessionId) return;
    this.isFinalizing = true;
    this.paymentError = '';

    try {
      const user = this.session.getUser();
      const result = await window.posApi.billing.finalize({
        locCode: this.locationCode,
        macCode: this.machineCode,
        txnDate: this.billingDate,
        receiptNo: this.receiptNo,
        sessionId: this.sessionId,
        payments: this.payments.map((p) => ({
          method: p.method,
          amount: p.amount,
          providerRef: p.providerRef || null,
          chequeDetails: p.chequeDetails || null
        })),
        userId: user?.id,
        customerCode: this.customerCode.trim().toUpperCase(),
        customerAccountId: this.customerAccountId
      }, this.actor());

      if (result.success) {
        const finalized = result.data as FinalizeResult;
        this.settledReceipt = this.buildSettledReceiptSnapshot(
          this.billItems,
          this.payments,
          finalized
        );
        // Do the output work before exposing the settled view. The Done button
        // clears its display snapshot, so setting success first allowed a fast
        // click to interrupt the active-bill reset and leave the completed
        // receipt number selected for the next sale.
        await this.printSettledReceipt();
        await this.autoSaveSettledReceiptPdf();
        this.billItems = [];
        this.customerCode = '';
        this.customerAccountId = null;
        this.linkedCustomer = null;
        this.billHeaderValues = {};
        this.resetInputs();
        // finalizeBill already reserves this number atomically. Opening a new
        // bill here allocated another number and made a second asynchronous
        // step vulnerable to the settled popup being dismissed.
        this.receiptNo = finalized.nextReceiptNo;
        this.authoritativeTotals = null;
        this.scheduleTotalsRefresh();
        await this.refreshPendingBills();
        this.paymentSuccess = finalized;
      } else {
        this.paymentError = (result as { error: string }).error || 'Finalize failed.';
      }
    } catch (err) {
      this.paymentError = err instanceof Error ? err.message : 'Finalize failed.';
    } finally {
      this.isFinalizing = false;
    }
  }

  doneWithPayment(): void {
    this.hidePaymentPopup();
    this.focusFirstBillInput();
  }

  // ── Printing ──────────────────────────────────────────

  /** Build an ESC/POS receipt document from the settled-receipt snapshot. */
  private buildReceiptDocument({ thermalPdf = false }: { thermalPdf?: boolean } = {}): PrintDocument {
    const r = this.settledReceipt;
    const cfg = this.receiptConfig;
    if (!r) throw new Error('No settled receipt to print.');
    const money = (n: number): string => `${cfg.currencySymbol} ${n.toFixed(2)}`;

    const meta: PrintDocument['meta'] = [
      { label: 'Receipt', value: `#${r.receiptNo}` },
      // Keep the full invoice reference in the finalized record, but do not print it:
      // receipt number, terminal, and billing date already identify this sale.
      // ...(r.invoiceNumber ? [{ label: 'Invoice', value: r.invoiceNumber }] : []),
      { label: 'Date', value: this.formatReceiptDateTime(r.settledAt) },
      { label: 'Terminal', value: `${r.locationCode}/${r.machineCode}` },
      { label: 'Cashier', value: r.cashierName }
    ];
    for (const field of this.billHeaderReceiptFields) {
      const value = r.billHeader[field.pluginId]?.[field.key];
      if (value === undefined || value === null || value === '' || (field.type === 'checkbox' && !value)) continue;
      meta.push({
        label: field.label,
        value: field.type === 'number' ? Number(value).toFixed(2) : String(value)
      });
    }

    const items: PrintDocItem[] = r.items.map((item) => ({
      // description: `${this.receiptItemCode(item) ? `${this.receiptItemCode(item)} ` : ''}${item.description}`,
      description: `${this.receiptSupplierCode(item) ? `${this.receiptSupplierCode(item)}~` : ''}${item.description}`,
      qty: this.receiptQtyLabel(item),
      amount: money(this.lineMerchandiseTotal(item)),
      measure: this.receiptMeasure(item),
      extras: this.receiptItemExtras(item)
    }));

    const totals: PrintDocument['totals'] = [
      { label: 'Subtotal', value: money(r.grossTotal) },
      ...(r.bagChargeTotal > 0 ? [{ label: 'Bag Charges', value: money(r.bagChargeTotal) }] : []),
      ...(r.wageChargeTotal > 0 ? [{ label: 'Wage Charges', value: money(r.wageChargeTotal) }] : []),
      ...(r.totalDiscount > 0 ? [{ label: 'Discount', value: `-${money(r.totalDiscount)}` }] : []),
      ...r.pluginTotals.filter((t) => t.value !== 0).map((t) => ({ label: t.label, value: money(t.value) })),
      { label: 'TOTAL', value: money(r.grandTotal), bold: true },
      ...r.payments.filter((p) => p.method !== 'pending').map((p) => ({ label: this.receiptPaymentLabel(p), value: money(p.amount) })),
      ...(r.changeAmt > 0 ? [{ label: 'Change', value: money(r.changeAmt) }] : []),
      ...(r.status === 'partial' ? [{ label: 'Pending Balance', value: money(r.balance) }] : [])
    ];

    return {
      documentTitle: 'Tax Invoice',
      brand: {
        name: cfg.storeName,
        // The tagline is rendered beside the customer code below the optional
        // headers, not in the default brand position.
        tagline: '',
        addressLines: cfg.addressLines,
        phone: cfg.phone
      },
      logoDataUrl: cfg.logoDataUrl || undefined,
      secondaryHeaderLines: [
        ...cfg.headers.map((text) => ({
        text,
          align: 'center' as const
        })),
        ...this.receiptIdentityLines(r.customerCode)
      ],
      meta,
      itemLayout: 'invoice-measures',
      receiptLanguage: cfg.language,
      rasterHeaderLayout: 'billing',
      quantityTotal: this.receiptQuantityTotal(r.items),
      pdfLayout: thermalPdf ? 'thermal-receipt' : 'standard',
      items,
      totals,
      footerLines: cfg.footers
    };
  }

  private receiptIdentityLines(customerCode: string): PrintTextLine[] {
    const tagline = this.receiptConfig.tagline.trim();
    const customer = String(customerCode || '').trim().toUpperCase();
    if (!tagline && !customer) return [];

    // Size 1 doubles the text; use a 24-character logical line so both values
    // remain on one physical 80 mm row, matching the store-name emphasis.
    const width = 24;
    if (!tagline) return [{ text: customer.slice(0, width), align: 'right', bold: true, size: 1, identity: { left: '', right: customer.slice(0, width) } }];
    if (!customer) return [{ text: tagline.slice(0, width), align: 'left', bold: true, size: 1, identity: { left: tagline.slice(0, width), right: '' } }];
    const right = customer.slice(0, Math.floor(width / 2));
    const left = tagline.slice(0, Math.max(1, width - right.length - 1));
    return [{ text: `${left}${' '.repeat(Math.max(1, width - left.length - right.length))}${right}`, align: 'left', bold: true, size: 1, identity: { left, right } }];
  }

  /** Print the current settled receipt to the default printer. Never throws. */
  async printSettledReceipt(): Promise<void> {
    if (!this.settledReceipt) return;
    try {
      // Settings can be changed while Billing remains open, so never print a
      // settled receipt with the branding captured when this page first loaded.
      await this.loadSettings();
      const result = await this.printing.printDocument(this.buildReceiptDocument());
      if (!result.success) {
        console.warn('Receipt print failed:', result.error || result.message);
      }
    } catch (err) {
      console.error('Receipt print failed', err);
    }
  }

  /** Auto-export is best-effort: a completed sale must never fail because a
   * local backup folder is unavailable. */
  private async autoSaveSettledReceiptPdf(): Promise<void> {
    if (!this.settledReceipt || !window.posApi) return;
    try {
      const output = await window.posApi.settings.getBillingOutput(this.actor());
      if (!output.success || !output.data.autoSavePdf) return;
      const directory = output.data.pdfFolder;
      if (!directory) return;
      const saved = await this.printing.savePdf(this.buildReceiptDocument({ thermalPdf: true }), {
        directory,
        fileName: this.settledReceipt.invoiceNumber
      });
      if (!saved.success) {
        this.paymentError = `Invoice was completed, but the PDF was not saved: ${saved.error || 'unknown error'}`;
      }
    } catch (error) {
      console.warn('Automatic invoice PDF save failed', error);
      this.paymentError = `Invoice was completed, but the PDF was not saved: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }

  reprintReceipt(): void {
    void this.printSettledReceipt();
  }

  // ── Recall ─────────────────────────────────────────

  /** Refresh the compact side queue without opening the full recall dialog. */
  async refreshPendingBills(newlyPendingReceiptNo?: number): Promise<void> {
    if (!window.posApi || !this.locationCode || !this.machineCode || !this.billingDate) return;
    this.isPendingBillsLoading = true;
    try {
      const result = await window.posApi.billing.recallBills(
        this.locationCode,
        this.machineCode,
        this.billingDate,
        this.actor()
      );
      if (!result.success) return;

      this.pendingBills = (result.data as HeldBill[])
        .filter((bill) => bill.receiptNo !== this.receiptNo);
      if (newlyPendingReceiptNo && this.pendingBills.some((bill) => bill.receiptNo === newlyPendingReceiptNo)) {
        this.newlyPendingReceiptNo = newlyPendingReceiptNo;
        if (this.pendingBillAnimationTimer) clearTimeout(this.pendingBillAnimationTimer);
        this.pendingBillAnimationTimer = setTimeout(() => { this.newlyPendingReceiptNo = null; }, 700);
      }
    } catch (err) {
      console.error('Pending bill queue refresh failed', err);
    } finally {
      this.isPendingBillsLoading = false;
    }
  }

  /**
   * Switch directly from the compact queue. Live lines are already durable in
   * invoice_items, so the current bill remains pending while the chosen
   * receipt becomes the active bill.
   */
  async recallPendingBill(bill: HeldBill): Promise<void> {
    if (!window.posApi || bill.receiptNo === this.receiptNo) return;
    const previousReceiptNo = this.billItems.length > 0 ? this.receiptNo : undefined;
    this.isPendingBillsLoading = true;
    try {
      const result = await window.posApi.billing.loadBill({
        locCode: this.locationCode,
        macCode: this.machineCode,
        txnDate: this.billingDate,
        receiptNo: bill.receiptNo
      }, this.actor());
      if (!result.success) return;

      const data = result.data as OpenBillResult;
      const items = data.items || [];
      if (items.length === 0) {
        await this.refreshPendingBills();
        return;
      }
      this.receiptNo = bill.receiptNo;
      this.billItems = items;
      this.customerCode = String(data.customerCode || items[0]?.customerCode || '').toUpperCase();
      this.customerAccountId = data.customerAccountId || items[0]?.customerAccountId || null;
      await this.loadLinkedCustomer();
      this.supplierCode = String(items[items.length - 1]?.supplierCode || '').toUpperCase();
      this.billHeaderValues = data.billHeader || {};
      this.resetInputs({ keepSupplier: true, focusSupplier: true });
      this.scheduleTotalsRefresh();
      await this.refreshPendingBills(previousReceiptNo);
    } catch (err) {
      console.error('Direct pending bill recall failed', err);
    } finally {
      this.isPendingBillsLoading = false;
    }
  }

  async loadRecallBills(): Promise<void> {
    if (this.billItems.length > 0) return;
    if (!window.posApi) return;
    this.isLoading = true;
    try {
      const result = await window.posApi.billing.recallBills(
        this.locationCode,
        this.machineCode,
        this.billingDate,
        this.actor()
      );
      if (result.success) {
        this.unfinalizedBills = result.data as HeldBill[];
        this.filteredBills = [...this.unfinalizedBills];
        this.searchTerm = '';
        this.selectedBill = null;
        this.previewItems = [];
        this.isRecallPopupVisible = true;
      }
    } catch (err) {
      console.error('Recall bills failed', err);
    } finally {
      this.isLoading = false;
    }
  }

  hideRecallPopup(): void {
    this.isRecallPopupVisible = false;
    this.unfinalizedBills = [];
    this.filteredBills = [];
    this.searchTerm = '';
    this.selectedBill = null;
    this.previewItems = [];
    this.previewBillHeader = {};
  }

  onSearch(): void {
    const term = this.searchTerm.trim();
    this.filteredBills = term
      ? this.unfinalizedBills.filter((b) => b.receiptNo.toString().includes(term))
      : [...this.unfinalizedBills];
  }

  async selectRecallBill(bill: HeldBill): Promise<void> {
    if (this.selectedBill?.receiptNo === bill.receiptNo && this.previewItems.length > 0) return;
    this.selectedBill = bill;
    this.previewItems = [];
    this.previewBillHeader = {};
    if (!window.posApi) return;
    this.isLoadingPreview = true;
    try {
      const result = await window.posApi.billing.loadBill({
        locCode: this.locationCode,
        macCode: this.machineCode,
        txnDate: this.billingDate,
        receiptNo: bill.receiptNo
      }, this.actor());
      if (result.success) {
        this.previewItems = result.data.items || [];
        this.previewBillHeader = result.data.billHeader || {};
      }
    } catch (err) {
      console.error('Load bill failed', err);
    } finally {
      this.isLoadingPreview = false;
    }
  }

  async recallSelectedBill(): Promise<void> {
    if (!this.selectedBill || !window.posApi) return;
    if (this.previewItems.length === 0) {
      try {
        const result = await window.posApi.billing.loadBill({
          locCode: this.locationCode,
          macCode: this.machineCode,
          txnDate: this.billingDate,
          receiptNo: this.selectedBill.receiptNo
        }, this.actor());
        if (result.success) {
          this.previewItems = result.data.items || [];
        }
      } catch (err) {
        console.error('Load bill failed', err);
        return;
      }
    }
    this.receiptNo = this.selectedBill.receiptNo;
    this.billItems = this.previewItems;
    this.customerCode = String((this.previewItems[0] as BillItem | undefined)?.customerCode || '').toUpperCase();
    this.customerAccountId = (this.previewItems[0] as BillItem | undefined)?.customerAccountId || null;
    await this.loadLinkedCustomer();
    this.supplierCode = String((this.previewItems[this.previewItems.length - 1] as BillItem | undefined)?.supplierCode || '').toUpperCase();
    this.billHeaderValues = this.previewBillHeader;
    this.hideRecallPopup();
    this.resetInputs({ keepSupplier: true, focusSupplier: true });
    this.scheduleTotalsRefresh();
    void this.refreshPendingBills();
  }

  exitBilling(): void {
    this.router.navigate(['/']);
  }
}
