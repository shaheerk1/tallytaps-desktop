import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { WorkstationService, Workstation } from '../services/workstation.service';
import type { PosLocation } from '../../../../../../packages/shared/ipc/pos-api';

@Component({
  selector: 'pos-workstation-management',
  templateUrl: './workstation-management.component.html',
  styleUrls: ['./workstation-management.component.css']
})
export class WorkstationManagementComponent implements OnInit {
  workstations: Workstation[] = [];
  locations: PosLocation[] = [];
  isLoading = true;
  errorMessage = '';

  // A location code is issued once and never reused, even after it is retired.
  showLocationModal = false;
  locationDraft = { locCode: '', businessCode: '', name: '', notes: '', editing: false };
  retireTarget: PosLocation | null = null;

  showCreateModal = false;
  showEditModal = false;
  showDeleteModal = false;

  newWs = { locationCode: '', machineCode: '', name: '', status: 'active' };
  editWs = { id: 0, name: '', status: 'active' };
  deleteTarget: Workstation | null = null;

  constructor(
    private session: SessionService,
    private wsService: WorkstationService
  ) {}

  async ngOnInit(): Promise<void> {
    await this.loadData();
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      this.workstations = await this.wsService.listAll();
      await this.loadLocations();
    } catch (err) {
      console.error('Failed to load workstations', err);
      this.errorMessage = 'Failed to load workstations.';
    } finally {
      this.isLoading = false;
    }
  }

  private actor() { return this.session.getActor() || undefined; }

  get activeLocations(): PosLocation[] { return this.locations.filter((row) => row.status === 'active'); }

  /** Locations grouped under their business label, for the overview. */
  get businesses(): Array<{ code: string; locations: PosLocation[] }> {
    const map = new Map<string, PosLocation[]>();
    for (const row of this.locations) {
      if (!map.has(row.businessCode)) map.set(row.businessCode, []);
      map.get(row.businessCode)!.push(row);
    }
    return [...map.entries()].map(([code, locations]) => ({ code, locations }));
  }

  async loadLocations(): Promise<void> {
    if (!window.posApi) return;
    const result = await window.posApi.locations.list(this.actor());
    if (result.success) this.locations = result.data || [];
    else this.errorMessage = result.error || 'Failed to load locations.';
  }

  openLocationModal(location?: PosLocation): void {
    this.errorMessage = '';
    this.locationDraft = location
      ? { locCode: location.locCode, businessCode: location.businessCode, name: location.name, notes: location.notes || '', editing: true }
      : { locCode: '', businessCode: '', name: '', notes: '', editing: false };
    this.showLocationModal = true;
  }

  closeLocationModal(): void { this.showLocationModal = false; }

  async submitLocation(): Promise<void> {
    if (!window.posApi) return;
    this.errorMessage = '';
    const draft = this.locationDraft;
    const result = draft.editing
      ? await window.posApi.locations.update(draft.locCode, { businessCode: draft.businessCode, name: draft.name, notes: draft.notes }, this.actor())
      : await window.posApi.locations.create({ locCode: draft.locCode, businessCode: draft.businessCode, name: draft.name, notes: draft.notes }, this.actor());
    if (!result.success) { this.errorMessage = result.error || 'Could not save the location.'; return; }
    this.showLocationModal = false;
    await this.loadLocations();
  }

  openRetire(location: PosLocation): void { this.errorMessage = ''; this.retireTarget = location; }
  closeRetire(): void { this.retireTarget = null; }

  async submitRetire(): Promise<void> {
    if (!window.posApi || !this.retireTarget) return;
    const result = await window.posApi.locations.retire(this.retireTarget.locCode, this.actor());
    if (!result.success) { this.errorMessage = result.error || 'Could not retire the location.'; return; }
    this.retireTarget = null;
    await this.loadLocations();
  }

  // ── Create ──────────────────────────────────────────────

  openCreateModal(): void {
    this.newWs = { locationCode: this.activeLocations[0]?.locCode || '', machineCode: '', name: '', status: 'active' };
    this.errorMessage = '';
    this.showCreateModal = true;
  }

  closeCreateModal(): void {
    this.showCreateModal = false;
  }

  async submitCreate(): Promise<void> {
    this.errorMessage = '';
    try {
      const result = await this.wsService.create(this.newWs);
      if (!result) {
        this.errorMessage = 'Failed to create workstation.';
        return;
      }
      this.showCreateModal = false;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to create workstation.';
    }
  }

  // ── Edit ────────────────────────────────────────────────

  openEditModal(ws: Workstation): void {
    this.editWs = { id: ws.id, name: ws.name, status: ws.status };
    this.errorMessage = '';
    this.showEditModal = true;
  }

  closeEditModal(): void {
    this.showEditModal = false;
  }

  async submitEdit(): Promise<void> {
    this.errorMessage = '';
    try {
      const result = await this.wsService.update(this.editWs.id, {
        name: this.editWs.name,
        status: this.editWs.status
      });
      if (!result) {
        this.errorMessage = 'Failed to update workstation.';
        return;
      }
      this.showEditModal = false;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to update workstation.';
    }
  }

  // ── Delete ──────────────────────────────────────────────

  openDeleteModal(ws: Workstation): void {
    this.deleteTarget = ws;
    this.errorMessage = '';
    this.showDeleteModal = true;
  }

  closeDeleteModal(): void {
    this.showDeleteModal = false;
    this.deleteTarget = null;
  }

  async submitDelete(): Promise<void> {
    if (!this.deleteTarget) return;
    this.errorMessage = '';
    try {
      const ok = await this.wsService.delete(this.deleteTarget.id);
      if (!ok) {
        this.errorMessage = 'Failed to delete workstation.';
        return;
      }
      this.showDeleteModal = false;
      this.deleteTarget = null;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to delete workstation.';
    }
  }
}
