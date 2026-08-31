import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { UserManagementService, ManageUser, ManageRole } from '../services/user-management.service';

@Component({
  selector: 'pos-user-management',
  templateUrl: './user-management.component.html',
  styleUrls: ['./user-management.component.css']
})
export class UserManagementComponent implements OnInit {
  users: ManageUser[] = [];
  roles: ManageRole[] = [];
  isLoading = true;
  searchTerm = '';
  errorMessage = '';

  showCreateModal = false;
  showEditModal = false;
  showDeleteModal = false;
  showPasswordModal = false;
  showRolesModal = false;

  newUser: NewUserForm = { username: '', password: '', displayName: '', email: '', phone: '', roleIds: [] };
  editUser: EditUserForm = { id: 0, displayName: '', email: '', phone: '', status: 'active' };
  deleteTarget: ManageUser | null = null;
  passwordForm = { id: 0, username: '', newPassword: '' };
  rolesTarget: ManageUser | null = null;
  selectedRoleIds: number[] = [];

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
      const [users, roles] = await Promise.all([
        this.umService.listUsers(),
        this.umService.listRoles()
      ]);
      this.users = users;
      this.roles = roles;
    } catch (err) {
      console.error('Failed to load user data', err);
      this.errorMessage = 'Failed to load user data.';
    } finally {
      this.isLoading = false;
    }
  }

  get filteredUsers(): ManageUser[] {
    if (!this.searchTerm.trim()) return this.users;
    const term = this.searchTerm.toLowerCase();
    return this.users.filter(u =>
      u.username.toLowerCase().includes(term) ||
      u.display_name.toLowerCase().includes(term) ||
      (u.email && u.email.toLowerCase().includes(term))
    );
  }

  // ── Create ──────────────────────────────────────────────

  openCreateModal(): void {
    this.newUser = { username: '', password: '', displayName: '', email: '', phone: '', roleIds: [] };
    this.errorMessage = '';
    this.showCreateModal = true;
  }

  closeCreateModal(): void {
    this.showCreateModal = false;
  }

  async submitCreate(): Promise<void> {
    this.errorMessage = '';
    try {
      const result = await this.umService.createUser({
        username: this.newUser.username,
        password: this.newUser.password,
        displayName: this.newUser.displayName,
        email: this.newUser.email || undefined,
        phone: this.newUser.phone || undefined,
        roleIds: this.newUser.roleIds
      });
      if (!result) {
        this.errorMessage = 'Failed to create user.';
        return;
      }
      this.showCreateModal = false;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to create user.';
    }
  }

  toggleNewUserRole(roleId: number): void {
    const idx = this.newUser.roleIds.indexOf(roleId);
    if (idx >= 0) {
      this.newUser.roleIds.splice(idx, 1);
    } else {
      this.newUser.roleIds.push(roleId);
    }
  }

  // ── Edit ────────────────────────────────────────────────

  openEditModal(user: ManageUser): void {
    this.editUser = {
      id: user.id,
      displayName: user.display_name,
      email: user.email || '',
      phone: user.phone || '',
      status: user.status
    };
    this.errorMessage = '';
    this.showEditModal = true;
  }

  closeEditModal(): void {
    this.showEditModal = false;
  }

  async submitEdit(): Promise<void> {
    this.errorMessage = '';
    try {
      const result = await this.umService.updateUser(this.editUser.id, {
        displayName: this.editUser.displayName,
        email: this.editUser.email || undefined,
        phone: this.editUser.phone || undefined,
        status: this.editUser.status
      });
      if (!result) {
        this.errorMessage = 'Failed to update user.';
        return;
      }
      this.showEditModal = false;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to update user.';
    }
  }

  // ── Delete ──────────────────────────────────────────────

  openDeleteModal(user: ManageUser): void {
    this.deleteTarget = user;
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
      const ok = await this.umService.deleteUser(this.deleteTarget.id);
      if (!ok) {
        this.errorMessage = 'Failed to delete user.';
        return;
      }
      this.showDeleteModal = false;
      this.deleteTarget = null;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to delete user.';
    }
  }

  // ── Password ────────────────────────────────────────────

  openPasswordModal(user: ManageUser): void {
    this.passwordForm = { id: user.id, username: user.username, newPassword: '' };
    this.errorMessage = '';
    this.showPasswordModal = true;
  }

  closePasswordModal(): void {
    this.showPasswordModal = false;
  }

  async submitPassword(): Promise<void> {
    this.errorMessage = '';
    try {
      const ok = await this.umService.updatePassword(this.passwordForm.id, this.passwordForm.newPassword);
      if (!ok) {
        this.errorMessage = 'Failed to update password.';
        return;
      }
      this.showPasswordModal = false;
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to update password.';
    }
  }

  // ── Roles ───────────────────────────────────────────────

  openRolesModal(user: ManageUser): void {
    this.rolesTarget = user;
    this.selectedRoleIds = user.roles.map(r => r.id);
    this.errorMessage = '';
    this.showRolesModal = true;
  }

  closeRolesModal(): void {
    this.showRolesModal = false;
    this.rolesTarget = null;
  }

  toggleSelectedRole(roleId: number): void {
    const idx = this.selectedRoleIds.indexOf(roleId);
    if (idx >= 0) {
      this.selectedRoleIds.splice(idx, 1);
    } else {
      this.selectedRoleIds.push(roleId);
    }
  }

  async submitRoles(): Promise<void> {
    if (!this.rolesTarget) return;
    this.errorMessage = '';
    try {
      const result = await this.umService.setRoles(this.rolesTarget.id, this.selectedRoleIds);
      if (!result) {
        this.errorMessage = 'Failed to update roles.';
        return;
      }
      this.showRolesModal = false;
      this.rolesTarget = null;
      await this.loadData();
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to update roles.';
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  formatRoles(user: ManageUser): string {
    if (!user.roles || user.roles.length === 0) return '—';
    return user.roles.map(r => r.name).join(', ');
  }

  formatDate(dateStr: string | null): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-LK', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  isAdmin(user: ManageUser): boolean {
    return user.username === 'admin';
  }
}

type NewUserForm = {
  username: string;
  password: string;
  displayName: string;
  email: string;
  phone: string;
  roleIds: number[];
};

type EditUserForm = {
  id: number;
  displayName: string;
  email: string;
  phone: string;
  status: string;
};
