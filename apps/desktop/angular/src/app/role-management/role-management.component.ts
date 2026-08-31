import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { UserManagementService, ManageRole, ManageRoleDetail, ManagePermission } from '../services/user-management.service';

@Component({
  selector: 'pos-role-management',
  templateUrl: './role-management.component.html',
  styleUrls: ['./role-management.component.css']
})
export class RoleManagementComponent implements OnInit {
  roles: ManageRole[] = [];
  permissions: ManagePermission[] = [];
  isLoading = true;
  searchTerm = '';
  errorMessage = '';

  showCreateModal = false;
  showEditModal = false;
  showDeleteModal = false;
  showPermissionsModal = false;

  newRole = { roleKey: '', name: '' };
  editRole = { id: 0, name: '' };
  deleteTarget: ManageRole | null = null;
  permissionsTarget: ManageRole | null = null;
  selectedPermissionIds: number[] = [];

  permissionGroups: Record<string, ManagePermission[]> = {};

  constructor(
    private session: SessionService,
    private umService: UserManagementService
  ) {}

  async ngOnInit(): Promise<void> {
    await this.loadData();
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const [roles, permissions] = await Promise.all([
        this.umService.listRoles(),
        this.umService.listPermissions()
      ]);
      this.roles = roles;
      this.permissions = permissions;
      this.buildPermissionGroups();
    } catch (err) {
      console.error('Failed to load role data', err);
      this.errorMessage = 'Failed to load role data.';
    } finally {
      this.isLoading = false;
    }
  }

  buildPermissionGroups(): void {
    this.permissionGroups = {};
    for (const p of this.permissions) {
      const parts = p.permission_key.split('.');
      const group = parts.length > 1 ? parts[0] : 'general';
      if (!this.permissionGroups[group]) {
        this.permissionGroups[group] = [];
      }
      this.permissionGroups[group].push(p);
    }
  }

  get filteredRoles(): ManageRole[] {
    if (!this.searchTerm.trim()) return this.roles;
    const term = this.searchTerm.toLowerCase();
    return this.roles.filter(r =>
      r.name.toLowerCase().includes(term) ||
      r.role_key.toLowerCase().includes(term)
    );
  }

  get permissionGroupKeys(): string[] {
    return Object.keys(this.permissionGroups).sort();
  }

  formatGroupLabel(key: string): string {
    return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
  }

  // ── Create ──────────────────────────────────────────────

  openCreateModal(): void {
    this.newRole = { roleKey: '', name: '' };
    this.errorMessage = '';
    this.showCreateModal = true;
  }

  closeCreateModal(): void {
    this.showCreateModal = false;
  }

  async submitCreate(): Promise<void> {
    this.errorMessage = '';
    try {
      const result = await this.umService.createRole(this.newRole);
      if (!result) {
        this.errorMessage = 'Failed to create role.';
        return;
      }
      this.showCreateModal = false;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to create role.';
    }
  }

  // ── Edit ────────────────────────────────────────────────

  openEditModal(role: ManageRole): void {
    this.editRole = { id: role.id, name: role.name };
    this.errorMessage = '';
    this.showEditModal = true;
  }

  closeEditModal(): void {
    this.showEditModal = false;
  }

  async submitEdit(): Promise<void> {
    this.errorMessage = '';
    try {
      const result = await this.umService.updateRole(this.editRole.id, { name: this.editRole.name });
      if (!result) {
        this.errorMessage = 'Failed to update role.';
        return;
      }
      this.showEditModal = false;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to update role.';
    }
  }

  // ── Delete ──────────────────────────────────────────────

  openDeleteModal(role: ManageRole): void {
    this.deleteTarget = role;
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
      const ok = await this.umService.deleteRole(this.deleteTarget.id);
      if (!ok) {
        this.errorMessage = 'Failed to delete role.';
        return;
      }
      this.showDeleteModal = false;
      this.deleteTarget = null;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to delete role.';
    }
  }

  // ── Permissions ─────────────────────────────────────────

  async openPermissionsModal(role: ManageRole): Promise<void> {
    this.permissionsTarget = role;
    this.errorMessage = '';
    this.selectedPermissionIds = [];

    const detail = await this.umService.getRole(role.id);
    if (detail) {
      this.selectedPermissionIds = detail.permissions.map(p => p.id);
    }

    this.showPermissionsModal = true;
  }

  closePermissionsModal(): void {
    this.showPermissionsModal = false;
    this.permissionsTarget = null;
  }

  togglePermission(permId: number): void {
    const idx = this.selectedPermissionIds.indexOf(permId);
    if (idx >= 0) {
      this.selectedPermissionIds.splice(idx, 1);
    } else {
      this.selectedPermissionIds.push(permId);
    }
  }

  toggleGroupPermissions(group: ManagePermission[]): void {
    const allSelected = group.every(p => this.selectedPermissionIds.includes(p.id));
    for (const p of group) {
      const idx = this.selectedPermissionIds.indexOf(p.id);
      if (allSelected) {
        if (idx >= 0) this.selectedPermissionIds.splice(idx, 1);
      } else {
        if (idx < 0) this.selectedPermissionIds.push(p.id);
      }
    }
  }

  isGroupFullySelected(group: ManagePermission[]): boolean {
    return group.every(p => this.selectedPermissionIds.includes(p.id));
  }

  isGroupPartiallySelected(group: ManagePermission[]): boolean {
    const count = group.filter(p => this.selectedPermissionIds.includes(p.id)).length;
    return count > 0 && count < group.length;
  }

  async submitPermissions(): Promise<void> {
    if (!this.permissionsTarget) return;
    this.errorMessage = '';
    try {
      const result = await this.umService.setRolePermissions(this.permissionsTarget.id, this.selectedPermissionIds);
      if (!result) {
        this.errorMessage = 'Failed to update permissions.';
        return;
      }
      this.showPermissionsModal = false;
      this.permissionsTarget = null;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to update permissions.';
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  isAdminRole(role: ManageRole): boolean {
    return role.role_key === 'admin';
  }
}
