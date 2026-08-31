import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type { FieldInboxMedia, FieldInboxRecord, FieldInboxRecordList, MobileInboxBill, PrintDocument, ReceiptPrintSettings } from '../../../../../../packages/shared/ipc/pos-api';

type StatusFilter = 'all' | 'open' | 'resolved';

@Component({
  selector: 'pos-field-transaction-inbox',
  templateUrl: './field-transaction-inbox.component.html',
  styleUrls: ['./field-transaction-inbox.component.css']
})
export class FieldTransactionInboxComponent implements OnInit {
  selectedDate = '';
  records: FieldInboxRecord[] = [];
  range: FieldInboxRecordList['range'] | null = null;
  hostId = '';
  loading = false;
  error = '';
  refreshedAt: Date | null = null;

  deviceFilter = 'all';
  typeFilter = 'all';
  directionFilter = 'all';
  itemFilter = 'all';
  statusFilter: StatusFilter = 'all';
  searchTerm = '';

  selectedRecord: FieldInboxRecord | null = null;
  resolvingIds = new Set<string>();
  mediaData = new Map<string, string>();
  mediaLoading = new Set<string>();
  mediaErrors = new Map<string, string>();
  fullSizeImage: FieldInboxMedia | null = null;
  mobileBills: MobileInboxBill[] = [];
  selectedBill: MobileInboxBill | null = null;
  billsLoading = false;
  billActionId = '';
  billError = '';

  private readonly sriLankaDateTime = new Intl.DateTimeFormat('en-LK', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  constructor(private session: SessionService, private printing: PrintingService) {}

  async ngOnInit(): Promise<void> {
    this.selectedDate = this.session.getBillingDate() || this.todayInSriLanka();
    await Promise.all([this.loadRecords(), this.loadMobileBills()]);
  }

  async loadMobileBills(): Promise<void> {
    if (!window.posApi || !this.selectedDate || this.billsLoading) return;
    this.billsLoading = true;
    this.billError = '';
    try {
      const { since, until } = this.mobileBillDayRange(this.selectedDate);
      const result = await window.posApi.cloudSync.listMobileBills(since, until, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.mobileBills = [...result.data.bills].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    } catch (error) {
      this.billError = error instanceof Error ? error.message : 'Could not load mobile bills.';
      this.mobileBills = [];
    } finally { this.billsLoading = false; }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.loadRecords(), this.loadMobileBills()]);
  }

  async openBill(bill: MobileInboxBill): Promise<void> {
    this.selectedBill = bill;
    if (bill.deliveryStatus === 'pending' && window.posApi) {
      const result = await window.posApi.cloudSync.setMobileBillStatus(bill.id, 'viewed', this.session.getActor());
      if (result.success) bill.deliveryStatus = 'viewed';
    }
  }

  closeBill(): void { this.selectedBill = null; }

