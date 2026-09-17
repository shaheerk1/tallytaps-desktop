import { Component, OnInit } from '@angular/core';
import { SessionService, WorkstationSession } from '../services/session.service';
import { PageLinksService } from '../services/page-links.service';
import type { BusinessDayState, CashShift } from '../../../../../../packages/shared/ipc/pos-api';

/** One lot still holding stock, shaped for reading at a glance. */
type LotRow = {
  id: number;
  tag: string;
  lotCode: string;
  supplierName: string;
  ownership: 'owned' | 'consignment';
  receivedOn: string;
  grnNo: number | null;
  remainingHandling: number;
  receivedHandling: number;
  remainingBase: number | null;
  receivedBase: number | null;
  handlingUom: string;
  baseUom: string;
};

/** Every lot of one item, with what is left of it in total. */
type ItemGroup = {
  key: string;
  sku: string;
  name: string;
  handlingUom: string;
  baseUom: string;
  remainingHandling: number;
  remainingBase: number | null;
  lots: LotRow[];
};

@Component({
  selector: 'pos-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit {
  userName = '';
  userUsername = '';
  userEmail = '';
  userPhone = '';
  userRoles: string[] = [];
  lastLoginAt = '';
  userPermissions: string[] = [];
  permissionsOpen = false;

  wsSession: WorkstationSession | null = null;
  dayState: BusinessDayState | null = null;
  shift: CashShift | null = null;

  itemGroups: ItemGroup[] = [];
  lotTerm = '';
  lotsLoading = false;
  lotsError = '';

  constructor(private session: SessionService, private pageLinks: PageLinksService) {}

  async ngOnInit(): Promise<void> {
    const user = this.session.getUser();
    if (user) {
      this.userName = user.displayName || user.username;
      this.userUsername = user.username;
      this.userEmail = user.email || '';
      this.userPhone = user.phone || '';
      this.userRoles = user.roles.map((role) => role.name);
      this.userPermissions = user.permissions;
      this.lastLoginAt = user.lastLoginAt ? this.formatDateTime(user.lastLoginAt) : 'First sign-in';
    }
    this.wsSession = this.session.getWorkstationSession();
    await Promise.all([this.loadWorkstation(), this.loadLots()]);
  }

  can(permission: string): boolean {
    return this.userPermissions.includes(permission);
  }

  get initials(): string {
    return this.userName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }

  // ── Workstation: read live, not from what was stored at sign-in ──

  private async loadWorkstation(): Promise<void> {
    if (!window.posApi) return;
    const user = this.session.getUser();
    const actor = this.session.getActor() || undefined;
    const live = user ? await window.posApi.workstations.activeSession(user.id) : null;
    if (live?.success && live.data) this.wsSession = { ...this.wsSession, ...live.data } as WorkstationSession;
    const ws = this.wsSession;
    if (!ws) return;
    const [day, shift] = await Promise.all([
      this.can('business-day.view') ? window.posApi.businessDays.state(ws.locationCode, actor) : Promise.resolve(null),
      this.can('cash.shift.view') ? window.posApi.cash.activeShift(ws.sessionId, actor) : Promise.resolve(null)
    ]);
    if (day?.success) this.dayState = day.data;
    if (shift?.success) this.shift = shift.data;
  }

  dayStatusLabel(status: string | undefined): string {
    const labels: Record<string, string> = { open: 'Open', closing: 'Closing', closed: 'Closed' };
    return status ? labels[status] || status : 'Not opened';
  }

  // ── Stock in lots ──────────────────────────────────────────

  async loadLots(): Promise<void> {
    const ws = this.wsSession;
    if (!window.posApi || !ws || !this.can('receiving.view')) return;
    this.lotsLoading = true; this.lotsError = '';
    const result = await window.posApi.catalog.listInventoryLots(null, ws.locationCode, this.session.getActor() || undefined);
    this.lotsLoading = false;
    if (!result.success) { this.lotsError = result.error || 'Could not load the lots in stock.'; return; }
    this.itemGroups = this.groupLots(result.data || []);
  }

  private groupLots(rows: any[]): ItemGroup[] {
    const groups = new Map<string, ItemGroup>();
    for (const row of rows) {
      const key = String(row.product_id);
      const remainingHandling = Number(row.remaining_handling_quantity ?? row.remaining_quantity ?? 0);
      const receivedHandling = Number(row.received_handling_quantity ?? row.received_quantity ?? 0);
      const remainingBase = row.remaining_base_quantity == null ? null : Number(row.remaining_base_quantity);
      const receivedBase = row.received_base_quantity == null ? null : Number(row.received_base_quantity);
      const lot: LotRow = {
        id: Number(row.id),
        tag: String(row.lot_tag || ''),
        lotCode: String(row.lot_code || ''),
        supplierName: String(row.supplier_name || ''),
        ownership: row.ownership_model === 'consignment' ? 'consignment' : 'owned',
        receivedOn: this.dateText(row.txn_date),
        grnNo: row.grn_no == null ? null : Number(row.grn_no),
        remainingHandling, receivedHandling, remainingBase, receivedBase,
        handlingUom: String(row.handling_uom_snapshot || 'qty'),
        baseUom: String(row.base_uom_snapshot || '')
      };
      const group = groups.get(key) || {
        key, sku: String(row.sku || ''), name: String(row.product_name || ''),
        handlingUom: lot.handlingUom, baseUom: lot.baseUom, remainingHandling: 0, remainingBase: null, lots: []
      };
      group.remainingHandling += remainingHandling;
      if (remainingBase != null) group.remainingBase = (group.remainingBase || 0) + remainingBase;
      group.lots.push(lot);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => ({ ...group, lots: group.lots.sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.id - b.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get visibleGroups(): ItemGroup[] {
    const term = this.lotTerm.trim().toLowerCase();
    if (!term) return this.itemGroups;
    return this.itemGroups
      .map((group) => {
        const itemMatches = `${group.sku} ${group.name}`.toLowerCase().includes(term);
        const lots = itemMatches ? group.lots : group.lots.filter((lot) => `${lot.tag} ${lot.lotCode} ${lot.supplierName}`.toLowerCase().includes(term));
        return { ...group, lots };
      })
      .filter((group) => group.lots.length);
  }

  get lotCount(): number {
    return this.itemGroups.reduce((sum, group) => sum + group.lots.length, 0);
  }

  trackGroup(_index: number, group: ItemGroup): string { return group.key; }
  trackLot(_index: number, lot: LotRow): number { return lot.id; }

  /** "Today", "Yesterday", or how many days ago the goods arrived. */
  ageLabel(date: string): string {
    const today = this.dateText(this.wsSession?.billingDate || new Date());
    const days = Math.round((new Date(`${today}T00:00:00`).getTime() - new Date(`${date}T00:00:00`).getTime()) / 86400000);
    if (Number.isNaN(days)) return date;
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  }

  quantity(value: number | null): string {
    if (value == null) return '';
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }

  // ── Shortcuts into Supplier Receiving ──────────────────────

  openLotCodes(): void { void this.pageLinks.openReceiving({ open: 'lot-codes' }); }
  newGrn(): void { void this.pageLinks.openReceiving({ open: 'new-grn' }); }
  newStatement(): void { void this.pageLinks.openReceiving({ open: 'new-statement' }); }
  sendGoodsOut(): void { void this.pageLinks.openReceiving({ open: 'send-out' }); }
  adjustAndCount(): void { void this.pageLinks.openReceiving({ open: 'adjust-count' }); }

  private dateText(value: unknown): string {
    if (value instanceof Date) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    return String(value || '').slice(0, 10);
  }

  private formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
}
