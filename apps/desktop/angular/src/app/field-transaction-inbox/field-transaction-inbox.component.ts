import { Component, HostListener, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import type { FieldInboxMedia, FieldInboxRecord, FieldInboxRecordList } from '../../../../../../packages/shared/ipc/pos-api';

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

  constructor(private session: SessionService) {}

  async ngOnInit(): Promise<void> {
    this.selectedDate = this.session.getBillingDate() || this.todayInSriLanka();
    await this.loadRecords();
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
}