  async printMobileBill(bill: MobileInboxBill): Promise<void> {
    if (!window.posApi || this.billActionId) return;
    this.billActionId = bill.id; this.error = '';
    try {
      const settings = await window.posApi.settings.getReceipt();
      if (!settings.success) throw new Error(settings.error);
      const printed = await this.printing.printDocument(this.mobileBillDocument(bill, settings.data));
      if (!printed.success) throw new Error(printed.error || 'Print failed.');
      const status = await window.posApi.cloudSync.setMobileBillStatus(bill.id, 'printed', this.session.getActor());
      if (!status.success) throw new Error(status.error);
      bill.deliveryStatus = 'printed';
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not print the mobile bill.'; }
    finally { this.billActionId = ''; }
  }

  get canResolve(): boolean {
    return this.session.hasPermission('field-inbox.resolve');
  }

  get devices(): Array<{ value: string; label: string }> {
    const values = new Map<string, string>();
    for (const record of this.records) {
      const key = this.deviceKey(record);
      if (key) values.set(key, this.deviceLabel(record));
    }
    return [...values.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  get types(): string[] {
    return this.uniqueValues(this.records.map((record) => record.type));
  }

  get directions(): string[] {
    return this.uniqueValues(this.records.map((record) => record.direction));
  }

  get items(): string[] {
    return this.uniqueValues(this.records.map((record) => record.item).filter((value): value is string => !!value));
  }

  get filteredRecords(): FieldInboxRecord[] {
    const search = this.searchTerm.trim().toLocaleLowerCase();
    return this.records.filter((record) => {
      if (this.deviceFilter !== 'all' && this.deviceKey(record) !== this.deviceFilter) return false;
      if (this.typeFilter !== 'all' && record.type !== this.typeFilter) return false;
      if (this.directionFilter !== 'all' && record.direction !== this.directionFilter) return false;
      if (this.itemFilter !== 'all' && record.item !== this.itemFilter) return false;
      if (this.statusFilter === 'open' && record.resolved) return false;
      if (this.statusFilter === 'resolved' && !record.resolved) return false;
      if (!search) return true;
      return [record.item, record.note, record.type, record.direction, record.clientRecordId, this.deviceLabel(record)]
        .some((value) => String(value || '').toLocaleLowerCase().includes(search));
    });
  }

  get openCount(): number {
    return this.records.filter((record) => !record.resolved).length;
  }

  get resolvedCount(): number {
    return this.records.length - this.openCount;
  }

  get receivedAmount(): number {
    return this.moneyMovementTotal(['incoming', 'received', 'in']);
  }

  get paidAmount(): number {
    return this.moneyMovementTotal(['outgoing', 'paid', 'spent', 'out']);
  }

  async loadRecords(): Promise<void> {
    if (!window.posApi || !this.selectedDate || this.loading) return;
    this.loading = true;
    this.error = '';
    try {
      const result = await window.posApi.fieldInbox.listRecords(this.selectedDate, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.records = [...result.data.records].sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      );
      this.hostId = result.data.hostId;
      this.range = result.data.range;
      this.refreshedAt = new Date();
      this.reconcileFilters();
    } catch (error) {
      this.records = [];
      this.range = null;
      this.error = error instanceof Error ? error.message : 'Could not load field transactions.';
    } finally {
      this.loading = false;
    }
  }

  clearFilters(): void {
    this.deviceFilter = 'all';
    this.typeFilter = 'all';
    this.directionFilter = 'all';
    this.itemFilter = 'all';
    this.statusFilter = 'all';
    this.searchTerm = '';
  }

  async openDetails(record: FieldInboxRecord): Promise<void> {
    this.selectedRecord = record;
    this.mediaData.clear();
    this.mediaErrors.clear();
    this.mediaLoading.clear();
    await Promise.all(record.media.map((media) => this.loadMedia(media)));
  }

  closeDetails(): void {
    this.fullSizeImage = null;
    this.selectedRecord = null;
    this.mediaData.clear();
    this.mediaErrors.clear();
    this.mediaLoading.clear();
  }

  openFullSizeImage(media: FieldInboxMedia): void {
    if (media.type === 'image' && this.mediaSource(media.id)) this.fullSizeImage = media;
  }

  closeFullSizeImage(): void {
    this.fullSizeImage = null;
  }

  @HostListener('document:keydown.escape')
  closeTopLayer(): void {
    if (this.fullSizeImage) {
      this.closeFullSizeImage();
      return;
    }
    if (this.selectedRecord) this.closeDetails();
    else if (this.selectedBill) this.closeBill();
  }

  async toggleResolved(record: FieldInboxRecord, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!window.posApi || !this.canResolve || this.resolvingIds.has(record.id)) return;
    this.resolvingIds.add(record.id);
    this.error = '';
    try {
      const result = await window.posApi.fieldInbox.setResolved(
        record.id,
        record.clientRecordId,
        !record.resolved,
        this.session.getActor()
      );
      if (!result.success) throw new Error(result.error);
      record.resolved = result.data.resolved;
      record.resolvedAt = result.data.resolvedAt;
      record.resolvedBy = result.data.resolvedBy;
      if (this.selectedRecord?.id === record.id) this.selectedRecord = record;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not update the local status.';
    } finally {
      this.resolvingIds.delete(record.id);
    }
  }

  async loadMedia(media: FieldInboxMedia): Promise<void> {
    if (!window.posApi || this.mediaData.has(media.id) || this.mediaLoading.has(media.id)) return;
    this.mediaLoading.add(media.id);
    this.mediaErrors.delete(media.id);
    try {
      const result = await window.posApi.fieldInbox.getMedia(media.id, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.mediaData.set(media.id, `data:${result.data.contentType};base64,${result.data.dataBase64}`);
    } catch (error) {
      this.mediaErrors.set(media.id, error instanceof Error ? error.message : 'Could not load attachment.');
    } finally {
      this.mediaLoading.delete(media.id);
    }
  }

  mediaSource(mediaId: string): string {
    return this.mediaData.get(mediaId) || '';
  }

  mediaError(mediaId: string): string {
    return this.mediaErrors.get(mediaId) || '';
  }

  isMediaLoading(mediaId: string): boolean {
    return this.mediaLoading.has(mediaId);
  }

  deviceLabel(record: FieldInboxRecord): string {
    return record.device.nickname || record.device.model || record.device.name || 'Unknown device';
  }

  deviceDetails(record: FieldInboxRecord): string {
    const details = [record.device.model, record.device.platform, record.device.appVersion].filter(Boolean);
    return details.join(' / ') || 'No device details';
  }

  displayDateTime(value: string | null): string {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : `${this.sriLankaDateTime.format(date)} SLST`;
  }

  displayTime(value: string | Date | null): string {
    if (!value) return '--:--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--:--';
    return new Intl.DateTimeFormat('en-LK', {
      timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(date);
  }

  displayQuantity(record: FieldInboxRecord): string {
    if (record.qty === null) return '-';
    return `${this.formatNumber(record.qty, 3)}${record.unit ? ` ${record.unit}` : ''}`;
  }

  syncDelay(record: FieldInboxRecord): string {
    if (!record.createdAt || !record.receivedAt) return 'Not available';
    const seconds = Math.max(0, Math.round((new Date(record.receivedAt).getTime() - new Date(record.createdAt).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return 'Not available';
    if (seconds < 60) return `${seconds} sec`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes} min ${remainder} sec`;
    return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  }

  formatNumber(value: number, decimals = 2): string {
    return Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  private deviceKey(record: FieldInboxRecord): string {
    return record.device.id || record.device.nickname || record.device.model || record.device.name || 'unknown';
  }

  private uniqueValues(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  private moneyMovementTotal(directions: string[]): number {
    const acceptedDirections = new Set(directions);
    return this.records.reduce((total, record) => {
      const type = String(record.type || '').trim().toLocaleLowerCase();
      const direction = String(record.direction || '').trim().toLocaleLowerCase();
      if (!['cash', 'card'].includes(type) || !acceptedDirections.has(direction)) return total;
      return total + Math.abs(Number(record.amount) || 0);
    }, 0);
  }

  private reconcileFilters(): void {
    if (this.deviceFilter !== 'all' && !this.devices.some((device) => device.value === this.deviceFilter)) this.deviceFilter = 'all';
    if (this.typeFilter !== 'all' && !this.types.includes(this.typeFilter)) this.typeFilter = 'all';
    if (this.directionFilter !== 'all' && !this.directions.includes(this.directionFilter)) this.directionFilter = 'all';
    if (this.itemFilter !== 'all' && !this.items.includes(this.itemFilter)) this.itemFilter = 'all';
  }

  private todayInSriLanka(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value['year']}-${value['month']}-${value['day']}`;
  }

  private mobileBillDayRange(date: string): { since: string; until: string } {
    const start = new Date(`${date}T00:00:00+05:30`);
    return { since: start.toISOString(), until: new Date(start.getTime() + 86400000).toISOString() };
  }

  private mobileBillDocument(bill: MobileInboxBill, cfg: ReceiptPrintSettings): PrintDocument {
    const money = (value: number) => `${cfg.currencySymbol} ${Number(value || 0).toFixed(2)}`;
    return {
      documentTitle: 'Field Sales Invoice',
      brand: { name: cfg.storeName, tagline: cfg.tagline, addressLines: cfg.addressLines, phone: cfg.phone },
      logoDataUrl: cfg.logoDataUrl || undefined,
      secondaryHeaderLines: cfg.headers.map((text) => ({ text, align: 'center' })),
      meta: [
        { label: 'Receipt', value: bill.clientBillId.slice(0, 12).toUpperCase() },
        { label: 'Date', value: this.displayDateTime(bill.createdAt) },
        { label: 'Source', value: bill.device.nickname || bill.device.name || 'Field device' },
        ...(bill.customerName ? [{ label: 'Customer', value: bill.customerName }] : []),
        ...(bill.customerMobile ? [{ label: 'Phone', value: bill.customerMobile }] : [])
      ],
      itemLayout: 'invoice-measures',
      receiptLanguage: cfg.language,
      rasterHeaderLayout: 'billing',
      items: bill.lines.map((line) => ({
        description: `${line.sku ? `${line.sku} ` : ''}${line.description}`,
        qty: line.pricingBasis === 'kilos' ? `${line.kilos || 0}` : `${line.quantity}`,
        measure: {
          qty: `${line.quantity}`,
          ...(line.pricingBasis === 'kilos' ? { kilos: `${line.kilos || 0}` } : {}),
          rate: money(line.unitPrice)
        },
        amount: money(line.lineTotal),
        extras: [
          ...(line.bagChargeTotal ? [{ label: 'Bag', value: money(line.bagChargeTotal) }] : []),
          ...(line.wageChargeTotal ? [{ label: 'Wage', value: money(line.wageChargeTotal) }] : [])
        ]
      })),
      totals: [
        { label: 'Subtotal', value: money(bill.subtotal) },
        ...(bill.bagChargeTotal ? [{ label: 'Bag Charges', value: money(bill.bagChargeTotal) }] : []),
        ...(bill.wageChargeTotal ? [{ label: 'Wage Charges', value: money(bill.wageChargeTotal) }] : []),
        ...(bill.discountTotal ? [{ label: 'Discount', value: `-${money(bill.discountTotal)}` }] : []),
        { label: 'TOTAL', value: money(bill.grandTotal), bold: true },
        ...bill.payments.map((payment) => ({ label: payment.method.toUpperCase(), value: money(payment.amount) })),
        ...(bill.balance ? [{ label: 'Pending Balance', value: money(bill.balance) }] : [])
      ],
      preLines: bill.note ? [{ text: bill.note, align: 'left' }] : [],
      footerLines: cfg.footers
    };
  }
}
