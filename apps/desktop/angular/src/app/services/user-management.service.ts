import { Injectable } from '@angular/core';
import { SessionService } from './session.service';

export type ManageUser = {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  last_login_at: string | null;
  password_updated_at: string | null;
  created_at: string;
  updated_at: string;
  roles: Array<{ id: number; role_key: string; name: string }>;
};

export type ManageUserDetail = ManageUser & {
  permissions: Array<{ permission_key: string; name: string }>;
};

export type ManageRole = {
  id: number;
  role_key: string;
  name: string;
  created_at: string;
  permissionCount: number;
  userCount: number;
};

export type ManageRoleDetail = ManageRole & {
  permissions: Array<{ id: number; permission_key: string; name: string }>;
  users: Array<{ id: number; username: string; display_name: string }>;
};

export type ManagePermission = {
  id: number;
  permission_key: string;
  name: string;
};

@Injectable({ providedIn: 'root' })
export class UserManagementService {

  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  async listUsers(): Promise<ManageUser[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.users.list(this.actor);
    if (!result.success) return [];
    return result.data as unknown as ManageUser[];
  }

  async getUser(id: number): Promise<ManageUserDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.users.get(id, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageUserDetail;
  }

  async createUser(payload: {
    username: string;
    password: string;
    displayName: string;
    email?: string;
    phone?: string;
    status?: string;
    roleIds?: number[];
  }): Promise<ManageUserDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.users.create(payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageUserDetail;
  }

  async updateUser(id: number, payload: {
    displayName?: string;
    email?: string;
    phone?: string;
    status?: string;
  }): Promise<ManageUserDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.users.update(id, payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageUserDetail;
  }

  async updatePassword(id: number, newPassword: string): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.users.updatePassword(id, newPassword, this.actor);
    return result.success;
  }

  async deleteUser(id: number): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.users.delete(id, this.actor);
    return result.success;
  }

  async setRoles(userId: number, roleIds: number[]): Promise<ManageUserDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.users.setRoles(userId, roleIds, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageUserDetail;
  }

  async listRoles(): Promise<ManageRole[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.roles.list(this.actor);
    if (!result.success) return [];
    return result.data as unknown as ManageRole[];
  }

  async getRole(id: number): Promise<ManageRoleDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.roles.get(id, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageRoleDetail;
  }

  async createRole(payload: { roleKey: string; name: string }): Promise<ManageRoleDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.roles.create(payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageRoleDetail;
  }

  async updateRole(id: number, payload: { name?: string }): Promise<ManageRoleDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.roles.update(id, payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageRoleDetail;
  }

  async deleteRole(id: number): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.roles.delete(id, this.actor);
    return result.success;
  }

  async setRolePermissions(roleId: number, permissionIds: number[]): Promise<ManageRoleDetail | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.roles.setPermissions(roleId, permissionIds, this.actor);
    if (!result.success) return null;
    return result.data as unknown as ManageRoleDetail;
  }

  async listPermissions(): Promise<ManagePermission[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.permissions.list(this.actor);
    if (!result.success) return [];
    return result.data as unknown as ManagePermission[];
  }
}
