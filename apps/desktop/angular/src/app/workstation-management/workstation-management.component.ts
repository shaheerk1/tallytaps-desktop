import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { WorkstationService, Workstation } from '../services/workstation.service';

@Component({
  selector: 'pos-workstation-management',
  templateUrl: './workstation-management.component.html',
  styleUrls: ['./workstation-management.component.css']
})
export class WorkstationManagementComponent implements OnInit {
  workstations: Workstation[] = [];
  isLoading = true;
  errorMessage = '';

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
    } catch (err) {
      console.error('Failed to load workstations', err);
      this.errorMessage = 'Failed to load workstations.';
    } finally {
      this.isLoading = false;
    }
  }

  // ── Create ──────────────────────────────────────────────

  openCreateModal(): void {
    this.newWs = { locationCode: '', machineCode: '', name: '', status: 'active' };
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
